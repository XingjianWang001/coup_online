// packages/server/src/speech.test.ts
import { describe, expect, it } from 'vitest';
import {
  COUP_COST,
  block,
  challenge,
  chooseAction,
  createGame,
  passChallenge,
  publicState,
  resolveLoss,
  revealPostGameCard,
  revealShowdownCard,
  type GameEvent,
  type GameState,
  type Role,
} from '@coup/engine';
import type { Reaction } from '@coup/shared';
import { afterGame, afterOwnClaim, merge, type Options, type Row } from './speech.ts';

describe('场景表的合并', () => {
  it('成立的行合并候选：同一条的权重相乘，写了排除的不出现，沉默始终在候选里；不成立的行不算', () => {
    const rows: Row<{ on: boolean }>[] = [
      { when: () => true, say: { dare: 2, honest: 3 } },
      { when: () => true, say: { dare: 5, mercy: 1, silence: 4 }, exclude: ['honest'] },
      { when: ({ on }) => on, say: { respect: 1 } },
      { when: () => true, say: { honest: 7 } }, // 被上面的排除，不管写在哪一行之后
    ];
    const merged = merge(rows, { on: false });
    expect(merged.get('dare')).toBe(10);
    expect(merged.get('mercy')).toBe(1);
    expect(merged.has('honest')).toBe(false);
    expect(merged.has('respect')).toBe(false);
    // 沉默有基础权重，再乘上「多沉默」的那一行
    expect(merged.get('silence')! / merge([{ when: () => true, say: { dare: 1 } }], {}).get('silence')!).toBe(4);
  });
});

// 一桌按真实流程推进的牌局：a 先手，did 记下引擎产生的事件，和 Room.gameEvents 一样
const IDS = ['a', 'b', 'c'];
const HANDS: Record<string, Role[]> = { a: ['duke', 'captain'], b: ['duke', 'assassin'], c: ['duke', 'contessa'] };
function table() {
  const g: GameState = createGame(IDS.map((id) => ({ id, name: id })), { startingPlayerId: 'a', hands: HANDS });
  const events: GameEvent[] = [];
  const did = (produced: GameEvent[]) => void events.push(...produced);
  const seat = (id: string) => g.players.find((p) => p.id === id)!;
  const cardOf = (id: string, role: Role) => seat(id).hand.find((c) => c.role === role)!.id;
  return {
    g,
    events,
    did,
    seat,
    tax: (by = 'a') => did(chooseAction(g, by, 'tax')),
    income: (...ids: string[]) => ids.forEach((id) => did(chooseAction(g, id, 'income'))),
    // 轮到 by 时政变 target，target 亮出 lose
    coup(by: string, target: string, lose: Role) {
      seat(by).coins = COUP_COST;
      did(chooseAction(g, by, 'coup', target));
      did(resolveLoss(g, target, cardOf(target, lose)));
    },
    passAll: (except: string) => IDS.filter((id) => id !== except && seat(id).alive).forEach((id) => did(passChallenge(g, id))),
    // a 征税，b 质疑，a 翻开 reveal
    challengedTax(reveal: Role) {
      did(chooseAction(g, 'a', 'tax'));
      did(challenge(g, 'b'));
      did(revealShowdownCard(g, 'a', cardOf('a', reveal)));
    },
    options: (me = 'a') => afterOwnClaim(publicState(g), events, me).options,
  };
}
type Table = ReturnType<typeof table>;

// 候选写成可读的标签：短语用它的键，「我有 X」写作 claim:X，沉默是 silence
const label = (r: Reaction | null) => (r === null ? 'silence' : r.kind === 'phrase' ? r.phrase : r.kind === 'verbalClaim' ? `claim:${r.role}` : r.action);
const labels = (options: Options) => options.map(([r]) => label(r)).sort();
const silenceShare = (options: Options) => options.find(([r]) => r === null)![1] / options.reduce((sum, [, w]) => sum + w, 0);

