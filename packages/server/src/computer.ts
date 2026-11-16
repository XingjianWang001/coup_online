import {
  ASSASSINATE_COST,
  BLOCK_ROLES,
  COUP_COST,
  FORCED_COUP_COINS,
  ROLE_COPIES,
  STEAL_AMOUNT,
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
// 声称对自己没有切身代价时，质疑只做这么多比例：替别人出头的输赢都便宜了旁观的人
const BYSTANDER = 0.5;
// 好感（结盟）：每点好感让冲着他来的声称多一份质疑的代价 GRATITUDE（像是冲着自己来的，只是轻些），选目标时少 ALLY 分
const GRATITUDE = 0.5;
const ALLY = 2;
// 好感是相互的：对方对自己的好感每变 1 点（自己替他出头、自己对他发起行动），自己对他的好感跟着变这么多
const RECIPROCITY = 0.5;
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
// 能偷、能暗杀的人都仍作数地声称过能挡它的角色、或有人仍作数地声称过公爵时外援，这个行动的权重乘这么多：他多半会挡，但可能是装的，偶尔还试
const GUARDED = 0.2;
// 手里有公爵、还没仍作数地声称过它时，有这么大的概率藏着不挡外援，留着以后收税或设套。挡过一次就一直挡。
// 偷窃、暗杀冲着自己来，不挡太疼，照旧必挡
const SLOWPLAY = 0.2;
// 对方的声称自相矛盾时，质疑概率乘这么多：更想质疑，不是必然质疑。矛盾时诈唬的多半超过一半，质疑才划算，所以给得重
const CONTRADICTION = 5;
// 对方的声称被证明为真过，质疑概率最多降到这个比例：CONTRADICTION 乘它仍大于 1，眼前的矛盾盖得过旧信用
const PROVEN_FLOOR = 0.6;
// 两人对峙、自己只剩 1 点影响力、对手快要政变时会挣扎：暗杀和偷窃的权重最多乘到 1 + STRUGGLE；
// 对手有声称可质疑时，质疑的代价最多加 COUP_HARM（和 HARM 同一把尺：政变挡不了，比暗杀更疼）
const STRUGGLE = 3;
const COUP_HARM = 2;
// 反过来，两人对峙、对手只剩 1 点影响力、自己快要政变赢下来时求稳：诈唬和没有切身代价的质疑最多少做这么多比例
const RESTRAINT = 0.75;

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
  // 看起来没有的角色，换过牌（交换、对质证明后补牌）就不再算。一种是当众没挡的：外援、偷窃、暗杀照常生效了，有资格阻挡的人
  // 就像是没有能挡它的牌；有牌也可能不挡（电脑偶尔藏着公爵不挡外援，SLOWPLAY），所以只是像。记在自己身上无妨：只在手里没有时才看它。
  // 另一种是自己丢掉的：失去哪张牌是自己选的，丢了它、留下另一张，剩下的多半不是它。
  // ponytail: 手里两张同角色、丢一张的也算进来，只是更想质疑，不是必然质疑；超时代选的随机一张也当作自己选的
  lacking: Map<string, Set<Role>>;
  attacker?: string; // 最近打过自己的玩家
  // 好感：替自己出过头（质疑过冲着自己来的声称，成败都算）一次加 1，对自己发起行动（以自己为目标）一次减 1，最低到 0。
  // 反过来自己替他出头、对他发起行动，各按 RECIPROCITY 加减
  favor: Map<string, number>;
}

