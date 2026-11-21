// packages/server/src/room-result.test.ts
// 表 5（#82）：结果公开后电脑的表态在 Room 里什么时候说、说几次
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomOptions } from './room.ts';
import { challenge } from '@coup/engine';
import type { GameRepository } from './repository.ts';

function makeRoom(options?: RoomOptions) {
  const repo = { save: vi.fn(), delete: vi.fn() } as unknown as GameRepository;
  const events = { onBroadcast: vi.fn(), onEmpty: vi.fn(), onReaction: vi.fn(), onShowdownFocus: vi.fn() };
  const room = new Room('ABC123', '', repo, events, options);
  return { room, repo, events };
}

describe('Room 结果公开后的表态', () => {
  afterEach(() => vi.useRealTimers());

  // Alice 先手征税（真有公爵），对面的电脑质疑后输掉对质。电脑总说第一候选；它在窗口里 15 秒才出手
  function lostChallenge() {
    vi.useFakeTimers();
    vi.clearAllTimers();
    const made = makeRoom({ startingPlayerRandom: () => 0, speechRandom: () => 0, computerDelayMs: () => 15_000 });
    const alice = made.room.addPlayer('Alice', 'sock1');
    made.room.addComputer(alice.id, 'sock1');
    made.room.startGame(alice.id, 'sock1');
    const computerId = made.room.playerList.find((p) => p.isComputer)!.id;
    const hand = made.room.game!.players.find((p) => p.id === alice.id)!.hand;
    hand[0].role = 'duke';
    made.room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'tax' });
    made.room.apply((g) => challenge(g, computerId));
    vi.advanceTimersByTime(3_000); // 试探等之前的表态都说完
    made.events.onReaction.mockClear();
    made.room.dispatch(alice.id, 'sock1', { type: 'revealShowdownCard', cardId: hand[0].id });
    const spoken = () => made.events.onReaction.mock.calls.filter(([, r]) => r.playerId === computerId).map(([, r]) => r.reaction);
    return { ...made, computerId, spoken };
  }

  it('对质的结果等揭晓动画播完再说', () => {
    const { spoken } = lostChallenge();
    vi.advanceTimersByTime(6_000);
    expect(spoken()).toEqual([]);
    vi.advanceTimersByTime(2_100);
    expect(spoken()).toEqual([{ kind: 'phrase', phrase: 'respect' }]);
  });

  it('一次结算只开口一次：电脑随后选丢哪张时不再说', () => {
    const { spoken, room, computerId } = lostChallenge();
    vi.advanceTimersByTime(29_000);
    expect(room.game!.players.find((p) => p.id === computerId)!.hand).toHaveLength(1); // 已丢了那张
    expect(spoken()).toEqual([{ kind: 'phrase', phrase: 'respect' }]);
  });
});
