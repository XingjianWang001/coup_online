// packages/server/src/computer.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_CLAIM,
  COUP_COST,
  ROLE_COPIES,
  ROLE_ORDER,
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
  type ActionType,
  type GameEvent,
  type GameState,
  type Role,
} from '@coup/engine';
import { STANDARD, STRONG, decideComputerIntent, drawTemperament, type ComputerIntent, type Returned, type Temperament } from './computer.ts';

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
// 引擎的 hands 选项不给没写到的玩家发牌：没指定暗牌的玩家按固定顺序从剩下的牌里各拿 2 张，免得出现没有暗牌的存活玩家
function game(hands: Record<string, Role[]> = {}): GameState {
  const left = Array.from({ length: ROLE_ORDER.length * ROLE_COPIES }, (_, i) => ROLE_ORDER[i % ROLE_ORDER.length]);
  for (const role of Object.values(hands).flat()) left.splice(left.indexOf(role), 1);
  const dealt = Object.fromEntries(IDS.map((id) => [id, hands[id] ?? left.splice(0, 2)]));
  return createGame(IDS.map((id) => ({ id, name: id })), { startingPlayerId: 'a', hands: dealt });
}
const seat = (g: GameState, id: string) => g.players.find((p) => p.id === id)!;
const cardOf = (g: GameState, id: string, role: Role) => seat(g, id).hand.find((c) => c.role === role)!.id;

// 一桌按真实流程推进的牌局：did 记下引擎产生的事件，电脑的局内记忆和在房间里一样只从这些事件来
function table(hands?: Record<string, Role[]>) {
  const g = game(hands);
  const events: GameEvent[] = [];
  const did = (produced: GameEvent[]) => void events.push(...produced);
  return {
    g,
    events,
    did,
    income: (...ids: string[]) => ids.forEach((id) => did(chooseAction(g, id, 'income'))),
    // 轮到 by 时政变 target，target 亮出 lose
    coup(by: string, target: string, lose: Role) {
      seat(g, by).coins = COUP_COST;
      did(chooseAction(g, by, 'coup', target));
      did(resolveLoss(g, target, cardOf(g, target, lose)));
    },
    // 轮到 by 时执行声称角色的行动，没有人质疑，目标也不阻挡
    unopposed(by: string, action: ActionType, target?: string) {
      did(chooseAction(g, by, action, target));
      for (const id of IDS) if (id !== by && seat(g, id).alive) did(passChallenge(g, id));
      if (g.phase === 'awaitingBlock') did(passBlock(g, target!));
    },
  };
}
type Table = ReturnType<typeof table>;

// 三项倾向都为 0：从不诈唬，最不爱质疑
const CALM: Temperament = { bluff: 0, suspicion: 0, aggression: 0 };
const EVEN: Temperament = { bluff: 0.5, suspicion: 0.5, aggression: 0.5 };
const KEEN: Temperament = { ...EVEN, bluff: 0.8 }; // 爱诈唬，但没到极爱：故事上限仍是 3 个角色
const BOLD: Temperament = { ...EVEN, bluff: 1 }; // 极爱诈唬：故事上限放宽到 4 个角色
// 决策函数在公开状态和自己的暗牌之外还要的三样；测试里没给的用这里的默认值
interface Mind {
  events: GameEvent[];
  temperament: Temperament;
  random: () => number;
  returned?: Returned[]; // 自己交换时放回牌堆的牌（牌堆记忆，只有强电脑用）
}
const decide = (g: GameState, id: string, { events = [], temperament = CALM, random = seeded(1) }: Partial<Mind> = {}) =>
  decideComputerIntent(publicState(g), privateState(g, id), events, temperament, random);

