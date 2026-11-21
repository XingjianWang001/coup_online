// 电脑玩家的表态（#58）：什么时候说、说哪条。和 computer.ts 并列，只看公开信息（ADR 0013）：
// 公开状态和本局公开事件，不读暗牌、性格、牌堆记忆。行动策略不读这里的任何东西，表态也不进 decideComputerIntent。
//
// 每个场景是一张表（条件 → 带权重的候选）加一个把公开局面翻成表里条件的函数，返回候选和发言延迟的区间；
// Room 在对应的时刻调用它，用 speak 抽签。新场景另写一张表和一个函数，不改已有的。调参只改表里的数。
import { ASSASSINATE_COST, BLOCK_ROLES, COUP_COST, FORCED_COUP_COINS, needsTarget, type ActionType, type GameEvent, type PublicState, type Role } from '@coup/engine';
import { PHRASES, type Phrase, type Reaction } from '@coup/shared';
import { contradicts, recall } from './computer.ts';

// 候选的一条：短语，「我有 X」（claim，X 由各场景按语境定，必须在自己仍作数的声称里，否则不算候选），
// 或一种行动预告（真的 announce、虚晃到另一目标 feintTarget、虚晃成另一种针对性行动 feintAction、反预告 counter），具体预告什么由各场景给出
export type Line = Phrase | 'claim' | Announcing;
type Announcing = 'announce' | 'feintTarget' | 'feintAction' | 'counter' | 'again' | OffTurnAnnouncing; // again：听到手下留情时再预告一遍同一目标（表 7）
type Weights = Partial<Record<Line | 'silence', number>>;

// 场景表的一行：条件成立时给出带权重的候选。silence 是这一行对沉默的倍数（「多沉默」大于 1，「开口概率高」小于 1）
export interface Row<S> {
  when: (s: S) => boolean;
  say: Weights;
  exclude?: readonly Line[];
}

// 以下数值都是起始值，靠试玩校准。
// 沉默的基础权重：一行三条候选（3 + 2 + 1.5）时开口约一半
const SILENCE = 8;
// 表里一行的候选按偏好从高到低排；「权重高」「权重低」是在这之外再写明的
const FIRST = 3;
const SECOND = 2;
const THIRD = 1.5;
const HIGH = 2 * FIRST;
const LOW = 0.5;
const QUIET = 3; // 多沉默

// 合并所有成立的行：同一条的权重相乘，任何一行写了排除就排除。沉默在每一行都是候选
export function merge<S>(rows: readonly Row<S>[], s: S): Map<Line | 'silence', number> {
  const weights = new Map<Line | 'silence', number>([['silence', SILENCE]]);
  const excluded = new Set<Line>();
  for (const row of rows.filter((r) => r.when(s))) {
    for (const [line, w] of Object.entries(row.say) as [Line | 'silence', number][]) weights.set(line, (weights.get(line) ?? 1) * w);
    row.exclude?.forEach((line) => excluded.add(line));
  }
  for (const line of excluded) weights.delete(line);
  return weights;
}

// 抽签用的候选：null 是沉默，排在最后
export type Options = (readonly [Reaction | null, number])[];
export interface Moment {
  options: Options;
  delayMs: readonly [number, number]; // 从此刻起多久之后说
  // 到点发送时语境还在不在。给了的换阶段、换行动者时 Room 不清它，全靠它判断，所以它自己要写全「还算不算数」；
  // 不给的只靠换阶段、换行动者时的清除
  current?: (state: PublicState) => boolean;
  depth?: number; // 接话的层数（表 7）：回应第 n 层的这句是第 n + 1 层；不是接话的是 0
}
const NOTHING = (delayMs: readonly [number, number]): Moment => ({ options: [], delayMs });

// 把合并后的候选翻成表态；claimRole 是「我有 X」的 X，不在自己仍作数的声称里时不给（这条不算候选）。
// 预告类的一条可以对应几条具体预告（如虚晃到另外几个目标），平分这条的权重；一条也没有就不算候选
function toOptions(weights: Map<Line | 'silence', number>, claimRole: Role | undefined, announcements: Partial<Record<Announcing, readonly Reaction[]>> = {}): Options {
  const options: Options = [];
  for (const [line, w] of weights) {
    if (line === 'silence') continue;
    if ((PHRASES as readonly string[]).includes(line)) options.push([{ kind: 'phrase', phrase: line as Phrase }, w]);
    else if (line === 'claim') {
      if (claimRole) options.push([{ kind: 'verbalClaim', has: true, role: claimRole }, w]);
    } else {
      const said = announcements[line as Announcing] ?? [];
      for (const reaction of said) options.push([reaction, w / said.length]);
    }
  }
  options.push([null, weights.get('silence')!]);
  return options;
}

// 按权重抽一条；抽中沉默或没有候选时不说话。说话时再抽一次延迟
export function speak({ options, delayMs: [min, max] }: Moment, random: () => number): { reaction: Reaction; delayMs: number } | null {
  let roll = random() * options.reduce((sum, [, w]) => sum + w, 0);
  for (const [reaction, w] of options) {
    roll -= w;
    if (roll < 0) return reaction && { reaction, delayMs: min + random() * (max - min) };
  }
  return null;
}

// ── 全桌错峰与降温（#74）：Room.say 让所有场景的电脑表态都经过这里，场景表不用管 ──
// 两条电脑表态之间至少隔这么久；撞上的顺延到那之后，再加 0～JITTER_MS 的抖动
const SPEECH_GAP_MS = 800;
const JITTER_MS = 300;

// 电脑已发出的一条表态
export interface Said {
  playerId: string;
  reaction: Reaction;
  at: number;
}

// 顺延后比原定时刻晚过这么久就取消：说的是眼前的事，晚到就过时了，也不排长队。
// 换阶段或换行动者时 clearTimer 已经把这期间的表态清掉，这里兜住同一阶段里排得太久的（例如牌局结束后几个电脑都要说）
const MAX_LATE_MS = 2_000;

// 到点时决定这条表态现在说（0）、再等多久，还是取消（null）：离全桌上一条电脑表态（lastAt）不足间隔就顺延。dueAt 是原定时刻
export function stagger(now: number, lastAt: number | undefined, dueAt: number, random: () => number): number | null {
  const wait = (lastAt ?? -Infinity) + SPEECH_GAP_MS - now;
  if (wait <= 0) return 0;
  const delay = wait + random() * JITTER_MS;
  return now + delay - dueAt > MAX_LATE_MS ? null : delay;
}

// 降温：全桌上一条电脑表态（自己的或别的电脑的）刚发出时沉默乘 COOL，COOL_MS 内线性恢复到原值
const COOL = 3;
const COOL_MS = 8_000;
// 重复降权：自己最近 REPEAT_MEMORY 条里说过的同一条，权重乘 REPEAT（不禁用）
const REPEAT = 0.3;
const REPEAT_MEMORY = 3;
// 同一条表态：字段相同即可，不论对象怎么拼出来的
const lineKey = (r: Reaction) => JSON.stringify(r, Object.keys(r).sort());

// 抽签前按电脑本局说过的话（said，按时间先后）调整候选的权重
export function temper(moment: Moment, me: string, said: readonly Said[], now: number): Moment {
  const last = said.at(-1);
  const cool = 1 + (COOL - 1) * Math.max(0, 1 - (last ? now - last.at : Infinity) / COOL_MS);
  const recent = new Set(said.filter((s) => s.playerId === me).slice(-REPEAT_MEMORY).map((s) => lineKey(s.reaction)));
  const options: Options = moment.options.map(([r, w]) => [r, r ? (recent.has(lineKey(r)) ? w * REPEAT : w) : w * cool]);
  return { ...moment, options };
}

