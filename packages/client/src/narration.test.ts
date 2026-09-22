import { describe, expect, it } from 'vitest';
import type { PublicState } from '@coup/shared';
import { describeAction, describeCountdown, describeEvent, describePending, estimateServerOffset, groupLog, remainingSinceReceipt } from './narration.ts';

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
  it('服务器期限已到时不再显示客户端滞后的 4 秒', () => {
    expect(describeCountdown(4000, 60_000, 60_000)).toBeNull();
  });

  it('消息延迟抵达后按服务器期限显示剩余时间', () => {
    expect(describeCountdown(8000, 60_000, 56_000)).toBe('4s');
  });

  it('浏览器暂停回调后按实际经过时间追上倒计时', () => {
    expect(remainingSinceReceipt(10_000, 1000, 7000)).toBe(4000);
  });

  it('两个本地时钟相差 30 秒的玩家仍看到相同倒计时', () => {
    const aOffset = estimateServerOffset(2000, 2100, 102_050);
    const bOffset = estimateServerOffset(32_000, 32_100, 102_050);
    expect(describeCountdown(9000, 110_000, 6000 + aOffset)).toBe('4s');
    expect(describeCountdown(9000, 110_000, 36_000 + bOffset)).toBe('4s');
  });

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

describe('describeEvent', () => {
  const s = state({});

  it('描述质疑', () => {
    expect(describeEvent({ type: 'challenged', challengerId: 'b', targetId: 'a' }, s)).toBe('李四 质疑 张三');
  });

  it('描述质疑失败（声称者确实有该角色）', () => {
    expect(describeEvent({ type: 'challengeResolved', truth: true, loserId: 'b', claimantId: 'a' }, s)).toBe(
      '质疑失败：李四 失去影响力',
    );
  });

  it('描述质疑成功（声称者在撒谎）', () => {
    expect(describeEvent({ type: 'challengeResolved', truth: false, loserId: 'a', claimantId: 'a' }, s)).toBe(
      '质疑成功：张三 失去影响力',
    );
  });

  it('描述阻挡', () => {
    expect(describeEvent({ type: 'blocked', blockerId: 'b', role: 'duke' }, s)).toBe('李四 用【公爵】阻挡');
  });

  it('描述翻开明牌与淘汰', () => {
    expect(describeEvent({ type: 'influenceLost', playerId: 'a', role: 'assassin' }, s)).toBe('张三 翻开【刺客】');
    expect(describeEvent({ type: 'eliminated', playerId: 'a' }, s)).toBe('张三 被淘汰');
  });

  it('描述游戏结束', () => {
    expect(describeEvent({ type: 'gameOver', winnerId: 'a' }, s)).toBe('张三 获胜');
  });

  it('跳过回合流转等不展示的事件', () => {
    expect(describeEvent({ type: 'turnChanged', playerId: 'a' }, s)).toBeNull();
    expect(describeEvent({ type: 'started', turnOrder: ['a', 'b'] }, s)).toBeNull();
  });

  it('描述金币变化与抽牌', () => {
    expect(describeEvent({ type: 'coinsChanged', playerId: 'a', coins: 5 }, s)).toBe('张三 金币 → 5');
    expect(describeEvent({ type: 'exchangeDrew', playerId: 'a', count: 2 }, s)).toBe('张三 抽取 2 张牌');
  });
});

describe('describeAction', () => {
  const s = state({});

  it('描述声称角色的行动', () => {
    expect(describeAction({ type: 'actionChosen', actorId: 'a', action: 'tax', claimedRole: 'duke' }, s)).toBe(
      '张三 声称【公爵】发动征税',
    );
  });

  it('描述带目标的行动', () => {
    expect(
      describeAction({ type: 'actionChosen', actorId: 'a', action: 'assassinate', targetId: 'b', claimedRole: 'assassin' }, s),
    ).toBe('张三 声称【刺客】发动暗杀，目标 李四');
  });

  it('描述收入与外援（无声称）', () => {
    expect(describeAction({ type: 'actionChosen', actorId: 'a', action: 'income' }, s)).toBe('张三 发动收入');
    expect(describeAction({ type: 'actionChosen', actorId: 'a', action: 'foreignAid' }, s)).toBe('张三 发动外援');
  });
});

describe('groupLog', () => {
  const s = state({});

  it('按行动分组：质疑/结果/翻牌归入该行动', () => {
    const groups = groupLog(
      [
        { id: 0, event: { type: 'actionChosen', actorId: 'a', action: 'tax', claimedRole: 'duke' } },
        { id: 1, event: { type: 'challenged', challengerId: 'b', targetId: 'a' } },
        { id: 2, event: { type: 'challengeResolved', truth: false, loserId: 'a', claimantId: 'a' } },
        { id: 3, event: { type: 'influenceLost', playerId: 'a', role: 'assassin' } },
        { id: 4, event: { type: 'turnChanged', playerId: 'b' } },
      ],
      s,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].action).toBe('张三 声称【公爵】发动征税');
    expect(groups[0].entries.map((x) => x.text)).toEqual([
      '李四 质疑 张三',
      '质疑成功：张三 失去影响力',
      '张三 翻开【刺客】',
    ]);
  });

  it('收入组含金币变化', () => {
    const groups = groupLog(
      [
        { id: 0, event: { type: 'actionChosen', actorId: 'a', action: 'income' } },
        { id: 1, event: { type: 'coinsChanged', playerId: 'a', coins: 3 } },
        { id: 2, event: { type: 'turnChanged', playerId: 'b' } },
      ],
      s,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].entries.map((x) => x.text)).toEqual(['张三 金币 → 3']);
  });

  it('gameOver 独立成组，turnChanged 不产生条目', () => {
    const groups = groupLog(
      [
        { id: 0, event: { type: 'gameOver', winnerId: 'a' } },
        { id: 1, event: { type: 'turnChanged', playerId: 'b' } },
      ],
      s,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].action).toBe('张三 获胜');
    expect(groups[0].entries).toEqual([]);
  });
});
