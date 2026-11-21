// packages/server/src/speech-targeted.test.ts
// 表 4（#79）：成为偷窃、暗杀、政变的目标时的表态与反预告
import { describe, expect, it } from 'vitest';
import {
  block,
  challenge,
  chooseAction,
  createGame,
  passBlock,
  passChallenge,
  publicState,
  resolveLoss,
  revealShowdownCard,
  type ActionType,
  type GameEvent,
  type GameState,
  type Role,
} from '@coup/engine';
import type { Reaction } from '@coup/shared';
import { counterAnnouncement, targeted, type Options } from './speech.ts';

// 一桌按真实流程推进的牌局：a 先手，did 记下引擎产生的事件，和 Room.gameEvents 一样
const IDS = ['a', 'b', 'c'];
function table() {
  const hands: Record<string, Role[]> = { a: ['duke', 'captain'], b: ['duke', 'assassin'], c: ['duke', 'contessa'] };
  const g: GameState = createGame(IDS.map((id) => ({ id, name: id })), { startingPlayerId: 'a', hands });
  const events: GameEvent[] = [];
  const did = (produced: GameEvent[]) => void events.push(...produced);
  const seat = (id: string) => g.players.find((p) => p.id === id)!;
  const others = (id: string) => IDS.filter((o) => o !== id && seat(o).alive);
  const t = {
    g,
    events,
    did,
    seat,
    act: (by: string, action: ActionType, target?: string) => did(chooseAction(g, by, action, target)),
    income: (...ids: string[]) => ids.forEach((id) => t.act(id, 'income')),
    // 没人质疑、没人阻挡，照常生效
    unopposed(by: string, action: ActionType, target?: string) {
      t.act(by, action, target);
      others(by).forEach((id) => did(passChallenge(g, id)));
      if (g.phase === 'awaitingBlock') did(passBlock(g, target!));
    },
    // 轮到 by 时政变 target，target 亮出 lose
    coup(by: string, target: string, lose: Role) {
      seat(by).coins = 7;
      t.act(by, 'coup', target);
      did(resolveLoss(g, target, seat(target).hand.find((c) => c.role === lose)!.id));
    },
    options: (me = 'c') => targeted(publicState(g), events, me).options,
  };
  return t;
}
type Table = ReturnType<typeof table>;

// 候选写成可读的标签：短语用它的键，「我有 X」写作 claim:X，预告写作「行动>目标」，沉默是 silence
const label = (r: Reaction | null) =>
  r === null ? 'silence' : r.kind === 'phrase' ? r.phrase : r.kind === 'verbalClaim' ? `claim:${r.role}` : `${r.action}>${r.targetId}`;
const labels = (options: Options) => options.map(([r]) => label(r)).sort();
const weight = (options: Options, l: string) => options.find(([r]) => label(r) === l)?.[1];
const silenceShare = (options: Options) => weight(options, 'silence')! / options.reduce((sum, [, w]) => sum + w, 0);

// 公开前情
// c 偷 b 声称了队长，之后轮到 a
const cClaimsCaptain = (t: Table) => {
  t.income('a', 'b');
  t.unopposed('c', 'steal', 'b');
};
// b 暗杀 c，c 以女伯爵阻挡没人质疑；之后 c 收入，轮到 a（金币 3）
const cClaimsContessa = (t: Table) => {
  t.income('a');
  t.seat('b').coins = 3;
  t.act('b', 'assassinate', 'c');
  ['a', 'c'].forEach((id) => t.did(passChallenge(t.g, id)));
  t.did(block(t.g, 'c', 'contessa'));
  ['a', 'b'].forEach((id) => t.did(passChallenge(t.g, id)));
  t.income('c');
};
// b 政变 c，c 只剩 1 点影响力；之后 c 收入，轮到 a（金币 3）
const cOnLastCard = (t: Table) => {
  t.income('a');
  t.coup('b', 'c', 'duke');
  t.income('c');
};
// a 征税时被 b 质疑、亮出队长被抓；之后 b、c 收入，轮到 a
const aCaught = (t: Table) => {
  t.act('a', 'tax');
  t.did(challenge(t.g, 'b'));
  t.did(revealShowdownCard(t.g, 'a', t.seat('a').hand.find((c) => c.role === 'captain')!.id));
  t.income('b', 'c');
};
// a 偷过 c，又过了 turns 个他自己的回合（收入）
const aStoleFromC = (t: Table, turns = 1) => {
  t.unopposed('a', 'steal', 'c');
  for (let i = 1; i < turns; i += 1) t.income('b', 'c', 'a');
  t.income('b', 'c');
};

