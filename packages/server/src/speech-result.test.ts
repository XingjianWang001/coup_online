// packages/server/src/speech-result.test.ts
// 表 5（#82）：对质、阻挡、失去影响力、淘汰的结果公开后的表态
import { describe, expect, it } from 'vitest';
import {
  block,
  challenge,
  chooseAction,
  createGame,
  forfeit,
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
import { afterResult, type Heard, type Options } from './speech.ts';

// 一桌按真实流程推进的牌局：a 先手，did 记下引擎产生的事件（和 Room.gameEvents 一样）和最近一次变化产生了几条（batch）。
// a 有公爵、刺客，b 有公爵、队长，c 有女伯爵、大使
const IDS = ['a', 'b', 'c'];
function table() {
  const hands: Record<string, Role[]> = { a: ['duke', 'assassin'], b: ['duke', 'captain'], c: ['contessa', 'ambassador'] };
  const g: GameState = createGame(IDS.map((id) => ({ id, name: id })), { startingPlayerId: 'a', hands });
  const events: GameEvent[] = [];
  const t = {
    g,
    events,
    batch: 0,
    heard: [] as Heard[],
    did(produced: GameEvent[]) {
      events.push(...produced);
      t.batch = produced.length;
    },
    seat: (id: string) => g.players.find((p) => p.id === id)!,
    act: (by: string, action: ActionType, target?: string) => t.did(chooseAction(g, by, action, target)),
    passAll: (...ids: string[]) => ids.forEach((id) => t.did(passChallenge(g, id))),
    challenge: (by: string) => t.did(challenge(g, by)),
    // 对质中 who 亮出 role（没有就亮第一张）
    reveal: (who: string, role: Role) => t.did(revealShowdownCard(g, who, (t.seat(who).hand.find((c) => c.role === role) ?? t.seat(who).hand[0]).id)),
    lose: (who: string) => t.did(resolveLoss(g, who, t.seat(who).hand[0].id)),
    says: (playerId: string, reaction: Reaction) => t.heard.push({ playerId, reaction, at: 0, depth: 0, seen: events.length }),
    options: (me: string) => afterResult(publicState(g), events, t.batch, t.heard, me).options,
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
const DARE: Reaction = { kind: 'phrase', phrase: 'dare' };

// 公开前情
// a 征税，b 质疑；a 亮出 role
const taxChallenged = (t: Table, role: Role) => {
  t.act('a', 'tax');
  t.challenge('b');
  t.reveal('a', role);
};
// who 只剩 1 点影响力（留下 keep，默认第一张），另一张已是明牌
const onLastCard = (t: Table, who: string, keep?: Role) => {
  const p = t.seat(who);
  const kept = p.hand.find((c) => c.role === keep) ?? p.hand[0];
  p.revealed.push(...p.hand.filter((c) => c !== kept));
  p.hand = [kept];
};
// a 暗杀 c，没人质疑行动，c 以女伯爵阻挡
const assassinBlocked = (t: Table) => {
  t.seat('a').coins = 3;
  t.act('a', 'assassinate', 'c');
  t.passAll('b', 'c');
  t.did(block(t.g, 'c', 'contessa'));
};

describe('表 5：结果公开后', () => {
  it.each<[string, (t: Table) => void, string, string[]]>([
    ['自己质疑失败，还在场：佩服', (t) => taxChallenged(t, 'duke'), 'b', ['respect', 'silence']],
    ['自己质疑失败，因此被淘汰：佩服', (t) => (onLastCard(t, 'b'), taxChallenged(t, 'duke')), 'b', ['respect', 'silence']],
    ['自己质疑成功：我信你个鬼', (t) => taxChallenged(t, 'assassin'), 'b', ['doubt', 'silence']],
    ['自己的声称被证明为真，之前说过来质疑我啊：我是老实人、来质疑我啊', (t) => (t.act('a', 'tax'), t.says('a', DARE), t.challenge('b'), t.reveal('a', 'duke')), 'a', ['dare', 'honest', 'silence']],
    ['自己的声称被证明为真，之前没说话：我是老实人', (t) => taxChallenged(t, 'duke'), 'a', ['honest', 'silence']],
    ['自己被抓到诈唬，之前说过来质疑我啊：只剩佩服', (t) => (t.act('a', 'tax'), t.says('a', DARE), t.challenge('b'), t.reveal('a', 'assassin')), 'a', ['respect', 'silence']],
    ['自己被抓到诈唬，之前没说话：佩服、手下留情', (t) => taxChallenged(t, 'assassin'), 'a', ['mercy', 'respect', 'silence']],
    ['针对自己的暗杀被化解，自己阻挡没人质疑：好险', (t) => (assassinBlocked(t), t.passAll('a', 'b')), 'c', ['close', 'silence']],
    ['针对自己的暗杀被化解，自己阻挡被质疑并证明为真：好险、我是老实人', (t) => (assassinBlocked(t), t.challenge('a'), t.reveal('c', 'contessa')), 'c', ['close', 'honest', 'silence']],
    [
      '针对自己的暗杀被化解，暗杀者被别人质疑抓到：好险、佩服',
      (t) => ((t.seat('a').hand[1].role = 'captain'), (t.seat('a').coins = 3), t.act('a', 'assassinate', 'c'), t.challenge('b'), t.reveal('a', 'assassin')),
      'c',
      ['close', 'respect', 'silence'],
    ],
    ['针对自己的偷窃被化解：好险', (t) => (t.act('a', 'steal', 'c'), t.passAll('b', 'c'), t.did(block(t.g, 'c', 'ambassador')), t.passAll('a', 'b')), 'c', ['close', 'silence']],
    ['自己的行动被阻挡，自己没质疑：我信你个鬼', (t) => (assassinBlocked(t), t.passAll('a', 'b')), 'a', ['doubt', 'silence']],
    [
      '自己失去影响力但还在场，金币够反击：反预告、手下留情',
      (t) => ((t.seat('a').coins = 7), (t.seat('c').coins = 3), t.act('a', 'coup', 'c'), t.lose('c')),
      'c',
      ['assassinate>a', 'mercy', 'silence'],
    ],
    ['自己失去影响力但还在场，金币不够：手下留情、佩服', (t) => ((t.seat('a').coins = 7), t.act('a', 'coup', 'c'), t.lose('c')), 'c', ['mercy', 'respect', 'silence']],
    ['自己被淘汰：佩服', (t) => (onLastCard(t, 'c'), (t.seat('a').coins = 7), t.act('a', 'coup', 'c'), t.lose('c')), 'c', ['respect', 'silence']],
    ['自己让别人被淘汰：佩服', (t) => (onLastCard(t, 'c'), (t.seat('a').coins = 7), t.act('a', 'coup', 'c'), t.lose('c')), 'a', ['respect', 'silence']],
    ['旁观：别人被抓到诈唬：我信你个鬼', (t) => taxChallenged(t, 'assassin'), 'c', ['doubt', 'silence']],
    ['旁观：别人的声称被证明为真：佩服', (t) => taxChallenged(t, 'duke'), 'c', ['respect', 'silence']],
  ])('%s', (_, setup, me, expected) => {
    const t = table();
    setup(t);
    const options = t.options(me);
    expect(labels(options)).toEqual(expected);
    for (const [, w] of options) expect(w).toBeGreaterThan(0);
  });

  it('多沉默的行开口概率低：质疑失败还在场比因此被淘汰更沉默', () => {
    const stays = table();
    taxChallenged(stays, 'duke');
    const out = table();
    onLastCard(out, 'b');
    taxChallenged(out, 'duke');
    expect(silenceShare(stays.options('b'))).toBeGreaterThan(silenceShare(out.options('b')));
  });

  it('一次结算只给一次机会：质疑失败者随后选丢哪张时不再给候选', () => {
    const t = table();
    taxChallenged(t, 'duke');
    expect(t.options('b')).not.toEqual([]);
    t.lose('b');
    for (const id of IDS) expect(t.options(id)).toEqual([]);
  });

  it('对质之后另起的结算照样给机会：暗杀被证明为真、质疑者丢牌后，目标被暗杀丢牌', () => {
    const t = table();
    t.seat('a').coins = 3;
    t.act('a', 'assassinate', 'c');
    t.challenge('b');
    t.reveal('a', 'assassin');
    t.lose('b');
    t.did(passBlock(t.g, 'c'));
    t.lose('c');
    expect(labels(t.options('c'))).toEqual(['mercy', 'respect', 'silence']);
  });

  it('危险没有真的化解时不说好险', () => {
    // c 以女伯爵阻挡暗杀是诈唬，被 b 质疑抓到：失去一张后暗杀照常生效
    const caught = table();
    caught.seat('c').hand[0].role = 'duke';
    assassinBlocked(caught);
    caught.challenge('b');
    caught.reveal('c', 'contessa');
    expect(labels(caught.options('c'))).not.toContain('close');
    caught.lose('c');
    expect(labels(caught.options('c'))).not.toContain('close');

    // 暗杀者被质疑并证明为真：暗杀继续
    const proven = table();
    proven.seat('a').coins = 3;
    proven.act('a', 'assassinate', 'c');
    proven.challenge('b');
    proven.reveal('a', 'assassin');
    expect(labels(proven.options('c'))).not.toContain('close');

    // 偷窃没人阻挡：被偷走了
    const stolen = table();
    stolen.act('a', 'steal', 'c');
    stolen.passAll('b', 'c');
    stolen.did(passBlock(stolen.g, 'c'));
    expect(labels(stolen.options('c'))).not.toContain('close');

    // 自己阻挡偷窃被抓到
    const blockCaught = table();
    blockCaught.act('a', 'steal', 'c');
    blockCaught.passAll('b', 'c');
    blockCaught.did(block(blockCaught.g, 'c', 'captain'));
    blockCaught.challenge('a');
    blockCaught.reveal('c', 'captain');
    expect(labels(blockCaught.options('c'))).not.toContain('close');
  });

  it('自己被抓到诈唬后从不出现我是老实人、来质疑我啊、我有 X', () => {
    for (const said of [[], [DARE], [{ kind: 'verbalClaim', has: true, role: 'duke' } as Reaction]]) {
      for (const lastCard of [false, true]) {
        const t = table();
        if (lastCard) onLastCard(t, 'a', 'assassin');
        t.act('a', 'tax');
        said.forEach((r) => t.says('a', r));
        t.challenge('b');
        t.reveal('a', 'assassin');
        const ls = labels(t.options('a'));
        expect(ls).toContain('respect');
        for (const banned of ['honest', 'dare', 'claim:duke']) expect(ls).not.toContain(banned);
      }
    }
  });

  it('之前说过的只算自己说的：别人说来质疑我啊不算', () => {
    const other = table();
    other.act('a', 'tax');
    other.says('b', DARE);
    other.challenge('b');
    other.reveal('a', 'assassin');
    expect(labels(other.options('a'))).toEqual(['mercy', 'respect', 'silence']);
  });

  it('被淘汰的电脑只发短语：金币够反击也不反预告', () => {
    const t = table();
    onLastCard(t, 'c');
    t.seat('a').coins = 7;
    t.seat('c').coins = 7;
    t.act('a', 'coup', 'c');
    t.lose('c');
    expect(t.options('c').every(([r]) => r === null || r.kind === 'phrase')).toBe(true);
  });

  it('信息边界：只改暗牌，候选和概率都不变', () => {
    const t = table();
    taxChallenged(t, 'duke');
    const look = () => IDS.map((id) => afterResult(publicState(t.g), t.events, t.batch, t.heard, id)).map(({ options, delayMs }) => ({ options, delayMs }));
    const before = look();
    t.seat('b').hand.forEach((c) => (c.role = 'ambassador'));
    t.seat('c').hand.forEach((c) => (c.role = 'assassin'));
    t.seat('a').hand.forEach((c) => (c.role = 'captain'));
    expect(look()).toEqual(before);
  });

  it('弃权（离开、断线）不是结果：弃权者和别人都没有候选', () => {
    const t = table();
    t.did(forfeit(t.g, 'c'));
    for (const id of IDS) expect(t.options(id)).toEqual([]);
  });

  it('没有结果时没有候选：声称、放弃、收入', () => {
    const t = table();
    t.act('a', 'tax');
    for (const id of IDS) expect(t.options(id)).toEqual([]);
    t.passAll('b');
    for (const id of IDS) expect(t.options(id)).toEqual([]);
  });
});
