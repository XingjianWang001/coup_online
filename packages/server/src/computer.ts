import {
  ASSASSINATE_COST,
  BLOCK_ROLES,
  COUP_COST,
  FORCED_COUP_COINS,
  ROLE_COPIES,
  type ActionType,
  type Card,
  type GameEvent,
  type PrivateState,
  type PublicPlayerView,
  type PublicState,
  type Role,
} from '@coup/engine';
import type { ClientIntent } from '@coup/shared';

export type ComputerIntent = Extract<
  ClientIntent,
  { type: 'chooseAction' | 'challenge' | 'passChallenge' | 'block' | 'passBlock' | 'revealShowdownCard' | 'resolveLoss' | 'resolveExchange' }
>;

// 性格：三项倾向各在 0 到 1 之间。每个电脑玩家每局开始时抽一次，不给任何人看
export interface Temperament {
  bluff: number; // 爱不爱诈唬
  suspicion: number; // 多疑程度
  aggression: number; // 攻击性
}

export const drawTemperament = (random: () => number): Temperament => ({ bluff: random(), suspicion: random(), aggression: random() });

// 这个文件里的数值都是「像不像人」的手感参数：下面几个常量，以及函数里各行动的权重、质疑概率的基调和上限、选目标的各项系数。
// 它们由自对弈检查（computer.test.ts）的区间和人工验收一起约束，调任何一个都要重跑自对弈检查
// 一张牌对自己有多大用：失去影响力、对质翻牌、交换选牌时留下大的
const WORTH: Record<Role, number> = { duke: 5, captain: 4, assassin: 3, contessa: 3, ambassador: 2 };
// 眼前有暗杀或偷窃的威胁时，能挡住它的牌多值这么多。是倾向不是规则：别的牌更值钱时仍不留
const THREAT = 1.5;
// 冲着自己来的行动（或拦下自己行动的阻挡）有多疼：越疼越想质疑
const HARM: Partial<Record<ActionType, number>> = { foreignAid: 0.5, steal: 1, assassinate: 1.5 };
// 诈唬的意愿都要乘诈唬倾向。起一个新的诈唬：声称角色行动用 NEW_BLUFF，假装阻挡按被阻挡的行动用 FAKE_BLOCK；
// 接着演声称过的角色用 REPEAT_BLUFF（乘完封顶为 1，即和手里真有一样）
const NEW_BLUFF = 0.5;
const FAKE_BLOCK: Partial<Record<ActionType, number>> = { foreignAid: 0.3, steal: 0.5, assassinate: 0.5 };
const REPEAT_BLUFF = 2;
// 故事（最近一次实际交换以来声称过的角色）加手里有的角色凑到这么多个，就不再起新的诈唬。
// 诈唬倾向不低于 RECKLESS_BLUFF 的多放宽 1 个。故事比暗牌多是有意留下的破绽：别人能从自相矛盾里抓到它
const STORY_ROLES = 3;
const RECKLESS_BLUFF = 0.9;
// 金币够政变（COUP_COST）但还没到规则强制政变的数目（FORCED_COUP_COINS）时，政变的概率
const COUP_EAGERNESS = 0.85;
// 对方的声称自相矛盾时，质疑概率乘这么多：更想质疑，不是必然质疑
const CONTRADICTION = 2.5;
// 对方的声称被证明为真过，质疑概率最多降到这个比例：CONTRADICTION 乘它仍大于 1，眼前的矛盾盖得过旧信用
const PROVEN_FLOOR = 0.6;

function pickAction(weights: readonly (readonly [ActionType, number])[], random: () => number): ActionType {
  let roll = random() * weights.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [action, weight] of weights) {
    roll -= weight;
    if (roll < 0) return action;
  }
  return weights[0][0];
}

// 局内记忆：只从本局的公开事件里得来，换一局事件清空，记忆也就没了
interface Memory {
  standing: Map<string, Set<Role>>; // 各玩家声称过、现在还作数的角色：被对质检验过、亮出来了或交换过牌就不再作数
  story: Set<Role>; // 自己的故事：最近一次实际交换以来声称过的全部角色，作数不作数都算
  caught: Map<string, number>; // 被抓到诈唬的次数
  proven: Map<string, number>; // 声称被对质证明为真的次数
  attacker?: string; // 最近打过自己的玩家
}

