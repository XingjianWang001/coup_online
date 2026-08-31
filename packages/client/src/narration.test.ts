import { describe, expect, it } from 'vitest';
import type { PublicState } from '@coup/shared';
import { describeCountdown, describePending } from './narration.ts';

function state(overrides: Partial<PublicState>): PublicState {
  return {
    phase: 'choosingAction',
    players: [
      { id: 'a', name: '张三', coins: 2, handCount: 2, revealed: [], alive: true },
      { id: 'b', name: '李四', coins: 2, handCount: 2, revealed: [], alive: true },
    ],
    currentPlayerId: 'a',
    pending: null,
    challengeSubject: null,
    lossPlayerId: null,
    exchangeKeepCount: null,
    passed: [],
    winnerId: null,
    ...overrides,
  };
}

describe('describePending', () => {
  it('无待处理行动时返回 null', () => {
    expect(describePending(state({ pending: null }))).toBeNull();
  });

  it('描述声称角色的行动', () => {
    const s = state({
      phase: 'awaitingChallenge',
      challengeSubject: 'action',
      pending: { action: 'tax', actorId: 'a', claimedRole: 'duke' },
    });
    expect(describePending(s)).toBe('张三 声称【公爵】发动征税');
  });

  it('描述带目标的行动', () => {
    const s = state({
      pending: { action: 'assassinate', actorId: 'a', targetId: 'b', claimedRole: 'assassin' },
    });
    expect(describePending(s)).toBe('张三 声称【刺客】发动暗杀，目标 李四');
  });

  it('描述外援（不声称角色）', () => {
    const s = state({
      phase: 'awaitingBlock',
      pending: { action: 'foreignAid', actorId: 'a' },
    });
    expect(describePending(s)).toBe('张三 发动外援');
  });

  it('描述阻挡', () => {
    const s = state({
      phase: 'awaitingChallenge',
      challengeSubject: 'block',
      pending: {
        action: 'foreignAid',
        actorId: 'a',
        blockById: 'b',
        blockRole: 'duke',
      },
    });
    expect(describePending(s)).toBe('张三 发动外援；李四 用【公爵】阻挡');
  });
});

describe('describeCountdown', () => {
  it('null 返回 null', () => {
    expect(describeCountdown(null)).toBeNull();
  });

  it('0 或负数返回 null', () => {
    expect(describeCountdown(0)).toBeNull();
    expect(describeCountdown(-500)).toBeNull();
  });

  it('向上取整为秒', () => {
    expect(describeCountdown(20000)).toBe('20s');
    expect(describeCountdown(19999)).toBe('20s');
    expect(describeCountdown(1100)).toBe('2s');
  });
});