// 控制台快照的分档：部署检查只读这个结果决定要不要拦下更新
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forfeit } from '@coup/engine';
import { Room } from './room.ts';
import type { GameRepository } from './repository.ts';
import { roomCheck } from '../../../scripts/deploy-room-check.mjs';

function makeRoom(code = 'ABC123') {
  const repo = { save: vi.fn(), delete: vi.fn() } as unknown as GameRepository;
  const events = { onBroadcast: vi.fn(), onEmpty: vi.fn(), onReaction: vi.fn(), onShowdownFocus: vi.fn() };
  return new Room(code, '', repo, events, { speechRandom: () => 0.999_999, startingPlayerRandom: () => 0 });
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

  it('部署检查读的就是真实快照：busy 要确认并列出在打的真人，waiting 只提示，idle 不出声', () => {
    vi.useFakeTimers();
    const busy = makeRoom('AAA111');
    const alice = busy.addPlayer('Alice', 'sock1');
    busy.addPlayer('Bob', 'sock2');
    busy.addComputer(alice.id, 'sock1');
    busy.startGame(alice.id, 'sock1');
    const waiting = makeRoom('BBB222');
    waiting.addPlayer('Carol', 'sock3');
    const idle = makeRoom('CCC333');
    const dave = idle.addPlayer('Dave', 'sock4');
    idle.addComputer(dave.id, 'sock4');
    idle.addComputer(dave.id, 'sock4');
    idle.startGame(dave.id, 'sock4');
    idle.apply((g) => forfeit(g, dave.id));
    // 和 /api/state 一样过一遍 JSON
    const state = (...rooms: Room[]) => JSON.parse(JSON.stringify({ rooms: rooms.map((r) => r.consoleSnapshot()) }));

    expect(roomCheck(state(busy, waiting, idle))).toEqual({
      confirm: true,
      lines: ['Games in progress; deploying now ends them:', '  AAA111: 2 humans playing', '  BBB222: 1 human waiting'],
    });
    expect(roomCheck(state(waiting, idle))).toEqual({ confirm: false, lines: ['Players waiting in a lobby or after a game will be disconnected:', '  BBB222: 1 human waiting'] });
    expect(roomCheck(state(idle))).toEqual({ confirm: false, lines: [] });
  });
});