// 同一局面下以中等性格重复决定 times 次，数各种结果出现的次数
function tally(times: number, key: (intent: ComputerIntent) => string, g: GameState, id: string, mind: Partial<Omit<Mind, 'random'>> = {}): Record<string, number> {
  const random = seeded(11);
  const counts: Record<string, number> = {};
  for (let i = 0; i < times; i++) {
    const k = key(decide(g, id, { temperament: EVEN, ...mind, random })!);
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
      seat(g, 'a').coins = 10;
      const intent = decide(g, 'a', { random: seeded(seed) });
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
      seat(g, 'a').coins = coins;
      const intent = decide(g, 'a', { random });
      if (intent?.type !== 'chooseAction') throw new Error(`unexpected ${JSON.stringify(intent)}`);
      seen.add(intent.action);
      expect(() => apply(g, 'a', intent)).not.toThrow();
    }
    expect([...seen].sort()).toEqual(actions);
  });

  it.each([7, 8, 9])('%i 金币时绝大多数时候政变，偶尔做别的合法行动', (coins) => {
    const g = game({ a: ['duke', 'captain'] });
    seat(g, 'a').coins = coins;
    const { coup, ...others } = tally(1000, byAction, g, 'a');
    expect(coup).toBeGreaterThan(750);
    expect(1000 - coup).toBeGreaterThan(50);
    expect(Object.keys(others).every((action) => ['income', 'foreignAid', 'tax', 'steal', 'assassinate', 'exchange'].includes(action))).toBe(true);
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
      const { g, coup, income } = table({ a: ['contessa', 'captain'], b: ['duke', 'duke'], c: ['duke', 'assassin'] });
      coup('a', 'c', 'duke');
      income('b', 'c');
      chooseAction(g, 'a', 'tax');
      expect(decide(g, 'b', { random: seeded(seed) })).toEqual({ type: 'challenge' });
    }
  });

  it('被暗杀且只剩 1 点影响力、没有女伯爵：质疑或假装女伯爵阻挡，不放弃', () => {
    const ways = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const random = seeded(seed);
      const temperament = drawTemperament(random);
      const { g, events, did, coup, income } = table({ a: ['assassin', 'duke'], b: ['captain', 'ambassador'], c: ['duke', 'duke'] });
      coup('a', 'b', 'ambassador');
      income('b', 'c');
      seat(g, 'a').coins = 3;
      did(chooseAction(g, 'a', 'assassinate', 'b'));
      const first = decide(g, 'b', { events, temperament, random })!;
      ways.add(first.type);
      if (first.type === 'challenge') continue;
      did(apply(g, 'b', first));
      did(passChallenge(g, 'c'));
      expect(g.phase).toBe('awaitingBlock');
      expect(decide(g, 'b', { events, temperament, random })).toEqual({ type: 'block', role: 'contessa' });
    }
    expect([...ways].sort()).toEqual(['challenge', 'passChallenge']);
  });

  it('被暗杀且只剩 1 点影响力：女伯爵 3 张都亮在桌上、别人的质疑已失败，仍假装女伯爵阻挡而不放弃', () => {
    const { g, events, did, coup } = table({ a: ['assassin', 'contessa'], b: ['captain', 'contessa'], c: ['duke', 'contessa'] });
    coup('a', 'b', 'contessa');
    coup('b', 'c', 'contessa');
    coup('c', 'a', 'contessa');
    seat(g, 'a').coins = 3;
    did(chooseAction(g, 'a', 'assassinate', 'b'));
    did(challenge(g, 'c'));
    did(revealShowdownCard(g, 'a', cardOf(g, 'a', 'assassin')));
    did(resolveLoss(g, 'c', cardOf(g, 'c', 'duke')));
    expect(g.phase).toBe('awaitingBlock');
    for (let seed = 0; seed < 50; seed++) {
      expect(decide(g, 'b', { events, random: seeded(seed) })).toEqual({ type: 'block', role: 'contessa' });
    }
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
        if (ids.slice(1).some((id) => decide(g, id, { temperament: EVEN, random })?.type === 'challenge')) challenged++;
      }
      return challenged / 4000;
    };
    const two = rate(2);
    const six = rate(6);
    expect(two).toBeGreaterThan(0.02);
    expect(Math.abs(two - six)).toBeLessThan(0.015);
  });

  it('质疑看证据：对方本局被抓过诈唬则更怀疑，声称被证明过则更相信', () => {
    // a 先偷 c（c 质疑或不质疑），各走一手后 a 收税：数 b 质疑这次收税的次数
    const challengesOfTax = (aHand: Role[], challenged: boolean) => {
      const { g, events, did, unopposed, income } = table({ a: aHand, b: ['assassin', 'contessa'], c: ['ambassador', 'ambassador'] });
      if (challenged) {
        did(chooseAction(g, 'a', 'steal', 'c'));
        did(challenge(g, 'c'));
        did(revealShowdownCard(g, 'a', seat(g, 'a').hand[1].id));
        // a 翻出队长：c 失去影响力，偷窃继续；否则 a 自己失去翻开的牌，行动作废
        if (g.phase === 'choosingLoss') {
          did(resolveLoss(g, 'c', seat(g, 'c').hand[0].id));
          did(passBlock(g, 'c'));
        }
      } else {
        unopposed('a', 'steal', 'c');
      }
      income('b', 'c');
      did(chooseAction(g, 'a', 'tax'));
      return tally(4000, byType, g, 'b', { events }).challenge;
    };
    const neutral = challengesOfTax(['duke', 'captain'], false);
    expect(challengesOfTax(['duke', 'contessa'], true)).toBeGreaterThan(neutral * 1.3);
    expect(challengesOfTax(['duke', 'captain'], true)).toBeLessThan(neutral * 0.8);
  });

  it('质疑看声称是否自相矛盾：仍作数的声称角色比暗牌多就更想质疑；同一角色声称几次、换牌后改口都不算', () => {
    // a 先走 before 里的几手（都没有人质疑），再收税：数 b 质疑这次收税的次数。同一个随机源，质疑概率相同则次数相同
    const challengesOfTax = (before: (t: Table) => void, aHand: Role[] = ['duke', 'duke']) => {
      const t = table({ a: aHand, b: ['contessa', 'contessa'], c: ['ambassador', 'ambassador'] });
      before(t);
      t.did(chooseAction(t.g, 'a', 'tax'));
      return tally(4000, byType, t.g, 'b', { events: t.events }).challenge;
    };
    // a 的一手，b 和 c 各收入一次
    const turn = (t: Table, action: ActionType) => {
      seat(t.g, 'a').coins = 3;
      if (action === 'income') t.income('a');
      else t.unopposed('a', action, action === 'tax' || action === 'exchange' ? undefined : 'c');
      if (t.g.phase === 'choosingLoss') t.did(resolveLoss(t.g, 'c', seat(t.g, 'c').hand[0].id));
      if (t.g.phase === 'choosingExchange') t.did(resolveExchange(t.g, 'a', seat(t.g, 'a').hand.slice(0, 2).map((card) => card.id)));
      t.income('b', 'c');
    };
    const after = (...actions: ActionType[]) => challengesOfTax((t) => actions.forEach((action) => turn(t, action)));

    const first = after('income', 'income');
    expect(after('tax', 'tax')).toBe(first); // 连续声称同一角色：不更可疑，也不更可信
    expect(after('income', 'steal')).toBe(first); // 2 个角色、2 张暗牌：说得通
    expect(after('steal', 'assassinate')).toBeGreaterThan(first * 1.5); // 3 个角色、2 张暗牌
    expect(after('steal', 'assassinate', 'exchange')).toBe(first); // 换过牌，之前的声称不作数

    // a 只剩 1 张暗牌：声称过队长再声称公爵就是矛盾
    const lastCard = (stole: boolean) =>
      challengesOfTax(
        (t) => {
          if (stole) t.unopposed('a', 'steal', 'c');
          else t.income('a');
          t.coup('b', 'a', 'contessa');
          t.income('c');
        },
        ['duke', 'contessa'],
      );
    expect(lastCard(true)).toBeGreaterThan(lastCard(false) * 1.5);
  });

  it('被证明为真的信用有上限，眼前的矛盾盖得过它', () => {
    // a 的收税 3 次被质疑、都证明为真（c 两次、b 一次），或 a 政变 c 两次、b 一次（没有证明）：两边都剩下 a 和只有 1 张暗牌的 b。
    // 再数 b 质疑 a 收税的次数
    const challengesOfTax = (proven: boolean, contradiction: boolean) => {
      const { g, events, did, coup, income, unopposed } = table({ a: ['duke', 'duke'], b: ['contessa', 'contessa'], c: ['ambassador', 'ambassador'] });
      for (const rival of ['c', 'c', 'b']) {
        if (proven) {
          seat(g, 'a').hand[0].role = 'duke'; // 上次证明后换来什么牌由测试指定
          did(chooseAction(g, 'a', 'tax'));
          did(challenge(g, rival));
          did(revealShowdownCard(g, 'a', cardOf(g, 'a', 'duke')));
          did(resolveLoss(g, rival, seat(g, rival).hand[0].id));
        } else {
          coup('a', rival, seat(g, rival).hand[0].role);
        }
        income(...['b', 'c'].filter((id) => seat(g, id).alive));
      }
      expect(g.players.map((p) => p.hand.length)).toEqual([2, 1, 0]);
      seat(g, 'a').coins = 2; // 离 10 金币的强制政变远一点
      if (contradiction) {
        // a 偷 b（队长），再用大使阻挡 b 的偷窃，接着收税（公爵）：3 个角色、2 张暗牌
        unopposed('a', 'steal', 'b');
        did(chooseAction(g, 'b', 'steal', 'a'));
        did(passChallenge(g, 'a'));
        did(block(g, 'a', 'ambassador'));
        did(passChallenge(g, 'b'));
      }
      did(chooseAction(g, 'a', 'tax'));
      return tally(4000, byType, g, 'b', { events }).challenge;
    };
    const fresh = challengesOfTax(false, false);
    const trusted = challengesOfTax(true, false);
    expect(trusted).toBeLessThan(fresh);
    expect(trusted).toBeGreaterThan(fresh * 0.5); // 证明 3 次、每次打七五折：不设上限就只剩四成
    expect(challengesOfTax(true, true)).toBeGreaterThan(fresh * 1.2);
  });

  it('质疑看代价：冲着自己来的行动比与己无关的更想质疑，只剩 1 点影响力时更谨慎，偷不走金币的偷窃不算代价', () => {
    const challengesOfSteal = (target: string, before = (_t: Table) => {}) => {
      const t = table({ b: ['duke', 'contessa'] });
      before(t);
      t.did(chooseAction(t.g, 'a', 'steal', target));
      return tally(4000, byType, t.g, 'b', { events: t.events }).challenge;
    };
    const bystander = challengesOfSteal('c');
    const victim = challengesOfSteal('b');
    // 被偷的人有代价，旁观的人那份没有依据的质疑还要再打折（BYSTANDER）：不打折时只差 3 倍左右
    expect(victim).toBeGreaterThan(bystander * 4);
    const lastCard = challengesOfSteal('b', ({ coup, income }) => {
      coup('a', 'b', 'contessa');
      income('b', 'c');
    });
    expect(lastCard).toBeLessThan(victim * 0.8);
    const broke = challengesOfSteal('b', ({ g }) => (seat(g, 'b').coins = 0));
    expect(broke).toBeLessThan(bystander * 1.3);
  });

  describe('结盟：c 替 b 质疑过冲着 b 来的偷窃，b 对 c 有了好感', () => {
    // a 没有队长却偷 b，challenger 质疑抓到它。b 自己质疑的那局是对照：只差替 b 出头的是不是 c
    const after = (challenger: string) => {
      const t = table({ a: ['duke', 'assassin'], b: ['duke', 'contessa'], c: ['ambassador', 'contessa'] });
      t.did(chooseAction(t.g, 'a', 'steal', 'b'));
      t.did(challenge(t.g, challenger));
      t.did(revealShowdownCard(t.g, 'a', cardOf(t.g, 'a', 'duke')));
      return t;
    };
    // 轮到 a 时它偷 c：b 质疑了多少次
    const challengesOfStealOnC = (t: Table) => {
      t.did(chooseAction(t.g, 'a', 'steal', 'c'));
      return tally(4000, byType, t.g, 'b', { events: t.events }).challenge;
    };
    const ally = after('c');
    ally.income('b', 'c');
    const none = after('b');
    none.income('b', 'c');
    const helped = challengesOfStealOnC(ally);
    const baseline = challengesOfStealOnC(none);

    it('冲着 c 来的偷窃，b 更想质疑', () => {
      expect(helped).toBeGreaterThan(baseline * 2);
    });

    it('b 政变时少打 c', () => {
      const coupsOnC = (t: Table) => {
        seat(t.g, 'b').coins = 10;
        return tally(4000, byTarget, t.g, 'b', { events: t.events }).c;
      };
      expect(coupsOnC(after('c'))).toBeLessThan(coupsOnC(after('b')) * 0.8);
    });

    it('c 之后偷了 b，好感就没了', () => {
      const t = after('c');
      t.income('b');
      t.unopposed('c', 'steal', 'b');
      expect(challengesOfStealOnC(t)).toBe(baseline);
    });

    // 好感是相互的：c 料到 b 对它有好感，自己对 b 也有一点。stealFirst：c 先偷 b 一次，两局都偷，只差 c 出没出过头
    const coupsByCOnB = (challenger: string, stealFirst = false) => {
      const t = after(challenger);
      t.income('b');
      if (stealFirst) {
        t.unopposed('c', 'steal', 'b');
        t.income('a', 'b');
      }
      seat(t.g, 'c').coins = 10;
      seat(t.g, 'a').coins = 9; // a 少 1 点影响力，用金币补上，两个目标才不相上下
      return tally(4000, byTarget, t.g, 'c', { events: t.events }).b;
    };

    it('c 政变时也少打 b，只是没有 b 少打 c 那么多', () => {
      expect(coupsByCOnB('c')).toBeLessThan(coupsByCOnB('b') * 0.9);
    });

    it('c 之后偷了 b，c 对 b 的好感也没了', () => {
      expect(coupsByCOnB('c', true)).toBe(coupsByCOnB('b', true));
    });
  });

  it('没有对应角色时按诈唬倾向决定是否假装阻挡', () => {
    const g = game({ a: ['captain', 'duke'], b: ['duke', 'contessa'] });
    chooseAction(g, 'a', 'steal', 'b');
    passChallenge(g, 'b');
    passChallenge(g, 'c');
    expect(tally(300, byType, g, 'b', { temperament: CALM })).toEqual({ passBlock: 300 });
    const bold = tally(300, byType, g, 'b', { temperament: BOLD });
    expect(bold.block).toBeGreaterThan(30);
    expect(bold.passBlock).toBeGreaterThan(30);
  });

  it('声称过队长的接着假装队长阻挡偷窃；自己没有金币可偷时不必假装', () => {
    const { g, events, did, unopposed, income } = table({ a: ['captain', 'duke'], b: ['duke', 'contessa'] });
    income('a');
    unopposed('b', 'steal', 'c');
    income('c');
    did(chooseAction(g, 'a', 'steal', 'b'));
    did(passChallenge(g, 'b'));
    did(passChallenge(g, 'c'));
    expect(tally(300, byType, g, 'b', { events, temperament: BOLD })).toEqual({ block: 300 });
    seat(g, 'b').coins = 0;
    expect(tally(300, byType, g, 'b', { events, temperament: BOLD })).toEqual({ passBlock: 300 });
  });

  it('当众没挡过偷窃的不再装队长、大使：不诈称偷窃和交换，也不假装阻挡；换过牌就又会装', () => {
    const { g, events, did, unopposed, income } = table({ a: ['captain', 'duke'], b: ['duke', 'contessa'] });
    unopposed('a', 'steal', 'b');
    const actions = () => Object.keys(tally(1000, byAction, g, 'b', { events, temperament: BOLD }));
    expect(actions()).not.toContain('steal');
    expect(actions()).not.toContain('exchange');
    income('b', 'c');
    did(chooseAction(g, 'a', 'steal', 'b'));
    did(passChallenge(g, 'b'));
    did(passChallenge(g, 'c'));
    expect(tally(300, byType, g, 'b', { events, temperament: BOLD })).toEqual({ passBlock: 300 });
    did(passBlock(g, 'b'));
    unopposed('b', 'exchange');
    did(resolveExchange(g, 'b', seat(g, 'b').hand.slice(0, 2).map((card) => card.id)));
    income('c', 'a');
    expect(actions()).toContain('steal');
  });

  it('质疑看对方当众没挡过的角色：没挡外援再收税、没挡偷窃再偷，都更想质疑；对质输了付的影响力不算没挡暗杀', () => {
    // a 先走一手，b 收入，c 再声称：数 b 质疑 c 的次数
    const challengesOfC = (aFirst: (t: Table) => void, cAction: ActionType) => {
      const t = table({ a: ['assassin', 'assassin'], b: ['contessa', 'contessa'], c: ['ambassador', 'ambassador'] });
      aFirst(t);
      t.income('b');
      t.did(chooseAction(t.g, 'c', cAction, cAction === 'steal' ? 'a' : undefined));
      return tally(4000, byType, t.g, 'b', { events: t.events }).challenge;
    };
    const quiet = (t: Table) => t.income('a');
    const foreignAid = ({ g, did }: Table) => {
      did(chooseAction(g, 'a', 'foreignAid'));
      did(passBlock(g, 'b'));
      did(passBlock(g, 'c'));
    };
    expect(challengesOfC(foreignAid, 'tax')).toBeGreaterThan(challengesOfC(quiet, 'tax') * 1.5);
    expect(challengesOfC((t) => t.unopposed('a', 'steal', 'c'), 'steal')).toBeGreaterThan(challengesOfC(quiet, 'steal') * 1.5);

    // c 先失去 1 点影响力（被政变，或质疑 a 的暗杀输了），再挡 a 的暗杀：b 质疑这个女伯爵的次数一样
    const challengesOfContessa = (lostChallenge: boolean) => {
      const { g, events, did, coup, income } = table({ a: ['assassin', 'duke'], b: ['captain', 'captain'], c: ['ambassador', 'duke'] });
      if (!lostChallenge) {
        coup('a', 'c', 'ambassador');
        income('b', 'c');
      }
      seat(g, 'a').coins = 3;
      did(chooseAction(g, 'a', 'assassinate', 'c'));
      if (lostChallenge) {
        did(challenge(g, 'c'));
        did(revealShowdownCard(g, 'a', cardOf(g, 'a', 'assassin')));
        did(resolveLoss(g, 'c', cardOf(g, 'c', 'ambassador')));
      } else {
        did(passChallenge(g, 'b'));
        did(passChallenge(g, 'c'));
      }
      did(block(g, 'c', 'contessa'));
      return tally(4000, byType, g, 'b', { events }).challenge;
    };
    expect(challengesOfContessa(true)).toBe(challengesOfContessa(false));
  });

  it('质疑看对方自己丢掉的角色：b 挨政变时亮出公爵，再收税就更想质疑；换过牌就不算', () => {
    // c 政变 b、b 亮出 lost，各走一手后 b 收税：数 a 质疑的次数
    const challengesOfTax = (lost: Role, exchanged = false) => {
      const { g, events, did, coup, income, unopposed } = table({ a: ['captain', 'contessa'], b: ['duke', 'assassin'] });
      income('a', 'b');
      coup('c', 'b', lost);
      income('a');
      if (exchanged) {
        unopposed('b', 'exchange');
        did(resolveExchange(g, 'b', [seat(g, 'b').hand[0].id]));
        income('c', 'a');
      }
      did(chooseAction(g, 'b', 'tax'));
      return tally(4000, byType, g, 'a', { events }).challenge ?? 0;
    };
    const kept = challengesOfTax('assassin');
    const discarded = challengesOfTax('duke');
    expect(discarded).toBeGreaterThan(kept * 4); // 亮出的公爵本身只让质疑翻倍
    expect(challengesOfTax('duke', true)).toBeLessThan(discarded * 0.5);
  });

  it('自己丢掉的角色不装：亮出公爵失去影响力后不诈称收税', () => {
    const { g, events, coup, income } = table({ a: ['duke', 'contessa'] });
    income('a');
    coup('b', 'a', 'duke');
    income('c');
    expect(tally(1000, byAction, g, 'a', { events, temperament: BOLD }).tax).toBeUndefined();

    // a 亮出 lost 后挨 c 偷：丢掉的是队长就改装大使，假装阻挡的次数不少于丢掉女伯爵、两个都能装的时候
    const fakeBlocks = (aHand: Role[], lost: Role) => {
      const t = table({ a: aHand });
      t.income('a');
      t.coup('b', 'a', lost);
      t.did(chooseAction(t.g, 'c', 'steal', 'a'));
      t.did(passChallenge(t.g, 'a'));
      t.did(passChallenge(t.g, 'b'));
      return tally(1000, (i) => (i.type === 'block' ? i.role : i.type), t.g, 'a', { events: t.events, temperament: BOLD });
    };
    const discardedCaptain = fakeBlocks(['captain', 'duke'], 'captain');
    expect(discardedCaptain.captain).toBeUndefined();
    expect(discardedCaptain.ambassador).toBeGreaterThan(0.8 * (1000 - fakeBlocks(['contessa', 'duke'], 'contessa').passBlock));
  });

  it('本局声称过的角色被优先再次声称，越爱诈唬越常接着演，从不诈唬的不演', () => {
    const { g, events, unopposed, income } = table({ a: ['contessa', 'contessa'] });
    unopposed('a', 'tax');
    income('b', 'c');
    const { tax = 0, steal = 0, assassinate = 0, exchange = 0 } = tally(1000, byAction, g, 'a', { events });
    expect(steal + assassinate + exchange).toBeGreaterThan(0); // 还会起别的诈唬，只是少得多
    expect(tax).toBeGreaterThan(1.5 * (steal + assassinate + exchange));
    const timid = tally(1000, byAction, g, 'a', { events, temperament: { ...EVEN, bluff: 0.1 } }).tax;
    expect(timid).toBeLessThan(0.7 * tally(1000, byAction, g, 'a', { events, temperament: BOLD }).tax);
    expect(tally(1000, byAction, g, 'a', { events, temperament: CALM }).tax).toBeUndefined();
  });

  it('声称被对质证明为真后牌已换走：不再把它当作自己的牌', () => {
    const afterTax = (challenged: boolean) => {
      const { g, events, did, unopposed, income } = table({ a: ['duke', 'contessa'], b: ['captain', 'captain'] });
      if (challenged) {
        did(chooseAction(g, 'a', 'tax'));
        did(challenge(g, 'b'));
        did(revealShowdownCard(g, 'a', cardOf(g, 'a', 'duke')));
        seat(g, 'a').hand[0].role = 'contessa'; // 换来什么牌由测试指定
        did(resolveLoss(g, 'b', seat(g, 'b').hand[0].id));
      } else {
        unopposed('a', 'tax');
      }
      income('b', 'c');
      return tally(300, byAction, g, 'a', { events, temperament: CALM }).tax;
    };
    expect(afterTax(false)).toBeGreaterThan(0);
    expect(afterTax(true)).toBeUndefined();
  });

  it('交换之后手里是什么牌没人知道：换走的角色不再照旧声称', () => {
    const { g, events, did, unopposed, income } = table({ a: ['duke', 'ambassador'] });
    unopposed('a', 'tax');
    income('b', 'c');
    unopposed('a', 'exchange');
    const [duke, ambassador, ...drawn] = seat(g, 'a').hand;
    drawn.forEach((card) => (card.role = 'contessa')); // 摸到什么由测试指定
    did(resolveExchange(g, 'a', drawn.map((card) => card.id)));
    expect([duke.role, ambassador.role]).toEqual(['duke', 'ambassador']);
    income('b', 'c');
    expect(Object.keys(tally(300, byAction, g, 'a', { events, temperament: CALM })).sort()).toEqual(['foreignAid', 'income']);
  });

  it('故事上限是 3 个角色：故事里的加手里有的凑到 3 个后不再起新的诈唬', () => {
    const { g, events, unopposed, income } = table({ a: ['contessa', 'contessa'] });
    unopposed('a', 'tax');
    income('b', 'c');
    unopposed('a', 'steal', 'c');
    income('b', 'c');
    seat(g, 'a').coins = 3;
    expect(Object.keys(tally(1000, byAction, g, 'a', { events, temperament: KEEN })).sort()).toEqual(['foreignAid', 'income', 'steal', 'tax']);
  });

  it('极爱诈唬的故事上限放宽到 4 个角色：会起第 4 个角色的诈唬，不起第 5 个', () => {
    const { g, events, did, unopposed, income } = table({ a: ['contessa', 'contessa'] });
    unopposed('a', 'tax');
    income('b', 'c');
    unopposed('a', 'steal', 'c');
    income('b', 'c');
    seat(g, 'a').coins = 3;
    expect(Object.keys(tally(1000, byAction, g, 'a', { events, temperament: BOLD })).sort()).toEqual(['assassinate', 'exchange', 'foreignAid', 'income', 'steal', 'tax']);
    unopposed('a', 'assassinate', 'b');
    did(resolveLoss(g, 'b', seat(g, 'b').hand[0].id));
    income('b', 'c');
    seat(g, 'a').coins = 3;
    expect(Object.keys(tally(1000, byAction, g, 'a', { events, temperament: BOLD })).sort()).toEqual(['assassinate', 'foreignAid', 'income', 'steal', 'tax']);
  });

  it('声称被对质检验过、不再作数，仍算在故事里：不腾出位置给新的诈唬', () => {
    const { g, events, did, unopposed, income } = table({ a: ['duke', 'captain'], b: ['assassin', 'assassin'] });
    unopposed('a', 'tax');
    income('b', 'c');
    unopposed('a', 'steal', 'c');
    income('b', 'c');
    seat(g, 'a').coins = 2;
    did(chooseAction(g, 'a', 'tax'));
    did(challenge(g, 'b'));
    did(revealShowdownCard(g, 'a', cardOf(g, 'a', 'duke')));
    seat(g, 'a').hand[0].role = 'contessa'; // 换来什么牌由测试指定
    did(resolveLoss(g, 'b', seat(g, 'b').hand[0].id));
    income('b', 'c');
    expect(seat(g, 'a').coins).toBe(5);
    expect(Object.keys(tally(1000, byAction, g, 'a', { events, temperament: KEEN })).sort()).toEqual(['foreignAid', 'income', 'steal']);
  });

  it('自己实际换牌后故事重新计数：换牌前声称过 3 个角色，摸到的真牌照样拿来行动', () => {
    const { g, events, did, unopposed, income } = table({ a: ['duke', 'captain'] });
    unopposed('a', 'tax');
    income('b', 'c');
    unopposed('a', 'steal', 'c');
    income('b', 'c');
    seat(g, 'a').coins = 3;
    unopposed('a', 'exchange');
    const drawn = seat(g, 'a').hand.slice(2);
    drawn[0].role = 'assassin'; // 摸到什么由测试指定
    drawn[1].role = 'contessa';
    did(resolveExchange(g, 'a', drawn.map((card) => card.id)));
    income('b', 'c');
    expect(Object.keys(tally(1000, byAction, g, 'a', { events, temperament: CALM })).sort()).toEqual(['assassinate', 'foreignAid', 'income']);
  });

  it('只宣布交换、被质疑抓到没换成：故事不重置，已声称过 3 个角色后手里真有的新角色也不拿来行动', () => {
    const { g, events, did, unopposed, income } = table({ a: ['duke', 'assassin'], b: ['contessa', 'contessa'] });
    unopposed('a', 'tax');
    income('b', 'c');
    unopposed('a', 'steal', 'c');
    income('b', 'c');
    did(chooseAction(g, 'a', 'exchange'));
    did(challenge(g, 'b'));
    did(revealShowdownCard(g, 'a', cardOf(g, 'a', 'duke')));
    income('b', 'c');
    expect(seat(g, 'a').hand.map((c) => c.role)).toEqual(['assassin']);
    seat(g, 'a').coins = 3; // 够暗杀，不够政变
    expect(Object.keys(tally(1000, byAction, g, 'a', { events, temperament: KEEN })).sort()).toEqual(['foreignAid', 'income', 'steal']);
  });

  it('选目标：优先打领先者（金币多、影响力多），但不是每次', () => {
    const richer = game();
    seat(richer, 'a').coins = 10; // 10 金币必政变：只看选谁
    seat(richer, 'b').coins = 6;
    const counts = tally(1000, byTarget, richer, 'a');
    expect(counts.b).toBeGreaterThan(700);
    expect(counts.c).toBeGreaterThan(0);

    const { g, events, coup, income } = table({ c: ['duke', 'captain'] });
    income('a');
    coup('b', 'c', 'duke');
    income('c');
    for (const p of g.players) p.coins = p.id === 'a' ? 10 : 2;
    expect(tally(1000, byTarget, g, 'a', { events }).b).toBeGreaterThan(700);
  });

  it('选目标：对最近打过自己的玩家有报复倾向', () => {
    // c 偷了 victim 之后轮到 a 政变，b 和 c 金币、影响力都一样
    const coupsOnC = (victim: string) => {
      const { g, events, unopposed, income } = table();
      income('a', 'b');
      unopposed('c', 'steal', victim);
      for (const p of g.players) p.coins = p.id === 'a' ? 10 : 2;
      return tally(1000, byTarget, g, 'a', { events }).c;
    };
    expect(coupsOnC('b')).toBeLessThan(600);
    expect(coupsOnC('a')).toBeGreaterThan(700);
  });

  it('选目标：挡过偷窃、暗杀的人不打，还有别人可打时打别人，他领先也一样；只剩他可打时少做这个行动', () => {
    // c 声称 role 挡下 a 的 action
    const blockedBy = ({ g, did }: Table, action: 'steal' | 'assassinate', role: Role) => {
      if (action === 'assassinate') seat(g, 'a').coins = 3;
      did(chooseAction(g, 'a', action, 'c'));
      for (const id of ['b', 'c']) if (seat(g, id).alive) did(passChallenge(g, id));
      did(block(g, 'c', role));
      for (const id of ['a', 'b']) if (seat(g, id).alive) did(passChallenge(g, id));
    };
    const hands = { a: ['captain', 'assassin'] as Role[], b: ['ambassador', 'ambassador'] as Role[], c: ['captain', 'contessa'] as Role[] };

    const threeWay = table(hands);
    blockedBy(threeWay, 'steal', 'captain');
    threeWay.income('b', 'c');
    for (const p of threeWay.g.players) p.coins = p.id === 'c' ? 6 : 2;
    const targets = tally(2000, (i) => (i.type === 'chooseAction' && i.targetId ? `${i.action}→${i.targetId}` : i.type), threeWay.g, 'a', { events: threeWay.events });
    expect(targets['steal→b']).toBeGreaterThan(0);
    expect(targets['steal→c']).toBeUndefined();

    // b 被 a 政变两次出局，只剩 a 和 c；c 挡过（或没挡过）a 的 action 后轮到 a，两人都有 3 金币
    const duel = (action: 'steal' | 'assassinate', blocked: boolean) => {
      const t = table(hands);
      t.coup('a', 'b', 'ambassador');
      t.income('b', 'c');
      t.coup('a', 'b', 'ambassador');
      t.income('c');
      if (blocked) blockedBy(t, action, action === 'steal' ? 'captain' : 'contessa');
      else t.income('a');
      t.income('c');
      for (const p of t.g.players) p.coins = 3;
      return tally(2000, byAction, t.g, 'a', { events: t.events })[action] ?? 0;
    };
    expect(duel('steal', true)).toBeLessThan(duel('steal', false) * 0.4);
    expect(duel('steal', true)).toBeGreaterThan(0); // 他可能是装的：偶尔还试
    expect(duel('assassinate', true)).toBeLessThan(duel('assassinate', false) * 0.4);
  });

  it('外援：有公爵的大多阻挡、偶尔藏着不挡，没有的放弃', () => {
    const g = game({ b: ['duke', 'captain'], c: ['contessa', 'captain'] });
    chooseAction(g, 'a', 'foreignAid');
    expect(decide(g, 'a')).toBeNull();
    const c = decide(g, 'c');
    expect(c).toEqual({ type: 'passBlock' });
    apply(g, 'c', c!);
    const { block: blocks, passBlock: passes } = tally(1000, byType, g, 'b');
    expect(blocks).toBeGreaterThan(700);
    expect(passes).toBeGreaterThan(100);
    apply(g, 'b', { type: 'block', role: 'duke' });
    expect(g.phase).toBe('awaitingChallenge');
  });

  it('外援：仍作数地声称过公爵的，手里有公爵就必挡', () => {
    const t = table({ b: ['duke', 'captain'] });
    t.income('a');
    t.unopposed('b', 'tax');
    t.income('c');
    t.did(chooseAction(t.g, 'a', 'foreignAid'));
    expect(tally(1000, byType, t.g, 'b', { events: t.events })).toEqual({ block: 1000 });
  });

  it('有人仍作数地声称过公爵时少做外援：比收入还少；没人声称时比收入多', () => {
    const hands = { a: ['contessa', 'ambassador'] as Role[] };
    const quiet = table(hands);
    quiet.income('a', 'b', 'c');
    const duke = table(hands);
    duke.income('a');
    duke.unopposed('b', 'tax');
    duke.income('c');
    const calm = tally(1000, byAction, quiet.g, 'a', { events: quiet.events, temperament: CALM });
    const wary = tally(1000, byAction, duke.g, 'a', { events: duke.events, temperament: CALM });
    expect(calm.foreignAid).toBeGreaterThan(calm.income);
    expect(wary.foreignAid).toBeLessThan(wary.income * 0.8);
    expect(wary.foreignAid).toBeGreaterThan(0);
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
      const intent = decide(g, 'a', { random: seeded(seed) });
      expect(intent).toEqual({ type: 'revealShowdownCard', cardId: g.players[0].hand[1].id });
      expect(() => apply(g, 'a', intent!)).not.toThrow();
    }
  });

  it.each([
    { claimed: 'assassin' as Role, action: 'assassinate' as const, lost: 'captain' as Role },
    { claimed: 'captain' as Role, action: 'steal' as const, lost: 'assassin' as Role },
  ])('失去影响力：留下本局一直在声称的 $claimed', ({ action, lost }) => {
    const { g, events, did, unopposed } = table({ a: ['captain', 'assassin'] });
    seat(g, 'a').coins = 3;
    unopposed('a', action, 'b');
    if (g.phase === 'choosingLoss') did(resolveLoss(g, 'b', seat(g, 'b').hand[0].id));
    seat(g, 'b').coins = COUP_COST;
    did(chooseAction(g, 'b', 'coup', 'a'));
    for (let seed = 0; seed < 20; seed++) {
      const intent = decide(g, 'a', { events, temperament: EVEN, random: seeded(seed) });
      expect(intent).toEqual({ type: 'resolveLoss', cardId: cardOf(g, 'a', lost) });
    }
  });

  it.each([
    { hand: ['ambassador', 'contessa'] as Role[], drawn: ['duke', 'captain'] as Role[], kept: ['captain', 'duke'] },
    { hand: ['duke', 'duke'] as Role[], drawn: ['ambassador', 'captain'] as Role[], kept: ['captain', 'duke'] }, // 不留两张一样的
  ])('交换选牌：留下更有用的牌 $hand 摸到 $drawn', ({ hand, drawn, kept }) => {
    const { g, events, unopposed } = table({ a: hand });
    unopposed('a', 'exchange');
    seat(g, 'a').hand.slice(2).forEach((card, i) => (card.role = drawn[i])); // 摸到什么由测试指定
    const intent = decide(g, 'a', { events });
    if (intent?.type !== 'resolveExchange') throw new Error(`unexpected ${JSON.stringify(intent)}`);
    expect(intent.keepIds.map((id) => seat(g, 'a').hand.find((c) => c.id === id)!.role).sort()).toEqual(kept);
    expect(() => apply(g, 'a', intent)).not.toThrow();
  });

  describe('两人对峙、只剩 1 点影响力、对手快要政变时会挣扎', () => {
    // 只剩 a 和 b 两人、轮到 b：c 被 a 政变两次出局。决定的是 b，可能政变它的是 a。
    // lose：b 再挨 a 一次政变亮出的牌，之后只剩 1 点影响力；不给就还有 2 点
    const duel = (bHand: Role[], lose?: Role) => {
      const t = table({ b: bHand, c: ['ambassador', 'ambassador'] });
      t.coup('a', 'c', 'ambassador');
      t.income('b', 'c');
      t.coup('a', 'c', 'ambassador');
      if (lose) {
        t.income('b');
        t.coup('a', 'b', lose);
      }
      return t;
    };
    const coins = (t: Table, a: number, b: number) => {
      seat(t.g, 'a').coins = a;
      seat(t.g, 'b').coins = b;
    };
    // b 有 3 金币（够暗杀）、a 有 aCoins 时，b 选各种行动的次数
    const actions = (t: Table, aCoins: number) => {
      coins(t, aCoins, 3);
      return tally(2000, byAction, t.g, 'b', { events: t.events });
    };
    const withAssassin = () => duel(['assassin', 'contessa'], 'contessa');
    const withCaptain = () => duel(['captain', 'contessa'], 'contessa');
    const fights = (counts: Record<string, number>) => (counts.steal ?? 0) + (counts.assassinate ?? 0);

    it('对手金币够政变：更常暗杀和偷窃，手里没有也更常装；对手 9 金币时偷了也拦不住政变，不为此多偷', () => {
      const level = 3; // 金币一样多：没有风险
      expect(actions(withAssassin(), 9).assassinate).toBeGreaterThan(actions(withAssassin(), level).assassinate * 1.3);
      const calm = actions(withCaptain(), level);
      const cornered = actions(withCaptain(), 7);
      expect(cornered.steal).toBe(2000); // a 还有 2 点影响力：暗杀拦不住政变，偷完他不够政变才拦得住
      const tooRich = actions(withCaptain(), 9);
      expect(tooRich.steal).toBeLessThan(calm.steal);
      expect(tooRich.assassinate).toBeGreaterThan(calm.assassinate * 1.5);
    });

    it('对手金币领先：他会先攒够政变，也算风险，只是小一些', () => {
      const behind = fights(actions(withCaptain(), 5));
      expect(behind).toBeGreaterThan(fights(actions(withCaptain(), 3)) * 1.15);
      expect(behind).toBeLessThan(fights(actions(withCaptain(), 7)));
    });

    it('还有 2 点影响力，或不止两人对峙：对手金币够政变也照常行动', () => {
      const twoCards = () => duel(['assassin', 'captain']);
      expect(actions(twoCards(), 7)).toEqual(actions(twoCards(), 3));
      const threeWay = () => {
        const t = table({ b: ['captain', 'contessa'] });
        t.coup('a', 'b', 'contessa');
        return t;
      };
      expect(actions(threeWay(), 7)).toEqual(actions(threeWay(), 3));
    });

    it('更想质疑对手：他阻挡自己的偷窃，或金币领先时收税；还有 2 点影响力时照常', () => {
      // b 偷 a，a 声称队长阻挡：数 b 质疑这次阻挡的次数。b 有 6 金币，a 有 4 金币时不领先
      const challengesOfBlock = (t: Table, aCoins: number) => {
        coins(t, aCoins, 6);
        t.did(chooseAction(t.g, 'b', 'steal', 'a'));
        t.did(passChallenge(t.g, 'a'));
        t.did(block(t.g, 'a', 'captain'));
        return tally(4000, byType, t.g, 'b', { events: t.events }).challenge;
      };
      expect(challengesOfBlock(withCaptain(), 7)).toBeGreaterThan(challengesOfBlock(withCaptain(), 4) * 2.5);
      const twoCards = () => duel(['captain', 'contessa']);
      expect(challengesOfBlock(twoCards(), 7)).toBe(challengesOfBlock(twoCards(), 4));

      // a 收税：数 b 质疑的次数。b 有 4 金币
      const challengesOfTax = (aCoins: number) => {
        const t = withCaptain();
        t.income('b');
        coins(t, aCoins, 4);
        t.did(chooseAction(t.g, 'a', 'tax'));
        return tally(4000, byType, t.g, 'b', { events: t.events }).challenge;
      };
      expect(challengesOfTax(6)).toBeGreaterThan(challengesOfTax(3) * 1.5);
    });

    it('走投无路时只做拦得住政变的事：a 还有 2 点影响力时政变、暗杀都拦不住，只偷；3 张队长都亮在桌上就偷不成', () => {
      const t = withAssassin();
      coins(t, 7, 8);
      expect(tally(2000, byAction, t.g, 'b', { events: t.events })).toEqual({ steal: 2000 });
      // c 和 b 被政变时亮出了 3 张队长：装队长必被质疑，没有拦得住的事，照常行动
      const shown = table({ b: ['assassin', 'captain'], c: ['captain', 'captain'] });
      shown.coup('a', 'c', 'captain');
      shown.income('b', 'c');
      shown.coup('a', 'c', 'captain');
      shown.income('b');
      shown.coup('a', 'b', 'captain');
      coins(shown, 7, 8);
      const counts = tally(2000, byAction, shown.g, 'b', { events: shown.events });
      expect(counts.steal).toBeUndefined();
      expect(counts.coup).toBeGreaterThan(1500);
    });

    it('放过就必输：a 外援后够政变、b 的回合拦不住时，b 有公爵不藏着，没有就装', () => {
      const blocks = (t: Table) => {
        t.income('b');
        coins(t, 7, 2);
        t.did(chooseAction(t.g, 'a', 'foreignAid'));
        return tally(2000, byType, t.g, 'b', { events: t.events });
      };
      expect(blocks(duel(['duke', 'contessa'], 'contessa'))).toEqual({ block: 2000 });
      expect(blocks(withCaptain())).toEqual({ block: 2000 });
    });
  });

  describe('两人对峙、对手只剩 1 点影响力、自己快要政变赢时求稳', () => {
    // 只剩 a 和 b 两人、轮到 a：c 被 b 政变两次出局。决定的是 b，它要政变的是 a。
    // aLoses：a 再挨 b 一次政变亮出公爵，只剩 1 点影响力；false 时还有 2 点
    const endgame = (aLoses = true) => {
      const t = table({ a: ['duke', 'captain'], b: ['assassin', 'contessa'], c: ['ambassador', 'ambassador'] });
      t.income('a');
      t.coup('b', 'c', 'ambassador');
      t.income('c', 'a');
      t.coup('b', 'c', 'ambassador');
      if (aLoses) {
        t.income('a');
        t.coup('b', 'a', 'duke');
      }
      return t;
    };
    const coins = (t: Table, a: number, b: number) => {
      seat(t.g, 'a').coins = a;
      seat(t.g, 'b').coins = b;
    };

    it('金币够政变就必政变', () => {
      const coups = (aLoses: boolean) => {
        const t = endgame(aLoses);
        t.income('a');
        coins(t, 0, 7);
        return tally(1000, byAction, t.g, 'b', { events: t.events }).coup;
      };
      expect(coups(true)).toBe(1000);
      expect(coups(false)).toBeLessThan(1000);
    });

    it('金币领先时少诈唬收税，也少假装阻挡', () => {
      // 轮到 b，b 有 5 金币：a 有 2 金币时 b 领先
      const taxes = (aCoins: number) => {
        const t = endgame();
        t.income('a');
        coins(t, aCoins, 5);
        return tally(4000, byAction, t.g, 'b', { events: t.events, temperament: KEEN }).tax;
      };
      expect(taxes(2)).toBeLessThan(taxes(5) * 0.85);
      // a 偷 b，b 没有队长和大使：数 b 假装阻挡的次数。a 有 3 金币
      const fakeBlocks = (bCoins: number) => {
        const t = endgame();
        coins(t, 3, bCoins);
        t.did(chooseAction(t.g, 'a', 'steal', 'b'));
        t.did(passChallenge(t.g, 'b'));
        return tally(4000, byType, t.g, 'b', { events: t.events, temperament: KEEN }).block;
      };
      expect(fakeBlocks(7)).toBeLessThan(fakeBlocks(3) * 0.4);
    });

    it('只为切身的代价质疑：a 收税少质疑，a 偷自己照样常质疑；a 还有 2 点影响力时照常', () => {
      // a 行动，数 b 质疑的次数。a 有 3 金币，b 有 7 金币时够政变
      const challenges = (bCoins: number, action: ActionType, aLoses = true) => {
        const t = endgame(aLoses);
        coins(t, 3, bCoins);
        t.did(chooseAction(t.g, 'a', action, action === 'steal' ? 'b' : undefined));
        return tally(4000, byType, t.g, 'b', { events: t.events }).challenge ?? 0;
      };
      expect(challenges(7, 'tax')).toBeLessThan(challenges(3, 'tax') * 0.4);
      expect(challenges(7, 'steal')).toBeGreaterThan(challenges(3, 'steal') * 0.5);
      expect(challenges(7, 'tax', false)).toBe(challenges(3, 'tax', false));
    });

    it('放过就必赢时不质疑、不假装阻挡：a 偷完 b 仍够政变', () => {
      const t = endgame();
      coins(t, 3, 9);
      t.did(chooseAction(t.g, 'a', 'steal', 'b'));
      expect(tally(2000, byType, t.g, 'b', { events: t.events, temperament: KEEN })).toEqual({ passChallenge: 2000 });
      t.did(passChallenge(t.g, 'b'));
      expect(tally(2000, byType, t.g, 'b', { events: t.events, temperament: KEEN })).toEqual({ passBlock: 2000 });
    });
  });

  describe('强电脑的牌堆记忆', () => {
    // a 手里两张公爵，c 挨政变亮出第三张；a 交换时留下摸到的两张、把两张公爵放回牌堆。之后 b 声称公爵收税
    function scene(drawBefore: boolean) {
      const t = table({ a: ['duke', 'duke'], b: ['captain', 'contessa'], c: ['duke', 'assassin'] });
      t.coup('a', 'c', 'duke');
      t.income('b', 'c');
      t.unopposed('a', 'exchange');
      const at = t.events.findIndex((e) => e.type === 'exchangeDrew');
      t.did(resolveExchange(t.g, 'a', seat(t.g, 'a').hand.slice(2).map((c) => c.id)));
      const returned = [{ at, roles: ['duke', 'duke'] as Role[] }];
      if (drawBefore) {
        // c 交换：从牌堆摸了 2 张，放回的两张公爵可能被摸走了
        t.income('b');
        t.unopposed('c', 'exchange');
        t.did(resolveExchange(t.g, 'c', seat(t.g, 'c').hand.slice(0, 1).map((c) => c.id)));
        t.income('a');
      }
      t.did(chooseAction(t.g, 'b', 'tax'));
      const challenges = (tuning: typeof STRONG, notes = returned) => {
        const random = seeded(5);
        let n = 0;
        for (let i = 0; i < 400; i++) {
          if (decideComputerIntent(publicState(t.g), privateState(t.g, 'a'), t.events, EVEN, random, tuning, notes)?.type === 'challenge') n++;
        }
        return n;
      };
      return challenges;
    }

    it('放回牌堆、还没人摸过牌：三张公爵都确知在哪，别人声称公爵必质疑；普通电脑不记', () => {
      const challenges = scene(false);
      expect(challenges(STRONG)).toBe(400);
      expect(challenges(STRONG, [])).toBeLessThan(400);
      expect(challenges(STANDARD)).toBeLessThan(400);
    });

    it('有人从牌堆摸过牌：只是多半还在，不再必质疑，但比不记时更想质疑', () => {
      const challenges = scene(true);
      expect(challenges(STRONG)).toBeLessThan(400);
      // 强电脑几乎不替别人质疑，看不出差别；拿普通电脑的参数开着记忆来比
      const remembering = { ...STANDARD, DECK_MEMORY: 1 };
      expect(challenges(remembering)).toBeLessThan(400);
      expect(challenges(remembering)).toBeGreaterThan(challenges(remembering, []));
    });
  });

  describe('保牌看眼前的威胁', () => {
    // 决定留牌的是 b，可能威胁它的是 c。c 手里是两张公爵：声称刺客或队长都是诈唬，被质疑就被抓到诈唬。
    // 下面每个函数是 c 的一手（连同 a、b 各收入一次），走完轮到 a
    const hands = (b: Role[]) => ({ b, c: ['duke', 'duke'] as Role[] });
    const cDoesNothing = (t: Table) => t.income('a', 'b', 'c');
    const cClaims = (action: 'assassinate' | 'steal') => (t: Table) => {
      t.income('a', 'b');
      seat(t.g, 'c').coins = 3;
      t.unopposed('c', action, 'a');
      if (t.g.phase === 'choosingLoss') t.did(resolveLoss(t.g, 'a', seat(t.g, 'a').hand[0].id));
    };
    const cIsCaughtClaiming = (action: 'assassinate' | 'steal') => (t: Table) => {
      t.income('a', 'b');
      seat(t.g, 'c').coins = 3;
      t.did(chooseAction(t.g, 'c', action, 'a'));
      t.did(challenge(t.g, 'a'));
      t.did(revealShowdownCard(t.g, 'c', seat(t.g, 'c').hand[0].id));
    };
    const cExchanges = (t: Table) => {
      t.income('a', 'b');
      t.unopposed('c', 'exchange');
      t.did(resolveExchange(t.g, 'c', seat(t.g, 'c').hand.slice(0, 2).map((card) => card.id)));
    };

    // b 拿 roles 里的一张配另外的每种角色、各换 25 种性格，被 a 政变时留下 roles 里那张的次数。同一个随机源：估值相同则次数相同
    const kept = (roles: Role[], moves: ((t: Table) => void)[], { bCoins = 2, cCoins = 3 } = {}) => {
      const random = seeded(5);
      let count = 0;
      for (const role of roles) {
        for (const other of ROLE_ORDER.filter((r) => !roles.includes(r))) {
          for (let i = 0; i < 25; i++) {
            const t = table(hands([role, other]));
            moves.forEach((move) => move(t));
            seat(t.g, 'a').coins = COUP_COST;
            t.did(chooseAction(t.g, 'a', 'coup', 'b'));
            seat(t.g, 'b').coins = bCoins;
            seat(t.g, 'c').coins = cCoins;
            const intent = decide(t.g, 'b', { events: t.events, temperament: drawTemperament(random), random });
            if (intent?.type !== 'resolveLoss') throw new Error(`unexpected ${JSON.stringify(intent)}`);
            if (intent.cardId !== cardOf(t.g, 'b', role)) count++;
          }
        }
      }
      return count;
    };

    it('暗杀威胁：有对手仍作数地声称刺客且金币够暗杀时更常留下女伯爵；对手被抓到诈唬、换过牌或金币不够，修正就消失', () => {
      const calm = kept(['contessa'], [cDoesNothing]);
      const threatened = kept(['contessa'], [cClaims('assassinate')]);
      expect(threatened).toBeGreaterThan(calm * 1.5);
      expect(threatened).toBeLessThan(100); // 是倾向不是规则：另一张更值钱时仍不留女伯爵
      expect(kept(['contessa'], [cIsCaughtClaiming('assassinate')])).toBe(calm);
      expect(kept(['contessa'], [cClaims('assassinate'), cExchanges])).toBe(calm);
      expect(kept(['contessa'], [cClaims('assassinate')], { cCoins: 2 })).toBe(calm);
    });

    it('偷窃威胁：有对手仍作数地声称队长且自己有金币可偷时更常留下大使或队长；对手被抓到诈唬、换过牌或自己没有金币，修正就消失', () => {
      const blockers: Role[] = ['captain', 'ambassador'];
      const calm = kept(blockers, [cDoesNothing]);
      const threatened = kept(blockers, [cClaims('steal')]);
      expect(threatened).toBeGreaterThan(calm * 1.5);
      expect(threatened).toBeLessThan(150);
      expect(kept(blockers, [cIsCaughtClaiming('steal')])).toBe(calm);
      expect(kept(blockers, [cClaims('steal'), cExchanges])).toBe(calm);
      expect(kept(blockers, [cClaims('steal')], { bCoins: 0 })).toBe(calm);
    });

    it('冲着自己来、还没结算的行动也是威胁：质疑它失败后，留下能阻挡它的牌', () => {
      // a 对 b 行动，challenger 质疑，a 证明为真。走到 b 失去影响力时，它亮出哪张
      const lost = (action: 'assassinate' | 'steal', bHand: Role[], challenger: 'b' | 'c', bCoins = 2) => {
        const { g, events, did } = table({ a: ['assassin', 'captain'], b: bHand, c: ['duke', 'duke'] });
        seat(g, 'a').coins = 3;
        seat(g, 'b').coins = bCoins;
        did(chooseAction(g, 'a', action, 'b'));
        did(challenge(g, challenger));
        did(revealShowdownCard(g, 'a', cardOf(g, 'a', ACTION_CLAIM[action]!)));
        if (challenger === 'c') {
          did(resolveLoss(g, 'c', seat(g, 'c').hand[0].id));
          did(passBlock(g, 'b'));
        }
        const intent = decide(g, 'b', { events });
        if (intent?.type !== 'resolveLoss') throw new Error(`unexpected ${JSON.stringify(intent)}`);
        return seat(g, 'b').hand.find((c) => c.id === intent.cardId)!.role;
      };
      // 接下来是阻挡窗口：留着女伯爵就能照实阻挡
      expect(lost('assassinate', ['contessa', 'captain'], 'b')).toBe('captain');
      expect(lost('assassinate', ['contessa', 'duke'], 'b')).toBe('duke'); // 公爵更值钱也丢它：这时不是倾向是规则
      // 质疑失败的是 c，b 没有阻挡：这张牌就是暗杀要走的，行动到此结算完，不再是威胁
      expect(lost('assassinate', ['contessa', 'captain'], 'c')).toBe('contessa');
      expect(lost('steal', ['ambassador', 'assassin'], 'b')).toBe('assassin');
      expect(lost('steal', ['ambassador', 'assassin'], 'b', 0)).toBe('ambassador'); // 没有金币可偷
    });

    it('对质翻牌也看威胁：手里没有被声称的角色，有暗杀威胁时翻开队长、留下女伯爵', () => {
      // b 诈唬收税被 a 质疑，手里没有公爵：它翻开哪张
      const turned = (move: (t: Table) => void) => {
        const t = table(hands(['captain', 'contessa']));
        move(t);
        t.income('a');
        t.did(chooseAction(t.g, 'b', 'tax'));
        t.did(challenge(t.g, 'a'));
        seat(t.g, 'c').coins = 3;
        const intent = decide(t.g, 'b', { events: t.events });
        if (intent?.type !== 'revealShowdownCard') throw new Error(`unexpected ${JSON.stringify(intent)}`);
        return seat(t.g, 'b').hand.find((c) => c.id === intent.cardId)!.role;
      };
      expect(turned(cDoesNothing)).toBe('contessa');
      expect(turned(cClaims('assassinate'))).toBe('captain');
    });

    it('交换选牌也看威胁：有暗杀威胁时女伯爵比队长值得留', () => {
      const keptRoles = (move: (t: Table) => void) => {
        const t = table(hands(['duke', 'contessa']));
        move(t);
        t.income('a');
        t.unopposed('b', 'exchange');
        const drawn = seat(t.g, 'b').hand.slice(2);
        drawn[0].role = 'captain'; // 摸到什么由测试指定
        drawn[1].role = 'ambassador';
        seat(t.g, 'c').coins = 3;
        const intent = decide(t.g, 'b', { events: t.events });
        if (intent?.type !== 'resolveExchange') throw new Error(`unexpected ${JSON.stringify(intent)}`);
        return intent.keepIds.map((id) => seat(t.g, 'b').hand.find((c) => c.id === id)!.role).sort();
      };
      expect(keptRoles(cDoesNothing)).toEqual(['captain', 'duke']);
      expect(keptRoles(cClaims('assassinate'))).toEqual(['contessa', 'duke']);
    });
  });
});

