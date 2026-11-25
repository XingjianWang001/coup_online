// packages/server/src/room-off-turn.test.ts — 电脑回合外的局势预告（#80，表 6）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomOptions } from './room.ts';
import { forfeit } from '@coup/engine';
import type { Reaction } from '@coup/shared';
import type { GameRepository } from './repository.ts';

function makeRoom(options?: RoomOptions) {
  const repo = { save: vi.fn(), delete: vi.fn() } as unknown as GameRepository;
  const events = { onBroadcast: vi.fn(), onEmpty: vi.fn(), onReaction: vi.fn(), onShowdownFocus: vi.fn() };
  const room = new Room('ABC123', '', repo, events, options);
  return { room, repo, events };
}

describe('Room 电脑回合外的局势预告', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Alice 先手，其后是 Bob 和 1 个电脑；电脑金币先设成 7，Alice 一出手局势就出现。
  // 发言随机源恒为 0：有候选就说第一条，延迟最短
  function offTurnTable(options: RoomOptions = {}) {
    vi.useFakeTimers();
    vi.clearAllTimers();
    const made = makeRoom({ startingPlayerRandom: () => 0, computerRandom: () => 0.5, computerDelayMs: () => 0, speechRandom: () => 0, ...options });
    const alice = made.room.addPlayer('Alice', 'sock1');
    const bob = made.room.addPlayer('Bob', 'sock2');
    made.room.addComputer(alice.id, 'sock1');
    made.room.startGame(alice.id, 'sock1');
    const computerId = made.room.playerList.find((p) => p.isComputer)!.id;
    made.room.game!.players.find((p) => p.id === computerId)!.coins = 7;
    const announced = () => made.events.onReaction.mock.calls.map(([, r]) => r as { playerId: string; reaction: Reaction }).filter((r) => r.reaction.kind === 'announcement');
    return { ...made, alice, bob, computerId, announced };
  }

  it('金币刚到 7：没轮到自己时预告政变领先者；局势持续时不再预告', () => {
    const { room, alice, bob, computerId, announced } = offTurnTable();
    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'income' }); // Alice 3 金币，成了领先者
    vi.advanceTimersByTime(500);
    expect(announced()).toEqual([{ playerId: computerId, reaction: { kind: 'announcement', action: 'coup', targetId: alice.id } }]);
    room.dispatch(bob.id, 'sock2', { type: 'chooseAction', action: 'income' });
    vi.advanceTimersByTime(2_000);
    expect(announced()).toHaveLength(1);
  });

  it('房里的真人全被淘汰、电脑 1 秒一步时不预告', () => {
    vi.useFakeTimers();
    const { room, events } = makeRoom({ startingPlayerRandom: () => 0, computerRandom: () => 0.5, speechRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.startGame(alice.id, 'sock1');
    // 第二个电脑金币到 7，Alice 弃权后轮到第一个电脑：局势对第二个电脑刚出现在回合外
    room.game!.players[2].coins = 7;
    room.apply((g) => forfeit(g, alice.id));
    for (let i = 0; i < 20; i += 1) vi.advanceTimersByTime(1_000);
    expect(events.onReaction.mock.calls.filter(([, r]) => r.reaction.kind === 'announcement')).toEqual([]);
  });

  it('有无这些表态，电脑轮到自己时的行动相同', () => {
    const run = (speechRandom: () => number) => {
      vi.useFakeTimers();
      vi.clearAllTimers();
      let seed = 7;
      vi.spyOn(Math, 'random').mockImplementation(() => (seed = (seed * 48271) % 2147483647) / 2147483647);
      let draw = 1;
      const computerRandom = () => (draw = (draw * 16807) % 2147483647) / 2147483647;
      const { room, events } = makeRoom({ startingPlayerRandom: () => 0, computerRandom, computerDelayMs: () => 0, speechRandom });
      // 记下每条预告发出时轮到谁：不是自己的就是回合外的
      const offTurn: unknown[] = [];
      events.onReaction.mockImplementation((r: Room, said: { playerId: string; reaction: Reaction }) => {
        if (said.reaction.kind === 'announcement' && r.game!.currentPlayerId !== said.playerId) offTurn.push(said);
      });
      const alice = room.addPlayer('Alice', 'sock1');
      for (let i = 0; i < 3; i += 1) room.addComputer(alice.id, 'sock1');
      room.startGame(alice.id, 'sock1');
      for (let step = 0; step < 5_000 && room.game!.phase !== 'gameOver'; step += 1) vi.advanceTimersToNextTimer();
      expect(room.game!.phase).toBe('gameOver');
      const seats = [...room.players.keys()];
      const moves = JSON.stringify(events.onBroadcast.mock.calls.flatMap(([, evs]) => evs)).replace(/"[0-9a-f]{16}"/g, (id) => `seat${seats.indexOf(JSON.parse(id))}`);
      vi.restoreAllMocks();
      return { moves, offTurn: offTurn.length };
    };
    const talkative = run(() => 0);
    const silent = run(() => 0.999_999);
    expect(talkative.offTurn).toBeGreaterThan(0);
    expect(silent.offTurn).toBe(0);
    expect(talkative.moves).toEqual(silent.moves);
  });
});
