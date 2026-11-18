// 电脑玩家的表态（#58）：什么时候说、说哪条。和 computer.ts 并列，只看公开信息（ADR 0013）：
// 公开状态和本局公开事件，不读暗牌、性格、牌堆记忆。行动策略不读这里的任何东西，表态也不进 decideComputerIntent。
//
// 每个场景是一张表（条件 → 带权重的候选）加一个把公开局面翻成表里条件的函数，返回候选和发言延迟的区间；
// Room 在对应的时刻调用它，用 speak 抽签。新场景另写一张表和一个函数，不改已有的。调参只改表里的数。
import type { ActionType, GameEvent, PublicState, Role } from '@coup/engine';
import type { Phrase, Reaction } from '@coup/shared';
import { recall } from './computer.ts';

// 候选的一条：短语，或「我有 X」（claim，X 由各场景按语境定，必须在自己仍作数的声称里，否则不算候选）
export type Line = Phrase | 'claim';
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

// 把合并后的候选翻成表态；claimRole 是「我有 X」的 X，不在自己仍作数的声称里时不给（这条不算候选）
function toOptions(weights: Map<Line | 'silence', number>, claimRole: Role | undefined): Options {
  const options: Options = [];
  for (const [line, w] of weights) {
    if (line === 'silence') continue;
    if (line !== 'claim') options.push([{ kind: 'phrase', phrase: line }, w]);
    else if (claimRole) options.push([{ kind: 'verbalClaim', has: true, role: claimRole }, w]);
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

// 到点时决定这条表态是现在说还是再等多久：离全桌上一条电脑表态（lastAt）不足间隔就顺延
export function stagger(now: number, lastAt: number | undefined, random: () => number): number {
  const wait = (lastAt ?? -Infinity) + SPEECH_GAP_MS - now;
  return wait > 0 ? wait + random() * JITTER_MS : 0;
}

// 公开前情复用电脑的局内记忆（computer.ts 的 recall）：不给它自己放回牌堆的牌，它得出的就只依赖公开事件
const memoryOf = (state: PublicState, events: readonly GameEvent[], me: string) => recall(events, me, state.players.map((p) => p.id), 0, []);
const shownCount = (state: PublicState, role: Role) => state.players.reduce((n, p) => n + p.revealed.filter((r) => r === role).length, 0);

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
