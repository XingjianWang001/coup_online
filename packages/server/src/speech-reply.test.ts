// packages/server/src/speech-reply.test.ts —— 电脑接话：回应短语和口头声称（#81，表 7）
import { describe, expect, it } from 'vitest';
import {
  COUP_COST,
  challenge,
  chooseAction,
  createGame,
  forfeit,
  passChallenge,
  publicState,
  resolveLoss,
  revealShowdownCard,
  type GameEvent,
  type GameState,
  type Role,
} from '@coup/engine';
import type { Phrase, Reaction } from '@coup/shared';
import { replyTo, type Heard, type Options } from './speech.ts';

// 一桌按真实流程推进的牌局：a 先手，did 记下引擎产生的事件（和 Room.gameEvents 一样），hear 记下桌上的表态（和 Room 的听到记录一样）
const IDS = ['a', 'b', 'c'];
const HANDS: Record<string, Role[]> = { a: ['duke', 'captain'], b: ['duke', 'assassin'], c: ['duke', 'contessa'] };
function table(hands = HANDS) {
  const g: GameState = createGame(IDS.map((id) => ({ id, name: id })), { startingPlayerId: 'a', hands });
  const events: GameEvent[] = [];
  const heard: Heard[] = [];
  let clock = 0;
  const did = (produced: GameEvent[]) => void events.push(...produced);
  const seat = (id: string) => g.players.find((p) => p.id === id)!;
  const cardOf = (id: string, role: Role) => seat(id).hand.find((c) => c.role === role)!.id;
  const t = {
    g,
    did,
    seat,
    income: (...ids: string[]) => ids.forEach((id) => did(chooseAction(g, id, 'income'))),
    tax: (by: string) => did(chooseAction(g, by, 'tax')),
    passAll: (except: string) => IDS.filter((id) => id !== except && seat(id).alive).forEach((id) => did(passChallenge(g, id))),
    // 没人质疑的征税
    taxed: (by: string) => (t.tax(by), t.passAll(by)),
    // 轮到 by 时政变 target，target 亮出 lose
    coup(by: string, target: string, lose: Role) {
      seat(by).coins = COUP_COST;
      did(chooseAction(g, by, 'coup', target));
      did(resolveLoss(g, target, cardOf(target, lose)));
    },
    // by 征税，challenger 质疑，by 翻开 reveal
    challengedTax(by: string, challenger: string, reveal: Role) {
      t.tax(by);
      did(challenge(g, challenger));
      did(revealShowdownCard(g, by, cardOf(by, reveal)));
    },
    hear(playerId: string, reaction: Reaction, depth = 0): Heard {
      const line = { playerId, reaction, at: (clock += 1_000), depth };
      heard.push(line);
      return line;
    },
    reply: (me: string, to: Heard) => replyTo(publicState(g), events, heard, to, me),
    options: (me: string, to: Heard) => t.reply(me, to).options,
  };
  return t;
}
type Table = ReturnType<typeof table>;

const phrase = (p: Phrase): Reaction => ({ kind: 'phrase', phrase: p });
const has = (role: Role, yes = true): Reaction => ({ kind: 'verbalClaim', has: yes, role });
// 候选写成可读的标签：短语用它的键，「我有 X」写作 claim:X，沉默是 silence
const label = (r: Reaction | null) => (r === null ? 'silence' : r.kind === 'phrase' ? r.phrase : r.kind === 'verbalClaim' ? `claim:${r.role}` : r.action);
const labels = (options: Options) => options.map(([r]) => label(r)).sort();
const speakShare = (options: Options) => 1 - options.find(([r]) => r === null)![1] / options.reduce((sum, [, w]) => sum + w, 0);

// b 偷窃 a 时诈称队长，被 a 抓到（亮出公爵）；之后轮到 c
const bCaught = (t: Table) => {
  t.income('a');
  t.did(chooseAction(t.g, 'b', 'steal', 'a'));
  t.did(challenge(t.g, 'a'));
  t.did(revealShowdownCard(t.g, 'b', t.seat('b').hand.find((c) => c.role === 'duke')!.id));
};