// 公开前情复用电脑的局内记忆（computer.ts 的 recall）：不给它自己放回牌堆的牌，它得出的就只依赖公开事件。
// 「谁最近打过自己」随回合淡化，只在发言里：和表 4 的「第二次被同一人针对」一样，他之后自己的回合超出 AGAIN_FADE 就不算。
// ponytail: 用到它的都是有无两档的条件，淡化只取了截止，不按回合减权重
function memoryOf(state: PublicState, events: readonly GameEvent[], me: string) {
  const memory = recall(events, me, state.players.map((p) => p.id), 0, []);
  const { attacker } = memory;
  return { ...memory, attacker: attacker && aimedAgo(events, events.length, attacker, me) ? attacker : undefined };
}
const shownCount = (state: PublicState, role: Role) => state.players.reduce((n, p) => n + p.revealed.filter((r) => r === role).length, 0);
// 最近一次声称（行动或阻挡）的事件下标，没有时是 -1
function lastClaimAt(events: readonly GameEvent[]): number {
  let at = events.length - 1;
  const claims = (e: GameEvent) => e.type === 'blocked' || (e.type === 'actionChosen' && !!e.claimedRole);
  while (at >= 0 && !claims(events[at])) at -= 1;
  return at;
}

// 任何行动预告都要看起来说得通：自己付得起（金币到 10 只能政变），针对性行动的目标在场、不是自己（偷窃还得对方有金币可偷），
// 非针对性行动不带目标。只看公开信息
const COST: Partial<Record<ActionType, number>> = { coup: COUP_COST, assassinate: ASSASSINATE_COST };
export function plausible(state: PublicState, me: string, action: ActionType, targetId?: string): boolean {
  const { coins } = state.players.find((p) => p.id === me)!;
  if (coins < (COST[action] ?? 0) || (coins >= FORCED_COUP_COINS && action !== 'coup')) return false;
  if (!needsTarget(action)) return targetId === undefined;
  const target = state.players.find((p) => p.id === targetId);
  return !!target?.alive && target.id !== me && (action !== 'steal' || target.coins > 0);
}
const announcement = (action: ActionType, targetId?: string): Reaction =>
  targetId === undefined ? { kind: 'announcement', action } : { kind: 'announcement', action, targetId };

// ── 表 1：轮到自己，行动决定已作出（行动预告）──
// 发言模块唯一的私有输入：自己刚作出、停顿之后就公开的那个决定，只用在这张表里（#58）。
// 嘴跟着手走：这里读决定，决定不读这里
export interface Decision {
  action: ActionType;
  targetId?: string;
}
interface OwnTurn {
  action: ActionType;
  forced: boolean; // 金币已到 10，人人知道必须政变
  atAttacker: boolean; // 目标是最近打过自己的人
  duel: boolean; // 两人对峙
  dukeStanding: boolean; // 公爵已在自己仍作数的声称里
  dukeElsewhere: boolean; // 有别人仍作数地声称着公爵
}
const FEINT = LOW; // 虚晃是小概率
const EAGER = 0.5; // 开口概率高一些
const TARGETED: readonly ActionType[] = ['coup', 'assassinate', 'steal'];
const assassinateOrSteal = (s: OwnTurn) => s.action === 'assassinate' || s.action === 'steal';
const ON_OWN_TURN: readonly Row<OwnTurn>[] = [
  { when: (s) => s.action === 'coup' && !s.forced, say: { announce: FIRST, feintTarget: FEINT } },
  { when: (s) => s.action === 'coup' && s.forced, say: { announce: FIRST, feintTarget: FEINT, silence: EAGER } },
  { when: (s) => assassinateOrSteal(s) && s.atAttacker, say: { announce: HIGH, feintTarget: FEINT * LOW, feintAction: FEINT * LOW * LOW } },
  { when: (s) => assassinateOrSteal(s) && !s.atAttacker, say: { announce: FIRST, feintTarget: FEINT, feintAction: FEINT * LOW } },
  // 真预告的权重由上面按行动给；这一行只排除虚晃目标
  { when: (s) => needsTarget(s.action) && s.duel, say: { announce: 1 }, exclude: ['feintTarget'] },
  { when: (s) => s.action === 'tax' && s.dukeStanding, say: { announce: FIRST } },
  { when: (s) => s.action === 'tax' && !s.dukeStanding, say: { announce: FIRST, silence: QUIET } },
  { when: (s) => s.action === 'foreignAid' && s.dukeElsewhere, say: { announce: FIRST } }, // 像在试探他挡不挡
  { when: (s) => s.action === 'foreignAid' && !s.dukeElsewhere, say: { announce: FIRST, silence: QUIET } },
  { when: (s) => s.action === 'exchange' || s.action === 'income', say: { announce: FIRST, silence: QUIET } },
];
// 这张表的延迟是说完之后停多久再出手：预告此刻就说，决定在停顿之后执行
const ON_OWN_TURN_MS = [800, 1_500] as const;

// me 不是此刻选行动的当前玩家时没有候选
export function onOwnTurn(state: PublicState, events: readonly GameEvent[], me: string, { action, targetId }: Decision): Moment {
  if (state.phase !== 'choosingAction' || state.currentPlayerId !== me) return NOTHING(ON_OWN_TURN_MS);
  const memory = memoryOf(state, events, me);
  const rivals = state.players.filter((p) => p.alive && p.id !== me);
  const situation: OwnTurn = {
    action,
    forced: state.players.find((p) => p.id === me)!.coins >= FORCED_COUP_COINS,
    atAttacker: targetId !== undefined && memory.attacker === targetId,
    duel: rivals.length === 1,
    dukeStanding: memory.standing.get(me)?.has('duke') ?? false,
    dukeElsewhere: rivals.some((p) => memory.standing.get(p.id)?.has('duke')),
  };
  const say = (a: ActionType, t?: string) => (plausible(state, me, a, t) ? [announcement(a, t)] : []);
  const announcements = {
    announce: say(action, targetId),
    feintTarget: needsTarget(action) ? rivals.filter((p) => p.id !== targetId).flatMap((p) => say(action, p.id)) : [],
    feintAction: needsTarget(action) ? TARGETED.filter((a) => a !== action).flatMap((a) => say(a, targetId)) : [],
  };
  return { options: toOptions(merge(ON_OWN_TURN, situation), undefined, announcements), delayMs: ON_OWN_TURN_MS };
}

// ── 表 2：自己刚作出声称（含阻挡），问询窗口还开着 ──
interface OwnClaim {
  continuing: boolean; // 这个角色在这次声称之前就仍作数地声称着（如连续征税）
  proven: boolean; // 本局有声称被对质证明为真
  caught: boolean; // 本局被抓到过诈唬
  shown: number; // 这个角色桌上的明牌张数
  lastCard: boolean;
  blocking?: ActionType; // 这次声称是阻挡：被拦的行动
}
const AFTER_OWN_CLAIM: readonly Row<OwnClaim>[] = [
  { when: (s) => s.continuing, say: { dare: FIRST, claim: SECOND, honest: THIRD } },
  { when: (s) => !s.continuing, say: { honest: FIRST, claim: SECOND, silence: QUIET } },
  { when: (s) => s.proven, say: { dare: HIGH, honest: SECOND } },
  { when: (s) => s.caught, say: { honest: FIRST, claim: SECOND, dare: LOW } },
  { when: (s) => s.shown >= 2, say: { claim: FIRST, honest: SECOND } },
  { when: (s) => s.lastCard, say: { honest: FIRST, mercy: SECOND, dare: LOW } },
  { when: (s) => s.blocking === 'assassinate', say: { claim: FIRST, dare: SECOND, sure: THIRD } },
  { when: (s) => s.blocking === 'steal' || s.blocking === 'foreignAid', say: { claim: FIRST, sure: SECOND, honest: THIRD } },
];
// 声称之后很快就说，赶在别人回应之前
const AFTER_OWN_CLAIM_MS = [500, 1_500] as const;