describe('表 4：成为偷窃、暗杀、政变的目标', () => {
  it.each<[string, (t: Table) => void, string[]]>([
    ['偷窃，没声称过：手下留情、你确定？、反预告（偷回去）', (t) => t.act('a', 'steal', 'c'), ['mercy', 'silence', 'steal>a', 'sure']],
    ['偷窃，仍作数地声称过队长：我有队长、你确定？', (t) => (cClaimsCaptain(t), t.act('a', 'steal', 'c')), ['claim:captain', 'silence', 'sure']],
    [
      '暗杀，仍作数地声称过女伯爵：我有女伯爵、你确定？',
      (t) => (cClaimsContessa(t), t.act('a', 'assassinate', 'c')),
      ['claim:contessa', 'silence', 'sure'],
    ],
    [
      '暗杀，没声称过、有 2 点影响力：你确定？、手下留情、反预告（暗杀回去）',
      (t) => {
        t.seat('a').coins = 3;
        t.seat('c').coins = 3;
        t.act('a', 'assassinate', 'c');
      },
      ['assassinate>a', 'mercy', 'silence', 'sure'],
    ],
    ['暗杀，没声称过、只剩 1 点影响力：手下留情、你确定？、我信你个鬼', (t) => (cOnLastCard(t), t.act('a', 'assassinate', 'c')), ['doubt', 'mercy', 'silence', 'sure']],
    [
      '政变，有 2 点影响力：反预告（政变回去）、佩服',
      (t) => {
        t.seat('c').coins = 7;
        t.seat('a').coins = 7;
        t.act('a', 'coup', 'c');
      },
      ['coup>a', 'respect', 'silence'],
    ],
    ['政变，只剩 1 点影响力：佩服', (t) => (cOnLastCard(t), (t.seat('a').coins = 7), t.act('a', 'coup', 'c')), ['respect', 'silence']],
    ['第二次被同一人针对：反预告、我信你个鬼、手下留情', (t) => (aStoleFromC(t), t.act('a', 'steal', 'c')), ['doubt', 'mercy', 'silence', 'steal>a', 'sure']],
    ['偷窃，行动者被抓过：我信你个鬼', (t) => (aCaught(t), t.act('a', 'steal', 'c')), ['assassinate>a', 'doubt', 'mercy', 'silence', 'sure']],
    ['暗杀，行动者被抓过：我信你个鬼', (t) => (aCaught(t), (t.seat('a').coins = 3), t.act('a', 'assassinate', 'c')), ['assassinate>a', 'doubt', 'mercy', 'silence', 'sure']],
  ])('%s', (_, setup, expected) => {
    const t = table();
    setup(t);
    const options = t.options();
    expect(labels(options)).toEqual(expected);
    for (const [, w] of options) expect(w).toBeGreaterThan(0);
  });

  it('多行同时成立时权重相乘：行动者被抓过时我信你个鬼权重高；只剩 1 点影响力时手下留情权重高；政变只剩 1 点影响力多沉默', () => {
    const caught = table();
    aCaught(caught);
    caught.act('a', 'steal', 'c');
    expect(weight(caught.options(), 'doubt')!).toBeGreaterThan(weight(caught.options(), 'mercy')!);

    const twice = table();
    aCaught(twice);
    twice.unopposed('a', 'steal', 'c');
    twice.income('b', 'c');
    twice.act('a', 'steal', 'c');
    // 两行都给了我信你个鬼：权重是两行的积
    expect(weight(twice.options(), 'doubt')!).toBeGreaterThan(weight(caught.options(), 'doubt')!);

    const last = table();
    cOnLastCard(last);
    last.act('a', 'assassinate', 'c');
    expect(weight(last.options(), 'mercy')!).toBeGreaterThan(weight(last.options(), 'sure')!);

    const coupTwo = table();
    coupTwo.seat('c').coins = 7;
    coupTwo.seat('a').coins = 7;
    coupTwo.act('a', 'coup', 'c');
    const coupOne = table();
    cOnLastCard(coupOne);
    coupOne.seat('a').coins = 7;
    coupOne.act('a', 'coup', 'c');
    expect(silenceShare(coupOne.options())).toBeGreaterThan(silenceShare(coupTwo.options()));
  });

  it('被政变时从不出现手下留情，第二次被同一人政变也不出现', () => {
    const t = table();
    t.coup('a', 'c', 'duke');
    t.income('b', 'c');
    t.seat('a').coins = 7;
    t.act('a', 'coup', 'c');
    // c 金币 3：反预告是暗杀回去
    expect(labels(t.options())).toEqual(['assassinate>a', 'doubt', 'respect', 'silence']);
  });

  it('反预告的目标是刚才的行动者，行动是自己付得起的：政变、暗杀、偷窃里选头一个；都付不起时不出现', () => {
    const state = (c: number, a: number) => {
      const t = table();
      t.seat('c').coins = c;
      t.seat('a').coins = a;
      return publicState(t.g);
    };
    expect(counterAnnouncement(state(7, 2), 'c', 'a')).toEqual([{ kind: 'announcement', action: 'coup', targetId: 'a' }]);
    expect(counterAnnouncement(state(3, 2), 'c', 'a')).toEqual([{ kind: 'announcement', action: 'assassinate', targetId: 'a' }]);
    expect(counterAnnouncement(state(2, 2), 'c', 'a')).toEqual([{ kind: 'announcement', action: 'steal', targetId: 'a' }]);
    expect(counterAnnouncement(state(2, 0), 'c', 'a')).toEqual([]);
    expect(counterAnnouncement(state(10, 0), 'c', 'a')).toEqual([{ kind: 'announcement', action: 'coup', targetId: 'a' }]);

    // 暗杀付掉 3 枚后 a 没有金币可偷，c 也付不起暗杀：反预告不算候选
    const broke = table();
    broke.seat('a').coins = 3;
    broke.act('a', 'assassinate', 'c');
    expect(labels(broke.options())).toEqual(['mercy', 'silence', 'sure']);
  });

  it('我有 X 只出现自己仍作数的声称里、能挡这次行动的角色', () => {
    // c 声称过公爵：挡不了偷窃
    const duke = table();
    duke.income('a', 'b');
    duke.unopposed('c', 'tax');
    duke.act('a', 'steal', 'c');
    expect(labels(duke.options()).filter((l) => l.startsWith('claim'))).toEqual([]);

    // c 声称过队长，但被质疑证明为真后换了牌：不再作数
    const proven = table();
    proven.seat('c').hand[1].role = 'captain';
    proven.income('a', 'b');
    proven.act('c', 'steal', 'b');
    proven.did(challenge(proven.g, 'b'));
    proven.did(revealShowdownCard(proven.g, 'c', proven.seat('c').hand[1].id));
    proven.did(resolveLoss(proven.g, 'b', proven.seat('b').hand[0].id));
    if (proven.g.phase === 'awaitingBlock') proven.did(passBlock(proven.g, 'b'));
    proven.act('a', 'steal', 'c');
    expect(labels(proven.options()).filter((l) => l.startsWith('claim'))).toEqual([]);

    // 声称过女伯爵，被偷时不说我有女伯爵
    const contessa = table();
    cClaimsContessa(contessa);
    contessa.act('a', 'steal', 'c');
    expect(labels(contessa.options()).filter((l) => l.startsWith('claim'))).toEqual([]);
  });

  it('第二次被同一人针对的加权随回合淡化：他上一回合刚针对过最重，再早一回合减弱，更早的不算', () => {
    const counter = (turns: number | null) => {
      const t = table();
      if (turns !== null) aStoleFromC(t, turns);
      else t.income('a', 'b', 'c');
      t.seat('c').coins = 2; // 反预告都是偷回去
      t.act('a', 'steal', 'c');
      return weight(t.options(), 'steal>a')!;
    };
    expect(counter(1)).toBeGreaterThan(counter(2));
    expect(counter(2)).toBeGreaterThan(counter(3));
    expect(counter(3)).toBe(counter(null));

    // 别人针对过自己不算同一人
    const other = table();
    other.income('a');
    other.unopposed('b', 'steal', 'c');
    other.income('c');
    other.act('a', 'steal', 'c');
    expect(labels(other.options())).toEqual(['mercy', 'silence', 'steal>a', 'sure']);
  });

  it('信息边界：只改暗牌，候选和概率都不变', () => {
    const t = table();
    aStoleFromC(t);
    t.act('a', 'steal', 'c');
    const before = targeted(publicState(t.g), t.events, 'c');
    t.seat('c').hand.forEach((c) => (c.role = 'captain'));
    t.seat('a').hand.forEach((c) => (c.role = 'ambassador'));
    const after = targeted(publicState(t.g), t.events, 'c');
    expect(after.options).toEqual(before.options);
    expect(after.delayMs).toEqual(before.delayMs);
  });

  it('不是目标、已回应、窗口已过，或行动不是偷窃、暗杀、政变时没有候选', () => {
    const t = table();
    expect(t.options()).toEqual([]);
    t.act('a', 'steal', 'c');
    expect(t.options('b')).toEqual([]);
    t.did(passChallenge(t.g, 'c'));
    expect(t.options()).toEqual([]);
    t.did(passChallenge(t.g, 'b'));
    expect(t.g.phase).toBe('awaitingBlock');
    expect(t.options()).toEqual([]);

    const tax = table();
    tax.act('a', 'tax');
    expect(tax.options()).toEqual([]);
  });

  it('偷窃、暗杀的表态发送时仍作数：自己还没回应、窗口还开着才说；自己放弃或有人质疑就作废', () => {
    const t = table();
    t.act('a', 'steal', 'c');
    const { current, delayMs } = targeted(publicState(t.g), t.events, 'c');
    expect(delayMs[1]).toBeLessThan(1_500); // 窗口前段：电脑最快 1.5 秒回应
    expect(current!(publicState(t.g))).toBe(true);
    t.did(passChallenge(t.g, 'b'));
    expect(current!(publicState(t.g))).toBe(true); // 别人放弃不算
    t.did(passChallenge(t.g, 'c'));
    expect(current!(publicState(t.g))).toBe(false);

    const challenged = table();
    challenged.act('a', 'steal', 'c');
    const later = targeted(publicState(challenged.g), challenged.events, 'c').current!;
    challenged.did(challenge(challenged.g, 'b'));
    expect(later(publicState(challenged.g))).toBe(false);
  });
});
