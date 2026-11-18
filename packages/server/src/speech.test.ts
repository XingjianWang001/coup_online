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
  revealShowdownCard,
  type GameEvent,
  type GameState,
  type Role,
} from '@coup/engine';
import type { Reaction } from '@coup/shared';
import { afterOwnClaim, merge, probe, type Options, type Row } from './speech.ts';

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

describe('表 3：别人作出声称，自己有资格质疑且尚未回应（试探）', () => {
  const probes = (t: Table, me = 'b') => probe(publicState(t.g), t.events, me);
  // 抽签用到的部分：候选和延迟区间
  const draw = (t: Table, me = 'b') => (({ options, delayMs }) => ({ options, delayMs }))(probes(t, me));
  // b 先征税声称公爵（没人质疑），再轮到 a
  const bClaimsDuke = (t: Table) => {
    t.income('a');
    t.did(chooseAction(t.g, 'b', 'tax'));
    t.passAll('b');
    t.income('c');
  };

  it.each<[string, (t: Table) => void, string, string[]]>([
    ['基线：没有前情', (t) => t.tax(), 'b', ['silence', 'sure']],
    ['同一声称的延续（连续征税）与基线相同', (t) => (taxedBefore(t), t.tax()), 'b', ['silence', 'sure']],
    [
      '声称者被抓过',
      (t) => {
        t.challengedTax('captain');
        t.income('b', 'c');
        t.tax();
      },
      'c',
      ['doubt', 'silence', 'sure'],
    ],
    [
      // a 失去影响力时丢掉了队长，又声称队长去偷 c；b 旁观
      '声称矛盾',
      (t) => {
        t.income('a');
        t.coup('b', 'a', 'captain');
        t.income('c');
        t.did(chooseAction(t.g, 'a', 'steal', 'c'));
      },
      'b',
      ['doubt', 'silence', 'sure'],
    ],
    [
      '声称者证明过',
      (t) => {
        t.challengedTax('duke');
        t.did(resolveLoss(t.g, 'b', t.seat('b').hand[0].id));
        t.income('b', 'c');
        t.tax();
      },
      'c',
      ['silence', 'sure'],
    ],
    ['该角色明牌已有 2 张', (t) => (twoDukesShown(t), t.tax()), 'b', ['doubt', 'silence', 'sure']],
    [
      // c 手里两张公爵都亮了，b 亮了一张
      '该角色 3 张都已是明牌',
      (t) => {
        t.seat('c').hand[1].role = 'duke';
        t.income('a');
        t.coup('b', 'c', 'duke');
        t.coup('c', 'b', 'duke');
        t.income('a');
        t.coup('b', 'c', 'duke');
        t.tax();
      },
      'b',
      ['doubt', 'silence'],
    ],
    ['自己也仍作数地声称着同一角色', (t) => (bClaimsDuke(t), t.tax()), 'b', ['claim:duke', 'doubt', 'silence']],
    [
      '是阻挡，拦的是自己的行动',
      (t) => {
        t.income('a');
        t.did(chooseAction(t.g, 'b', 'foreignAid'));
        t.did(block(t.g, 'a', 'duke'));
      },
      'b',
      ['doubt', 'silence', 'sure'],
    ],
    [
      '是阻挡，拦的是别人的行动',
      (t) => {
        t.income('a', 'b');
        t.did(chooseAction(t.g, 'c', 'foreignAid'));
        t.did(block(t.g, 'a', 'duke'));
      },
      'b',
      ['silence', 'sure'],
    ],
  ])('%s', (_, setup, me, expected) => {
    const t = table();
    setup(t);
    expect(t.g.phase).toBe('awaitingChallenge');
    const options = probes(t, me);
    expect(labels(options.options)).toEqual(expected);
    for (const [, weight] of options.options) expect(weight).toBeGreaterThan(0);
  });

  it('权重：矛盾时我信你个鬼比你确定？重；基线、证明过、拦别人的阻挡多沉默；3 张都已是明牌时开口概率高', () => {
    const contradicted = table();
    contradicted.income('a');
    contradicted.coup('b', 'a', 'captain');
    contradicted.income('c');
    contradicted.did(chooseAction(contradicted.g, 'a', 'steal', 'c'));
    const weight = (options: Options, l: string) => options.find(([r]) => label(r) === l)![1];
    const { options } = probes(contradicted);
    expect(weight(options, 'doubt')).toBeGreaterThan(weight(options, 'sure'));

    const baseline = table();
    baseline.tax();
    const caught = table();
    caught.challengedTax('captain');
    caught.income('b', 'c');
    caught.tax();
    const allShown = table();
    allShown.seat('c').hand[1].role = 'duke';
    allShown.income('a');
    allShown.coup('b', 'c', 'duke');
    allShown.coup('c', 'b', 'duke');
    allShown.income('a');
    allShown.coup('b', 'c', 'duke');
    allShown.tax();
    expect(silenceShare(probes(baseline).options)).toBeGreaterThan(silenceShare(probes(caught, 'c').options));
    expect(silenceShare(probes(allShown).options)).toBeLessThan(silenceShare(probes(caught, 'c').options));
  });

  it('同一声称重复多次，试探的候选和概率都不变', () => {
    const once = table();
    once.tax();
    const thrice = table();
    taxedBefore(thrice);
    taxedBefore(thrice);
    thrice.tax();
    expect(draw(thrice)).toEqual(draw(once));
  });

  it('信息边界：只改暗牌，候选和概率都不变', () => {
    const t = table();
    t.tax();
    const before = draw(t);
    t.seat('b').hand.forEach((c) => (c.role = 'duke'));
    t.seat('a').hand.forEach((c) => (c.role = 'ambassador'));
    expect(draw(t)).toEqual(before);
  });

  it('自己是声称者、已放弃、已被淘汰、被冲着来（表 4），或问询窗口没开着时没有候选', () => {
    const t = table();
    expect(probes(t).options).toEqual([]);
    t.tax();
    expect(probes(t, 'a').options).toEqual([]);
    t.did(passChallenge(t.g, 'b'));
    expect(probes(t, 'b').options).toEqual([]);
    expect(probes(t, 'c').options).not.toEqual([]);

    const targeted = table();
    targeted.did(chooseAction(targeted.g, 'a', 'steal', 'c'));
    expect(probes(targeted, 'c').options).toEqual([]);
    expect(probes(targeted, 'b').options).not.toEqual([]);

    const out = table();
    out.seat('c').hand[1].role = 'duke';
    out.income('a');
    out.coup('b', 'c', 'duke');
    out.income('c', 'a');
    out.coup('b', 'c', 'duke');
    out.tax();
    expect(probes(out, 'c').options).toEqual([]);
  });

  it('发送时仍作数：自己还没回应、窗口还开着才说；自己放弃或有人质疑就作废', () => {
    const t = table();
    t.tax();
    const { current } = probes(t);
    expect(current!(publicState(t.g))).toBe(true);
    t.did(passChallenge(t.g, 'c'));
    expect(current!(publicState(t.g))).toBe(true); // 别人放弃不算
    t.did(passChallenge(t.g, 'b'));
    expect(current!(publicState(t.g))).toBe(false);

    const challenged = table();
    challenged.tax();
    const later = probes(challenged).current!;
    challenged.did(challenge(challenged.g, 'c'));
    expect(later(publicState(challenged.g))).toBe(false);
  });
});