// me 不是此刻问询窗口里的声称者时没有候选
export function afterOwnClaim(state: PublicState, events: readonly GameEvent[], me: string): Moment {
  const { pending } = state;
  const blocking = state.challengeSubject === 'block';
  if (state.phase !== 'awaitingChallenge' || !pending || (blocking ? pending.blockById : pending.actorId) !== me) return NOTHING(AFTER_OWN_CLAIM_MS);
  const role = blocking ? pending.blockRole! : pending.claimedRole!;
  // 这次声称的事件是最后一条 actionChosen 或 blocked：在它之前就作数的才算延续
  const before = memoryOf(state, events.slice(0, lastClaimAt(events)), me);
  const now = memoryOf(state, events, me);
  const situation: OwnClaim = {
    continuing: before.standing.get(me)?.has(role) ?? false,
    proven: (now.proven.get(me) ?? 0) > 0,
    caught: (now.caught.get(me) ?? 0) > 0,
    shown: shownCount(state, role),
    lastCard: state.players.find((p) => p.id === me)!.handCount === 1,
    blocking: blocking ? pending.action : undefined,
  };
  const options = toOptions(merge(AFTER_OWN_CLAIM, situation), now.standing.get(me)?.has(role) ? role : undefined);
  return { options, delayMs: AFTER_OWN_CLAIM_MS };
}

// ── 表 8：牌局结束后（只发短语） ──
interface AfterGame {
  won: boolean;
  lastOut: boolean; // 自己是最后一个被淘汰的
  shown: number; // 获胜者已揭晓几张
  bluffShown: boolean; // 获胜者揭晓的牌里没有他最后声称的角色（他本局没声称过就不算）
  honestShown: boolean; // 获胜者揭晓的牌里有他本局声称过的角色
}
const AFTER_GAME: readonly Row<AfterGame>[] = [
  { when: (s) => !s.won && s.lastOut, say: { respect: HIGH } },
  { when: (s) => !s.won && !s.lastOut, say: { respect: FIRST, silence: QUIET } },
  { when: (s) => !s.won && s.bluffShown, say: { respect: FIRST, doubt: SECOND } },
  { when: (s) => s.won && s.shown === 0, say: { respect: FIRST, silence: QUIET } },
  { when: (s) => s.won && s.honestShown, say: { honest: FIRST, respect: SECOND } },
  { when: (s) => s.won && s.shown === 2 && s.bluffShown, say: { dare: FIRST, respect: SECOND } },
];
// 每位电脑在结束后这段时间里各醒来一次（Room 抽时刻），按那时已公开的揭晓结果决定说不说，说就当即说
export const AFTER_GAME_MS = [1_000, 6_000] as const;
const AT_ONCE = [0, 0] as const;

// 牌局没结束时没有候选。只读公开的揭晓结果，不读获胜者的暗牌
export function afterGame(state: PublicState, events: readonly GameEvent[], me: string): Moment {
  const winner = state.winnerId;
  if (state.phase !== 'gameOver' || !winner) return NOTHING(AT_ONCE);
  const claims = events.flatMap((e) =>
    e.type === 'actionChosen' && e.actorId === winner && e.claimedRole ? [e.claimedRole] : e.type === 'blocked' && e.blockerId === winner ? [e.role] : [],
  );
  const shown = state.players.find((p) => p.id === winner)!.postGameRevealed.map((r) => r.role);
  const situation: AfterGame = {
    won: me === winner,
    lastOut: events.filter((e) => e.type === 'eliminated').at(-1)?.playerId === me,
    shown: shown.length,
    bluffShown: shown.length > 0 && claims.length > 0 && !shown.includes(claims.at(-1)!),
    honestShown: shown.some((r) => claims.includes(r)),
  };
  return { options: toOptions(merge(AFTER_GAME, situation), undefined), delayMs: AT_ONCE };
}

// 从此刻起还没换过回合。events 在 Room 里是本局只增不减的同一个数组，到点时已含这期间的事
const thisTurn = (events: readonly GameEvent[]) => {
  const seen = events.length;
  return () => !events.slice(seen).some((e) => e.type === 'turnChanged');
};

// 问询窗口前段、自己还没回应时说的话（表 3 试探；表 4 里偷窃、暗杀的目标也这样）：发送时自己已回应、有人质疑或窗口已关就作废。
// 窗口关了又在下一回合开出同一种窗口也不算
const whileUndecided = (state: PublicState, events: readonly GameEvent[], me: string) => {
  const subject = state.challengeSubject;
  const sameTurn = thisTurn(events);
  return (now: PublicState) => now.phase === 'awaitingChallenge' && now.challengeSubject === subject && !now.passed.includes(me) && sameTurn();
};

// ── 表 3：别人作出声称（含阻挡），自己有资格质疑且尚未回应（试探）。冲着自己来的行动另见表 4 ──
// 试探不读自己的决定，也不改变之后质疑的概率：行动策略不读这里
interface Probe {
  caught: boolean; // 声称者本局被抓到过诈唬
  contradicts: boolean; // 声称矛盾
  proven: boolean; // 声称者本局有声称被对质证明为真
  shown: number; // 这个角色桌上的明牌张数，不算自己的暗牌
  alsoMine: boolean; // 自己也仍作数地声称着这个角色
  blocking?: 'mine' | 'other'; // 这次声称是阻挡：拦的是自己的还是别人的行动
}
const LOUD = 1 / QUIET; // 开口概率高
// 同一声称的延续（如连续征税）与基线相同，不单写一行：重复几次候选和概率都一样
const PROBE: readonly Row<Probe>[] = [
  { when: (s) => !(s.caught || s.contradicts || s.proven || s.shown >= 2 || s.alsoMine || s.blocking), say: { sure: FIRST, silence: QUIET } },
  { when: (s) => s.caught, say: { doubt: FIRST, sure: SECOND } },
  { when: (s) => s.contradicts, say: { doubt: HIGH, sure: SECOND } },
  { when: (s) => s.proven, say: { sure: FIRST, silence: QUIET } },
  { when: (s) => s.shown === 2, say: { sure: FIRST, doubt: SECOND } },
  { when: (s) => s.shown === 3, say: { doubt: FIRST, silence: LOUD } },
  { when: (s) => s.alsoMine, say: { claim: FIRST, doubt: SECOND } },
  { when: (s) => s.blocking === 'mine', say: { doubt: FIRST, sure: SECOND } },
  { when: (s) => s.blocking === 'other', say: { sure: FIRST, silence: QUIET } },
];
// 窗口前段：电脑在问询窗口里最快 1.5 秒出手，试探多半赶在自己回应之前
const PROBE_MS = [600, 1_400] as const;

