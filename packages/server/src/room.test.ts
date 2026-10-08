// packages/server/src/room.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomOptions } from './room.ts';
import type { GameState } from '@coup/engine';
import type { GameRepository } from './repository.ts';

function makeRoom(options?: RoomOptions) {
  const repo = { save: vi.fn(), delete: vi.fn() } as unknown as GameRepository;
  const events = { onBroadcast: vi.fn(), onEmpty: vi.fn() };
  const room = new Room('ABC123', '', repo, events, options);
  return { room, repo, events };
}

describe('Room 断连清理', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('游戏结束后（gameOver）断连的玩家在宽限期后被移除，空房随后回收', () => {
    vi.useFakeTimers();
    const { room, repo, events } = makeRoom();
    const p = room.addPlayer('Alice', 'sock1');
    room.game = { phase: 'gameOver' } as unknown as GameState;

    room.markDisconnected(p.id, 'sock1');
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

describe('Room 连接归属', () => {
  afterEach(() => vi.useRealTimers());

  it('新连接接管后，旧连接不能开局或离开，晚断开也不会让玩家离线或弃权', () => {
    vi.useFakeTimers();
    const { room } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'old');
    room.hostId = alice.id;
    room.addPlayer('Bob', 'bob');
    room.addPlayer('Alice', 'new', { id: alice.id, secret: alice.secret });

    expect(() => room.startGame(alice.id, 'old')).toThrow('illegalIntent');
    expect(() => room.leavePlayer(alice.id, 'old')).toThrow('illegalIntent');
    expect(room.markDisconnected(alice.id, 'old')).toBe(false);
    expect(room.playerList.find((p) => p.id === alice.id)?.connected).toBe(true);

    room.startGame(alice.id, 'new');
    expect(() => room.dispatch(alice.id, 'old', { type: 'chooseAction', action: 'income' })).toThrow('illegalIntent');
    expect(room.getPublicState()?.players.find((p) => p.id === alice.id)?.coins).toBe(1);
    expect(room.dispatch(alice.id, 'new', { type: 'chooseAction', action: 'income' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'actionChosen', actorId: alice.id })]));

    vi.advanceTimersByTime(90_001);
    expect(room.playerList.find((p) => p.id === alice.id)?.connected).toBe(true);
    expect(room.getPublicState()?.players.find((p) => p.id === alice.id)?.alive).toBe(true);
  });

  it('当前连接断开后，宽限期内重连取消弃权；未重连则在 90 秒后弃权', () => {
    vi.useFakeTimers();
    const { room, events } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'first');
    room.hostId = alice.id;
    room.addPlayer('Bob', 'bob');
    room.startGame(alice.id, 'first');

    expect(room.markDisconnected(alice.id, 'first')).toBe(true);
    expect(room.playerList.find((p) => p.id === alice.id)?.connected).toBe(false);
    vi.advanceTimersByTime(89_000);
    room.addPlayer('Alice', 'second', { id: alice.id, secret: alice.secret });
    vi.advanceTimersByTime(1_001);
    expect(room.playerList.find((p) => p.id === alice.id)?.connected).toBe(true);
    expect(room.getPublicState()?.players.find((p) => p.id === alice.id)?.alive).toBe(true);

    expect(room.markDisconnected(alice.id, 'second')).toBe(true);
    vi.advanceTimersByTime(90_000);
    expect(room.getPublicState()?.players.find((p) => p.id === alice.id)?.alive).toBe(false);
    expect(events.onBroadcast).toHaveBeenCalledWith(room, expect.arrayContaining([
      expect.objectContaining({ type: 'eliminated', playerId: alice.id }),
    ]));
  });

  it('当前连接主动离开仍立即弃权并移除房间座位', () => {
    const { room } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'first');
    room.hostId = alice.id;
    room.addPlayer('Bob', 'bob');
    room.startGame(alice.id, 'first');

    expect(room.leavePlayer(alice.id, 'first'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'eliminated', playerId: alice.id })]));
    expect(room.playerList.some((p) => p.id === alice.id)).toBe(false);
    expect(room.getPublicState()?.players.find((p) => p.id === alice.id)?.alive).toBe(false);
  });
});

