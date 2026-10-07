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
  resolveBlockTimeout,
  resolveChallengeTimeout,
  resolveExchange,
  resolveLoss,
} from './index.ts';
import type { GameState, Role } from './types.ts';

const P = (id: string, name = id) => ({ id, name });

function setup(hands: Record<string, Role[]>) {
  const players = Object.keys(hands).map((id) => P(id));
  return createGame(players, { hands, startingPlayerId: players[0].id });
}

function coins(state: GameState, id: string): number {
  return state.players.find((p) => p.id === id)!.coins;
}

describe('createGame', () => {
  it('发 2 张暗牌、2 金币、牌堆 15-2n 张', () => {
    const s = createGame([P('a'), P('b'), P('c')], { startingPlayerId: 'a' });
    expect(s.players).toHaveLength(3);
    for (const p of s.players) {
      expect(p.hand).toHaveLength(2);
      expect(p.coins).toBe(2);
      expect(p.alive).toBe(true);
    }
    expect(s.deck).toHaveLength(9);
    expect(s.currentPlayerId).toBe('a');
  });

  it('拒绝少于 2 人或超过 6 人', () => {
    expect(() => createGame([P('a')], { startingPlayerId: 'a' })).toThrow();
    expect(() =>
      createGame([P('a'), P('b'), P('c'), P('d'), P('e'), P('f'), P('g')], {
        startingPlayerId: 'a',
      }),
    ).toThrow();
  });

  it('允许 2 人开局', () => {
    const s = createGame([P('a'), P('b')], { startingPlayerId: 'a' });
    expect(s.players).toHaveLength(2);
  });

  it('使用服务器指定的起始玩家', () => {
    const s = createGame([P('a'), P('b'), P('c')], { startingPlayerId: 'b' });
    expect(s.currentPlayerId).toBe('b');
  });

  it('两人局中起始玩家有 1 枚金币，另一位有 2 枚', () => {
    const s = createGame([P('a'), P('b')], { startingPlayerId: 'b' });
    expect(s.currentPlayerId).toBe('b');
    expect(coins(s, 'a')).toBe(2);
    expect(coins(s, 'b')).toBe(1);
  });

  it.each([3, 4, 5, 6])('%i 人局中所有玩家均有 2 枚金币', (playerCount) => {
    const players = Array.from({ length: playerCount }, (_, i) => P(String(i)));
    const s = createGame(players, { startingPlayerId: players.at(-1)!.id });
    expect(s.players.every((player) => player.coins === 2)).toBe(true);
  });
});

describe('income & 回合流转', () => {
  it('收入 +1 并轮到下一位', () => {
    const s = setup({ a: ['duke', 'duke'], b: ['captain', 'captain'], c: ['contessa', 'contessa'] });
    chooseAction(s, 'a', 'income');
    expect(coins(s, 'a')).toBe(3);
    expect(s.currentPlayerId).toBe('b');
  });
});

describe('事件顺序', () => {
  it('actionChosen 是每回合首个事件，income 也发出', () => {
    const s = setup({ a: ['duke', 'duke'], b: ['captain', 'captain'], c: ['contessa', 'contessa'] });
    const incomeEvents = chooseAction(s, 'a', 'income');
    expect(incomeEvents[0]).toMatchObject({ type: 'actionChosen', action: 'income' });

    s.players.find((p) => p.id === 'b')!.coins = 7;
    const coupEvents = chooseAction(s, 'b', 'coup', 'c');
    expect(coupEvents[0]).toMatchObject({ type: 'actionChosen', action: 'coup' });
    expect(coupEvents[1].type).toBe('coinsChanged');
  });
});

describe('coup', () => {
  it('花费 7 金币并让目标失去影响力', () => {
    const s = setup({ a: ['duke', 'duke'], b: ['captain', 'captain'], c: ['contessa', 'contessa'] });
    s.players.find((p) => p.id === 'a')!.coins = 7;
    chooseAction(s, 'a', 'coup', 'b');
    expect(coins(s, 'a')).toBe(0);
    expect(s.phase).toBe('choosingLoss');
    expect(s.lossToResolve?.playerId).toBe('b');
  });

  it('金币不足则报错', () => {
    const s = setup({ a: ['duke', 'duke'], b: ['captain', 'captain'], c: ['contessa', 'contessa'] });
    expect(() => chooseAction(s, 'a', 'coup', 'b')).toThrow();
  });

  it('持有 10 枚以上金币必须发动政变', () => {
    const s = setup({ a: ['duke', 'duke'], b: ['captain', 'captain'], c: ['contessa', 'contessa'] });
    s.players.find((p) => p.id === 'a')!.coins = 10;
    expect(() => chooseAction(s, 'a', 'income')).toThrow();
    expect(() => chooseAction(s, 'a', 'tax')).toThrow();
    // 政变本身允许
    chooseAction(s, 'a', 'coup', 'b');
    expect(coins(s, 'a')).toBe(3); // 10 - 7
  });
});