// 公开前情
const twoDukesShown = (t: Table) => {
  t.income('a');
  t.coup('b', 'c', 'duke');
  t.coup('c', 'b', 'duke');
};
const taxedBefore = (t: Table) => {
  t.tax();
  t.passAll('a');
  t.income('b', 'c');
};

describe('表 2：自己刚作出声称，问询窗口还开着', () => {
  it.each<[string, (t: Table) => void, string[]]>([
    ['首次声称这个角色', (t) => t.tax(), ['claim:duke', 'honest', 'silence']],
    ['延续声称过的角色（连续征税）', (t) => (taxedBefore(t), t.tax()), ['claim:duke', 'dare', 'honest', 'silence']],
    [
      // 证明为真后那张牌已换走、那个声称不再作数，再声称就是首次
      '自己证明过（加首次声称）',
      (t) => {
        t.challengedTax('duke');
        t.did(resolveLoss(t.g, 'b', t.seat('b').hand[0].id));
        t.income('b', 'c');
        t.tax();
      },
      ['claim:duke', 'dare', 'honest', 'silence'],
    ],
    [
      // 被抓到诈唬就丢了一点影响力：同时也只剩 1 点
      '自己被抓过（加首次声称、只剩 1 点影响力）',
      (t) => {
        t.challengedTax('captain');
        t.income('b', 'c');
        t.tax();
      },
      ['claim:duke', 'dare', 'honest', 'mercy', 'silence'],
    ],
    [
      '自己只剩 1 点影响力（加首次声称）',
      (t) => {
        t.income('a');
        t.coup('b', 'a', 'captain');
        t.income('c');
        t.tax();
      },
      ['claim:duke', 'dare', 'honest', 'mercy', 'silence'],
    ],
    ['该角色明牌已有 2 张（加首次声称）', (t) => (twoDukesShown(t), t.tax()), ['claim:duke', 'honest', 'silence']],
    [
      '声称是阻挡暗杀（加首次声称）',
      (t) => {
        t.income('a');
        t.seat('b').coins = 3;
        t.did(chooseAction(t.g, 'b', 'assassinate', 'a'));
        t.passAll('b');
        t.did(block(t.g, 'a', 'contessa'));
      },
      ['claim:contessa', 'dare', 'honest', 'silence', 'sure'],
    ],
    [
      '声称是阻挡偷窃（加首次声称）',
      (t) => {
        t.income('a');
        t.did(chooseAction(t.g, 'b', 'steal', 'a'));
        t.passAll('b');
        t.did(block(t.g, 'a', 'captain'));
      },
      ['claim:captain', 'honest', 'silence', 'sure'],
    ],
    [
      '声称是阻挡外援（加首次声称）',
      (t) => {
        t.income('a');
        t.did(chooseAction(t.g, 'b', 'foreignAid'));
        t.did(block(t.g, 'a', 'duke'));
      },
      ['claim:duke', 'honest', 'silence', 'sure'],
    ],
  ])('%s', (_, setup, expected) => {
    const t = table();
    setup(t);
    expect(t.g.phase).toBe('awaitingChallenge');
    const options = t.options();
    expect(labels(options)).toEqual(expected);
    for (const [, weight] of options) expect(weight).toBeGreaterThan(0);
  });

  it('首次声称多沉默：比延续声称开口的概率低；明牌已有 2 张时比只是首次声称更想开口', () => {
    const first = table();
    first.tax();
    const again = table();
    taxedBefore(again);
    again.tax();
    const shown = table();
    twoDukesShown(shown);
    shown.tax();
    expect(silenceShare(first.options())).toBeGreaterThan(silenceShare(again.options()));
    expect(silenceShare(shown.options())).toBeLessThan(silenceShare(first.options()));
  });

  it('不是自己的声称、或问询窗口没开着时没有候选', () => {
    const t = table();
    expect(t.options()).toEqual([]);
    t.tax();
    expect(t.options('b')).toEqual([]);
  });
});

