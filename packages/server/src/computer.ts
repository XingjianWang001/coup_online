import {
  ASSASSINATE_COST,
  BLOCK_ROLES,
  COUP_COST,
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

// 下面的数值都是「像不像人」的手感参数，由自对弈检查（computer.test.ts）的区间和人工验收一起约束
// 一张牌对自己有多大用：失去影响力、对质翻牌、交换选牌时留下大的
const WORTH: Record<Role, number> = { duke: 5, captain: 4, assassin: 3, contessa: 3, ambassador: 2 };
// 冲着自己来的行动（或拦下自己行动的阻挡）有多疼：越疼越想质疑
const HARM: Partial<Record<ActionType, number>> = { foreignAid: 0.5, steal: 1, assassinate: 1.5 };
// 诈唬倾向拉满时，手里没有对应角色却假装阻挡的概率
const FAKE_BLOCK: Partial<Record<ActionType, number>> = { foreignAid: 0.3, steal: 0.5, assassinate: 0.5 };
// 起一个新诈唬的意愿相对照实声称的折扣（再乘诈唬倾向）；接着演已经声称过的角色用 KEEP_STORY
const NEW_BLUFF = 0.5;
const KEEP_STORY = 1;

const pick = <T>(items: readonly T[], random: () => number): T => items[Math.floor(random() * items.length)];

function weighted<T>(options: readonly (readonly [T, number])[], random: () => number): T {
  let roll = random() * options.reduce((sum, [, weight]) => sum + weight, 0);
  return (options.find(([, weight]) => (roll -= weight) < 0) ?? options[0])[0];
}

// 局内记忆：只从本局的公开事件里得来，换一局事件清空，记忆也就没了
interface Memory {
  claims: Map<string, Set<Role>>; // 各玩家声称过、还没被对质检验也没亮出来的角色
  caught: Map<string, number>; // 被抓到诈唬的次数
  proven: Map<string, number>; // 声称被对质证明为真的次数
  attacker?: string; // 最近打过自己的玩家
}

function recall(events: readonly GameEvent[], me: string): Memory {
  const memory: Memory = { claims: new Map(), caught: new Map(), proven: new Map() };
  let claimed: Role | undefined; // 最近一次声称的角色：对质检验的就是它
  const claim = (id: string, role: Role) => {
    claimed = role;
    memory.claims.set(id, (memory.claims.get(id) ?? new Set()).add(role));
  };
  for (const e of events) {
    if (e.type === 'actionChosen') {
      if (e.claimedRole) claim(e.actorId, e.claimedRole);
      if (e.targetId === me) memory.attacker = e.actorId;
    } else if (e.type === 'blocked') {
      claim(e.blockerId, e.role);
    } else if (e.type === 'challengeResolved') {
      // 证明为真则那张牌已换走，被抓则本来就没有：这个声称都不再作数
      if (claimed) memory.claims.get(e.claimantId)?.delete(claimed);
      const count = e.truth ? memory.proven : memory.caught;
      count.set(e.claimantId, (count.get(e.claimantId) ?? 0) + 1);
    } else if (e.type === 'influenceLost') {
      memory.claims.get(e.playerId)?.delete(e.role);
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
  const story = memory.claims.get(me) ?? new Set<Role>(); // 自己本局声称过、还作数的角色
  const lastCard = self.handCount === 1;

  // 自己看得见的某角色张数：自己的暗牌加全场明牌。凑齐 3 张就没有别人能有它
  const seen = (role: Role) => hand.filter((c) => c.role === role).length + state.players.reduce((n, p) => n + p.revealed.filter((r) => r === role).length, 0);
  // 把「这件事总共有 p 的概率被某人做」折算成自己这一份：有资格的人越多，每人越少出手
  const share = (p: number) => 1 - (1 - p) ** (1 / rivals.length);
  const worth = (role: Role) => WORTH[role] + (role === 'assassin' ? temperament.aggression : 0) + (story.has(role) ? 2 : 0);
  const leastUseful = () => hand.reduce((a, b) => (worth(b.role) < worth(a.role) ? b : a));

  // 领先者优先（影响力多、金币多），最近打过自己的加分，再带一点随机。wary：对方声称过这些角色就多半会阻挡
  const target = (candidates: PublicPlayerView[], wary: Role[] = []) => {
    const score = (p: PublicPlayerView) =>
      p.handCount * 3 +
      p.coins / 2 +
      (p.id === memory.attacker ? 1 + 2 * temperament.aggression : 0) -
      (wary.some((r) => memory.claims.get(p.id)?.has(r)) ? 3 : 0) +
      random() * 3;
    return candidates.map((p) => [p.id, score(p)] as const).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  };

  // 声称某角色的意愿：手里有就照实声称。没有时接着演声称过的角色；声称过的角色数还不到暗牌数才按诈唬倾向起一个新的，
  // 所以一局里不会轮流声称四五个角色。3 张都亮在桌上的角色不碰
  const claimable = (role: Role) => {
    if (held.has(role)) return 1;
    if (seen(role) >= ROLE_COPIES) return 0;
    if (story.has(role)) return KEEP_STORY;
    return story.size < self.handCount ? temperament.bluff * NEW_BLUFF * (lastCard ? 0.5 : 1) : 0;
  };

  const chooseAction = (): ComputerIntent => {
    if (self.coins >= COUP_COST) return { type: 'chooseAction', action: 'coup', targetId: target(rivals) };
    const victims = rivals.filter((p) => p.coins > 0);
    const dukeAbout = rivals.some((p) => memory.claims.get(p.id)?.has('duke'));
    const action = weighted<ActionType>(
      [
        ['income', 1],
        ['foreignAid', dukeAbout ? 1 : 3],
        ['tax', 5 * claimable('duke')],
        ['steal', victims.length ? (2 + 2 * temperament.aggression) * claimable('captain') : 0],
        ['assassinate', self.coins >= ASSASSINATE_COST ? (3 + 4 * temperament.aggression) * claimable('assassin') : 0],
        ['exchange', 1.5 * claimable('ambassador')],
      ],
      random,
    );
    if (action === 'steal') return { type: 'chooseAction', action, targetId: target(victims, ['captain', 'ambassador']) };
    if (action === 'assassinate') return { type: 'chooseAction', action, targetId: target(rivals, ['contessa']) };
    return { type: 'chooseAction', action };
  };

  // 质疑的概率：看证据和代价
  const doubt = (claimantId: string, role: Role, onAction: boolean) => {
    if (seen(role) >= ROLE_COPIES) return 1;
    const { action } = pending!;
    const aimedAtMe = onAction ? pending!.targetId === me : pending!.actorId === me;
    // 多疑程度定基调；看得见的同角色牌越多、对方本局被抓过越可疑，被证明过越可信
    const p = Math.min(
      0.9,
      ((0.055 + 0.17 * temperament.suspicion) * (1 + seen(role)) * (1 + (memory.caught.get(claimantId) ?? 0))) / (1 + (memory.proven.get(claimantId) ?? 0)),
    );
    if (onAction && aimedAtMe && action === 'assassinate' && lastCard && !held.has('contessa')) {
      // 挨了这一下就出局，放弃等于认输：不质疑就留到阻挡窗口假装女伯爵。多疑的倾向质疑，爱诈唬的倾向假装
      if (seen('contessa') >= ROLE_COPIES) return 1;
      const base = 0.5 + (temperament.suspicion - temperament.bluff) / 2;
      return base + (1 - base) * p;
    }
    // 能照实阻挡就不必冒险质疑
    const stake = aimedAtMe && !(onAction && BLOCK_ROLES[action].some((r) => held.has(r))) ? (HARM[action] ?? 0) : 0;
    return (share(p) + p * stake) * (lastCard ? 0.5 : 1);
  };

  // 手里没有能阻挡的角色时，假装有的概率
  const pretend = (role: Role) => {
    const { action } = pending!;
    if (action === 'assassinate' && lastCard) return 1; // 不阻挡就出局
    if (story.has(role)) return KEEP_STORY;
    if (story.size >= self.handCount || (action === 'steal' && self.coins === 0)) return 0;
    const p = temperament.bluff * (FAKE_BLOCK[action] ?? 0) * (lastCard ? 0.5 : 1);
    return action === 'foreignAid' ? share(p) : p;
  };

  switch (state.phase) {
    case 'choosingAction':
      return state.currentPlayerId === me ? chooseAction() : null;
    case 'awaitingChallenge': {
      const onAction = state.challengeSubject === 'action';
      const claimantId = onAction ? pending!.actorId : pending!.blockById!;
      if (claimantId === me || state.passed.includes(me)) return null;
      const role = onAction ? pending!.claimedRole! : pending!.blockRole!;
      return { type: random() < doubt(claimantId, role, onAction) ? 'challenge' : 'passChallenge' };
    }
    case 'awaitingBlock': {
      const eligible = pending!.action === 'foreignAid' ? pending!.actorId !== me : pending!.targetId === me;
      if (!eligible || state.passed.includes(me)) return null;
      const roles = BLOCK_ROLES[pending!.action];
      const real = roles.find((r) => held.has(r));
      if (real) return { type: 'block', role: real };
      const fakes = roles.filter((r) => seen(r) < ROLE_COPIES);
      if (fakes.length === 0) return { type: 'passBlock' };
      const fake = fakes.find((r) => story.has(r)) ?? pick(fakes, random);
      return random() < pretend(fake) ? { type: 'block', role: fake } : { type: 'passBlock' };
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
