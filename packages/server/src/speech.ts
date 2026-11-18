// 电脑玩家的表态（#58）：什么时候说、说哪条。和 computer.ts 并列，只看公开信息（ADR 0013）：
// 公开状态和本局公开事件，不读暗牌、性格、牌堆记忆。行动策略不读这里的任何东西，表态也不进 decideComputerIntent。
//
// 每个场景是一张表（条件 → 带权重的候选）加一个把公开局面翻成表里条件的函数，返回候选和发言延迟的区间；
// Room 在对应的时刻调用它，用 speak 抽签。新场景另写一张表和一个函数，不改已有的。调参只改表里的数。
import { ASSASSINATE_COST, COUP_COST, FORCED_COUP_COINS, needsTarget, type ActionType, type GameEvent, type PublicState, type Role } from '@coup/engine';
import { PHRASES, type Phrase, type Reaction } from '@coup/shared';
import { recall } from './computer.ts';

// 候选的一条：短语，「我有 X」（claim，X 由各场景按语境定，必须在自己仍作数的声称里，否则不算候选），
// 或一种行动预告（真的 announce、虚晃到另一目标 feintTarget、虚晃成另一种针对性行动 feintAction），具体预告什么由各场景给出
export type Line = Phrase | 'claim' | Announcing;
type Announcing = 'announce' | 'feintTarget' | 'feintAction';
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

// 公开前情复用电脑的局内记忆（computer.ts 的 recall）：不给它自己放回牌堆的牌，它得出的就只依赖公开事件
const memoryOf = (state: PublicState, events: readonly GameEvent[], me: string) => recall(events, me, state.players.map((p) => p.id), 0, []);
const shownCount = (state: PublicState, role: Role) => state.players.reduce((n, p) => n + p.revealed.filter((r) => r === role).length, 0);

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
  let at = events.length - 1;
  while (at >= 0 && events[at].type !== 'actionChosen' && events[at].type !== 'blocked') at -= 1;
  const before = memoryOf(state, events.slice(0, at), me);
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
