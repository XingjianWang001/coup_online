// 控制台快照的分档：部署检查只读这个结果决定要不要拦下更新
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forfeit } from '@coup/engine';
import { Room } from './room.ts';
import type { GameRepository } from './repository.ts';

function makeRoom() {
  const repo = { save: vi.fn(), delete: vi.fn() } as unknown as GameRepository;
  const events = { onBroadcast: vi.fn(), onEmpty: vi.fn(), onReaction: vi.fn(), onShowdownFocus: vi.fn() };
  return new Room('ABC123', '', repo, events, { speechRandom: () => 0.999_999, startingPlayerRandom: () => 0 });
}

describe('Room 控制台快照分档', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('大厅有真人在场 → waiting；开局 → busy；断线在宽限期内仍 busy', () => {
    vi.useFakeTimers();
    const room = makeRoom();
    const alice = room.addPlayer('Alice', 'sock1');
    room.addComputer(alice.id, 'sock1');
    expect(room.consoleSnapshot().tier).toBe('waiting');

    room.startGame(alice.id, 'sock1');
    expect(room.consoleSnapshot().tier).toBe('busy');

    room.markDisconnected(alice.id, 'sock1');
    expect(room.consoleSnapshot().tier).toBe('busy');
  });

  it('真人都出局、只剩电脑在打 → idle；牌局结束有人在场 → waiting', () => {
    vi.useFakeTimers();
    const room = makeRoom();
    const alice = room.addPlayer('Alice', 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.startGame(alice.id, 'sock1');
    room.apply((g) => forfeit(g, alice.id));
    expect(room.consoleSnapshot().tier).toBe('idle');

    room.game!.phase = 'gameOver';
    expect(room.consoleSnapshot().tier).toBe('waiting');
  });

  it('快照带完整牌局和电脑性格，不带重连凭证', () => {
    vi.useFakeTimers();
    const room = makeRoom();
    const alice = room.addPlayer('Alice', 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.startGame(alice.id, 'sock1');
    const snapshot = room.consoleSnapshot();
    expect(snapshot.game?.deck.length).toBe(11);
    expect(snapshot.players.find((p) => p.isComputer)?.temperament).toBeDefined();
    expect(JSON.stringify(snapshot)).not.toContain(alice.secret);
  });
});
