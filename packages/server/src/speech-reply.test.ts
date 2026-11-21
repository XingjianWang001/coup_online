// packages/server/src/speech-reply.test.ts —— 电脑接话：回应短语和口头声称（#81，表 7）
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COUP_COST,
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
import type { Phrase, Reaction } from '@coup/shared';
import { replyTo, type Heard, type Options } from './speech.ts';
import { Room, type RoomOptions } from './room.ts';
import type { GameRepository } from './repository.ts';

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
      const line = { playerId, reaction, at: (clock += 1_000), depth, seen: events.length };
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

// 行动预告、手下留情、好险的接话（#83）：预告写成 动作>目标
const announce = (action: ActionType, targetId?: string): Reaction => (targetId ? { kind: 'announcement', action, targetId } : { kind: 'announcement', action });
const said = (r: Reaction | null) => (r?.kind === 'announcement' ? `${r.action}${r.targetId ? `>${r.targetId}` : ''}` : label(r));
const saids = (options: Options) => options.map(([r]) => said(r)).sort();

describe('表 7 接话：行动预告、手下留情、好险', () => {
  it.each<[string, (t: Table) => [me: string, to: Heard], string[]]>([
    ['预告政变自己，对方金币够 7（反预告偷窃他）', (t) => ((t.seat('b').coins = 7), ['a', t.hear('b', announce('coup', 'a'))]), ['mercy', 'respect', 'silence', 'steal>b']],
    ['预告政变自己，对方金币不够', (t) => ['a', t.hear('b', announce('coup', 'a'))], ['doubt', 'silence', 'sure']],
    [
      '预告暗杀自己，对方金币够 3，自己仍作数地声称过女伯爵',
      (t) => {
        t.seat('a').coins = 3;
        t.did(chooseAction(t.g, 'a', 'assassinate', 'c'));
        t.passAll('a');
        t.did(block(t.g, 'c', 'contessa'));
        t.passAll('c');
        t.seat('b').coins = 3;
        return ['c', t.hear('b', announce('assassinate', 'c'))];
      },
      ['claim:contessa', 'silence', 'sure'],
    ],
    ['预告暗杀自己，对方金币够 3，自己没声称过（反预告暗杀他）', (t) => ((t.seat('b').coins = 3), (t.seat('a').coins = 3), ['a', t.hear('b', announce('assassinate', 'a'))]), ['assassinate>b', 'mercy', 'silence', 'sure']],
    ['预告暗杀自己，对方金币不够', (t) => ['a', t.hear('b', announce('assassinate', 'a'))], ['doubt', 'silence', 'sure']],
    [
      '预告偷窃自己，自己仍作数地声称过队长',
      (t) => (t.did(chooseAction(t.g, 'a', 'steal', 'b')), t.passAll('a'), t.did(passBlock(t.g, 'b')), ['a', t.hear('c', announce('steal', 'a'))]),
      ['claim:captain', 'silence', 'sure'],
    ],
    ['预告偷窃自己，没声称过（反预告偷窃他）', (t) => ['a', t.hear('b', announce('steal', 'a'))], ['mercy', 'silence', 'steal>b']],
    ['预告外援，自己仍作数地声称过公爵', (t) => (t.taxed('a'), ['a', t.hear('b', announce('foreignAid'))]), ['claim:duke', 'silence', 'sure']],
    ['预告征税，预告者被抓过', (t) => (bCaught(t), ['c', t.hear('b', announce('tax'))]), ['doubt', 'silence', 'sure']],
    [
      '预告征税，声称矛盾（仍作数的声称比暗牌多）',
      (t) => {
        t.income('a');
        t.taxed('b');
        t.income('c', 'a');
        t.did(chooseAction(t.g, 'b', 'steal', 'a'));
        t.passAll('b');
        t.did(passBlock(t.g, 'a'));
        t.coup('c', 'b', 'assassin');
        return ['a', t.hear('b', announce('tax'))];
      },
      ['doubt', 'silence', 'sure'],
    ],
    ['预告征税，自己也仍作数地声称着公爵', (t) => (t.taxed('a'), ['a', t.hear('b', announce('tax'))]), ['claim:duke', 'doubt', 'silence']],
    ['预告针对别人，预告者金币不够付', (t) => ['c', t.hear('b', announce('coup', 'a'))], ['silence', 'sure']],
    [
      '听到手下留情，自己刚预告了针对他的行动（再预告一遍）',
      (t) => ((t.seat('a').coins = 7), t.hear('a', announce('coup', 'b')), ['a', t.hear('b', phrase('mercy'))]),
      ['coup>b', 'silence', 'sure'],
    ],
    ['听到手下留情，自己刚发起了针对他的行动（再预告一遍）', (t) => (t.did(chooseAction(t.g, 'a', 'steal', 'b')), ['a', t.hear('b', phrase('mercy'))]), ['silence', 'steal>b', 'sure']],
    [
      '听到手下留情，自己刚发起了针对他的行动，再预告一遍付不起',
      (t) => ((t.seat('a').coins = 3), t.did(chooseAction(t.g, 'a', 'assassinate', 'b')), ['a', t.hear('b', phrase('mercy'))]),
      ['silence', 'sure'],
    ],
    [
      '听到好险，自己的暗杀刚被阻挡（反预告偷窃他）',
      (t) => {
        t.seat('a').coins = 3;
        t.did(chooseAction(t.g, 'a', 'assassinate', 'c'));
        t.passAll('a');
        t.did(block(t.g, 'c', 'contessa'));
        t.passAll('c');
        return ['a', t.hear('c', phrase('close'))];
      },
      ['respect', 'silence', 'steal>c'],
    ],
    [
      '听到好险，自己的暗杀刚被抓到诈唬',
      (t) => {
        t.seat('a').coins = 3;
        t.did(chooseAction(t.g, 'a', 'assassinate', 'b'));
        t.did(challenge(t.g, 'b'));
        t.did(revealShowdownCard(t.g, 'a', t.seat('a').hand.find((c) => c.role === 'duke')!.id));
        return ['a', t.hear('b', phrase('close'))];
      },
      ['assassinate>b', 'respect', 'silence'], // 诈唬被抓，暗杀的钱没付出去
    ],
  ])('%s', (_, setup, expected) => {
    const t = table();
    const [me, to] = setup(t);
    const options = t.options(me, to);
    expect(saids(options)).toEqual(expected);
    for (const [, weight] of options) expect(weight).toBeGreaterThan(0);
  });

  it.each<[string, (t: Table) => [me: string, to: Heard]]>([
    ['预告收入', (t) => ['b', t.hear('a', announce('income'))]],
    ['预告交换', (t) => (t.taxed('a'), ['a', t.hear('b', announce('exchange'))])],
    ['预告针对别人，金币够付', (t) => ((t.seat('b').coins = 7), ['c', t.hear('b', announce('coup', 'a'))])],
    ['预告偷窃别人（偷窃不花钱）', (t) => ['c', t.hear('b', announce('steal', 'a'))]],
    ['预告征税，没有前情', (t) => ['c', t.hear('b', announce('tax'))]],
    ['预告外援，自己没声称过公爵', (t) => ['c', t.hear('b', announce('foreignAid'))]],
    ['手下留情，自己刚针对的是别人', (t) => (t.did(chooseAction(t.g, 'a', 'steal', 'c')), ['a', t.hear('b', phrase('mercy'))])],
    [
      '手下留情，自己的预告已是好一会儿之前',
      (t) => {
        t.seat('a').coins = 7;
        t.hear('a', announce('coup', 'b'));
        for (let i = 0; i < 6; i += 1) t.hear('c', phrase('sure'));
        return ['a', t.hear('b', phrase('mercy'))];
      },
    ],
    ['好险，自己的偷窃得手了', (t) => (t.did(chooseAction(t.g, 'a', 'steal', 'b')), t.passAll('a'), t.did(passBlock(t.g, 'b')), ['a', t.hear('b', phrase('close'))])],
    [
      '好险，阻挡被抓到诈唬、自己的偷窃照样得手',
      (t) => {
        t.did(chooseAction(t.g, 'a', 'steal', 'b'));
        t.passAll('a');
        t.did(block(t.g, 'b', 'captain'));
        t.did(challenge(t.g, 'a'));
        t.did(revealShowdownCard(t.g, 'b', t.seat('b').hand.find((c) => c.role === 'duke')!.id));
        return ['a', t.hear('b', phrase('close'))];
      },
    ],
    ['好险，最近一次行动不是自己的', (t) => (t.income('a'), t.did(chooseAction(t.g, 'b', 'steal', 'c')), t.passAll('b'), t.did(block(t.g, 'c', 'captain')), t.passAll('c'), ['a', t.hear('c', phrase('close'))])],
    ['手下留情，牌局已结束', (t) => (t.coup('a', 'b', 'duke'), t.did(forfeit(t.g, 'c')), t.did(forfeit(t.g, 'b')), ['a', t.hear('b', phrase('mercy'))])],
  ])('表外的组合不接话：%s', (_, setup) => {
    const t = table();
    const [me, to] = setup(t);
    expect(t.options(me, to)).toEqual([]);
  });

  it('预告没兑现的记忆：同一人上次针对自己的预告没兑现，我信你个鬼的权重升高，随他的回合淡化', () => {
    const doubtOf = (options: Options) => options.find(([r]) => said(r) === 'doubt')?.[1] ?? 0;
    // b 预告偷窃 a，然后 kept 时真的偷，否则收入；之后每轮 b 又收入 extra 次，再预告一遍
    const after = (kept: boolean, extra: number) => {
      const t = table();
      t.income('a');
      t.hear('b', announce('steal', 'a'));
      if (kept) t.did(chooseAction(t.g, 'b', 'steal', 'a')), t.passAll('b'), t.did(passBlock(t.g, 'a'));
      else t.income('b');
      for (let i = 0; i < extra; i += 1) t.income('c', 'a', 'b');
      t.income('c', 'a');
      return doubtOf(t.options('a', t.hear('b', announce('steal', 'a'))));
    };
    expect(after(true, 0)).toBe(0);
    expect(after(false, 0)).toBeGreaterThan(0);
    expect(after(false, 1)).toBeGreaterThan(0);
    expect(after(false, 1)).toBeLessThan(after(false, 0));
    expect(after(false, 2)).toBe(0);
  });

  it('对方金币不够付预告的行动时，候选是怀疑类的短语，不出现手下留情', () => {
    for (const action of ['coup', 'assassinate'] as const) {
      const t = table();
      const options = t.options('a', t.hear('b', announce(action, 'a')));
      expect(saids(options).filter((l) => l !== 'silence').every((l) => l === 'sure' || l === 'doubt')).toBe(true);
    }
  });
});

