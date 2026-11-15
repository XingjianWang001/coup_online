// packages/server/src/computer.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_CLAIM,
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
  type GameEvent,
  type GameState,
  type Role,
} from '@coup/engine';
import { decideComputerIntent, drawTemperament, type ComputerIntent, type Temperament } from './computer.ts';

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

// 三项倾向都为 0：不起新的诈唬，最不爱质疑
const CALM: Temperament = { bluff: 0, suspicion: 0, aggression: 0 };
const EVEN: Temperament = { bluff: 0.5, suspicion: 0.5, aggression: 0.5 };
const decide = (g: GameState, id: string, random = seeded(1), events: GameEvent[] = [], temperament = CALM) =>
  decideComputerIntent(publicState(g), privateState(g, id), events, temperament, random);

// 同一局面下重复决定 times 次，数各种结果出现的次数
function tally(times: number, key: (intent: ComputerIntent) => string, g: GameState, id: string, events: GameEvent[] = [], temperament = EVEN): Record<string, number> {
  const random = seeded(11);
  const counts: Record<string, number> = {};
  for (let i = 0; i < times; i++) {
    const k = key(decide(g, id, random, events, temperament)!);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
const byType = (intent: ComputerIntent) => intent.type;
const byAction = (intent: ComputerIntent) => (intent.type === 'chooseAction' ? intent.action : intent.type);
const byTarget = (intent: ComputerIntent) => (intent.type === 'chooseAction' ? intent.targetId! : intent.type);

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
  it('满 10 金币必须政变一个存活的对手', () => {
    for (let seed = 0; seed < 20; seed++) {
      const g = game();
      g.players[0].coins = 10;
      const intent = decide(g, 'a', seeded(seed));
      expect(intent).toMatchObject({ type: 'chooseAction', action: 'coup' });
      expect(() => apply(g, 'a', intent!)).not.toThrow();
    }
  });

  // 不爱诈唬的性格：只选收入、外援和自己暗牌对应的行动；金币不够的行动不选
  it.each([
    { hand: ['duke', 'captain'] as Role[], coins: 2, actions: ['foreignAid', 'income', 'steal', 'tax'] },
    { hand: ['assassin', 'ambassador'] as Role[], coins: 2, actions: ['exchange', 'foreignAid', 'income'] },
    { hand: ['assassin', 'contessa'] as Role[], coins: 3, actions: ['assassinate', 'foreignAid', 'income'] },
  ])('不满 7 金币、不爱诈唬时只在合法且不诈唬的行动里选：$hand $coins 金币', ({ hand, coins, actions }) => {
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

  it('质疑窗口：声称者自己无需决定，放弃过的不再决定', () => {
    const g = game({ a: ['duke', 'duke'], b: ['duke', 'captain'] });
    chooseAction(g, 'a', 'tax');
    expect(decide(g, 'a')).toBeNull();
    expect(['challenge', 'passChallenge']).toContain(decide(g, 'b')?.type);
    passChallenge(g, 'b');
    expect(decide(g, 'b')).toBeNull();
  });

  it('明牌加自己的暗牌已凑齐被声称角色的 3 张时必质疑', () => {
    for (let seed = 0; seed < 50; seed++) {
      const g = game({ a: ['contessa', 'captain'], b: ['duke', 'duke'], c: ['duke', 'assassin'] });
      g.players[0].coins = 7;
      chooseAction(g, 'a', 'coup', 'c');
      resolveLoss(g, 'c', g.players[2].hand[0].id);
      chooseAction(g, 'b', 'income');
      chooseAction(g, 'c', 'income');
      chooseAction(g, 'a', 'tax');
      expect(decide(g, 'b', seeded(seed))).toEqual({ type: 'challenge' });
    }
  });

  it('被暗杀且只剩 1 点影响力、没有女伯爵：质疑或假装女伯爵阻挡，不放弃', () => {
    const ways = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const random = seeded(seed);
      const temperament = drawTemperament(random);
      const g = game({ a: ['assassin', 'duke'], b: ['captain'], c: ['duke', 'duke'] });
      g.players[0].coins = 3;
      chooseAction(g, 'a', 'assassinate', 'b');
      const first = decide(g, 'b', random, [], temperament)!;
      ways.add(first.type);
      if (first.type === 'challenge') continue;
      apply(g, 'b', first);
      passChallenge(g, 'c');
      expect(g.phase).toBe('awaitingBlock');
      expect(decide(g, 'b', random, [], temperament)).toEqual({ type: 'block', role: 'contessa' });
    }
    expect([...ways].sort()).toEqual(['challenge', 'passChallenge']);
  });

  it('质疑率按有资格质疑的人数折算：2 人局和 6 人局里一个声称被质疑的总概率接近', () => {
    const spare: Role[][] = [['assassin', 'captain'], ['ambassador', 'contessa'], ['assassin', 'captain'], ['ambassador', 'contessa'], ['assassin', 'captain']];
    const rate = (count: number) => {
      const ids = Array.from({ length: count }, (_, i) => `p${i}`);
      const hands = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? (['duke', 'duke'] as Role[]) : spare[i - 1]]));
      const g = createGame(ids.map((id) => ({ id, name: id })), { startingPlayerId: 'p0', hands });
      chooseAction(g, 'p0', 'tax');
      const random = seeded(count);
      let challenged = 0;
      for (let i = 0; i < 4000; i++) {
        if (ids.slice(1).some((id) => decide(g, id, random, [], EVEN)?.type === 'challenge')) challenged++;
      }
      return challenged / 4000;
    };
    const two = rate(2);
    const six = rate(6);
    expect(two).toBeGreaterThan(0.08);
    expect(Math.abs(two - six)).toBeLessThan(0.03);
  });

  it('质疑看证据：对方本局被抓过诈唬则更怀疑，声称被证明过则更相信', () => {
    const g = game({ a: ['duke', 'captain'], b: ['assassin', 'contessa'] });
    chooseAction(g, 'a', 'tax');
    const earlier: GameEvent = { type: 'actionChosen', actorId: 'a', action: 'steal', targetId: 'c', claimedRole: 'captain' };
    const caught: GameEvent[] = [earlier, { type: 'challengeResolved', truth: false, loserId: 'a', claimantId: 'a', role: 'contessa', slot: 0 }];
    const proven: GameEvent[] = [earlier, { type: 'challengeResolved', truth: true, loserId: 'c', claimantId: 'a', role: 'captain', slot: 0 }];
    const neutral = tally(4000, byType, g, 'b').challenge;
    expect(tally(4000, byType, g, 'b', caught).challenge).toBeGreaterThan(neutral * 1.3);
    expect(tally(4000, byType, g, 'b', proven).challenge).toBeLessThan(neutral * 0.8);
  });

  it('质疑看代价：冲着自己来的行动比与己无关的更想质疑，只剩 1 点影响力时更谨慎', () => {
    const stolen = (target: string, hands: Record<string, Role[]>) => {
      const g = game(hands);
      chooseAction(g, 'a', 'steal', target);
      return tally(4000, byType, g, 'b').challenge;
    };
    const bystander = stolen('c', { b: ['duke', 'contessa'] });
    const victim = stolen('b', { b: ['duke', 'contessa'] });
    expect(victim).toBeGreaterThan(bystander * 1.5);
    expect(stolen('b', { b: ['duke'] })).toBeLessThan(victim * 0.8);
  });

  it('没有对应角色时按诈唬倾向决定是否假装阻挡', () => {
    const g = game({ a: ['captain', 'duke'], b: ['duke', 'contessa'] });
    chooseAction(g, 'a', 'steal', 'b');
    passChallenge(g, 'b');
    passChallenge(g, 'c');
    expect(tally(300, byType, g, 'b', [], CALM)).toEqual({ passBlock: 300 });
    const bold = tally(300, byType, g, 'b', [], { ...EVEN, bluff: 1 });
    expect(bold.block).toBeGreaterThan(30);
    expect(bold.passBlock).toBeGreaterThan(30);
  });

  it('本局声称过的角色被优先再次声称', () => {
    const g = game({ a: ['contessa', 'contessa'] });
    g.players[0].coins = 3;
    const claimedDuke: GameEvent[] = [{ type: 'actionChosen', actorId: 'a', action: 'tax', claimedRole: 'duke' }];
    const { tax = 0, steal = 0, assassinate = 0, exchange = 0 } = tally(1000, byAction, g, 'a', claimedDuke);
    expect(steal + assassinate + exchange).toBeGreaterThan(0); // 还会起别的诈唬，只是少得多
    expect(tax).toBeGreaterThan(1.5 * (steal + assassinate + exchange));
  });

  it('声称被对质证明为真后牌已换走：不再把它当作自己的牌', () => {
    const g = game({ a: ['contessa', 'contessa'] });
    const claimedDuke: GameEvent = { type: 'actionChosen', actorId: 'a', action: 'tax', claimedRole: 'duke' };
    const proven: GameEvent = { type: 'challengeResolved', truth: true, loserId: 'b', claimantId: 'a', role: 'duke', slot: 0 };
    expect(tally(300, byAction, g, 'a', [claimedDuke], CALM).tax).toBeGreaterThan(0);
    expect(tally(300, byAction, g, 'a', [claimedDuke, proven], CALM).tax).toBeUndefined();
  });

  it('不在同一局里轮流声称四五个角色：声称过的角色数达到暗牌数后不再起新的诈唬', () => {
    const g = game({ a: ['contessa', 'contessa'] });
    g.players[0].coins = 3;
    const story: GameEvent[] = [
      { type: 'actionChosen', actorId: 'a', action: 'tax', claimedRole: 'duke' },
      { type: 'actionChosen', actorId: 'a', action: 'steal', targetId: 'b', claimedRole: 'captain' },
    ];
    const counts = tally(1000, byAction, g, 'a', story, { ...EVEN, bluff: 1 });
    expect(Object.keys(counts).sort()).toEqual(['foreignAid', 'income', 'steal', 'tax']);
  });

  it('选目标：优先打领先者（金币多、影响力多），但不是每次', () => {
    const richer = game();
    richer.players[0].coins = 7;
    richer.players[1].coins = 6;
    const counts = tally(1000, byTarget, richer, 'a');
    expect(counts.b).toBeGreaterThan(700);
    expect(counts.c).toBeGreaterThan(0);

    const stronger = game();
    stronger.players[0].coins = 7;
    stronger.players[2].hand.pop(); // c 只剩 1 点影响力
    expect(tally(1000, byTarget, stronger, 'a').b).toBeGreaterThan(700);
  });

  it('选目标：对最近打过自己的玩家有报复倾向', () => {
    const g = game();
    g.players[0].coins = 7;
    const attacked: GameEvent[] = [{ type: 'actionChosen', actorId: 'c', action: 'steal', targetId: 'a', claimedRole: 'captain' }];
    expect(tally(1000, byTarget, g, 'a').c).toBeLessThan(600);
    expect(tally(1000, byTarget, g, 'a', attacked).c).toBeGreaterThan(700);
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

  it('对质：没有被声称的角色时翻对自己价值较低的那张', () => {
    for (let seed = 0; seed < 20; seed++) {
      const g = game({ a: ['duke', 'ambassador'] });
      chooseAction(g, 'a', 'steal', 'b');
      challenge(g, 'c');
      const intent = decide(g, 'a', seeded(seed));
      expect(intent).toEqual({ type: 'revealShowdownCard', cardId: g.players[0].hand[1].id });
      expect(() => apply(g, 'a', intent!)).not.toThrow();
    }
  });

  it.each([
    { claimed: 'assassin' as Role, action: 'assassinate' as const, lost: 'captain' },
    { claimed: 'captain' as Role, action: 'steal' as const, lost: 'assassin' },
  ])('失去影响力：留下本局一直在声称的 $claimed', ({ claimed, action, lost }) => {
    const g = game({ a: ['captain', 'assassin'] });
    g.players[1].coins = 7;
    chooseAction(g, 'a', 'income');
    chooseAction(g, 'b', 'coup', 'a');
    const events: GameEvent[] = [{ type: 'actionChosen', actorId: 'a', action, targetId: 'b', claimedRole: claimed }];
    for (let seed = 0; seed < 20; seed++) {
      const intent = decide(g, 'a', seeded(seed), events, EVEN);
      expect(intent).toEqual({ type: 'resolveLoss', cardId: g.players[0].hand.find((c) => c.role === lost)!.id });
    }
  });

  it.each([
    { hand: ['ambassador', 'contessa', 'duke', 'captain'] as Role[], kept: ['captain', 'duke'] },
    { hand: ['duke', 'duke', 'ambassador', 'captain'] as Role[], kept: ['captain', 'duke'] }, // 不留两张一样的
  ])('交换选牌：留下更有用的牌 $hand', ({ hand, kept }) => {
    const g = game({ a: ['ambassador', 'contessa'] });
    chooseAction(g, 'a', 'exchange');
    passChallenge(g, 'b');
    passChallenge(g, 'c');
    g.players[0].hand.forEach((card, i) => (card.role = hand[i])); // 摸到什么由测试指定
    const intent = decide(g, 'a');
    if (intent?.type !== 'resolveExchange') throw new Error(`unexpected ${JSON.stringify(intent)}`);
    expect(intent.keepIds.map((id) => g.players[0].hand.find((c) => c.id === id)!.role).sort()).toEqual(kept);
    expect(() => apply(g, 'a', intent)).not.toThrow();
  });
});