describe('resolveLoss', () => {
  it('亮牌后失去一张暗牌，掉到 0 则淘汰', () => {
    const s = setup({ a: ['duke', 'duke'], b: ['captain', 'captain'], c: ['contessa', 'contessa'] });
    s.players.find((p) => p.id === 'a')!.coins = 7;
    chooseAction(s, 'a', 'coup', 'b');
    const card = s.players.find((p) => p.id === 'b')!.hand[0];
    resolveLoss(s, 'b', card.id);
    const b = s.players.find((p) => p.id === 'b')!;
    expect(b.hand).toHaveLength(1);
    expect(b.revealed).toHaveLength(1);
    expect(b.alive).toBe(true);
  });
});

describe('声称行动与质疑', () => {
  it('征税声称公爵，被质疑且为真 → 质疑者掉影响力，行动继续', () => {
    const s = setup({
      a: ['duke', 'captain'],
      b: ['ambassador', 'ambassador'],
      c: ['contessa', 'contessa'],
    });
    chooseAction(s, 'a', 'tax');
    expect(s.phase).toBe('awaitingChallenge');
    challenge(s, 'b');
    expect(s.phase).toBe('choosingLoss');
    expect(s.lossToResolve?.playerId).toBe('b');
    expect(s.players.find((p) => p.id === 'a')!.hand).toHaveLength(2);
  });

  it('声称角色被质疑且为假 → 行动作废，声称者掉影响力', () => {
    const s = setup({
      a: ['captain', 'captain'], // 没有 duke
      b: ['ambassador', 'ambassador'],
      c: ['contessa', 'contessa'],
    });
    chooseAction(s, 'a', 'tax');
    challenge(s, 'b');
    expect(s.phase).toBe('choosingLoss');
    expect(s.lossToResolve?.playerId).toBe('a');
  });

  it('付费角色行动被成功质疑时退还全部费用', () => {
    const s = setup({
      a: ['captain', 'captain'],
      b: ['ambassador', 'ambassador'],
      c: ['contessa', 'contessa'],
    });
    s.players.find((p) => p.id === 'a')!.coins = 5;

    chooseAction(s, 'a', 'assassinate', 'b');
    expect(coins(s, 'a')).toBe(2);

    const events = challenge(s, 'b');
    expect(coins(s, 'a')).toBe(5);
    expect(events).toContainEqual({ type: 'coinsChanged', playerId: 'a', coins: 5 });
    expect(s.lossToResolve).toMatchObject({ playerId: 'a', continuation: { kind: 'cancelAction' } });

    const card = s.players.find((p) => p.id === 'a')!.hand[0];
    resolveLoss(s, 'a', card.id);
    expect(s.currentPlayerId).toBe('b');
    expect(s.players.find((p) => p.id === 'b')!.hand).toHaveLength(2);
  });

  it('无人质疑则行动结算', () => {
    const s = setup({
      a: ['duke', 'captain'],
      b: ['ambassador', 'ambassador'],
      c: ['contessa', 'contessa'],
    });
    chooseAction(s, 'a', 'tax');
    resolveChallengeTimeout(s);
    expect(coins(s, 'a')).toBe(5);
    expect(s.currentPlayerId).toBe('b');
  });

  it('部分玩家放弃质疑不会关闭窗口，全员放弃才关闭', () => {
    const s = setup({
      a: ['duke', 'captain'],
      b: ['ambassador', 'ambassador'],
      c: ['contessa', 'contessa'],
    });
    chooseAction(s, 'a', 'tax');
    // b 放弃，但 c 尚未表态 → 窗口仍开
    passChallenge(s, 'b');
    expect(s.phase).toBe('awaitingChallenge');
    // c 也放弃 → 全员放弃，结算
    passChallenge(s, 'c');
    expect(coins(s, 'a')).toBe(5);
  });
});