// me 不在场、是声称者、已回应、是这次行动的目标，或问询窗口没开着时没有候选
export function probe(state: PublicState, events: readonly GameEvent[], me: string): Moment {
  const { pending } = state;
  const blocking = state.challengeSubject === 'block';
  const claimantId = blocking ? pending?.blockById : pending?.actorId;
  const eligible = state.players.find((p) => p.id === me)?.alive && claimantId !== me && !state.passed.includes(me);
  if (state.phase !== 'awaitingChallenge' || !pending || !eligible || (!blocking && pending.targetId === me)) return NOTHING(PROBE_MS);
  const role = blocking ? pending.blockRole! : pending.claimedRole!;
  const memory = memoryOf(state, events, me);
  const situation: Probe = {
    caught: (memory.caught.get(claimantId!) ?? 0) > 0,
    contradicts: contradicts(memory, state.players.find((p) => p.id === claimantId)!, role),
    proven: (memory.proven.get(claimantId!) ?? 0) > 0,
    shown: shownCount(state, role),
    alsoMine: memory.standing.get(me)?.has(role) ?? false,
    blocking: blocking ? (pending.actorId === me ? 'mine' : 'other') : undefined,
  };
  return { options: toOptions(merge(PROBE, situation), situation.alsoMine ? role : undefined), delayMs: PROBE_MS, current: whileUndecided(state, events, me) };
}

// 反预告：以 targetId 为目标的行动预告，在政变、暗杀、偷窃里选头一个说得通的（自己付得起，偷窃还得对方有金币）；
// 都说不通时一条也没有，这条就不算候选。只读公开信息，不兑现也无妨。表 4 引入，结果公开后、接话时也用
export const counterAnnouncement = (state: PublicState, me: string, targetId: string): Reaction[] =>
  TARGETED.filter((a) => plausible(state, me, a, targetId))
    .slice(0, 1)
    .map((a) => announcement(a, targetId));

// ── 表 4：成为偷窃、暗杀、政变的目标。偷窃、暗杀在问询窗口前段说，政变在宣布后说 ──
interface Targeted {
  action: ActionType;
  blocker?: Role; // 自己仍作数地声称着、能挡这次行动的角色
  lastCard: boolean;
  again: number; // 第二次被同一人针对：他上次针对自己是他自己往前数第几个回合（1 是他的上一回合）；0 是近来没有
  actorCaught: boolean; // 行动者本局被抓到过诈唬
}
// 第二次被同一人针对的加权随回合淡化：他上一回合刚针对过自己时全额，再早一回合的按指数减弱，更早的不算。
// 指数小于 1 只让倍数向 1 靠拢，不会压低别的行已给的权重
const AGAIN_FADE = [1, 0.5];
// 往回数 actorId 自己的回合（1 是 end 之前他的最近一个回合），找他最近一次针对 me 的行动；超出淡化的回合数就不算（0）
function aimedAgo(events: readonly GameEvent[], end: number, actorId: string, me: string): number {
  for (let i = end - 1, n = 1; i >= 0 && n <= AGAIN_FADE.length; i -= 1) {
    const e = events[i];
    if (e.type !== 'actionChosen' || e.actorId !== actorId) continue;
    if (e.targetId === me) return n;
    n += 1;
  }
  return 0;
}
const again = (turns: number, fade: number): Row<Targeted> => ({
  when: (s) => s.again === turns,
  say: { counter: HIGH ** fade, doubt: SECOND ** fade, mercy: THIRD ** fade },
});
const TARGETED_AT_ME: readonly Row<Targeted>[] = [
  { when: (s) => s.action === 'steal' && !!s.blocker, say: { claim: FIRST, sure: SECOND } },
  { when: (s) => s.action === 'steal' && !s.blocker, say: { mercy: FIRST, sure: SECOND, counter: THIRD } },
  { when: (s) => s.action === 'assassinate' && !!s.blocker, say: { claim: FIRST, sure: SECOND } },
  { when: (s) => s.action === 'assassinate' && !s.blocker && !s.lastCard, say: { sure: FIRST, mercy: SECOND, counter: THIRD } },
  { when: (s) => s.action === 'assassinate' && !s.blocker && s.lastCard, say: { mercy: HIGH, sure: SECOND, doubt: THIRD } },
  // 政变化解不了，不求手下留情
  { when: (s) => s.action === 'coup' && !s.lastCard, say: { counter: FIRST, respect: SECOND }, exclude: ['mercy'] },
  { when: (s) => s.action === 'coup' && s.lastCard, say: { respect: FIRST, silence: QUIET }, exclude: ['mercy'] },
  ...AGAIN_FADE.map((fade, i) => again(i + 1, fade)),
  { when: (s) => s.action !== 'coup' && s.actorCaught, say: { doubt: HIGH } },
];
// 偷窃、暗杀赶在窗口前段（电脑最快 1.5 秒回应）；政变赶在自己选丢哪张之前（最快 2 秒）
const TARGETED_MS = [600, 1_400] as const;

// me 不是此刻偷窃、暗杀（问询窗口开着、自己还没回应）或政变（轮到自己选丢哪张）的目标时没有候选
export function targeted(state: PublicState, events: readonly GameEvent[], me: string): Moment {
  const at = lastIndex(events, 'actionChosen');
  const chosen = events[at];
  if (chosen?.type !== 'actionChosen' || chosen.targetId !== me) return NOTHING(TARGETED_MS);
  const { action, actorId } = chosen;
  const coup = action === 'coup';
  const open = coup
    ? state.phase === 'choosingLoss' && state.lossPlayerId === me
    : (action === 'steal' || action === 'assassinate') && state.phase === 'awaitingChallenge' && state.challengeSubject === 'action' && !state.passed.includes(me);
  if (!open) return NOTHING(TARGETED_MS);
  const memory = memoryOf(state, events, me);
  const blocker = BLOCK_ROLES[action].find((r) => memory.standing.get(me)?.has(r));
  const situation: Targeted = {
    action,
    blocker,
    lastCard: state.players.find((p) => p.id === me)!.handCount === 1,
    again: aimedAgo(events, at, actorId, me),
    actorCaught: (memory.caught.get(actorId) ?? 0) > 0,
  };
  const options = toOptions(merge(TARGETED_AT_ME, situation), blocker, { counter: counterAnnouncement(state, me, actorId) });
  return { options, delayMs: TARGETED_MS, current: coup ? undefined : whileUndecided(state, events, me) };
}