// 自对弈检查（#57）：电脑对电脑打几千局，看它不出错、打得完，而且诈唬和质疑的比例像人。
// 每次运行换一个种子，失败信息里带着它：把 SEED 写死成那个数就能复现
describe('电脑玩家自对弈', () => {
  const SEED = Date.now() | 0;
  const TURN_LIMIT = 300;
  type Seat = (g: GameState, id: string, events: GameEvent[], temperament: Temperament, random: () => number) => ComputerIntent | null;
  const computer: Seat = (g, id, events, temperament, random) => decide(g, id, random, events, temperament);
  // 「只会收入和政变」的对手：借电脑的决策得知此刻轮不轮到它，再把决定换成最朴素的
  const plain: Seat = (g, id, events, temperament, random) => {
    const intent = computer(g, id, events, temperament, random);
    if (intent?.type === 'challenge') return { type: 'passChallenge' };
    if (intent?.type === 'block') return { type: 'passBlock' };
    if (intent?.type !== 'chooseAction') return intent;
    const rivals = g.players.filter((p) => p.alive && p.id !== id);
    return g.players.find((p) => p.id === id)!.coins < 7
      ? { type: 'chooseAction', action: 'income' }
      : { type: 'chooseAction', action: 'coup', targetId: rivals[Math.floor(random() * rivals.length)].id };
  };

  // 打 games 局，返回各座位的胜局数和问询窗口的统计
  function play(games: number, seats: Seat[]) {
    const random = seeded(SEED + seats.length);
    vi.spyOn(Math, 'random').mockImplementation(random); // 引擎洗牌也跟着种子走
    const ids = seats.map((_, i) => `p${i}`);
    const stats = { wins: seats.map(() => 0), claims: 0, bluffs: 0, challenges: 0, blockWindows: 0 };
    for (let n = 0; n < games; n++) {
      const where = `seed ${SEED}, ${seats.length} players, game ${n}`;
      const g = createGame(ids.map((id) => ({ id, name: id })), { startingPlayerId: ids[Math.floor(random() * ids.length)] });
      const temperaments = ids.map(() => drawTemperament(random));
      const events: GameEvent[] = [];
      let turns = 0;
      while (g.phase !== 'gameOver') {
        const deciders = ids.flatMap((id, i) => {
          const intent = seats[i](g, id, events, temperaments[i], random);
          return intent ? [{ id, intent }] : [];
        });
        if (deciders.length === 0) throw new Error(`nobody has anything to decide in ${g.phase} (${where})`);
        const { id, intent } = deciders[Math.floor(random() * deciders.length)];
        const role = intent.type === 'chooseAction' ? ACTION_CLAIM[intent.action] : intent.type === 'block' ? intent.role : null;
        if (role) {
          stats.claims++;
          if (!privateState(g, id).hand.some((c) => c.role === role)) stats.bluffs++;
        }
        if (intent.type === 'challenge') stats.challenges++;
        const wasBlockWindow = g.phase === 'awaitingBlock';
        const produced = apply(g, id, intent);
        events.push(...produced);
        if (!wasBlockWindow && g.phase === 'awaitingBlock') stats.blockWindows++;
        turns += produced.filter((e) => e.type === 'turnChanged').length;
        if (turns > TURN_LIMIT) throw new Error(`no winner within ${TURN_LIMIT} turns (${where})`);
      }
      stats.wins[ids.indexOf(g.winnerId!)]++;
    }
    return stats;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([2, 3, 5, 6])('%i 人局：每局都在回合数上限内分出胜负', (count) => {
    const { wins } = play(250, Array<Seat>(count).fill(computer));
    expect(wins.reduce((a, b) => a + b)).toBe(250);
  });

  it('4 人局：诈唬占全部角色声称的 20% 到 40%，以质疑收场的问询窗口占 10% 到 25%', () => {
    const { claims, bluffs, challenges, blockWindows } = play(1500, Array<Seat>(4).fill(computer));
    const within = (rate: number, low: number, high: number) => {
      expect(rate, `seed ${SEED}`).toBeGreaterThan(low);
      expect(rate, `seed ${SEED}`).toBeLessThan(high);
    };
    within(bluffs / claims, 0.2, 0.4);
    // 每个声称开一个质疑窗口，问询窗口还包括阻挡窗口：只数质疑窗口或两种都数，比例都要落在区间里
    within(challenges / claims, 0.1, 0.25);
    within(challenges / (claims + blockWindows), 0.1, 0.25);
  });

  it('1 个电脑对 3 个只会收入和政变的对手：胜率高于 40%', () => {
    const { wins } = play(1000, [computer, plain, plain, plain]);
    expect(wins[0] / 1000, `seed ${SEED}`).toBeGreaterThan(0.4);
  });
});