describe('外援与阻挡', () => {
  it('外援可被公爵阻挡', () => {
    const s = setup({
      a: ['captain', 'captain'],
      b: ['duke', 'duke'],
      c: ['contessa', 'contessa'],
    });
    chooseAction(s, 'a', 'foreignAid');
    expect(s.phase).toBe('awaitingBlock');
    block(s, 'b', 'duke');
    expect(s.phase).toBe('awaitingChallenge');
    expect(s.challengeSubject).toBe('block');
    resolveChallengeTimeout(s);
    expect(coins(s, 'a')).toBe(2);
    expect(s.currentPlayerId).toBe('b');
  });

  it('外援无人阻挡则 +2', () => {
    const s = setup({
      a: ['captain', 'captain'],
      b: ['ambassador', 'ambassador'],
      c: ['contessa', 'contessa'],
    });
    chooseAction(s, 'a', 'foreignAid');
    resolveBlockTimeout(s);
    expect(coins(s, 'a')).toBe(4);
  });
});

describe('暗杀与偷窃', () => {
  it('暗杀结算后目标失去影响力', () => {
    const s = setup({
      a: ['assassin', 'captain'],
      b: ['ambassador', 'ambassador'],
      c: ['contessa', 'contessa'],
    });
    s.players.find((p) => p.id === 'a')!.coins = 5;
    chooseAction(s, 'a', 'assassinate', 'b');
    resolveChallengeTimeout(s);
    resolveBlockTimeout(s);
    expect(s.phase).toBe('choosingLoss');
    expect(s.lossToResolve?.playerId).toBe('b');
    expect(coins(s, 'a')).toBe(2);
  });

  it('暗杀被无人质疑的女伯爵阻挡时不退费', () => {
    const s = setup({
      a: ['assassin', 'captain'],
      b: ['contessa', 'ambassador'],
      c: ['duke', 'duke'],
    });
    s.players.find((p) => p.id === 'a')!.coins = 5;

    chooseAction(s, 'a', 'assassinate', 'b');
    resolveChallengeTimeout(s);
    block(s, 'b', 'contessa');
    resolveChallengeTimeout(s);

    expect(coins(s, 'a')).toBe(2);
    expect(s.currentPlayerId).toBe('b');
    expect(s.players.find((p) => p.id === 'b')!.hand).toHaveLength(2);
  });

  it('暗杀被真实的女伯爵声明阻挡时不退费', () => {
    const s = setup({
      a: ['assassin', 'captain'],
      b: ['contessa', 'ambassador'],
      c: ['duke', 'duke'],
    });
    s.players.find((p) => p.id === 'a')!.coins = 5;

    chooseAction(s, 'a', 'assassinate', 'b');
    resolveChallengeTimeout(s);
    block(s, 'b', 'contessa');
    challenge(s, 'a');

    expect(coins(s, 'a')).toBe(2);
    expect(s.lossToResolve).toMatchObject({ playerId: 'a', continuation: { kind: 'cancelAction' } });
  });

  it('偷窃转移 2 金币', () => {
    const s = setup({
      a: ['captain', 'captain'],
      b: ['ambassador', 'ambassador'],
      c: ['contessa', 'contessa'],
    });
    s.players.find((p) => p.id === 'b')!.coins = 5;
    chooseAction(s, 'a', 'steal', 'b');
    resolveChallengeTimeout(s);
    resolveBlockTimeout(s);
    expect(coins(s, 'a')).toBe(4);
    expect(coins(s, 'b')).toBe(3);
  });
});

describe('大使交换', () => {
  it('抽 2 张后保留 2 张', () => {
    const s = setup({
      a: ['ambassador', 'captain'],
      b: ['duke', 'duke'],
      c: ['contessa', 'contessa'],
    });
    chooseAction(s, 'a', 'exchange');
    resolveChallengeTimeout(s);
    expect(s.phase).toBe('choosingExchange');
    const a = s.players.find((p) => p.id === 'a')!;
    expect(a.hand).toHaveLength(4);
    const keep = a.hand.slice(0, 2).map((c) => c.id);
    resolveExchange(s, 'a', keep);
    expect(a.hand).toHaveLength(2);
    expect(s.currentPlayerId).toBe('b');
  });
});

describe('forfeit', () => {
  it('弃权翻开全部暗牌并淘汰', () => {
    const s = setup({ a: ['duke', 'duke'], b: ['captain', 'captain'], c: ['contessa', 'contessa'] });
    forfeit(s, 'b');
    const b = s.players.find((p) => p.id === 'b')!;
    expect(b.alive).toBe(false);
    expect(b.hand).toHaveLength(0);
    expect(b.revealed).toHaveLength(2);
  });
});

describe('publicState 不泄露暗牌', () => {
  it('公开状态只含手牌数量，不含牌面', () => {
    const s = setup({ a: ['duke', 'duke'], b: ['captain', 'captain'], c: ['contessa', 'contessa'] });
    const pub = publicState(s);
    for (const p of pub.players) {
      expect(p.handCount).toBe(2);
      expect((p as unknown as { hand?: unknown }).hand).toBeUndefined();
    }
  });
});