// ── 表 5：结果公开后（#82）。一次结算里的质疑结果、失去影响力、淘汰合并成一次机会 ──
// 对质的结果在揭晓那一刻就定了谁失去影响力：质疑失败者还要自己选丢哪张，暗杀还要目标再丢一张，这些待丢的都算进这次结算，
// 之后选牌那一下不再给机会。阻挡没人质疑、窗口关上时，阻挡成立也算一次结果
interface Result {
  challenge?: 'won' | 'lost'; // 自己质疑成功、失败
  claim?: 'proven' | 'caught'; // 自己的声称被证明为真、被抓到诈唬
  backed: boolean; // 这次声称以来自己说过来质疑我啊、我是老实人或我有 X（X 是这次声称的角色）
  saved?: 'assassinate' | 'steal'; // 针对自己的暗杀或偷窃确实被化解
  how?: 'unchallenged' | 'proven' | 'caught'; // 怎么化解的：自己阻挡没人质疑、自己阻挡被质疑并证明为真、行动者被别人质疑抓到
  blocked: boolean; // 自己的行动被阻挡（阻挡成立），自己没质疑
  hit: boolean; // 自己被政变或暗杀失去影响力，还在场（对质里丢的由上面几行管）
  canCounter: boolean; // 金币够反击打自己的人（反预告说得通）
  out: boolean; // 自己被淘汰（含这次结算里待丢的最后一张）
  outed: boolean; // 自己让别人被淘汰
  watched?: 'caught' | 'proven'; // 旁观（不是对质双方、也不是行动的目标）：别人被抓到诈唬、别人的声称被证明为真
}
const BACKING: readonly Line[] = ['honest', 'dare', 'claim'];
const AFTER_RESULT: readonly Row<Result>[] = [
  { when: (s) => s.challenge === 'lost' && !s.out, say: { respect: FIRST, silence: QUIET } },
  { when: (s) => s.challenge === 'lost' && s.out, say: { respect: FIRST } },
  { when: (s) => s.challenge === 'won', say: { doubt: FIRST, silence: QUIET } },
  { when: (s) => s.claim === 'proven' && s.backed, say: { honest: FIRST, dare: SECOND } },
  { when: (s) => s.claim === 'proven' && !s.backed, say: { honest: FIRST, silence: QUIET } },
  { when: (s) => s.claim === 'caught' && s.backed, say: { respect: FIRST }, exclude: BACKING },
  { when: (s) => s.claim === 'caught' && !s.backed, say: { respect: FIRST, mercy: SECOND, silence: QUIET }, exclude: BACKING },
  { when: (s) => s.saved === 'assassinate' && s.how === 'unchallenged', say: { close: FIRST } },
  { when: (s) => s.saved === 'assassinate' && s.how === 'proven', say: { close: FIRST, honest: SECOND } },
  { when: (s) => s.saved === 'assassinate' && s.how === 'caught', say: { close: FIRST, respect: SECOND } },
  { when: (s) => s.saved === 'steal', say: { close: FIRST, silence: QUIET } },
  { when: (s) => s.blocked, say: { doubt: FIRST, silence: QUIET } },
  { when: (s) => s.hit && s.canCounter, say: { counter: FIRST, mercy: SECOND } },
  { when: (s) => s.hit && !s.canCounter, say: { mercy: FIRST, respect: SECOND, silence: QUIET } },
  { when: (s) => s.out, say: { respect: FIRST, silence: QUIET } },
  { when: (s) => s.outed, say: { respect: FIRST, silence: QUIET } },
  { when: (s) => s.watched === 'caught', say: { doubt: FIRST, silence: QUIET } },
  { when: (s) => s.watched === 'proven', say: { respect: FIRST, silence: QUIET } },
];
// 结果公开后稍停一下再说（认错、自嘲不抢在结果前头）。对质的结果另要等揭晓动画播完，由 Room 加上动画时长
export const AFTER_RESULT_MS = [800, 2_000] as const;
const SETTLING: readonly GameEvent['type'][] = ['influenceLost', 'eliminated', 'coinsChanged'];

// batch 是 events 末尾刚由这次变化产生的几条；heard 是这次声称以来听到的表态。牌局结束后归表 8，这里没有候选
export function afterResult(state: PublicState, events: readonly GameEvent[], batch: number, heard: readonly Heard[], me: string): Moment {
  if (state.phase === 'gameOver') return NOTHING(AFTER_RESULT_MS);
  const start = events.length - batch;
  const fresh = events.slice(start);
  const r = fresh.find((e) => e.type === 'challengeResolved');
  const resolved = r?.type === 'challengeResolved' ? r : undefined;
  const resolvedAt = resolved ? events.indexOf(resolved) : start;
  const chosen = events[lastIndex(events, 'actionChosen', resolvedAt)] as Extract<GameEvent, { type: 'actionChosen' }> | undefined;
  const claimAt = lastClaimAt(events.slice(0, resolvedAt));
  const blockAt = lastIndex(events, 'blocked', resolvedAt);
  const onBlock = blockAt >= 0 && blockAt === claimAt && blockAt > lastIndex(events, 'actionChosen', resolvedAt);
  const blockerId = onBlock ? (events[blockAt] as Extract<GameEvent, { type: 'blocked' }>).blockerId : undefined;

  // 这次变化里失去影响力、被淘汰的人。这次只是在丢上一次对质结果定下的那张时（质疑失败者那张，或诈唬阻挡暗杀被抓后暗杀要的那张），
  // 已在那次结算里说过
  let i = start - 1;
  while (i >= 0 && SETTLING.includes(events[i].type)) i -= 1;
  const before = events[i];
  const first = fresh.find((e) => e.type === 'influenceLost');
  const lostSince = (id: string) => events.slice(i, start).filter((e) => e.type === 'influenceLost' && e.playerId === id).length;
  const folded =
    !resolved && before?.type === 'challengeResolved' && first?.type === 'influenceLost' &&
    (before.truth ? first.playerId === before.loserId && lostSince(first.playerId) === 0 : first.playerId === before.claimantId && lostSince(first.playerId) === 1);
  const challengerId = resolved && (events[lastIndex(events, 'challenged', resolvedAt)] as Extract<GameEvent, { type: 'challenged' }>).challengerId;
  // 谁让 id 失去了影响力：对质里输的是对质的另一方，否则是政变、暗杀他的行动者。没有的（弃权）不算结果
  const culprit = (id: string) =>
    resolved && resolved.loserId === id
      ? id === resolved.claimantId ? challengerId : resolved.claimantId
      : chosen && chosen.targetId === id && (chosen.action === 'coup' || chosen.action === 'assassinate') ? chosen.actorId : undefined;
  const losers = new Set(folded ? [] : fresh.flatMap((e) => (e.type === 'influenceLost' ? [e.playerId] : [])));
  const outs = new Set(folded ? [] : fresh.flatMap((e) => (e.type === 'eliminated' ? [e.playerId] : [])));
  if (resolved && state.lossPlayerId) {
    losers.add(state.lossPlayerId);
    if (state.players.find((p) => p.id === state.lossPlayerId)!.handCount === 1) outs.add(state.lossPlayerId);
  }
  for (const set of [losers, outs]) for (const id of set) if (!culprit(id)) set.delete(id);
  // 阻挡没人质疑：这次变化关掉了阻挡的问询窗口，轮到下一位
  const stood = !resolved && onBlock && lastIndex(events, 'challenged', start) < blockAt && lastIndex(events, 'turnChanged', start) < blockAt && fresh.some((e) => e.type === 'turnChanged');
  const threat = chosen && chosen.targetId === me && (chosen.action === 'assassinate' || chosen.action === 'steal') ? chosen.action : undefined;
  const how: Result['how'] = stood
    ? 'unchallenged'
    : resolved && onBlock && resolved.truth && blockerId === me ? 'proven'
    : resolved && !onBlock && !resolved.truth && challengerId !== me ? 'caught'
    : undefined;
  const claimEvent = events[claimAt] as Claim | undefined;
  const claimRole = claimEvent && (claimEvent.type === 'blocked' ? claimEvent.role : claimEvent.claimedRole);
  const party = resolved && (me === resolved.claimantId || me === challengerId);
  const attacker = culprit(me);
  const situation: Result = {
    challenge: resolved && challengerId === me ? (resolved.truth ? 'lost' : 'won') : undefined,
    claim: resolved?.claimantId === me ? (resolved.truth ? 'proven' : 'caught') : undefined,
    backed: heard.some(({ playerId, reaction: x }) => playerId === me && (x.kind === 'phrase' ? x.phrase === 'dare' || x.phrase === 'honest' : x.kind === 'verbalClaim' && x.has && x.role === claimRole)),
    saved: how && (how !== 'unchallenged' || blockerId === me) ? threat : undefined,
    how,
    blocked: chosen?.actorId === me && (stood || (!!resolved && onBlock && resolved.truth && challengerId !== me)),
    hit: !resolved && losers.has(me) && !outs.has(me),
    canCounter: !!attacker && counterAnnouncement(state, me, attacker).length > 0,
    out: outs.has(me),
    outed: [...outs].some((id) => id !== me && culprit(id) === me),
    watched: resolved && !party && chosen?.targetId !== me ? (resolved.truth ? 'proven' : 'caught') : undefined,
  };
  if (!AFTER_RESULT.some((row) => row.when(situation))) return NOTHING(AFTER_RESULT_MS);
  const counter = attacker && !situation.out ? counterAnnouncement(state, me, attacker) : [];
  // 说到下一次结算为止：选丢哪张（这次结算里待丢的）、下一位行动都不算，下一次行动之后的对质结果、失去影响力、阻挡才算；牌局结束归表 8
  const seen = events.length;
  const current = (now: PublicState) => {
    const later = events.slice(seen);
    const next = later.findIndex((e) => e.type === 'actionChosen');
    return now.phase !== 'gameOver' && (next < 0 || !later.slice(next).some((e) => NEXT_RESULT.includes(e.type)));
  };
  return { options: toOptions(merge(AFTER_RESULT, situation), undefined, { counter }), delayMs: AFTER_RESULT_MS, current };
}
const NEXT_RESULT: readonly GameEvent['type'][] = ['challengeResolved', 'influenceLost', 'blocked'];