function makeRoom(options?: RoomOptions) {
  const repo = { save: vi.fn(), delete: vi.fn() } as unknown as GameRepository;
  const events = { onBroadcast: vi.fn(), onEmpty: vi.fn(), onReaction: vi.fn(), onShowdownFocus: vi.fn() };
  const room = new Room('ABC123', '', repo, events, options);
  return { room, repo, events };
}
const lehmer = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

describe('Room 电脑接话', () => {
  afterEach(() => vi.useRealTimers());

  // 真人坐前面、第一位先手，电脑坐后面。电脑出手的延迟拉到很长，测试替它们走（直接调引擎）。
  // 发言随机源默认恒为 0：有候选就开口、说第一条、按最短延迟说，顺延不加抖动
  function seated(humans: string[], computers: number, options: RoomOptions = {}) {
    vi.useFakeTimers();
    vi.clearAllTimers();
    const made = makeRoom({ startingPlayerRandom: () => 0, speechRandom: () => 0, computerDelayMs: () => 600_000, ...options });
    const { room } = made;
    const people = humans.map((name, i) => room.addPlayer(name, `sock${i}`));
    const sockOf = new Map(people.map((p, i) => [p.id, `sock${i}`]));
    for (let i = 0; i < computers; i += 1) room.addComputer(people[0].id, 'sock0');
    room.startGame(people[0].id, 'sock0');
    const cs = room.playerList.filter((p) => p.isComputer).map((p) => p.id);
    const act = (id: string, intent: { type: string } & Record<string, unknown>) =>
      sockOf.has(id)
        ? room.dispatch(id, sockOf.get(id)!, intent)
        : room.apply((g) => (intent.type === 'chooseAction' ? chooseAction(g, id, intent.action as 'tax') : passChallenge(g, id)));
    const income = (id: string) => act(id, { type: 'chooseAction', action: 'income' });
    const tax = (id: string) => act(id, { type: 'chooseAction', action: 'tax' });
    const pass = (id: string) => act(id, { type: 'passChallenge' });
    const say = (id: string, reaction: Reaction) => room.react(id, sockOf.get(id)!, reaction);
    // 电脑说的每一句：谁、说什么、离 since 多少毫秒
    const sent: { by: string; line: string; at: number }[] = [];
    made.events.onReaction.mockImplementation((_room: Room, r: { playerId: string; reaction: Reaction }) => {
      if (cs.includes(r.playerId)) sent.push({ by: r.playerId, line: label(r.reaction), at: Date.now() });
    });
    const lines = (since: number) => sent.filter((s) => s.at >= since).map(({ by, line, at }) => ({ by, line, ms: at - since }));
    return { ...made, people, cs, income, tax, pass, say, lines };
  }

  it('真人发一条口头声称后，电脑在 0.6～2 秒内接一句', () => {
    for (const [u, at] of [[0, 600], [0.1, 740]] as const) {
      const { people: [alice], cs: [c1], say, lines } = seated(['Alice'], 1, { speechRandom: () => u });
      const start = Date.now();
      say(alice.id, has('duke'));
      vi.advanceTimersByTime(at - 1);
      expect(lines(start)).toEqual([]);
      vi.advanceTimersByTime(2_000);
      expect(lines(start)).toEqual([{ by: c1, line: 'sure', ms: at }]);
    }
  });

  it('电脑也接电脑的话，最多两层：一句话、一句回应、一句再回应', () => {
    const { people: [alice], cs: [c1, c2], income, tax, pass, say, lines } = seated(['Alice'], 2);
    income(alice.id);
    income(c1);
    tax(c2); // c2 仍作数地声称着公爵
    [alice.id, c1].forEach(pass);
    vi.advanceTimersByTime(5_000);
    income(alice.id);
    tax(c1); // c1 首次声称公爵，问询窗口开着
    vi.advanceTimersByTime(7_000); // 声称后的表态、试探和它们引出的接话都已说完，也不再算「刚说过」
    const start = Date.now();
    say(alice.id, phrase('sure'));
    vi.advanceTimersByTime(8_000);
    expect(lines(start)).toEqual([
      { by: c1, line: 'honest', ms: 600 }, // 自己是当前窗口的声称者，首次声称
      { by: c2, line: 'claim:duke', ms: 1_400 }, // 当前声称者说我是老实人，自己也声称着公爵（错峰顺延到 0.8 秒之后）
      // c1 听到窗口之外的我有公爵、自己也声称着，本可以接我信你个鬼：已是第三句，不再接
    ]);
  });

  it('到点时自己已回应，接话取消', () => {
    const { people: [alice, bob], cs: [c1], income, tax, pass, say, lines } = seated(['Alice', 'Bob'], 1);
    income(alice.id);
    income(bob.id);
    tax(c1);
    [alice.id, bob.id].forEach(pass);
    tax(alice.id);
    const start = Date.now();
    say(alice.id, has('duke')); // c1 也声称着公爵：要接
    vi.advanceTimersByTime(300);
    pass(c1); // Bob 还没回应，窗口没关
    vi.advanceTimersByTime(3_000);
    expect(lines(start)).toEqual([]);
  });

  it('到点时说话者已被淘汰，接话取消', () => {
    const { room, people: [, bob], say, lines } = seated(['Alice', 'Bob'], 1);
    const start = Date.now();
    say(bob.id, has('duke'));
    vi.advanceTimersByTime(300);
    room.apply((g) => forfeit(g, bob.id)); // 不是 Bob 的回合：不换阶段也不换行动者
    vi.advanceTimersByTime(3_000);
    expect(lines(start)).toEqual([]);
  });

  it('真人连续刷表态：电脑每条之间仍隔着 1.5 秒的限流，没发出的接话不会越积越多', () => {
    const { people: [alice], cs: [c1], income, tax, pass, say, lines } = seated(['Alice'], 1, { speechRandom: lehmer(3) });
    income(alice.id);
    tax(c1); // c1 的征税生效：Alice 的怀疑冲着它来
    pass(alice.id);
    vi.advanceTimersByTime(3_000);
    const start = Date.now();
    let most = 0;
    for (let i = 0; i < 600; i += 1) {
      say(alice.id, phrase(i % 2 ? 'doubt' : 'sure'));
      vi.advanceTimersByTime(100);
      most = Math.max(most, vi.getTimerCount());
    }
    const said = lines(start);
    expect(said.length).toBeGreaterThan(1);
    for (let i = 1; i < said.length; i += 1) expect(said[i].ms - said[i - 1].ms).toBeGreaterThanOrEqual(1_500);
    expect(said.every((s) => s.by === c1)).toBe(true);
    expect(most).toBeLessThanOrEqual(4); // 回合时限 + 至多 3 条还没发出的接话
  });

  it('同一局面和行动种子下，无论听到什么表态，电脑的行动相同', () => {
    const TALK: Reaction[] = [phrase('doubt'), has('duke'), phrase('sure'), has('captain', false), phrase('respect'), phrase('dare')];
    const play = (talk: boolean) => {
      vi.spyOn(Math, 'random').mockImplementation(lehmer(5)); // 发牌、洗牌用的：两局同一副牌
      const { room, events, people: [alice], cs } = seated(['Alice'], 2, { computerRandom: lehmer(7), computerDelayMs: () => 1_000 });
      // Alice 只收入（金币到 10 就政变第一个对手），从不质疑、阻挡，对质和失去影响力时选第一张
      const move = () => {
        const g = room.game!;
        const self = g.players.find((p) => p.id === alice.id)!;
        const first = self.hand[0]?.id;
        const turn = self.coins >= 10 ? { type: 'chooseAction', action: 'coup', targetId: g.players.find((p) => p.alive && p.id !== alice.id)!.id } : { type: 'chooseAction', action: 'income' };
        for (const intent of [turn, { type: 'passChallenge' }, { type: 'passBlock' }, { type: 'resolveLoss', cardId: first }, { type: 'revealShowdownCard', cardId: first }]) {
          try {
            room.dispatch(alice.id, 'sock0', intent);
          } catch {
            // 此刻不该 Alice 这么做
          }
        }
      };
      for (let step = 0; step < 4_000 && room.game!.phase !== 'gameOver'; step += 1) {
        if (talk) room.react(alice.id, 'sock0', TALK[step % TALK.length]);
        move();
        vi.advanceTimersByTime(250);
      }
      expect(room.game!.phase).toBe('gameOver');
      const said = events.onReaction.mock.calls.filter(([, r]) => cs.includes(r.playerId)).map(([, r]) => label(r.reaction));
      // 两个房间的玩家 id 不同：换成座位号再比
      const seats = room.game!.players.map((p) => p.id);
      const moves = JSON.stringify(events.onBroadcast.mock.calls.flatMap(([, evs]) => evs)).replace(/"[0-9a-f]{16}"/g, (id) => `"seat${seats.indexOf(JSON.parse(id))}"`);
      vi.restoreAllMocks();
      return { moves, said };
    };
    const quiet = play(false);
    const noisy = play(true);
    expect(noisy.said).not.toEqual(quiet.said); // 电脑听到了、也接了话
    expect(quiet.moves.match(/actionChosen/g)!.length).toBeGreaterThan(10);
    expect(noisy.moves).toEqual(quiet.moves);
  });
});