describe('表 8：牌局结束后', () => {
  // a 获胜：a 政变 b，b 政变 c，c 政变 b（b 出局），a 政变 c（c 最后出局）。claimed 时 a 先征税一回合，最后声称的是公爵
  function finished(claimed = false) {
    const t = table();
    if (claimed) taxedBefore(t);
    t.coup('a', 'b', 'duke');
    t.coup('b', 'c', 'duke');
    t.coup('c', 'b', 'assassin');
    t.coup('a', 'c', 'contessa');
    expect(t.g.winnerId).toBe('a');
    const reveal = (...slots: number[]) => slots.forEach((slot) => t.did(revealPostGameCard(t.g, 'a', t.seat('a').hand[slot].id)));
    const setHand = (roles: Role[]) => t.seat('a').hand.forEach((c, i) => (c.role = roles[i]));
    const options = (me: string) => afterGame(publicState(t.g), t.events, me).options;
    return { ...t, reveal, setHand, options };
  }
  type Finished = ReturnType<typeof finished>;

  // a 的暗牌依次是公爵、队长
  it.each<[string, (f: Finished) => void, string, string[]]>([
    ['未获胜，最后一个被淘汰', () => {}, 'c', ['respect', 'silence']],
    ['未获胜，更早被淘汰', () => {}, 'b', ['respect', 'silence']],
    ['未获胜，获胜者揭晓的牌不是他最后声称的角色（加最后被淘汰）', (f) => f.reveal(1), 'c', ['doubt', 'respect', 'silence']],
    ['未获胜，获胜者揭晓的牌不是他最后声称的角色（加更早被淘汰）', (f) => f.reveal(1), 'b', ['doubt', 'respect', 'silence']],
    ['获胜，揭晓之前', () => {}, 'a', ['respect', 'silence']],
    ['获胜，揭晓的牌里有自己本局声称过的角色', (f) => f.reveal(0), 'a', ['honest', 'respect', 'silence']],
    ['获胜，两张都已揭晓，都不是自己最后声称的角色', (f) => (f.setHand(['captain', 'contessa']), f.reveal(0, 1)), 'a', ['dare', 'respect', 'silence']],
  ])('%s', (_, setup, me, expected) => {
    const f = finished(true);
    setup(f);
    const options = f.options(me);
    expect(labels(options)).toEqual(expected);
    for (const [reaction, weight] of options) {
      expect(weight).toBeGreaterThan(0);
      expect(reaction === null || reaction.kind === 'phrase').toBe(true); // 只发短语
    }
  });

  it('最后一个被淘汰的比更早被淘汰的更想说佩服；获胜者揭晓之前多沉默', () => {
    const f = finished(true);
    const respect = (options: Options) => options.find(([r]) => r !== null && label(r) === 'respect')![1];
    expect(respect(f.options('c'))).toBeGreaterThan(respect(f.options('b')));
    expect(silenceShare(f.options('c'))).toBeLessThan(silenceShare(f.options('b')));
    expect(silenceShare(f.options('a'))).toBeGreaterThan(0.5);
  });

  it('获胜者本局没作过声称：揭晓什么都不算诈唬，也不算老实', () => {
    const f = finished();
    f.reveal(0, 1);
    expect(labels(f.options('c'))).toEqual(['respect', 'silence']);
    expect(labels(f.options('a'))).toEqual(['silence']);
  });

  it('只看已公开的揭晓结果：揭晓之前改获胜者的暗牌，各人的候选都不变', () => {
    const honest = finished(true);
    const bluffing = finished(true);
    bluffing.setHand(['contessa', 'contessa']);
    for (const me of IDS) expect(bluffing.options(me)).toEqual(honest.options(me));
  });

  it('牌局没结束时没有候选', () => {
    const t = table();
    expect(afterGame(publicState(t.g), t.events, 'a').options).toEqual([]);
  });
});
