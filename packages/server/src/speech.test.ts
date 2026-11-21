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
import { afterOwnClaim, merge, offTurn, onOwnTurn, plausible, probe, type Decision, type Options, type Row } from './speech.ts';

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

describe('表 6：回合外的局势', () => {
  // 预告写作 行动:目标；只列开口的候选（沉默另看）
  const name = (r: Reaction | null) => (r?.kind === 'announcement' ? [r.action, r.targetId].filter(Boolean).join(':') : label(r));
  const spoken = (options: Options) => options.filter(([r]) => r).map(([r]) => name(r)).sort();
  // 先看一眼记下已成立的局势，change 之后再看：只有刚出现的局势给机会
  const after = (t: Table, change: () => void, me = 'a') => {
    const { held } = offTurn(publicState(t.g), t.events, me, new Set());
    change();
    return offTurn(publicState(t.g), t.events, me, held);
  };
  const coins = (t: Table, id: string, n: number) => () => void (t.seat(id).coins = n);
  const loseCard = (t: Table, id: string) => void t.seat(id).revealed.push(t.seat(id).hand.pop()!);
  // b 偷 a，没人质疑、a 不阻挡：轮到 c
  const bStoleFromA = (t: Table) => {
    t.income('a');
    t.did(chooseAction(t.g, 'b', 'steal', 'a'));
    t.passAll('b');
    t.did(passBlock(t.g, 'a'));
  };
  // c 被 b 政变两次出局，a、b 两人对峙；a 收入后轮到 b
  const duel = (t: Table) => {
    t.income('a');
    t.coup('b', 'c', 'duke');
    t.income('c', 'a');
    t.coup('b', 'c', 'contessa');
    t.income('a');
  };

  it.each<[string, (t: Table) => () => void, string[]]>([
    ['自己金币刚到 7，有最近打过自己的人：预告政变他', (t) => (bStoleFromA(t), (t.seat('c').coins = 6), coins(t, 'a', 7)), ['coup:b']], // 领先者是 c
    ['自己金币刚到 7，没有：预告政变领先者', (t) => (t.income('a'), (t.seat('c').coins = 5), coins(t, 'a', 7)), ['coup:c']],
    ['自己金币够 3、刚被人打：预告暗杀他', (t) => (t.income('a'), (t.seat('b').coins = 3), () => t.did(chooseAction(t.g, 'b', 'assassinate', 'a'))), ['assassinate:b']],
    ['有对手金币到 10，多人局：手下留情', (t) => (t.income('a'), coins(t, 'b', 10)), ['mercy']],
    ['两人对峙，对手够政变，自己只剩 1 点影响力：手下留情、佩服', (t) => (duel(t), loseCard(t, 'a'), coins(t, 'b', 7)), ['mercy', 'respect']],
    ['两人对峙，自己够政变，对手只剩 1 点影响力：预告政变', (t) => (duel(t), (t.seat('a').coins = 7), () => loseCard(t, 'b')), ['coup:b']],
  ])('%s', (_, setup, expected) => {
    const t = table();
    const { moment } = after(t, setup(t));
    expect(t.g.currentPlayerId).not.toBe('a');
    expect(spoken(moment.options)).toEqual(expected);
    for (const [, weight] of moment.options) expect(weight).toBeGreaterThan(0);
    expect(moment.options.at(-1)![0]).toBeNull(); // 沉默有概率
  });

  it('多沉默：只有「对手够政变、自己只剩 1 点」那一行开口概率不低', () => {
    const rich = table();
    rich.income('a');
    const plead = table();
    duel(plead);
    loseCard(plead, 'a');
    expect(silenceShare(after(plead, coins(plead, 'b', 7)).moment.options)).toBeLessThan(silenceShare(after(rich, coins(rich, 'b', 10)).moment.options));
  });

  it('同一局势持续时不重复触发；消失后再出现算新的', () => {
    const t = table();
    t.income('a');
    const first = after(t, coins(t, 'a', 7));
    expect(spoken(first.moment.options)).toEqual(['coup:b']);
    const again = offTurn(publicState(t.g), t.events, 'a', first.held);
    expect(spoken(again.moment.options)).toEqual([]);
    t.seat('a').coins = 5;
    const gone = offTurn(publicState(t.g), t.events, 'a', again.held);
    t.seat('a').coins = 8;
    expect(spoken(offTurn(publicState(t.g), t.events, 'a', gone.held).moment.options)).toEqual(['coup:b']);
  });

  it('轮到自己时不给机会，也不算用掉：轮完之后还成立就给', () => {
    const t = table();
    const mine = after(t, coins(t, 'a', 7));
    expect(spoken(mine.moment.options)).toEqual([]);
    t.income('a');
    expect(spoken(offTurn(publicState(t.g), t.events, 'a', mine.held).moment.options)).toEqual(['coup:b']);
  });

  it('目标：最近打过自己的人已出局时预告政变领先者；领先者先比影响力、再比金币', () => {
    const t = table();
    bStoleFromA(t);
    t.seat('b').alive = false;
    t.seat('c').coins = 1;
    expect(spoken(after(t, coins(t, 'a', 7)).moment.options)).toEqual(['coup:c']);

    const u = table();
    u.income('a');
    loseCard(u, 'c');
    u.seat('c').coins = 6;
    expect(spoken(after(u, coins(u, 'a', 7)).moment.options)).toEqual(['coup:b']);
  });

  it('金币够付预告的行动：不够 3 时刚被打也不预告暗杀；两人对峙时对手到 10 不算「多人局」那一行', () => {
    const t = table();
    t.income('a');
    t.seat('a').coins = 2;
    t.seat('b').coins = 3;
    expect(spoken(after(t, () => t.did(chooseAction(t.g, 'b', 'assassinate', 'a'))).moment.options)).toEqual([]);

    const d = table();
    duel(d);
    expect(spoken(after(d, coins(d, 'b', 10)).moment.options)).toEqual([]);
  });

  it('自己出局后没有候选', () => {
    const t = table();
    t.income('a');
    t.seat('a').alive = false;
    expect(spoken(after(t, coins(t, 'b', 10)).moment.options)).toEqual([]);
  });

  it('信息边界：公开经历相同时，暗牌不同不改变表态的候选和概率', () => {
    const run = (hands: Record<string, Role[]>) => {
      const g: GameState = createGame(IDS.map((id) => ({ id, name: id })), { startingPlayerId: 'a', hands });
      const { held } = offTurn(publicState(g), [], 'b', new Set());
      g.players[1].coins = 7;
      return offTurn(publicState(g), [], 'b', held);
    };
    expect(run({ a: ['captain', 'captain'], b: ['duke', 'duke'], c: ['contessa', 'contessa'] })).toEqual(run({ a: ['duke', 'assassin'], b: ['captain', 'ambassador'], c: ['duke', 'contessa'] }));
  });
});