// ponytail: 每次决定都把本局的事件（Room.gameEvents，一局内只增不减）从头数一遍。一局几百条事件、一次决定几微秒；
// 事件多到要紧时改成随事件增量更新
function recall(events: readonly GameEvent[], me: string, ids: readonly string[]): Memory {
  const memory: Memory = { standing: new Map(), story: new Set(), caught: new Map(), proven: new Map(), lacking: new Map(), favor: new Map() };
  const befriend = (id: string, by: number) => memory.favor.set(id, Math.max(0, (memory.favor.get(id) ?? 0) + by));
  let underChallenge: Role | undefined; // 最近一次声称的角色：对质检验的就是它
  // 最近一次声称冲着谁来：行动的目标，阻挡则是被拦下的行动者
  let actor: string | undefined;
  let aimedAt: string | undefined;
  const note = (id: string, role: Role) => {
    underChallenge = role;
    if (id === me) memory.story.add(role);
    memory.standing.set(id, (memory.standing.get(id) ?? new Set()).add(role));
  };
  // 本回合的行动：它生效了而没人阻挡，有资格阻挡的人都算没挡。事件里没有「放弃阻挡」，只能从效果认出来
  let turn: { action: ActionType; actorId: string; targetId?: string } | undefined;
  let owing: string | undefined; // 对质输了、接下来那次失去影响力是在付这笔账的人：那次不是暗杀生效
  const lack = (id: string, role: Role) => {
    memory.lacking.set(id, (memory.lacking.get(id) ?? new Set()).add(role));
    memory.standing.get(id)?.delete(role); // 声称过也不再作数
  };
  const wave = () => {
    const { action, actorId, targetId } = turn!;
    turn = undefined;
    for (const id of action === 'foreignAid' ? ids.filter((id) => id !== actorId) : [targetId!]) {
      for (const r of BLOCK_ROLES[action]) lack(id, r);
    }
  };
  for (const e of events) {
    if (e.type === 'actionChosen') {
      turn = BLOCK_ROLES[e.action].length ? { action: e.action, actorId: e.actorId, targetId: e.targetId } : undefined;
      if (e.claimedRole) note(e.actorId, e.claimedRole);
      if (e.targetId === me) {
        memory.attacker = e.actorId;
        befriend(e.actorId, -1);
      }
      if (e.actorId === me && e.targetId) befriend(e.targetId, -RECIPROCITY);
      actor = e.actorId;
      aimedAt = e.targetId;
    } else if (e.type === 'blocked') {
      turn = undefined;
      note(e.blockerId, e.role);
      aimedAt = actor;
    } else if (e.type === 'challenged') {
      if (aimedAt === me && e.challengerId !== me) befriend(e.challengerId, 1);
      if (e.challengerId === me && aimedAt && aimedAt !== me) befriend(aimedAt, RECIPROCITY);
    } else if (e.type === 'coinsChanged') {
      // 外援、偷窃的行动者金币变了就是生效了（偷窃先记目标、再记行动者）。暗杀的金币在宣布时付、被抓时退，不算
      if (turn && turn.action !== 'assassinate' && e.playerId === turn.actorId) wave();
    } else if (e.type === 'challengeResolved') {
      // 证明为真则那张牌已换走，被抓则本来就没有：这个声称都不再作数
      if (underChallenge) memory.standing.get(e.claimantId)?.delete(underChallenge);
      const count = e.truth ? memory.proven : memory.caught;
      count.set(e.claimantId, (count.get(e.claimantId) ?? 0) + 1);
      if (e.truth) memory.lacking.delete(e.claimantId); // 补了一张新牌
      owing = e.loserId;
    } else if (e.type === 'influenceLost') {
      lack(e.playerId, e.role);
      if (owing === e.playerId) owing = undefined;
      else if (turn?.action === 'assassinate' && e.playerId === turn.targetId) wave();
    } else if (e.type === 'exchangeDrew') {
      memory.standing.delete(e.playerId); // 交换之后手里是什么牌没人知道
      memory.lacking.delete(e.playerId);
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
  const memory = recall(events, me, state.players.map((p) => p.id));
  const stillClaims = (id: string, role: Role) => memory.standing.get(id)?.has(role) ?? false;
  const lacks = (id: string, role: Role) => memory.lacking.get(id)?.has(role) ?? false;
  const storyCap = temperament.bluff >= RECKLESS_BLUFF ? STORY_ROLES + 1 : STORY_ROLES;
  const lastCard = self.handCount === 1;
  // striker 政变 victim 结束这局的把握（0 到 1）：只剩两人对峙、victim 只剩 1 点影响力时才算。striker 金币够政变，
  // 轮到他多半就政变；他金币领先也算半份：他会先攒够
  const [foe] = rivals;
  const finishing = (striker: PublicPlayerView, victim: PublicPlayerView) =>
    rivals.length === 1 && victim.handCount === 1 ? (striker.coins >= COUP_COST ? 1 : striker.coins > victim.coins ? 0.5 : 0) : 0;
  const coupRisk = finishing(foe, self); // 挨政变出局的风险
  const calm = 1 - RESTRAINT * finishing(self, foe); // 快要政变赢了：别节外生枝
  const caution = lastCard ? 0.5 + coupRisk / 2 : 1; // 只剩 1 点影响力时，冒险的事少做一半；横竖要挨政变出局就没什么可小心的
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

  // 领先者优先（影响力多、金币多），最近打过自己的加分，有好感的减分，再带一点随机
  const pickTarget = (candidates: PublicPlayerView[]) => {
    const score = (p: PublicPlayerView) =>
      p.handCount * 3 +
      p.coins / 2 +
      (p.id === memory.attacker ? 1 + 2 * temperament.aggression : 0) -
      ALLY * (memory.favor.get(p.id) ?? 0) +
      random() * 3;
    return candidates.map((p) => [p.id, score(p)] as const).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  };

  // 手里没有某角色时声称它的意愿（0 到 1），全看诈唬倾向。声称过、还作数的角色接着演，意愿高得多；
  // 其余的要起一个新的诈唬（意愿再乘 fresh），而且只在故事里的加手里有的还不满 storyCap 个角色时才起
  // 看起来没有的角色（当众没挡过、自己丢掉的）不装：谁都看得出是假的
  const bluffWillingness = (role: Role, fresh: number) => {
    if (lacks(me, role)) return 0;
    if (stillClaims(me, role)) return Math.min(1, REPEAT_BLUFF * temperament.bluff) * calm;
    return new Set([...memory.story, ...held]).size < storyCap ? fresh * temperament.bluff * caution * calm : 0;
  };

  // 声称某角色来行动的权重：手里有就照实声称，但故事里已有 storyCap 个角色后不再添新的，哪怕是真的：
  // 别人看不见暗牌，只看见它什么都声称。手里没有时看诈唬的意愿，3 张都亮在桌上的角色不碰
  const claimWeight = (role: Role) => {
    if (held.has(role)) return memory.story.has(role) || memory.story.size < storyCap ? 1 : 0;
    return allSeen(role) ? 0 : bluffWillingness(role, NEW_BLUFF);
  };

  const chooseAction = (): ComputerIntent => {
    // 够政变就多半政变，偶尔先做别的；政变就能赢、或到了 FORCED_COUP_COINS（规则只许政变）时必政变
    if (self.coins >= FORCED_COUP_COINS || (self.coins >= COUP_COST && (calm < 1 || random() < COUP_EAGERNESS))) {
      return { type: 'chooseAction', action: 'coup', targetId: pickTarget(rivals) };
    }
    const victims = rivals.filter((p) => p.coins > 0);
    const dukeAbout = rivals.some((p) => stillClaims(p.id, 'duke'));
    // 挨政变出局的风险越大越想先下手。暗杀去掉他一点影响力；偷窃只在偷完他就不够政变时才拦得住
    const struggle = 1 + STRUGGLE * coupRisk;
    const stealStalls = foe.coins < COUP_COST + STEAL_AMOUNT;
    // 仍作数地声称过能挡它的角色的人多半会挡：有别人可打就不打他，只剩这样的人可打时少做（GUARDED）
    const aim = (action: ActionType, candidates: PublicPlayerView[]) => {
      const open = candidates.filter((p) => !BLOCK_ROLES[action].some((r) => stillClaims(p.id, r)));
      return open.length ? { targets: open, weight: 1 } : { targets: candidates, weight: GUARDED };
    };
    const stealAim = aim('steal', victims);
    const assassinateAim = aim('assassinate', rivals);
    const action = pickAction(
      [
        ['income', 1],
        ['foreignAid', 3 * (dukeAbout ? GUARDED : 1)],
        ['tax', 5 * claimWeight('duke')],
        ['steal', victims.length ? (2 + 2 * temperament.aggression) * claimWeight('captain') * (stealStalls ? struggle : 1) * stealAim.weight : 0],
        ['assassinate', self.coins >= ASSASSINATE_COST ? (3 + 4 * temperament.aggression) * claimWeight('assassin') * struggle * assassinateAim.weight : 0],
        ['exchange', 1.5 * claimWeight('ambassador')],
      ],
      random,
    );
    if (action === 'steal') return { type: 'chooseAction', action, targetId: pickTarget(stealAim.targets) };
    if (action === 'assassinate') return { type: 'chooseAction', action, targetId: pickTarget(assassinateAim.targets) };
    return { type: 'chooseAction', action };
  };

  // 质疑的概率：看证据和代价
  const challengeChance = (claimantId: string, role: Role, onAction: boolean) => {
    if (allSeen(role)) return 1;
    const { action } = pending!;
    // 自相矛盾：对方仍作数的声称角色（含眼前这个）比暗牌多，或声称的是换牌以来看起来没有的角色（当众没挡过、自己丢掉的），没有换牌能解释。
    // 同一角色声称几次只算一个，声称一致也不算证明
    const claimant = state.players.find((p) => p.id === claimantId)!;
    const contradicts = (memory.standing.get(claimantId)?.size ?? 0) > claimant.handCount || lacks(claimantId, role);
    // 被证明为真的信用：每次把质疑概率打七五折，最低到 PROVEN_FLOOR。证明用的那张牌已洗回牌堆，说明不了对方现在拿着什么
    const credit = Math.max(PROVEN_FLOOR, 0.75 ** (memory.proven.get(claimantId) ?? 0));
    // 多疑程度定基调；看得见的同角色牌越多、对方本局被抓过、声称自相矛盾越可疑，被证明过略可信。
    // 基调定得低，给证据的加成留出余量：没有依据时很少质疑，加成叠上来之后质疑的总量才落在自对弈检查的区间里。
    // 没有依据的质疑多半落空（声称里诈唬的不到三成），对质又是一换一、让旁观者得利：基调再高，从不质疑的人就占了便宜
    const p = Math.min(
      0.9,
      (0.02 + 0.065 * temperament.suspicion) * (1 + seen(role)) * (1 + (memory.caught.get(claimantId) ?? 0)) * (contradicts ? CONTRADICTION : 1) * credit,
    );
    if (dying && !held.has('contessa')) {
      // 放弃等于认输：不质疑就留到阻挡窗口假装女伯爵。多疑的倾向质疑，爱诈唬的倾向假装；女伯爵 3 张都亮了就没人会信，只能质疑
      if (allSeen('contessa')) return 1;
      const base = 0.5 + (temperament.suspicion - temperament.bluff) / 2;
      return base + (1 - base) * p;
    }
    // 冲着自己来才有额外的代价；能照实阻挡、或对方偷不走什么，就不必为此冒险。
    // 有挨政变出局的风险时，声称的人就是要政变自己的那个，抓到他诈唬能先去掉他一点影响力：这份风险也算代价。
    // 冲着有好感的人来，每点好感也算一份代价（GRATITUDE）。
    // 快要政变赢了时只为代价质疑，没有代价的那份少做；完全没有代价时那份也少做（BYSTANDER）
    const aimedAt = onAction ? pending!.targetId : pending!.actorId;
    const aimedAtMe = aimedAt === me;
    const canBlock = onAction && BLOCK_ROLES[action].some((r) => held.has(r));
    const stake =
      (aimedAtMe && !canBlock && !nothingToSteal ? (HARM[action] ?? 0) : 0) +
      GRATITUDE * (aimedAt ? (memory.favor.get(aimedAt) ?? 0) : 0) +
      COUP_HARM * coupRisk;
    return (perSeat(p) * calm * (stake ? 1 : BYSTANDER) + p * stake) * caution;
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
      if (real) {
        const slowplay = pending!.action === 'foreignAid' && !stillClaims(me, real) && random() < SLOWPLAY;
        return slowplay ? { type: 'passBlock' } : { type: 'block', role: real };
      }
      // 3 张都亮在桌上的角色没人会信，看起来没有的角色也不装（还有别的可装就装别的）；除非不阻挡就出局
      const fakes = dying ? roles : roles.filter((r) => !allSeen(r) && !lacks(me, r));
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