// ── 表 6：回合外的局势（没轮到自己时，只读公开信息：谁最近打过自己、各人的金币和影响力）──
// 预告不兑现也无妨，行动策略不读它。每种局势在刚出现时给一次机会：held 是上次看时已成立的局势，
// Room 按电脑各记一份、开局清空；同一局势持续时不再抽签，消失后再出现算新的
type OffTurnAnnouncing = 'warnCoup' | 'warnAssassinate'; // 预告政变（最近打过自己的人，没有则领先者；对峙时就是对手）、预告暗杀刚打自己的人
interface OffTurn {
  coins7: boolean; // 自己金币刚到 7
  attacker: boolean; // 有最近打过自己、还在场的人
  hit: boolean; // 刚被人打（被偷窃、暗杀、政变的目标）；金币够不够 3 由预告说不说得通来管
  rich: boolean; // 多人局，有对手金币刚到 10：自己可能是他被迫政变的目标
  threatened: boolean; // 两人对峙，对手够政变，自己只剩 1 点影响力
  threatening: boolean; // 两人对峙，自己够政变，对手只剩 1 点影响力
}
const OFF_TURN: readonly Row<OffTurn>[] = [
  { when: (s) => s.coins7 && s.attacker, say: { warnCoup: FIRST, silence: QUIET } },
  { when: (s) => s.coins7 && !s.attacker, say: { warnCoup: FIRST, silence: QUIET } },
  { when: (s) => s.hit, say: { warnAssassinate: FIRST, silence: QUIET } },
  { when: (s) => s.rich, say: { mercy: FIRST, silence: QUIET } },
  { when: (s) => s.threatened, say: { mercy: FIRST, respect: SECOND } },
  { when: (s) => s.threatening, say: { warnCoup: FIRST, silence: QUIET } },
];
// 局势刚出现就说；换阶段或换行动者时 Room 清掉没说出的，电脑在任何阶段最快 1.5 秒出手
const OFF_TURN_MS = [500, 1_800] as const;

// 轮到自己时（表 1 的事）不看也不更新 held：轮完之后还成立就算刚出现。自己出局或牌局结束后没有候选
export function offTurn(state: PublicState, events: readonly GameEvent[], me: string, held: ReadonlySet<string>): { held: ReadonlySet<string>; moment: Moment } {
  const self = state.players.find((p) => p.id === me);
  if (state.phase === 'gameOver' || !self?.alive) return { held: new Set(), moment: NOTHING(OFF_TURN_MS) };
  if (state.currentPlayerId === me) return { held, moment: NOTHING(OFF_TURN_MS) };
  const rivals = state.players.filter((p) => p.alive && p.id !== me);
  const [rival] = rivals.length === 1 ? rivals : [];
  const hitAt = events.reduce((at, e, i) => (e.type === 'actionChosen' && e.targetId === me ? i : at), -1);
  // 局势带上身份：每次被打、每位到 10 的对手各算一种
  const now = new Set<string>();
  if (self.coins >= COUP_COST) now.add('coins7');
  if (hitAt >= 0) now.add(`hit:${hitAt}`);
  if (!rival) for (const p of rivals.filter((p) => p.coins >= FORCED_COUP_COINS)) now.add(`rich:${p.id}`);
  if (rival && rival.coins >= COUP_COST && self.handCount === 1) now.add('threatened');
  if (rival && self.coins >= COUP_COST && rival.handCount === 1) now.add('threatening');
  const fresh = [...now].filter((k) => !held.has(k));
  const memory = memoryOf(state, events, me);
  const attacker = rivals.find((p) => p.id === memory.attacker);
  // 领先者：影响力最多、其次金币最多；ponytail: 再平手取座次靠前的
  const leader = rivals.reduce((a, b) => (b.handCount > a.handCount || (b.handCount === a.handCount && b.coins > a.coins) ? b : a));
  const situation: OffTurn = {
    coins7: fresh.includes('coins7'),
    attacker: !!attacker,
    hit: fresh.some((k) => k.startsWith('hit:')),
    rich: fresh.some((k) => k.startsWith('rich:')),
    threatened: fresh.includes('threatened'),
    threatening: fresh.includes('threatening'),
  };
  const say = (a: ActionType, t?: string) => (plausible(state, me, a, t) ? [announcement(a, t)] : []);
  // 最近打过自己的人就是刚打自己的人：局内记忆记的是最后一次以自己为目标的行动者
  const options = toOptions(merge(OFF_TURN, situation), undefined, { warnCoup: say('coup', (attacker ?? leader).id), warnAssassinate: say('assassinate', memory.attacker) });
  return { held: now, moment: { options, delayMs: OFF_TURN_MS } };
}

