// packages/server/src/room.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room } from './room.ts';
import type { GameState } from '@coup/engine';
import type { GameRepository } from './repository.ts';

describe('Room 断连清理', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRoom() {
    const repo = { save: () => {}, delete: vi.fn() } as unknown as GameRepository;
    const events = { onBroadcast: () => {}, onEmpty: vi.fn() };
    const room = new Room('ABC123', '', repo, events);
    return { room, repo, events };
  }

  it('游戏结束后（gameOver）断连的玩家在宽限期后被移除，空房随后回收', () => {
    vi.useFakeTimers();
    const { room, repo, events } = makeRoom();
    const p = room.addPlayer('Alice', 'sock1');
    room.game = { phase: 'gameOver' } as unknown as GameState;

    room.markDisconnected(p.id);
    expect(room.players.size).toBe(1);

    // 断连宽限 90 秒后应移除玩家（而非走 forfeit 保留座位）
    vi.advanceTimersByTime(90_000);
    expect(room.players.size).toBe(0);

    // 空房 5 分钟宽限后触发回收：删除仓库条目并回调 onEmpty
    vi.advanceTimersByTime(5 * 60_000);
    expect(repo.delete).toHaveBeenCalledWith('ABC123');
    expect(events.onEmpty).toHaveBeenCalled();
  });
});

describe('Room 加入守卫', () => {
  function makeRoom() {
    const repo = { save: () => {}, delete: vi.fn() } as unknown as GameRepository;
    const events = { onBroadcast: () => {}, onEmpty: vi.fn() };
    const room = new Room('ABC123', '', repo, events);
    return { room };
  }

  it('开局后新玩家加入被拒绝（保证 room.players ⊆ game.players）', () => {
    const { room } = makeRoom();
    room.game = { phase: 'choosingAction', players: [] } as unknown as GameState;
    expect(() => room.addPlayer('Bob', 'sock2')).toThrow('游戏已开始，无法加入');
  });

  it('开局后带正确 id+secret 的重连仍复用座位', () => {
    const { room } = makeRoom();
    const p = room.addPlayer('Alice', 'sock1');
    room.game = { phase: 'choosingAction', players: [] } as unknown as GameState;
    const re = room.addPlayer('Alice', 'sock2', { id: p.id, secret: p.secret });
    expect(re.id).toBe(p.id);
  });

  it('getPrivateState 对局外玩家返回 null 而非抛错', () => {
    const { room } = makeRoom();
    room.game = { phase: 'choosingAction', players: [] } as unknown as GameState;
    expect(room.getPrivateState('ghost')).toBeNull();
  });
});
