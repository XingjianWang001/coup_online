// packages/server/src/computer.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  block,
  challenge,
  chooseAction,
  createGame,
  passBlock,
  passChallenge,
  privateState,
  publicState,
  resolveExchange,
  resolveLoss,
  revealShowdownCard,
  type GameState,
  type Role,
} from '@coup/engine';
import { decideComputerIntent, type ComputerIntent } from './computer.ts';

// 可复现的随机源（mulberry32）
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDS = ['a', 'b', 'c'];
function game(hands?: Record<string, Role[]>): GameState {
  return createGame(IDS.map((id) => ({ id, name: id })), { startingPlayerId: 'a', hands });
}

const decide = (g: GameState, id: string, random = seeded(1)) => decideComputerIntent(publicState(g), privateState(g, id), [], random);

// 与 Room 处理客户端意图相同的引擎调用
function apply(g: GameState, id: string, intent: ComputerIntent) {
  switch (intent.type) {
    case 'chooseAction':
      return chooseAction(g, id, intent.action, intent.targetId);
    case 'challenge':
      return challenge(g, id);
    case 'passChallenge':
      return passChallenge(g, id);
    case 'block':
      return block(g, id, intent.role);
    case 'passBlock':
      return passBlock(g, id);
    case 'revealShowdownCard':
      return revealShowdownCard(g, id, intent.cardId);
    case 'resolveLoss':
      return resolveLoss(g, id, intent.cardId);
    case 'resolveExchange':
      return resolveExchange(g, id, intent.keepIds);
  }
}

describe('decideComputerIntent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('满 10 金币必须政变一个存活的对手', () => {
    for (let seed = 0; seed < 20; seed++) {
      const g = game();
      g.players[0].coins = 10;
      const intent = decide(g, 'a', seeded(seed));
      expect(intent).toMatchObject({ type: 'chooseAction', action: 'coup' });
      expect(() => apply(g, 'a', intent!)).not.toThrow();
    }
  });

  // 不诈唬：只选收入、外援和自己暗牌对应的行动；金币不够的行动不选
  it.each([
    { hand: ['duke', 'captain'] as Role[], coins: 2, actions: ['foreignAid', 'income', 'steal', 'tax'] },
    { hand: ['assassin', 'ambassador'] as Role[], coins: 2, actions: ['exchange', 'foreignAid', 'income'] },
    { hand: ['assassin', 'contessa'] as Role[], coins: 3, actions: ['assassinate', 'foreignAid', 'income'] },
  ])('不满 7 金币时在合法且不诈唬的行动里随机选：$hand $coins 金币', ({ hand, coins, actions }) => {
    const random = seeded(7);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const g = game({ a: hand });
      g.players[0].coins = coins;
      const intent = decide(g, 'a', random);
      if (intent?.type !== 'chooseAction') throw new Error(`unexpected ${JSON.stringify(intent)}`);
      seen.add(intent.action);
      expect(() => apply(g, 'a', intent)).not.toThrow();
    }
    expect([...seen].sort()).toEqual(actions);
  });

  it('满 7 金币时政变', () => {
    const g = game({ a: ['duke', 'duke'] });
    g.players[0].coins = 7;
    expect(decide(g, 'a')).toMatchObject({ type: 'chooseAction', action: 'coup' });
  });

  it('从不质疑：有资格表态时放弃，声称者自己无需决定', () => {
    const g = game({ a: ['duke', 'duke'], b: ['duke', 'captain'] });
    chooseAction(g, 'a', 'tax');
    expect(decide(g, 'a')).toBeNull();
    const intent = decide(g, 'b');
    expect(intent).toEqual({ type: 'passChallenge' });
    apply(g, 'b', intent!);
    expect(decide(g, 'b')).toBeNull(); // 已放弃
  });

  it('外援：有公爵的阻挡，没有的放弃', () => {
    const g = game({ b: ['duke', 'captain'], c: ['contessa', 'captain'] });
    chooseAction(g, 'a', 'foreignAid');
    expect(decide(g, 'a')).toBeNull();
    const c = decide(g, 'c');
    expect(c).toEqual({ type: 'passBlock' });
    apply(g, 'c', c!);
    const b = decide(g, 'b');
    expect(b).toEqual({ type: 'block', role: 'duke' });
    apply(g, 'b', b!);
    expect(g.phase).toBe('awaitingChallenge');
  });

  it('偷窃：只有目标表态，用手里的大使阻挡', () => {
    const g = game({ a: ['captain', 'duke'], b: ['ambassador', 'duke'] });
    chooseAction(g, 'a', 'steal', 'b');
    passChallenge(g, 'b');
    passChallenge(g, 'c');
    expect(g.phase).toBe('awaitingBlock');
    expect(decide(g, 'c')).toBeNull();
    const b = decide(g, 'b');
    expect(b).toEqual({ type: 'block', role: 'ambassador' });
    expect(() => apply(g, 'b', b!)).not.toThrow();
  });

  it('对质：手里有被声称的角色就翻它', () => {
    const g = game({ a: ['contessa', 'duke'] });
    chooseAction(g, 'a', 'tax');
    challenge(g, 'b');
    expect(decide(g, 'b')).toBeNull();
    const intent = decide(g, 'a');
    expect(intent).toEqual({ type: 'revealShowdownCard', cardId: g.players[0].hand[1].id });
    expect(() => apply(g, 'a', intent!)).not.toThrow();
  });

  it('对质：没有被声称的角色时随机翻一张', () => {
    const seen = new Set<string>();
    const random = seeded(3);
    for (let i = 0; i < 50; i++) {
      const g = game({ a: ['contessa', 'captain'] });
      chooseAction(g, 'a', 'tax');
      challenge(g, 'c');
      const intent = decide(g, 'a', random);
      if (intent?.type !== 'revealShowdownCard') throw new Error(`unexpected ${JSON.stringify(intent)}`);
      seen.add(g.players[0].hand.find((c) => c.id === intent.cardId)!.role);
      expect(() => apply(g, 'a', intent)).not.toThrow();
    }
    expect([...seen].sort()).toEqual(['captain', 'contessa']);
  });

  // 全电脑对局：每一步都有人要决定，引擎接受每条意图，最终分出胜负
  it.each([2, 3, 4, 5, 6])('%i 个电脑玩家自对弈能打到 gameOver', (count) => {
    const phases = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      const random = seeded(seed * 10 + count);
      vi.spyOn(Math, 'random').mockImplementation(random); // 引擎洗牌也可复现
      const ids = Array.from({ length: count }, (_, i) => `p${i}`);
      const g = createGame(ids.map((id) => ({ id, name: id })), { startingPlayerId: 'p0' });
      for (let step = 0; g.phase !== 'gameOver'; step++) {
        if (step > 2000) throw new Error('game did not end');
        const deciders = ids.flatMap((id) => {
          const intent = decide(g, id, random);
          return intent ? [{ id, intent }] : [];
        });
        expect(deciders.length).toBeGreaterThan(0);
        phases.add(g.phase);
        const { id, intent } = deciders[Math.floor(random() * deciders.length)];
        apply(g, id, intent);
      }
    }
    expect([...phases].sort()).toEqual(['awaitingBlock', 'awaitingChallenge', 'choosingAction', 'choosingExchange', 'choosingLoss']);
  });
});