// ── 表 7：接话（#81）。听到短语和口头声称时回一句；听到行动预告、手下留情、好险的各行是 #83 加的 ──
// 桌上通过校验的一条表态（真人和电脑的）：电脑「听到」的全部内容，由 Room.relay 按时间先后记下
export interface Heard extends Said {
  depth: number; // 接话的层数：自己起头的是 0，回应第 n 层的是 n + 1。只在服务器里记，不进协议
  seen: number; // 听到时本局已有几条公开事件：拿预告和之后的公开行动比，看兑没兑现
}
// 表态不带对象（ADR 0012）：先从公开语境认出听到的是哪一类、是不是冲着自己来，认不出的不接
interface Reply {
  // 你确定？/我信你个鬼；当前声称者替声称表态；窗口之外的我有 X / 我没有 X；佩服；
  // 预告针对自己、针对别人、预告征税、外援（#83）；手下留情、好险（#83，牌局中）
  heard: 'doubt' | 'backing' | 'has' | 'hasNot' | 'respect' | 'aimed' | 'aimedElsewhere' | 'tax' | 'foreignAid' | 'mercy' | 'close';
  claimant: boolean; // 自己是当前问询窗口的声称者
  continuing: boolean; // 自己是声称者，这次声称之前就仍作数地声称着这个角色（如连续征税）
  settled: boolean; // 最近一次声称是自己的、没人质疑、已过了问询窗口，或自己刚发过口头声称
  caught: boolean; // 自己是声称者时：自己被抓过；否则：说话者被抓过
  proven: boolean; // 同上：证明过
  contradicts: boolean; // 说话者对说的这个角色的声称矛盾
  alsoMine: boolean; // 自己也仍作数地声称着说的这个角色
  allShown: boolean; // 说的这个角色 3 张都已是明牌
  won?: 'claimant' | 'challenger'; // 自己刚赢下一次对质：作为被证明为真的声称者，或作为质疑者
  over: boolean; // 牌局已结束
  action?: ActionType; // 听到的行动预告是什么行动
  affordable: boolean; // 预告者金币够付预告的行动
  broken: number; // 说话者上次针对自己的预告没兑现：从没兑现的那次行动算起，是他自己的第几个回合（1 是那次）；0 是没有
  pressing: boolean; // 自己刚预告或刚发起了针对说话者的行动
  foiled: boolean; // 自己是刚才没得手的行动者
}
// 预告针对自己的 X：自己仍作数地声称着、能挡它的角色（「我有 X」的 X）记在 alsoMine
const aimed = (action: ActionType, s: Reply) => s.heard === 'aimed' && s.action === action;
const REPLY: readonly Row<Reply>[] = [
  { when: (s) => s.heard === 'doubt' && s.claimant && (s.continuing || s.proven), say: { dare: FIRST, claim: SECOND, honest: THIRD } },
  { when: (s) => s.heard === 'doubt' && s.claimant && (!s.continuing || s.caught), say: { honest: FIRST, claim: SECOND, silence: QUIET } },
  { when: (s) => s.heard === 'doubt' && s.settled, say: { honest: FIRST, claim: SECOND, silence: QUIET } },
  { when: (s) => s.heard === 'backing' && (s.caught || s.contradicts), say: { doubt: FIRST, sure: SECOND } },
  { when: (s) => s.heard === 'backing' && s.proven, say: { sure: FIRST, silence: QUIET } },
  { when: (s) => s.heard === 'backing' && s.alsoMine, say: { claim: FIRST, doubt: SECOND } },
  { when: (s) => s.heard === 'has' && s.allShown, say: { doubt: FIRST, silence: LOUD } },
  { when: (s) => s.heard === 'has' && (s.caught || s.alsoMine), say: { doubt: FIRST, claim: SECOND } },
  // 其他：我没有 X 都在这行；我有 X 是上面两行都不成立时
  { when: (s) => s.heard === 'hasNot' || (s.heard === 'has' && !s.allShown && !s.caught && !s.alsoMine), say: { sure: FIRST, doubt: SECOND, silence: QUIET } },
  { when: (s) => s.heard === 'respect' && s.won === 'claimant', say: { honest: FIRST, respect: SECOND } },
  { when: (s) => s.heard === 'respect' && s.won === 'challenger', say: { respect: FIRST, doubt: SECOND } },
  { when: (s) => s.heard === 'respect' && s.over, say: { respect: FIRST } },
  { when: (s) => aimed('coup', s) && s.affordable, say: { mercy: FIRST, counter: SECOND, respect: THIRD } },
  { when: (s) => aimed('coup', s) && !s.affordable, say: { sure: FIRST, doubt: SECOND } },
  { when: (s) => aimed('assassinate', s) && s.affordable && s.alsoMine, say: { claim: FIRST, sure: SECOND } },
  { when: (s) => aimed('assassinate', s) && s.affordable && !s.alsoMine, say: { mercy: FIRST, sure: SECOND, counter: THIRD } },
  { when: (s) => aimed('assassinate', s) && !s.affordable, say: { doubt: FIRST, sure: SECOND } },
  { when: (s) => aimed('steal', s) && s.alsoMine, say: { claim: FIRST, sure: SECOND } },
  { when: (s) => aimed('steal', s) && !s.alsoMine, say: { mercy: FIRST, counter: SECOND } },
  // 同一人上次针对自己的预告没兑现：和表 4 的「第二次被同一人针对」一样按他自己的回合淡化
  ...AGAIN_FADE.map((fade, i): Row<Reply> => ({ when: (s) => s.heard === 'aimed' && s.broken === i + 1, say: { doubt: HIGH ** fade } })),
  { when: (s) => s.heard === 'foreignAid' && s.alsoMine, say: { claim: FIRST, sure: SECOND } },
  { when: (s) => s.heard === 'tax' && (s.caught || s.contradicts), say: { doubt: FIRST, sure: SECOND } },
  { when: (s) => s.heard === 'tax' && s.alsoMine, say: { claim: FIRST, doubt: SECOND } },
  { when: (s) => s.heard === 'aimedElsewhere' && !s.affordable, say: { sure: FIRST, silence: QUIET } },
  { when: (s) => s.heard === 'mercy' && s.pressing, say: { again: FIRST, sure: SECOND, silence: QUIET } },
  { when: (s) => s.heard === 'close' && s.foiled, say: { respect: FIRST, counter: SECOND, silence: QUIET } },
];
const REPLY_MS = [600, 2_000] as const;
// 一句话、一句回应、一句再回应：第 MAX_DEPTH 层的话不再有电脑接
const MAX_DEPTH = 2;
// 「自己刚发过口头声称」的「刚」
const JUST_SAID_MS = 6_000;

// 听到 to 之后 me 回什么。heard 是本局听到的全部表态（含 to，按时间先后）。
// 返回的 current 到点时用同一份 events、heard 再判断一次：Room 里两者都是本局只增不减的同一个数组，到点时已含这期间的事。
// 在问询窗口里听到的，窗口关了就作废；其余的（如轮到谁时的行动预告）说到这一回合结束，预告的行动执行了也还算
export function replyTo(state: PublicState, events: readonly GameEvent[], heard: readonly Heard[], to: Heard, me: string): Moment {
  const subject = state.phase === 'awaitingChallenge' ? state.challengeSubject : null;
  const sameTurn = thisTurn(events);
  const inWindow = (now: PublicState) => !subject || (now.phase === 'awaitingChallenge' && now.challengeSubject === subject);
  const current = (now: PublicState) => sameTurn() && inWindow(now) && replyOptions(now, events, heard, to, me).length > 0;
  return { options: replyOptions(state, events, heard, to, me), delayMs: REPLY_MS, depth: to.depth + 1, current };
}

type Claim = Extract<GameEvent, { type: 'actionChosen' | 'blocked' }>;
function lastIndex(events: readonly GameEvent[], type: GameEvent['type'], end = events.length): number {
  let at = end - 1;
  while (at >= 0 && events[at].type !== type) at -= 1;
  return at;
}

