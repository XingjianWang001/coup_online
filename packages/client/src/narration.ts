import type { GameEvent, PublicState } from '@coup/shared';
import { translate, type Locale } from './localization.ts';
import { actionName, roleName } from './rules.ts';

export function nameOf(state: PublicState, id: string | null | undefined): string {
  if (!id) return '？';
  return state.players.find((p) => p.id === id)?.name ?? '？';
}

function describeChosenAction(
  action: Pick<ActionChosen, 'actorId' | 'action' | 'targetId' | 'claimedRole'>,
  state: PublicState,
  locale: Locale,
): string {
  const actor = nameOf(state, action.actorId);
  let text = action.claimedRole
    ? translate(locale, 'narrationClaim', {
        actor,
        role: roleName(locale, action.claimedRole),
        action: actionName(locale, action.action),
      })
    : translate(locale, 'narrationAction', { actor, action: actionName(locale, action.action) });
  if (action.targetId) text += translate(locale, 'narrationTarget', { target: nameOf(state, action.targetId) });
  return text;
}

/** 描述当前待处理的声称/行动/阻挡；无待处理时返回 null。 */
export function describePending(state: PublicState, locale: Locale = 'zh-CN'): string | null {
  const p = state.pending;
  if (!p) return null;

  let text = describeChosenAction(p, state, locale);
  if (p.blockById && p.blockRole) {
    text += translate(locale, 'narrationBlock', {
      blocker: nameOf(state, p.blockById),
      role: roleName(locale, p.blockRole),
    });
  }

  return text;
}

/** 收到状态后以单调时钟计算，浏览器延迟调用计时器时也能追上实际时间。 */
export function remainingSinceReceipt(remainingMs: number | null, receivedAt: number, now: number): number | null {
  if (remainingMs == null) return null;
  return Math.max(0, remainingMs - (now - receivedAt));
}

/** 客户端往返时间的中点近似服务器响应时刻。 */
export function estimateServerOffset(sentAt: number, receivedAt: number, serverNow: number): number {
  return serverNow - (sentAt + receivedAt) / 2;
}

/** 已同步服务器时按权威截止时刻计算；同步前使用本地单调时钟推算的剩余时间。 */
export function effectiveRemainingMs(
  remainingMs: number | null,
  deadlineAt?: number | null,
  serverNow?: number | null,
): number | null {
  if (deadlineAt != null && serverNow != null) return Math.max(0, deadlineAt - serverNow);
  if (remainingMs == null) return null;
  return Math.max(0, remainingMs);
}

/** 剩余时间展示文本；null/非正数表示无需显示。 */
export function describeCountdown(
  remainingMs: number | null,
  deadlineAt?: number | null,
  serverNow?: number | null,
): string | null {
  const effective = effectiveRemainingMs(remainingMs, deadlineAt, serverNow);
  if (effective == null || effective <= 0) return null;
  const sec = Math.ceil(effective / 1000);
  return `${sec}s`;
}

/** 事件 → 日志文案；不重要的（回合流转/金币变化等）返回 null 跳过。 */
export function describeEvent(e: GameEvent, state: PublicState, locale: Locale = 'zh-CN'): string | null {
  switch (e.type) {
    case 'challenged':
      return translate(locale, 'logChallenge', {
        challenger: nameOf(state, e.challengerId),
        target: nameOf(state, e.targetId),
      });
    case 'challengeResolved':
      return translate(locale, e.truth ? 'logChallengeFailed' : 'logChallengeSucceeded', {
        loser: nameOf(state, e.loserId),
      });
    case 'blocked':
      return translate(locale, 'logBlock', { blocker: nameOf(state, e.blockerId), role: roleName(locale, e.role) });
    case 'influenceLost':
      return translate(locale, 'logInfluenceLost', { player: nameOf(state, e.playerId), role: roleName(locale, e.role) });
    case 'eliminated':
      return translate(locale, 'logEliminated', { player: nameOf(state, e.playerId) });
    case 'gameOver':
      return translate(locale, 'logGameOver', { winner: nameOf(state, e.winnerId) });
    case 'coinsChanged':
      return translate(locale, 'logCoinsChanged', { player: nameOf(state, e.playerId), coins: e.coins });
    case 'exchangeDrew':
      return translate(locale, 'logExchangeDrew', { player: nameOf(state, e.playerId), count: e.count });
    default:
      return null;
  }
}

export type ActionChosen = Extract<GameEvent, { type: 'actionChosen' }>;

/** 行动头部文案（actionChosen 事件）。 */
export function describeAction(e: ActionChosen, state: PublicState, locale: Locale = 'zh-CN'): string {
  return describeChosenAction(e, state, locale);
}

export interface LogEntry {
  id: number;
  event: GameEvent;
}

export interface LogGroup {
  id: number;
  action: string;
  entries: { id: number; text: string }[];
}

/** 把扁平事件按行动分组：actionChosen 开组、turnChanged 收组、gameOver 独立成组。 */
export function groupLog(entries: LogEntry[], state: PublicState, locale: Locale = 'zh-CN'): LogGroup[] {
  const groups: LogGroup[] = [];
  let current: LogGroup | null = null;

  for (const { id, event } of entries) {
    switch (event.type) {
      case 'actionChosen':
        current = { id, action: describeAction(event, state, locale), entries: [] };
        groups.push(current);
        break;
      case 'turnChanged':
        current = null;
        break;
      case 'gameOver':
        current = null;
        groups.push({ id, action: describeEvent(event, state, locale)!, entries: [] });
        break;
      default: {
        const text = describeEvent(event, state, locale);
        if (text == null) break;
        if (current) current.entries.push({ id, text });
        else groups.push({ id, action: text, entries: [] });
      }
    }
  }
  return groups;
}
