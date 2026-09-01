import type { ActionType, GameEvent, PublicState } from '@coup/shared';
import { ROLE_NAMES } from './rules.ts';

const ACTION_NAMES: Record<ActionType, string> = {
  income: '收入',
  foreignAid: '外援',
  coup: '政变',
  tax: '征税',
  assassinate: '暗杀',
  steal: '偷窃',
  exchange: '交换',
};

export function nameOf(state: PublicState, id: string | null | undefined): string {
  if (!id) return '？';
  return state.players.find((p) => p.id === id)?.name ?? '？';
}

/** 描述当前待处理的声称/行动/阻挡；无待处理时返回 null。 */
export function describePending(state: PublicState): string | null {
  const p = state.pending;
  if (!p) return null;

  const actor = nameOf(state, p.actorId);
  let text: string;
  if (p.claimedRole) {
    text = `${actor} 声称【${ROLE_NAMES[p.claimedRole]}】发动${ACTION_NAMES[p.action]}`;
  } else if (p.action === 'foreignAid') {
    text = `${actor} 发动外援`;
  } else {
    text = `${actor} 发动${ACTION_NAMES[p.action]}`;
  }

  if (p.targetId) text += `，目标 ${nameOf(state, p.targetId)}`;
  if (p.blockById && p.blockRole) text += `；${nameOf(state, p.blockById)} 用【${ROLE_NAMES[p.blockRole]}】阻挡`;

  return text;
}

/** 剩余时间展示文本；null/非正数表示无需显示。 */
export function describeCountdown(remainingMs: number | null): string | null {
  if (remainingMs == null || remainingMs <= 0) return null;
  const sec = Math.ceil(remainingMs / 1000);
  return `${sec}s`;
}

/** 事件 → 日志文案；不重要的（回合流转/金币变化等）返回 null 跳过。 */
export function describeEvent(e: GameEvent, state: PublicState): string | null {
  switch (e.type) {
    case 'challenged':
      return `${nameOf(state, e.challengerId)} 质疑 ${nameOf(state, e.targetId)}`;
    case 'challengeResolved':
      return e.truth
        ? `质疑失败：${nameOf(state, e.loserId)} 失去影响力`
        : `质疑成功：${nameOf(state, e.loserId)} 失去影响力`;
    case 'blocked':
      return `${nameOf(state, e.blockerId)} 用【${ROLE_NAMES[e.role]}】阻挡`;
    case 'influenceLost':
      return `${nameOf(state, e.playerId)} 翻开【${ROLE_NAMES[e.role]}】`;
    case 'eliminated':
      return `${nameOf(state, e.playerId)} 被淘汰`;
    case 'gameOver':
      return `${nameOf(state, e.winnerId)} 获胜`;
    case 'coinsChanged':
      return `${nameOf(state, e.playerId)} 金币 → ${e.coins}`;
    case 'exchangeDrew':
      return `${nameOf(state, e.playerId)} 抽取 ${e.count} 张牌`;
    default:
      return null;
  }
}

export type ActionChosen = Extract<GameEvent, { type: 'actionChosen' }>;

/** 行动头部文案（actionChosen 事件）。 */
export function describeAction(e: ActionChosen, state: PublicState): string {
  const actor = nameOf(state, e.actorId);
  let text: string;
  if (e.claimedRole) {
    text = `${actor} 声称【${ROLE_NAMES[e.claimedRole]}】发动${ACTION_NAMES[e.action]}`;
  } else {
    text = `${actor} 发动${ACTION_NAMES[e.action]}`;
  }
  if (e.targetId) text += `，目标 ${nameOf(state, e.targetId)}`;
  return text;
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
export function groupLog(entries: LogEntry[], state: PublicState): LogGroup[] {
  const groups: LogGroup[] = [];
  let current: LogGroup | null = null;

  for (const { id, event } of entries) {
    switch (event.type) {
      case 'actionChosen':
        current = { id, action: describeAction(event, state), entries: [] };
        groups.push(current);
        break;
      case 'turnChanged':
        current = null;
        break;
      case 'gameOver':
        current = null;
        groups.push({ id, action: describeEvent(event, state)!, entries: [] });
        break;
      default: {
        const text = describeEvent(event, state);
        if (text == null) break;
        if (current) current.entries.push({ id, text });
        else groups.push({ id, action: text, entries: [] });
      }
    }
  }
  return groups;
}