describe('表 7 接话：短语和口头声称', () => {
  it.each<[string, (t: Table) => [me: string, to: Heard], string[]]>([
    [
      '听到你确定？，自己是当前窗口的声称者，延续的角色',
      (t) => (t.taxed('a'), t.income('b', 'c'), t.tax('a'), ['a', t.hear('b', phrase('sure'))]),
      ['claim:duke', 'dare', 'honest', 'silence'],
    ],
    [
      // 证明过之后那张牌换走了，再声称是首次：两行合并
      '听到我信你个鬼，自己是当前窗口的声称者，证明过（加首次声称）',
      (t) => {
        t.challengedTax('a', 'b', 'duke');
        t.did(resolveLoss(t.g, 'b', t.seat('b').hand[0].id));
        t.income('b', 'c');
        t.tax('a');
        return ['a', t.hear('c', phrase('doubt'))];
      },
      ['claim:duke', 'dare', 'honest', 'silence'],
    ],
    ['听到你确定？，自己是当前窗口的声称者，首次声称', (t) => (t.tax('a'), ['a', t.hear('b', phrase('sure'))]), ['claim:duke', 'honest', 'silence']],
    [
      '听到我信你个鬼，自己的声称已经生效',
      (t) => (t.taxed('a'), ['a', t.hear('c', phrase('doubt'))]),
      ['claim:duke', 'honest', 'silence'],
    ],
    [
      '听到你确定？，自己刚发过口头声称',
      (t) => {
        t.taxed('a');
        t.taxed('b'); // 最近的声称已是 b 的
        t.hear('a', has('duke'));
        return ['a', t.hear('c', phrase('sure'))];
      },
      ['claim:duke', 'honest', 'silence'],
    ],
    [
      '听到来质疑我啊，说话者是当前声称者，自己有资格质疑且尚未回应，他被抓过',
      (t) => (bCaught(t), t.income('c', 'a'), t.tax('b'), ['a', t.hear('b', phrase('dare'))]),
      ['doubt', 'silence', 'sure'],
    ],
    [
      '听到我是老实人，同上，他证明过',
      (t) => {
        t.challengedTax('a', 'b', 'duke');
        t.did(resolveLoss(t.g, 'b', t.seat('b').hand[0].id));
        t.income('b', 'c');
        t.tax('a');
        return ['b', t.hear('a', phrase('honest'))];
      },
      ['silence', 'sure'],
    ],
    [
      '听到我有公爵，同上，自己也仍作数地声称着同一角色',
      (t) => (t.income('a', 'b'), t.taxed('c'), t.tax('a'), ['c', t.hear('a', has('duke'))]),
      ['claim:duke', 'doubt', 'silence'],
    ],
    [
      '窗口之外听到我有公爵，公爵 3 张都已是明牌',
      (t) => {
        t.income('a');
        t.coup('b', 'c', 'duke');
        t.coup('c', 'b', 'duke');
        t.income('a');
        t.coup('b', 'a', 'duke');
        return ['c', t.hear('b', has('duke'))];
      },
      ['doubt', 'silence'],
    ],
    ['窗口之外听到我有队长，说话者被抓过', (t) => (bCaught(t), ['c', t.hear('b', has('captain'))]), ['doubt', 'silence']],
    ['窗口之外听到我有公爵，自己也仍作数地声称着公爵', (t) => (t.taxed('a'), ['a', t.hear('b', has('duke'))]), ['claim:duke', 'doubt', 'silence']],
    ['窗口之外听到我有公爵，其他', (t) => ['b', t.hear('a', has('duke'))], ['doubt', 'silence', 'sure']],
    ['窗口之外听到我没有队长', (t) => (t.taxed('a'), ['a', t.hear('b', has('captain', false))]), ['doubt', 'silence', 'sure']],
    [
      '听到佩服，自己刚赢下一次对质，是被证明为真的声称者',
      (t) => (t.challengedTax('a', 'b', 'duke'), ['a', t.hear('b', phrase('respect'))]),
      ['honest', 'respect', 'silence'],
    ],
    [
      '听到佩服，自己刚赢下一次对质，是质疑者',
      (t) => (t.challengedTax('a', 'b', 'captain'), ['b', t.hear('a', phrase('respect'))]),
      ['doubt', 'respect', 'silence'],
    ],
    [
      '听到佩服，牌局结束后（被淘汰的也接）',
      (t) => (t.did(forfeit(t.g, 'b')), t.did(forfeit(t.g, 'c')), ['c', t.hear('b', phrase('respect'))]),
      ['respect', 'silence'],
    ],
  ])('%s', (_, setup, expected) => {
    const t = table();
    const [me, to] = setup(t);
    const options = t.options(me, to);
    expect(labels(options)).toEqual(expected);
    for (const [, weight] of options) expect(weight).toBeGreaterThan(0);
  });

  it('多沉默与开口概率高：首次声称比延续更少开口；3 张明牌时比其他更想开口', () => {
    const first = table();
    first.tax('a');
    const again = table();
    again.taxed('a');
    again.income('b', 'c');
    again.tax('a');
    expect(speakShare(first.options('a', first.hear('b', phrase('sure'))))).toBeLessThan(speakShare(again.options('a', again.hear('b', phrase('sure')))));
    const plain = table();
    const shown = table();
    shown.income('a');
    shown.coup('b', 'c', 'duke');
    shown.coup('c', 'b', 'duke');
    shown.income('a');
    shown.coup('b', 'a', 'duke');
    expect(speakShare(shown.options('c', shown.hear('b', has('duke'))))).toBeGreaterThan(speakShare(plain.options('b', plain.hear('a', has('duke')))));
  });

  it.each<[string, (t: Table) => [me: string, to: Heard]]>([
    ['表态不是冲着自己来的（没声称过就听到你确定？）', (t) => ['b', t.hear('c', phrase('sure'))]],
    ['当前声称者表态，自己没有任何前情', (t) => (t.tax('a'), ['b', t.hear('a', phrase('dare'))])],
    ['当前声称者表态，自己已回应', (t) => (bCaught(t), t.income('c', 'a'), t.tax('b'), t.did(passChallenge(t.g, 'a')), ['a', t.hear('b', phrase('dare'))])],
    ['窗口之外的来质疑我啊', (t) => ['b', t.hear('a', phrase('dare'))]],
    ['手下留情、好险不在这张工单的行里', (t) => (t.taxed('a'), ['a', t.hear('b', phrase('mercy'))])],
    ['行动预告不在这张工单的行里', (t) => ['b', t.hear('a', { kind: 'announcement', action: 'income' })]],
    ['佩服，但自己没赢下对质、牌局也没结束', (t) => (t.challengedTax('a', 'b', 'duke'), ['c', t.hear('b', phrase('respect'))])],
    ['自己说的话', (t) => (t.taxed('a'), ['a', t.hear('a', phrase('doubt'))])],
    ['说话者已被淘汰（牌局还没结束）', (t) => (t.did(forfeit(t.g, 'c')), ['b', t.hear('c', has('duke'))])],
    ['自己已被淘汰（牌局还没结束）', (t) => (t.did(forfeit(t.g, 'c')), ['c', t.hear('a', has('duke'))])],
    ['已是第三句（一句话、一句回应、一句再回应之后）', (t) => ['b', t.hear('a', has('duke'), 2)]],
  ])('表外的组合不接话：%s', (_, setup) => {
    const t = table();
    const [me, to] = setup(t);
    expect(t.options(me, to)).toEqual([]);
  });

  it('接话的接话开口概率减半，候选之间的比例不变；层数随回应加一', () => {
    const t = table();
    const first = t.reply('b', t.hear('a', has('duke'), 0));
    const second = t.reply('b', t.hear('a', has('duke'), 1));
    expect(speakShare(second.options)).toBeCloseTo(speakShare(first.options) / 2);
    const spoken = (o: Options) => o.filter(([r]) => r).map(([, w]) => w);
    expect(spoken(second.options)).toEqual(spoken(first.options));
    expect([first.depth, second.depth]).toEqual([1, 2]);
  });

  it('在听到后 0.6～2 秒说', () => {
    const t = table();
    expect(t.reply('b', t.hear('a', has('duke'))).delayMs).toEqual([600, 2_000]);
  });

  it('发送时语境过时就作废：自己已回应、自己之后已说过话、对方已被淘汰', () => {
    const t = table();
    bCaught(t);
    t.income('c', 'a');
    t.tax('b');
    const dare = t.hear('b', phrase('dare'));
    const { current } = t.reply('a', dare);
    expect(current!(publicState(t.g))).toBe(true);
    t.did(passChallenge(t.g, 'a'));
    expect(current!(publicState(t.g))).toBe(false);

    const u = table();
    const claim = u.hear('a', has('duke'));
    const later = u.reply('b', claim).current!;
    expect(later(publicState(u.g))).toBe(true);
    u.hear('b', phrase('honest'));
    expect(later(publicState(u.g))).toBe(false);

    const v = table();
    const fromC = v.reply('b', v.hear('c', has('duke'))).current!;
    v.did(forfeit(v.g, 'c'));
    expect(fromC(publicState(v.g))).toBe(false);
  });

  it('改暗牌不改变接话的选择和概率', () => {
    const flow = (t: Table) => (t.taxed('a'), t.income('b', 'c'), t.options('a', t.hear('b', phrase('doubt'))));
    const swapped: Record<string, Role[]> = { a: ['ambassador', 'contessa'], b: ['captain', 'captain'], c: ['assassin', 'ambassador'] };
    expect(flow(table(swapped))).toEqual(flow(table()));
  });
});