describe('Room 加入守卫', () => {
  it('拒绝空白、过长或带控制字符的昵称', () => {
    const { room } = makeRoom();
    for (const name of ['   ', 'x'.repeat(33), 'A\nB']) {
      expect(() => room.addPlayer(name, 'sock')).toThrow('invalidName');
    }
    expect(room.players.size).toBe(0);
  });

  it('六名玩家后拒绝第七名新玩家', () => {
    const { room } = makeRoom();
    for (let index = 1; index <= 6; index += 1) {
      room.addPlayer(`Player ${index}`, `sock${index}`);
    }

    expect(() => room.addPlayer('Player 7', 'sock7')).toThrow('roomFull');
    expect(room.players.size).toBe(6);
  });

  it('满房时持有效凭证的玩家仍可重连到原座位', () => {
    const { room } = makeRoom();
    const returning = room.addPlayer('Alice', 'sock1');
    for (let index = 2; index <= 6; index += 1) {
      room.addPlayer(`Player ${index}`, `sock${index}`);
    }

    const reconnected = room.addPlayer('Alice', 'replacement-socket', {
      id: returning.id,
      secret: returning.secret,
    });

    expect(reconnected).toBe(returning);
    expect(reconnected.socketId).toBe('replacement-socket');
    expect(room.players.size).toBe(6);
  });

  it('开局后新玩家加入被拒绝（保证 room.players ⊆ game.players）', () => {
    const { room } = makeRoom();
    room.game = { phase: 'choosingAction', players: [] } as unknown as GameState;
    expect(() => room.addPlayer('Bob', 'sock2')).toThrow('gameAlreadyStarted');
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

describe('Room 计时结束', () => {
  afterEach(() => vi.useRealTimers());

  it('行动超时后把默认收入的事件和下一回合状态推送给所有玩家', () => {
    vi.useFakeTimers();
    const {
      room,
      events: { onBroadcast },
    } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    expect(room.getDeadlineAt()).toBe(Date.now() + 60_000);

    vi.advanceTimersByTime(60_000);

    expect(room.game?.players.find((p) => p.id === alice.id)?.coins).toBe(2);
    expect(room.game?.currentPlayerId).toBe(bob.id);
    expect(onBroadcast).toHaveBeenCalledWith(room, expect.arrayContaining([
      expect.objectContaining({ type: 'actionChosen', actorId: alice.id, action: 'income' }),
      expect.objectContaining({ type: 'turnChanged', playerId: bob.id }),
    ]));
    expect(room.getDeadlineMs()).toBe(60_000);
  });

  it('金币达到 10 时自动政变并广播目标选择失去影响力的阶段', () => {
    vi.useFakeTimers();
    const {
      room,
      events: { onBroadcast },
    } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    room.game!.players.find((player) => player.id === alice.id)!.coins = 10;

    vi.advanceTimersByTime(60_000);

    expect(room.game?.phase).toBe('choosingLoss');
    expect(room.getPublicState()?.lossPlayerId).toBe(bob.id);
    expect(onBroadcast).toHaveBeenCalledWith(room, expect.arrayContaining([
      expect.objectContaining({ type: 'actionChosen', actorId: alice.id, action: 'coup', targetId: bob.id }),
    ]));
    expect(room.getDeadlineMs()).toBeNull();
  });

  it('阻挡窗口超时后广播结算事件和下一回合状态', () => {
    vi.useFakeTimers();
    const {
      room,
      events: { onBroadcast },
    } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'foreignAid' });

    vi.advanceTimersByTime(20_000);

    expect(room.game?.players.find((p) => p.id === alice.id)?.coins).toBe(3);
    expect(room.game?.currentPlayerId).toBe(bob.id);
    expect(onBroadcast).toHaveBeenCalledWith(room, expect.arrayContaining([
      expect.objectContaining({ type: 'coinsChanged', playerId: alice.id, coins: 3 }),
      expect.objectContaining({ type: 'turnChanged', playerId: bob.id }),
    ]));
  });
});

describe('Room 开局', () => {
  it('使用服务器注入的随机源选择当前玩家并应用两人局金币规则', () => {
    const { room } = makeRoom({ startingPlayerRandom: () => 0.75 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');

    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');

    expect(room.getPublicState()?.currentPlayerId).toBe(bob.id);
    expect(room.getPublicState()?.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: alice.id, coins: 2, handCount: 2 }),
      expect.objectContaining({ id: bob.id, coins: 1, handCount: 2 }),
    ]));
    expect(room.getPublicState()?.players.every((player) => !('hand' in player))).toBe(true);
  });
});

describe('Room 意图错误', () => {
  it('把引擎规则校验映射为稳定的客户端错误', () => {
    const { room } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');

    expect(() => room.dispatch(bob.id, 'sock2', { type: 'chooseAction', action: 'income' }))
      .toThrow('invalidGameAction');
  });

  it('即使牌局尚未开始也把未知意图映射为稳定的客户端错误', () => {
    const { room } = makeRoom();
    const alice = room.addPlayer('Alice', 'sock1');

    expect(() => room.dispatch(alice.id, 'sock1', { type: 'futureIntent' })).toThrow('illegalIntent');
  });

  it('不把意外基础设施异常误报为规则校验错误', () => {
    const { room, repo } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    room.addPlayer('Bob', 'sock2');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    const failure = new Error('storage failed');
    vi.mocked(repo.save).mockImplementationOnce(() => { throw failure; });

    expect(() => room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'income' })).toThrow(failure);
  });
});
