import type { ActionType, PublicState } from '@coup/shared';
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