// ponytail: 每次决定都把本局的事件（Room.gameEvents，一局内只增不减）从头数一遍。一局几百条事件、一次决定几微秒；
// 事件多到要紧时改成随事件增量更新
function recall(events: readonly GameEvent[], me: string): Memory {
  const memory: Memory = { standing: new Map(), story: new Set(), caught: new Map(), proven: new Map() };
  let underChallenge: Role | undefined; // 最近一次声称的角色：对质检验的就是它
  const note = (id: string, role: Role) => {
    underChallenge = role;
    if (id === me) memory.story.add(role);
    memory.standing.set(id, (memory.standing.get(id) ?? new Set()).add(role));
  };
  for (const e of events) {
    if (e.type === 'actionChosen') {
      if (e.claimedRole) note(e.actorId, e.claimedRole);
      if (e.targetId === me) memory.attacker = e.actorId;
    } else if (e.type === 'blocked') {
      note(e.blockerId, e.role);
    } else if (e.type === 'challengeResolved') {
      // 证明为真则那张牌已换走，被抓则本来就没有：这个声称都不再作数
      if (underChallenge) memory.standing.get(e.claimantId)?.delete(underChallenge);
      const count = e.truth ? memory.proven : memory.caught;
      count.set(e.claimantId, (count.get(e.claimantId) ?? 0) + 1);
    } else if (e.type === 'influenceLost') {
      memory.standing.get(e.playerId)?.delete(e.role);
    } else if (e.type === 'exchangeDrew') {
      memory.standing.delete(e.playerId); // 交换之后手里是什么牌没人知道
      if (e.playerId === me) memory.story.clear(); // 自己换了牌可以改口：故事从头讲。只宣布、被抓到没换成的没有这个事件
    }
  }
  return memory;
}