function replyOptions(state: PublicState, events: readonly GameEvent[], heard: readonly Heard[], to: Heard, me: string): Options {
  const over = state.phase === 'gameOver';
  const alive = (id: string) => state.players.find((p) => p.id === id)?.alive ?? false;
  const at = heard.indexOf(to);
  // 不接自己的话、第三句；牌局中已淘汰的人不接，也没人接他（对方已被淘汰）；听到之后自己已开过口就算已回应
  if (to.depth >= MAX_DEPTH || to.playerId === me || (!over && !(alive(me) && alive(to.playerId)))) return [];
  if (heard.slice(at + 1).some((h) => h.playerId === me)) return [];
  const r = to.reaction;
  const { pending } = state;
  const block = state.challengeSubject === 'block';
  const claimantId = state.phase === 'awaitingChallenge' ? (block ? pending!.blockById : pending!.actorId) : undefined;
  const windowRole = claimantId ? (block ? pending!.blockRole! : pending!.claimedRole!) : undefined;
  const byClaimant = to.playerId === claimantId;
  let kind: Reply['heard'] | undefined;
  if (r.kind === 'phrase') kind = r.phrase === 'sure' || r.phrase === 'doubt' ? 'doubt' : r.phrase === 'respect' ? 'respect' : byClaimant && (r.phrase === 'dare' || r.phrase === 'honest') ? 'backing' : undefined;
  else if (r.kind === 'verbalClaim') kind = byClaimant ? (r.has ? 'backing' : undefined) : r.has ? 'has' : 'hasNot';
  else if (r.kind === 'announcement') kind = r.targetId === me ? 'aimed' : r.targetId ? 'aimedElsewhere' : r.action === 'tax' || r.action === 'foreignAid' ? r.action : undefined;
  if (r.kind === 'phrase' && (r.phrase === 'mercy' || r.phrase === 'close') && !over) kind = r.phrase;
  // 替声称表态只有有资格质疑且尚未回应的接（在场、不是声称者就有资格）
  if (kind === 'backing' && state.passed.includes(me)) return [];
  if (!kind) return [];

  const memory = memoryOf(state, events, me);
  // 说的是哪个角色：当前声称者替声称表态时是窗口里的角色，口头声称是它说的角色；预告征税、外援是公爵，
  // 预告针对自己是自己仍作数地声称着、能挡它的角色
  const announced = r.kind === 'announcement' ? r.action : undefined;
  const role =
    kind === 'backing' ? windowRole
    : r.kind === 'verbalClaim' ? r.role
    : kind === 'tax' || kind === 'foreignAid' ? 'duke'
    : kind === 'aimed' ? BLOCK_ROLES[announced!].find((x) => memory.standing.get(me)?.has(x))
    : undefined;
  const claimAt = lastClaimAt(events);
  const claim = events[claimAt] as Claim | undefined;
  // 自己的声称已经生效：最近一次声称是自己的，没人质疑，问询窗口已过
  const settledRole =
    claim && (claim.type === 'blocked' ? claim.blockerId : claim.actorId) === me && !claimantId && lastIndex(events, 'challenged') < claimAt
      ? claim.type === 'blocked' ? claim.role : claim.claimedRole
      : undefined;
  const mine = heard.slice(0, at).filter((h) => h.playerId === me).at(-1);
  const justClaimed = mine?.reaction.kind === 'verbalClaim' && mine.reaction.has && to.at - mine.at <= JUST_SAID_MS ? mine.reaction.role : undefined;
  // 刚出的对质结果：最近一次对质之后还没有新的行动
  const resolvedAt = lastIndex(events, 'challengeResolved');
  const resolved = resolvedAt > lastIndex(events, 'actionChosen') ? (events[resolvedAt] as Extract<GameEvent, { type: 'challengeResolved' }>) : undefined;
  const challenger = resolved && (events[lastIndex(events, 'challenged', resolvedAt)] as Extract<GameEvent, { type: 'challenged' }>).challengerId;
  const subject = kind === 'doubt' && claimantId === me ? me : to.playerId;
  // 手下留情：自己刚预告了针对说话者的行动，或最近一次行动是自己针对他的；再预告一遍同一目标（说得通才算候选）
  const actAt = lastIndex(events, 'actionChosen');
  const act = events[actAt] as Extract<GameEvent, { type: 'actionChosen' }> | undefined;
  const pressed =
    mine?.reaction.kind === 'announcement' && mine.reaction.targetId === to.playerId && to.at - mine.at <= JUST_SAID_MS ? [mine.reaction]
    : act?.actorId === me && act.targetId === to.playerId ? [announcement(act.action, to.playerId)]
    : [];
  const situation: Reply = {
    heard: kind,
    claimant: claimantId === me,
    continuing: claimantId === me && (memoryOf(state, events.slice(0, claimAt), me).standing.get(me)?.has(windowRole!) ?? false),
    settled: !!settledRole || !!justClaimed,
    caught: (memory.caught.get(subject) ?? 0) > 0,
    proven: (memory.proven.get(subject) ?? 0) > 0,
    contradicts: !!role && contradicts(memory, state.players.find((p) => p.id === to.playerId)!, role),
    alsoMine: !!role && (memory.standing.get(me)?.has(role) ?? false),
    allShown: !!role && shownCount(state, role) === 3,
    won: resolved?.truth && resolved.claimantId === me ? 'claimant' : resolved && !resolved.truth && challenger === me ? 'challenger' : undefined,
    over,
    action: announced,
    affordable: !!announced && state.players.find((p) => p.id === to.playerId)!.coins >= (COST[announced] ?? 0),
    broken: kind === 'aimed' ? broken(events, heard.slice(0, at), to.playerId, me) : 0,
    pressing: pressed.length > 0,
    foiled: act?.actorId === me && foiled(events.slice(actAt + 1), me),
  };
  if (!REPLY.some((row) => row.when(situation))) return [];
  // 「我有 X」的 X：回冲着自己的怀疑时是自己的声称（刚说的口头声称优先），其余是说的那个角色
  const x = kind === 'doubt' ? (justClaimed ?? (claimantId === me ? windowRole : settledRole)) : role;
  const again = pressed.filter((a) => a.kind === 'announcement' && plausible(state, me, a.action, a.targetId));
  const announcements = { counter: counterAnnouncement(state, me, to.playerId), again };
  return halve(toOptions(merge(REPLY, situation), x && memory.standing.get(me)?.has(x) ? x : undefined, announcements), to.depth);
}

// 预告没兑现的记忆，只来自公开信息：speaker 上一次针对 me 的预告（earlier 里，按时间先后）之后，他的下一个行动不是预告的那个。
// 返回从那次行动算起是他自己的第几个回合（1 是那次）；没有这样的预告、还没行动过或兑现了是 0
function broken(events: readonly GameEvent[], earlier: readonly Heard[], speaker: string, me: string): number {
  const last = earlier.filter((h) => h.playerId === speaker && h.reaction.kind === 'announcement' && h.reaction.targetId === me).at(-1);
  if (last?.reaction.kind !== 'announcement') return 0;
  const acts = events.slice(last.seen).filter((e) => e.type === 'actionChosen' && e.actorId === speaker) as Extract<GameEvent, { type: 'actionChosen' }>[];
  const kept = acts[0]?.action === last.reaction.action && acts[0].targetId === me;
  return kept ? 0 : acts.length;
}

// 自己最近一次行动没得手（after 是那之后的事件）：被抓到诈唬，或被阻挡且阻挡没被推翻
function foiled(after: readonly GameEvent[], me: string): boolean {
  const caught = (id: string) => after.some((e) => e.type === 'challengeResolved' && e.claimantId === id && !e.truth);
  const blocked = after.find((e) => e.type === 'blocked');
  return caught(me) || (blocked?.type === 'blocked' && !caught(blocked.blockerId));
}

// 每深一层开口概率减半，候选之间的比例不变：开口的权重合计 N、沉默 S 时，沉默换成 N + 2S
function halve(options: Options, times: number): Options {
  if (times === 0) return options;
  const spoken = options.reduce((sum, [r, w]) => sum + (r ? w : 0), 0);
  return halve(options.map(([r, w]) => [r, r ? w : spoken + 2 * w]), times - 1);
}
