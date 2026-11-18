// packages/server/src/speech.test.ts
import { describe, expect, it } from 'vitest';
import {
  COUP_COST,
  block,
  challenge,
  chooseAction,
  createGame,
  passBlock,
  passChallenge,
  publicState,
  resolveLoss,
  revealShowdownCard,
  type GameEvent,
  type GameState,
  type Role,
} from '@coup/engine';
import type { Reaction } from '@coup/shared';
import { afterOwnClaim, merge, onOwnTurn, plausible, type Decision, type Options, type Row } from './speech.ts';

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

describe('表 1：轮到自己（行动预告，读已作出的决定）', () => {
  // 预告写作 行动:目标，其余同上
  const name = (r: Reaction | null) => (r?.kind === 'announcement' ? [r.action, r.targetId].filter(Boolean).join(':') : label(r));
  const said = (options: Options) => options.map(([r]) => name(r)).sort();
  const weightOf = (options: Options, line: string) => options.find(([r]) => name(r) === line)![1];
  const turn = (t: Table, decision: Decision, me = 'a') => onOwnTurn(publicState(t.g), t.events, me, decision).options;
  const coins = (t: Table, n: number, id = 'a') => void (t.seat(id).coins = n);
  // b 偷 a，没人质疑、a 不阻挡；c 收入，又轮到 a
  const bStoleFromA = (t: Table) => {
    t.income('a');
    t.did(chooseAction(t.g, 'b', 'steal', 'a'));
    t.passAll('b');
    t.did(passBlock(t.g, 'a'));
    t.income('c');
  };
  // c 被政变两次出局，又轮到 a：只剩 a、b 两人对峙
  const duel = (t: Table) => {
    t.income('a');
    t.coup('b', 'c', 'duke');
    t.income('c', 'a');
    t.coup('b', 'c', 'contessa');
  };
  // b 征税没人质疑，c 收入，又轮到 a：b 仍作数地声称着公爵
  const bClaimsDuke = (t: Table) => {
    t.income('a');
    t.tax('b');
    t.passAll('b');
    t.income('c');
  };

  it.each<[string, (t: Table) => void, Decision, string[]]>([
    ['政变，金币不到 10：预告政变、虚晃到另一目标', (t) => coins(t, 7), { action: 'coup', targetId: 'b' }, ['coup:b', 'coup:c', 'silence']],
    ['政变，金币已到 10', (t) => coins(t, 10), { action: 'coup', targetId: 'b' }, ['coup:b', 'coup:c', 'silence']],
    ['偷窃，目标是最近打过自己的人', (t) => (bStoleFromA(t), coins(t, 3)), { action: 'steal', targetId: 'b' }, ['assassinate:b', 'silence', 'steal:b', 'steal:c']],
    ['偷窃，其他：预告、虚晃到另一目标、虚晃成另一种针对性行动', (t) => coins(t, 3), { action: 'steal', targetId: 'b' }, ['assassinate:b', 'silence', 'steal:b', 'steal:c']],
    ['暗杀，其他', (t) => coins(t, 3), { action: 'assassinate', targetId: 'b' }, ['assassinate:b', 'assassinate:c', 'silence', 'steal:b']],
    ['两人对峙：排除虚晃目标', (t) => (duel(t), coins(t, 7), coins(t, 2, 'b')), { action: 'assassinate', targetId: 'b' }, ['assassinate:b', 'coup:b', 'silence', 'steal:b']],
    ['征税，公爵已在自己仍作数的声称里', taxedBefore, { action: 'tax' }, ['silence', 'tax']],
    ['征税，首次声称公爵', () => {}, { action: 'tax' }, ['silence', 'tax']],
    ['外援，有人仍作数地声称公爵', bClaimsDuke, { action: 'foreignAid' }, ['foreignAid', 'silence']],
    ['外援，没人声称公爵', () => {}, { action: 'foreignAid' }, ['foreignAid', 'silence']],
    ['交换', () => {}, { action: 'exchange' }, ['exchange', 'silence']],
    ['收入', () => {}, { action: 'income' }, ['income', 'silence']],
  ])('%s', (_, setup, decision, expected) => {
    const t = table();
    setup(t);
    expect(t.g.phase).toBe('choosingAction');
    expect(t.g.currentPlayerId).toBe('a');
    const options = turn(t, decision);
    expect(said(options)).toEqual(expected);
    for (const [, weight] of options) expect(weight).toBeGreaterThan(0);
  });

  it('开口多少：被迫政变比能选时更想开口；首次声称公爵、没人声称公爵时的外援、交换和收入多沉默；虚晃是小概率', () => {
    const share = (setup: (t: Table) => void, decision: Decision) => {
      const t = table();
      setup(t);
      return silenceShare(turn(t, decision));
    };
    expect(share((t) => coins(t, 10), { action: 'coup', targetId: 'b' })).toBeLessThan(share((t) => coins(t, 7), { action: 'coup', targetId: 'b' }));
    const standingTax = share(taxedBefore, { action: 'tax' });
    expect(share(() => {}, { action: 'tax' })).toBeGreaterThan(standingTax);
    expect(share(() => {}, { action: 'foreignAid' })).toBeGreaterThan(share(bClaimsDuke, { action: 'foreignAid' }));
    expect(share(() => {}, { action: 'income' })).toBeGreaterThan(standingTax);
    expect(share(() => {}, { action: 'exchange' })).toBeGreaterThan(standingTax);

    const t = table();
    coins(t, 3);
    const options = turn(t, { action: 'steal', targetId: 'b' });
    for (const feint of ['steal:c', 'assassinate:b']) expect(weightOf(options, feint)).toBeLessThan(weightOf(options, 'steal:b') / 2);
  });

  it('目标是最近打过自己的人：真预告权重更高，虚晃权重更低', () => {
    const steal = (setup: (t: Table) => void) => {
      const t = table();
      setup(t);
      coins(t, 3);
      return turn(t, { action: 'steal', targetId: 'b' });
    };
    const [attacker, other] = [steal(bStoleFromA), steal(() => {})];
    for (const feint of ['steal:c', 'assassinate:b']) expect(weightOf(attacker, feint)).toBeLessThan(weightOf(other, feint));
    expect(weightOf(attacker, 'steal:b')).toBeGreaterThan(weightOf(other, 'steal:b'));
  });

  it('任何预告都说得通：目标在场且不是自己、金币够付；付不起的、没有金币可偷的不作虚晃', () => {
    const t = table();
    coins(t, 2);
    coins(t, 0, 'c');
    expect(said(turn(t, { action: 'steal', targetId: 'b' }))).toEqual(['silence', 'steal:b']);

    const g = publicState(t.g);
    expect(plausible(g, 'a', 'steal', 'b')).toBe(true);
    expect(plausible(g, 'a', 'steal', 'c')).toBe(false); // 没有金币可偷
    expect(plausible(g, 'a', 'steal', 'a')).toBe(false);
    expect(plausible(g, 'a', 'steal')).toBe(false);
    expect(plausible(g, 'a', 'income', 'b')).toBe(false);
    expect(plausible(g, 'a', 'assassinate', 'b')).toBe(false); // 付不起
    expect(plausible(g, 'a', 'tax')).toBe(true);
    coins(t, 10);
    expect(plausible(publicState(t.g), 'a', 'coup', 'b')).toBe(true);
    expect(plausible(publicState(t.g), 'a', 'tax')).toBe(false); // 金币到 10 只能政变
    t.seat('b').alive = false;
    expect(plausible(publicState(t.g), 'a', 'coup', 'b')).toBe(false);
  });

  it('不是自己的回合、或不在选行动时没有候选', () => {
    const t = table();
    expect(turn(t, { action: 'income' }, 'b')).toEqual([]);
    t.tax();
    expect(turn(t, { action: 'income' })).toEqual([]);
  });

  it('真预告之后停顿约 0.8～1.5 秒再出手', () => {
    const t = table();
    expect(onOwnTurn(publicState(t.g), t.events, 'a', { action: 'tax' }).delayMs).toEqual([800, 1_500]);
  });

  it('信息边界：公开经历和决定相同时，暗牌不同不改变预告', () => {
    const run = (hands: Record<string, Role[]>) => {
      const g: GameState = createGame(IDS.map((id) => ({ id, name: id })), { startingPlayerId: 'a', hands });
      g.players[0].coins = 3;
      return onOwnTurn(publicState(g), [], 'a', { action: 'steal', targetId: 'b' });
    };
    expect(run({ a: ['captain', 'captain'], b: ['duke', 'duke'], c: ['contessa', 'contessa'] })).toEqual(run({ a: ['duke', 'assassin'], b: ['captain', 'ambassador'], c: ['duke', 'contessa'] }));
  });
});