// 自对弈检查（#57）：电脑对电脑打几千局，看它不出错、打得完，而且诈唬和质疑的比例像人。
// 每次运行换一个种子，失败信息里带着它：把 SEED 写死成那个数就能复现。
// 几千局要跑好几秒，4 人局贴着 vitest 默认的 5 秒时限，机器一忙就超时（#67）：整组放宽到 30 秒
describe('电脑玩家自对弈', { timeout: 30_000 }, () => {
  const SEED = Date.now() | 0;
  const TURN_LIMIT = 300;
  type Seat = (g: GameState, id: string, mind: Mind) => ComputerIntent | null;
  const computer: Seat = decide;
  // 「只会收入和政变」的对手：借电脑的决策得知此刻轮不轮到它，再把决定换成最朴素的
  const plain: Seat = (g, id, mind) => {
    const intent = computer(g, id, mind);
    if (intent?.type === 'challenge') return { type: 'passChallenge' };
    if (intent?.type === 'block') return { type: 'passBlock' };
    if (intent?.type !== 'chooseAction') return intent;
    const rivals = g.players.filter((p) => p.alive && p.id !== id);
    return seat(g, id).coins < COUP_COST
      ? { type: 'chooseAction', action: 'income' }
      : { type: 'chooseAction', action: 'coup', targetId: rivals[Math.floor(mind.random() * rivals.length)].id };
  };

  // 引擎的不变量：自对弈每一步之后都查一遍，几千局随机牌局顺带当作引擎的模糊测试
  // 每步都要查，用 throw 而不是 expect：expect 放在这么热的循环里会让整组自对弈慢上好几倍
  function checkInvariants(g: GameState, where: string) {
    const fail = (what: string) => { throw new Error(`invariant broken: ${what} (${where}, phase ${g.phase})`); };
    const cards = [...g.deck, ...g.players.flatMap((p) => [...p.hand, ...p.revealed])];
    const total = ROLE_ORDER.length * ROLE_COPIES;
    if (cards.length !== total || new Set(cards.map((c) => c.id)).size !== total) fail('cards conserved with unique ids');
    for (const role of ROLE_ORDER) if (cards.filter((c) => c.role === role).length !== ROLE_COPIES) fail(`${ROLE_COPIES} × ${role}`);
    for (const p of g.players) {
      if (p.coins < 0) fail(`${p.id} coins never negative`);
      if (p.alive !== p.hand.length > 0) fail(`${p.id} alive iff holding a hidden card`);
      const exchanging = g.phase === 'choosingExchange' && g.pending?.actorId === p.id;
      if (!exchanging && p.hand.length + p.revealed.length !== 2) fail(`${p.id} holds two cards outside an exchange`);
    }
    const alive = g.players.filter((p) => p.alive);
    if (g.phase === 'gameOver' ? alive.length !== 1 || alive[0].id !== g.winnerId : alive.length < 2) fail('survivors match the phase');
  }

  // 打 games 局，返回各座位的胜局数和声称、质疑、阻挡窗口的统计。
  // overStory：一个座位自最近一次实际交换以来自愿声称超出故事上限的新角色的次数。上限是 3 个角色，诈唬倾向不低于 0.9 的是 4 个
  function play(games: number, seats: Seat[]) {
    const random = seeded(SEED + seats.length);
    vi.spyOn(Math, 'random').mockImplementation(random); // 引擎洗牌也跟着种子走
    const ids = seats.map((_, i) => `p${i}`);
    const stats = { wins: seats.map(() => 0), claims: 0, bluffs: 0, challenges: 0, caught: 0, blockWindows: 0, overStory: 0 };
    for (let n = 0; n < games; n++) {
      const where = `seed ${SEED}, ${seats.length} players, game ${n}`;
      const g = createGame(ids.map((id) => ({ id, name: id })), { startingPlayerId: ids[Math.floor(random() * ids.length)] });
      const temperaments = ids.map(() => drawTemperament(random));
      const claimed = ids.map(() => new Set<Role>());
      const events: GameEvent[] = [];
      const returned = ids.map((): Returned[] => []);
      let turns = 0;
      while (g.phase !== 'gameOver') {
        const deciders = ids.flatMap((id, i) => {
          const intent = seats[i](g, id, { events, temperament: temperaments[i], random, returned: returned[i] });
          return intent ? [{ id, intent }] : [];
        });
        if (deciders.length === 0) throw new Error(`nobody has anything to decide in ${g.phase} (${where})`);
        const { id, intent } = deciders[Math.floor(random() * deciders.length)];
        const role = intent.type === 'chooseAction' ? ACTION_CLAIM[intent.action] : intent.type === 'block' ? intent.role : null;
        if (role) {
          const { hand } = privateState(g, id);
          const bluff = !hand.some((c) => c.role === role);
          const i = ids.indexOf(id);
          const roles = claimed[i];
          // 不得不声称的不算自愿：手里真有的阻挡，以及不阻挡就出局时的假阻挡
          // 走投无路时（两人对峙、只剩 1 点影响力、对手已够政变）拿来拦政变的暗杀、偷窃，以及放过就让对手够政变的假阻挡也是。
          // ponytail: 外援和偷窃都按对手多 2 金币算，偷窃偷不满 2 枚的也放过了
          const foes = g.players.filter((p) => p.alive && p.id !== id);
          const cornered = foes.length === 1 && hand.length === 1 && foes[0].coins + (intent.type === 'block' ? 2 : 0) >= COUP_COST;
          const forced = cornered || (intent.type === 'block' && (!bluff || (g.pending!.type === 'assassinate' && hand.length === 1)));
          stats.claims++;
          if (bluff) stats.bluffs++;
          if (!forced && !roles.has(role) && roles.size >= (temperaments[i].bluff >= 0.9 ? 4 : 3)) stats.overStory++;
          roles.add(role);
        }
        if (intent.type === 'challenge') stats.challenges++;
        // 和 Room 一样记下交换时放回牌堆的牌
        if (intent.type === 'resolveExchange') {
          const roles = privateState(g, id).hand.filter((c) => !intent.keepIds.includes(c.id)).map((c) => c.role);
          returned[ids.indexOf(id)].push({ at: events.length - 1, roles }); // 自对弈里没人弃权，交换选牌时最后一条事件就是这次 exchangeDrew
        }
        const wasBlockWindow = g.phase === 'awaitingBlock';
        const produced = apply(g, id, intent);
        checkInvariants(g, where);
        events.push(...produced);
        stats.caught += produced.filter((e) => e.type === 'challengeResolved' && !e.truth).length;
        // 实际换了牌的座位故事重新计数
        for (const e of produced) if (e.type === 'exchangeDrew') claimed[ids.indexOf(e.playerId)].clear();
        if (!wasBlockWindow && g.phase === 'awaitingBlock') stats.blockWindows++;
        turns += produced.filter((e) => e.type === 'turnChanged').length;
        if (turns > TURN_LIMIT) throw new Error(`no winner within ${TURN_LIMIT} turns (${where})`);
      }
      stats.wins[ids.indexOf(g.winnerId!)]++;
    }
    return stats;
  }
  const within = (rate: number, low: number, high: number) => {
    expect(rate, `seed ${SEED}`).toBeGreaterThan(low);
    expect(rate, `seed ${SEED}`).toBeLessThan(high);
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [2, 500],
    [3, 500],
    [4, 1500],
    [5, 250],
    [6, 250],
  ])('%i 人局：每局都在回合数上限内分出胜负，诈唬占全部角色声称的 20% 到 40%，换牌以来没有人自愿声称第 4 个角色（极爱诈唬的是第 5 个）', (count, games) => {
    const { wins, claims, bluffs, challenges, caught, blockWindows, overStory } = play(games, Array<Seat>(count).fill(computer));
    expect(wins.reduce((a, b) => a + b)).toBe(games);
    within(bluffs / claims, 0.2, 0.4);
    expect(overStory, `seed ${SEED}`).toBe(0);
    if (count !== 4) return;
    // 4 人局里以质疑收场的问询窗口占 10% 到 25%。每个声称开一个质疑窗口，问询窗口还包括阻挡窗口：只数质疑窗口或两种都数，比例都要落在区间里。
    // 区间管的是质疑的总量：没有依据的质疑（基调）和冲着证据去的质疑（矛盾、被抓到过诈唬）合在一起算，一头调高另一头就得让。
    // 两种都数时下限放到 8%：电脑之间每次对质都有一方掉影响力，总量压不下来，从不质疑的人就坐收渔利（BYSTANDER）
    within(challenges / claims, 0.1, 0.25);
    within(challenges / (claims + blockWindows), 0.08, 0.25);
    // 质疑要准：抓到诈唬的占四成以上。只管总量时，靠没有依据的质疑就能凑够，成功率曾低到三成六，老实又从不质疑的人因此占了大便宜
    within(caught / challenges, 0.38, 1);
  });

  it('1 个电脑对 3 个只会收入和政变的对手：胜率高于 40%', () => {
    const { wins } = play(1000, [computer, plain, plain, plain]);
    expect(wins[0] / 1000, `seed ${SEED}`).toBeGreaterThan(0.4);
  });

  // 强电脑（ADR 0014）：play 按普通电脑抽性格（各项 0 到 1 均匀），这里线性映射进 STRONG 的区间，和按 STRONG 抽是同一个分布
  const strong: Seat = (g, id, { events, temperament, random, returned }) => {
    const scale = (k: keyof Temperament) => STRONG.TEMPERAMENT[k][0] + temperament[k] * (STRONG.TEMPERAMENT[k][1] - STRONG.TEMPERAMENT[k][0]);
    const own = { bluff: scale('bluff'), suspicion: scale('suspicion'), aggression: scale('aggression') };
    return decideComputerIntent(publicState(g), privateState(g, id), events, own, random, STRONG, returned);
  };
  // 调参时约 40% 和 60%；下限留出几个百分点的余量给随机波动
  it('强电脑对普通电脑：4 人局 1 对 3 胜率高于 33%，2 人局高于 55%', () => {
    const four = play(1500, [strong, computer, computer, computer]);
    expect(four.wins[0] / 1500, `seed ${SEED}`).toBeGreaterThan(0.33);
    const two = play(1500, [strong, computer]);
    expect(two.wins[0] / 1500, `seed ${SEED}`).toBeGreaterThan(0.55);
  }, 60_000);
});