// 电脑玩家的决策：只看真人在这个座位上能看到的东西（ADR 0013）：公开状态、自己的暗牌、本局的公开事件。此刻无需它决定时返回 null
export function decideComputerIntent(
  state: PublicState,
  own: PrivateState,
  events: readonly GameEvent[],
  temperament: Temperament,
  random: () => number,
): ComputerIntent | null {
  const me = own.playerId;
  const self = state.players.find((p) => p.id === me);
  if (!self?.alive) return null;
  const { pending } = state;
  const { hand } = own;
  const held = new Set(hand.map((c) => c.role));
  const rivals = state.players.filter((p) => p.alive && p.id !== me);
  const memory = recall(events, me);
  const stillClaims = (id: string, role: Role) => memory.standing.get(id)?.has(role) ?? false;
  const storyCap = temperament.bluff >= RECKLESS_BLUFF ? STORY_ROLES + 1 : STORY_ROLES;
  const lastCard = self.handCount === 1;
  const caution = lastCard ? 0.5 : 1; // 只剩 1 点影响力时，冒险的事少做一半
  const dying = pending?.action === 'assassinate' && pending.targetId === me && lastCard; // 这次暗杀成了自己就出局
  const nothingToSteal = pending?.action === 'steal' && pending.targetId === me && self.coins === 0;

  // 自己看得见的某角色张数：自己的暗牌加全场明牌。allSeen：凑齐了，别人不可能有它
  const seen = (role: Role) => hand.filter((c) => c.role === role).length + state.players.reduce((n, p) => n + p.revealed.filter((r) => r === role).length, 0);
  const allSeen = (role: Role) => seen(role) >= ROLE_COPIES;
  // 把「这件事总共有 p 的概率被某人做」折算成自己这一份：有资格的人越多，每人越少出手
  const perSeat = (p: number) => 1 - (1 - p) ** (1 / rivals.length);
  // 眼前的威胁，能挡住它的牌更值得留。一种是对手仍作数的声称：声称刺客且金币够暗杀，或声称队长而自己有金币可偷。
  // 另一种是冲着自己来、还没结算的行动（incoming）：自己质疑它失败、正为此失去影响力，接下来就是它的阻挡窗口。
  // 这个声称刚被证明、已不作数，暗杀的金币也已付过，只能从「上一条事件是自己质疑失败」认出它。
  // ponytail: 旁人恰在这时弃权会插进事件，就认不出来，退回只看声称；行动者弃权则行动作废，本来就不算威胁
  const last = events.at(-1);
  const incoming = last?.type === 'challengeResolved' && last.truth && last.loserId === me && pending?.targetId === me ? pending.action : undefined;
  const assassinationThreat = incoming === 'assassinate' || rivals.some((p) => stillClaims(p.id, 'assassin') && p.coins >= ASSASSINATE_COST);
  const stealThreat = self.coins > 0 && (incoming === 'steal' || rivals.some((p) => stillClaims(p.id, 'captain')));
  const worth = (role: Role) =>
    WORTH[role] +
    (role === 'assassin' ? temperament.aggression : 0) +
    (memory.story.has(role) ? 1.5 : 0) +
    ((assassinationThreat && BLOCK_ROLES.assassinate.includes(role)) || (stealThreat && BLOCK_ROLES.steal.includes(role)) ? THREAT : 0);
  const leastUseful = () => hand.reduce((a, b) => (worth(b.role) < worth(a.role) ? b : a));

  // 领先者优先（影响力多、金币多），最近打过自己的加分，再带一点随机。wary：对方声称过这些角色就多半会阻挡
  const pickTarget = (candidates: PublicPlayerView[], wary: Role[] = []) => {
    const score = (p: PublicPlayerView) =>
      p.handCount * 3 +
      p.coins / 2 +
      (p.id === memory.attacker ? 1 + 2 * temperament.aggression : 0) -
      (wary.some((r) => stillClaims(p.id, r)) ? 3 : 0) +
      random() * 3;
    return candidates.map((p) => [p.id, score(p)] as const).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  };

  // 手里没有某角色时声称它的意愿（0 到 1），全看诈唬倾向。声称过、还作数的角色接着演，意愿高得多；
  // 其余的要起一个新的诈唬（意愿再乘 fresh），而且只在故事里的加手里有的还不满 storyCap 个角色时才起
  const bluffWillingness = (role: Role, fresh: number) => {
    if (stillClaims(me, role)) return Math.min(1, REPEAT_BLUFF * temperament.bluff);
    return new Set([...memory.story, ...held]).size < storyCap ? fresh * temperament.bluff * caution : 0;
  };

  // 声称某角色来行动的权重：手里有就照实声称，但故事里已有 storyCap 个角色后不再添新的，哪怕是真的：
  // 别人看不见暗牌，只看见它什么都声称。手里没有时看诈唬的意愿，3 张都亮在桌上的角色不碰
  const claimWeight = (role: Role) => {
    if (held.has(role)) return memory.story.has(role) || memory.story.size < storyCap ? 1 : 0;
    return allSeen(role) ? 0 : bluffWillingness(role, NEW_BLUFF);
  };

  const chooseAction = (): ComputerIntent => {
    // 够政变就多半政变，偶尔先做别的；到了 FORCED_COUP_COINS 规则只许政变
    if (self.coins >= FORCED_COUP_COINS || (self.coins >= COUP_COST && random() < COUP_EAGERNESS)) {
      return { type: 'chooseAction', action: 'coup', targetId: pickTarget(rivals) };
    }
    const victims = rivals.filter((p) => p.coins > 0);
    const dukeAbout = rivals.some((p) => stillClaims(p.id, 'duke'));
    const action = pickAction(
      [
        ['income', 1],
        ['foreignAid', dukeAbout ? 1 : 3],
        ['tax', 5 * claimWeight('duke')],
        ['steal', victims.length ? (2 + 2 * temperament.aggression) * claimWeight('captain') : 0],
        ['assassinate', self.coins >= ASSASSINATE_COST ? (3 + 4 * temperament.aggression) * claimWeight('assassin') : 0],
        ['exchange', 1.5 * claimWeight('ambassador')],
      ],
      random,
    );
    if (action === 'steal') return { type: 'chooseAction', action, targetId: pickTarget(victims, ['captain', 'ambassador']) };
    if (action === 'assassinate') return { type: 'chooseAction', action, targetId: pickTarget(rivals, ['contessa']) };
    return { type: 'chooseAction', action };
  };

  // 质疑的概率：看证据和代价
  const challengeChance = (claimantId: string, role: Role, onAction: boolean) => {
    if (allSeen(role)) return 1;
    const { action } = pending!;
    // 自相矛盾：对方仍作数的声称角色（含眼前这个）比暗牌多，没有换牌能解释。同一角色声称几次只算一个，声称一致也不算证明
    const contradicts = (memory.standing.get(claimantId)?.size ?? 0) > state.players.find((p) => p.id === claimantId)!.handCount;
    // 被证明为真的信用：每次把质疑概率打七五折，最低到 PROVEN_FLOOR。证明用的那张牌已洗回牌堆，说明不了对方现在拿着什么
    const credit = Math.max(PROVEN_FLOOR, 0.75 ** (memory.proven.get(claimantId) ?? 0));
    // 多疑程度定基调；看得见的同角色牌越多、对方本局被抓过、声称自相矛盾越可疑，被证明过略可信。
    // 基调定得低，给证据的加成留出余量：没有依据时很少质疑，加成叠上来之后质疑的总量才落在自对弈检查的区间里
    const p = Math.min(
      0.9,
      (0.04 + 0.13 * temperament.suspicion) * (1 + seen(role)) * (1 + (memory.caught.get(claimantId) ?? 0)) * (contradicts ? CONTRADICTION : 1) * credit,
    );
    if (dying && !held.has('contessa')) {
      // 放弃等于认输：不质疑就留到阻挡窗口假装女伯爵。多疑的倾向质疑，爱诈唬的倾向假装；女伯爵 3 张都亮了就没人会信，只能质疑
      if (allSeen('contessa')) return 1;
      const base = 0.5 + (temperament.suspicion - temperament.bluff) / 2;
      return base + (1 - base) * p;
    }
    // 冲着自己来才有额外的代价；能照实阻挡、或对方偷不走什么，就不必为此冒险
    const aimedAtMe = onAction ? pending!.targetId === me : pending!.actorId === me;
    const canBlock = onAction && BLOCK_ROLES[action].some((r) => held.has(r));
    const stake = aimedAtMe && !canBlock && !nothingToSteal ? (HARM[action] ?? 0) : 0;
    return (perSeat(p) + p * stake) * caution;
  };

  // 手里没有能阻挡的角色时，假装有 role 来阻挡的概率
  const fakeBlockChance = (role: Role) => {
    if (dying) return 1; // 不阻挡就出局
    if (nothingToSteal) return 0;
    const fresh = FAKE_BLOCK[pending!.action] ?? 0;
    return bluffWillingness(role, pending!.action === 'foreignAid' ? perSeat(fresh) : fresh);
  };

  switch (state.phase) {
    case 'choosingAction':
      return state.currentPlayerId === me ? chooseAction() : null;
    case 'awaitingChallenge': {
      const onAction = state.challengeSubject === 'action';
      const claimantId = onAction ? pending!.actorId : pending!.blockById!;
      if (claimantId === me || state.passed.includes(me)) return null;
      const role = onAction ? pending!.claimedRole! : pending!.blockRole!;
      return { type: random() < challengeChance(claimantId, role, onAction) ? 'challenge' : 'passChallenge' };
    }
    case 'awaitingBlock': {
      const eligible = pending!.action === 'foreignAid' ? pending!.actorId !== me : pending!.targetId === me;
      if (!eligible || state.passed.includes(me)) return null;
      const roles = BLOCK_ROLES[pending!.action];
      const real = roles.find((r) => held.has(r));
      if (real) return { type: 'block', role: real };
      // 3 张都亮在桌上的角色没人会信，不装；除非不阻挡就出局
      const fakes = dying ? roles : roles.filter((r) => !allSeen(r));
      if (fakes.length === 0) return { type: 'passBlock' };
      const fake = fakes.find((r) => stillClaims(me, r)) ?? fakes[Math.floor(random() * fakes.length)];
      return random() < fakeBlockChance(fake) ? { type: 'block', role: fake } : { type: 'passBlock' };
    }
    case 'showdown': {
      if (state.showdown!.claimantId !== me) return null;
      const card = hand.find((c) => c.role === state.showdown!.role) ?? leastUseful();
      return { type: 'revealShowdownCard', cardId: card.id };
    }
    case 'choosingLoss':
      return state.lossPlayerId === me ? { type: 'resolveLoss', cardId: leastUseful().id } : null;
    case 'choosingExchange': {
      if (pending!.actorId !== me) return null;
      const pool = hand.slice();
      const keep: Card[] = [];
      while (keep.length < state.exchangeKeepCount!) {
        // 同一个角色留第二张用处小得多
        const value = (c: Card) => worth(c.role) - (keep.some((k) => k.role === c.role) ? 3 : 0);
        const best = pool.reduce((a, b) => (value(b) > value(a) ? b : a));
        keep.push(...pool.splice(pool.indexOf(best), 1));
      }
      return { type: 'resolveExchange', keepIds: keep.map((c) => c.id) };
    }
    default:
      return null;
  }
}
