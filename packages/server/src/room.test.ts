// packages/server/src/room.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomOptions } from './room.ts';
import { challenge, chooseAction, forfeit, type GameEvent, type GameState, type Role } from '@coup/engine';
import type { GameRepository } from './repository.ts';

function makeRoom(options?: RoomOptions) {
  const repo = { save: vi.fn(), delete: vi.fn() } as unknown as GameRepository;
  const events = { onBroadcast: vi.fn(), onEmpty: vi.fn(), onReaction: vi.fn(), onShowdownFocus: vi.fn() };
  // 电脑默认不开口：轮到它时的行动预告会把出手推后 0.8～1.5 秒，要量出手时刻的用例不该随 Math.random 时有时无
  const room = new Room('ABC123', '', repo, events, { speechRandom: () => 0.999_999, ...options });
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

  it('房主离开空房间后，下一位加入者成为房主并能开局', () => {
    vi.useFakeTimers();
    const { room } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    room.leavePlayer(alice.id, 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.addPlayer('Carol', 'sock3');
    expect(room.hostId).toBe(bob.id);
    room.startGame(bob.id, 'sock2');
    expect(room.game).not.toBeNull();
  });

  it('空房间有人加入后重置空房计时：再次变空后满 5 分钟才回收', () => {
    vi.useFakeTimers();
    const { room, events } = makeRoom();
    const alice = room.addPlayer('Alice', 'sock1');
    room.leavePlayer(alice.id, 'sock1');
    vi.advanceTimersByTime(4 * 60_000);
    const bob = room.addPlayer('Bob', 'sock2');
    room.leavePlayer(bob.id, 'sock2');
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(events.onEmpty).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(events.onEmpty).toHaveBeenCalledWith(room);
  });

  function startedRoom() {
    const made = makeRoom({ startingPlayerRandom: () => 0 });
    const { room } = made;
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    const carol = room.addPlayer('Carol', 'sock3');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    return { ...made, alice, bob, carol };
  }

  it('牌局中全员断线：弃权的座位不算在场，宽限期加 5 分钟后空房回收', () => {
    vi.useFakeTimers();
    const { room, events, alice, bob, carol } = startedRoom();
    for (const [p, sock] of [[alice, 'sock1'], [bob, 'sock2'], [carol, 'sock3']] as const) room.markDisconnected(p.id, sock);

    vi.advanceTimersByTime(90_000);
    expect(room.game?.phase).toBe('gameOver');
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(events.onEmpty).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(events.onEmpty).toHaveBeenCalledWith(room);
  });

  it('两人先后断线弃权、最后一人离开：空房 5 分钟后回收', () => {
    vi.useFakeTimers();
    const { room, repo, events, alice, bob, carol } = startedRoom();
    room.markDisconnected(carol.id, 'sock3');
    vi.advanceTimersByTime(90_000);
    room.markDisconnected(bob.id, 'sock2');
    vi.advanceTimersByTime(90_000);
    expect(room.game?.phase).toBe('gameOver');
    room.leavePlayer(alice.id, 'sock1');

    vi.advanceTimersByTime(5 * 60_000);
    expect(repo.delete).toHaveBeenCalledWith('ABC123');
    expect(events.onEmpty).toHaveBeenCalledWith(room);
  });

  it('回收计时到点时仍有玩家在宽限期内：房间保留，等其宽限期过后再回收', () => {
    vi.useFakeTimers();
    const { room, events, alice, bob, carol } = startedRoom();
    room.markDisconnected(carol.id, 'sock3');
    vi.advanceTimersByTime(90_000);
    room.markDisconnected(bob.id, 'sock2');
    vi.advanceTimersByTime(90_000);
    room.leavePlayer(alice.id, 'sock1');

    // 已弃权的 Bob 回来看结果，又在回收计时到点前断线
    vi.advanceTimersByTime(4 * 60_000);
    room.addPlayer('Bob', 'sock2b', { id: bob.id, secret: bob.secret });
    room.markDisconnected(bob.id, 'sock2b');
    vi.advanceTimersByTime(60_000);
    expect(events.onEmpty).not.toHaveBeenCalled();
    room.addPlayer('Bob', 'sock2c', { id: bob.id, secret: bob.secret });
    expect(room.players.has(bob.id)).toBe(true);

    room.markDisconnected(bob.id, 'sock2c');
    vi.advanceTimersByTime(90_000 + 5 * 60_000);
    expect(events.onEmpty).toHaveBeenCalledWith(room);
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

  it('getPrivateState 牌局外玩家返回 null 而非抛错', () => {
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
    expect(room.getDeadlineMs()).toBe(20_000);

    // 超时默认选择：随机失去一张，回合推进
    vi.advanceTimersByTime(20_000);
    expect(room.game?.players.find((p) => p.id === bob.id)?.revealed).toHaveLength(1);
    expect(room.game?.currentPlayerId).toBe(bob.id);
  });

  it('交换选牌超时后保留原手牌，摸到的牌放回牌堆，回合推进', () => {
    vi.useFakeTimers();
    const { room } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    const hand = room.game!.players.find((p) => p.id === alice.id)!.hand.map((c) => c.id);
    const deckSize = room.game!.deck.length;
    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'exchange' });
    vi.advanceTimersByTime(20_000); // 无人质疑
    expect(room.game?.phase).toBe('choosingExchange');
    expect(room.getDeadlineMs()).toBe(60_000);

    vi.advanceTimersByTime(60_000);

    expect(room.game?.players.find((p) => p.id === alice.id)?.hand.map((c) => c.id)).toEqual(hand);
    expect(room.game?.deck).toHaveLength(deckSize);
    expect(room.game?.currentPlayerId).toBe(bob.id);
  });

  it('对质限时 20 秒，超时替持有被声称角色的玩家翻开它；揭晓后下一段计时多出揭晓时间', () => {
    vi.useFakeTimers();
    const {
      room,
      events: { onBroadcast },
    } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    room.game!.players.find((p) => p.id === alice.id)!.hand = [
      { id: 'x-captain', role: 'captain' },
      { id: 'x-duke', role: 'duke' },
    ];
    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'tax' });
    room.dispatch(bob.id, 'sock2', { type: 'challenge' });
    expect(room.game?.phase).toBe('showdown');
    expect(room.getDeadlineMs()).toBe(20_000);

    vi.advanceTimersByTime(20_000);
    expect(onBroadcast).toHaveBeenCalledWith(room, expect.arrayContaining([
      expect.objectContaining({ type: 'challengeResolved', truth: true, slot: 1 }),
    ]));
    expect(room.getPublicState()?.lossPlayerId).toBe(bob.id);
    expect(room.getDeadlineMs()).toBe(26_000);
  });

  it('被质疑者在对质中翻牌', () => {
    vi.useFakeTimers();
    const { room } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    room.game!.players.find((p) => p.id === alice.id)!.hand = [
      { id: 'x-captain', role: 'captain' },
      { id: 'x-contessa', role: 'contessa' },
    ];
    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'tax' });
    room.dispatch(bob.id, 'sock2', { type: 'challenge' });
    room.dispatch(alice.id, 'sock1', { type: 'revealShowdownCard', cardId: 'x-contessa' });
    expect(room.getPublicState()?.players.find((p) => p.id === alice.id)?.revealed).toEqual(['contessa']);
    expect(room.game?.currentPlayerId).toBe(bob.id);
    expect(room.getDeadlineMs()).toBe(66_000);
  });

  it('问询窗口时限从进入窗口起算：重复放弃或已淘汰者弃权不重新计时，进入新阶段才重新计时', () => {
    vi.useFakeTimers();
    const { room } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    const carol = room.addPlayer('Carol', 'sock3');
    const dave = room.addPlayer('Dave', 'sock4');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    room.apply((g) => forfeit(g, dave.id));
    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'tax' });
    vi.advanceTimersByTime(5_000);
    room.dispatch(bob.id, 'sock2', { type: 'passChallenge' });
    expect(room.getDeadlineMs()).toBe(15_000);
    vi.advanceTimersByTime(5_000);
    room.dispatch(bob.id, 'sock2', { type: 'passChallenge' });
    room.apply((g) => forfeit(g, dave.id));
    expect(room.getDeadlineMs()).toBe(10_000);

    room.dispatch(carol.id, 'sock3', { type: 'passChallenge' });
    expect(room.game?.currentPlayerId).toBe(bob.id);
    expect(room.getDeadlineMs()).toBe(60_000);
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
  it.each(['choosingAction', 'gameOver'])('牌局已存在（%s）时房主不能再开局，只能再来一局', (phase) => {
    const { room } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    room.addPlayer('Bob', 'sock2');
    room.startGame(alice.id, 'sock1');
    const game = room.game!;
    game.phase = phase as GameState['phase'];

    expect(() => room.startGame(alice.id, 'sock1')).toThrow('gameAlreadyStarted');
    expect(room.game).toBe(game);
  });

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

  it.each([null, 'ab', { length: 2 }])('交换时 keepIds 不是数组（%j）按非法行动拒绝', (keepIds) => {
    const { room } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'exchange' });
    room.dispatch(bob.id, 'sock2', { type: 'passChallenge' });
    expect(room.game?.phase).toBe('choosingExchange');

    expect(() => room.dispatch(alice.id, 'sock1', { type: 'resolveExchange', keepIds })).toThrow('invalidGameAction');
  });

  it.each([
    ['passChallenge', 'tax'],
    ['passBlock', 'foreignAid'],
  ] as const)('重复的 %s（例如双击）不报错，也不向全房间广播', (pass, action) => {
    const { room, events } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.addPlayer('Carol', 'sock3');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action });
    room.dispatch(bob.id, 'sock2', { type: pass });
    events.onBroadcast.mockClear();

    expect(room.dispatch(bob.id, 'sock2', { type: pass })).toEqual([]);
    expect(events.onBroadcast).not.toHaveBeenCalled();
    expect(room.game?.passed).toEqual([bob.id]);
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

describe('Room 大厅阶段', () => {
  afterEach(() => vi.useRealTimers());

  it('房主断线时开局权立即交给下一位在线玩家，原房主重连后是普通玩家', () => {
    vi.useFakeTimers();
    const { room } = makeRoom();
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    expect(room.hostId).toBe(alice.id);
    room.markDisconnected(alice.id, 'sock1');
    expect(room.hostId).toBe(bob.id);
    room.addPlayer('Alice', 'sock1b', { id: alice.id, secret: alice.secret });
    expect(room.hostId).toBe(bob.id);
    expect(() => room.startGame(alice.id, 'sock1b')).toThrow('hostOnly');
  });

  it('全员断线后新玩家加入即成为房主', () => {
    vi.useFakeTimers();
    const { room } = makeRoom();
    const alice = room.addPlayer('Alice', 'sock1');
    room.markDisconnected(alice.id, 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    expect(room.hostId).toBe(bob.id);
  });
});

describe('Room 牌局结束后', () => {
  afterEach(() => vi.useRealTimers());

  function finishedRoom() {
    const made = makeRoom({ startingPlayerRandom: () => 0 });
    const { room } = made;
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    const carol = room.addPlayer('Carol', 'sock3');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    room.apply((g) => forfeit(g, carol.id));
    room.apply((g) => forfeit(g, alice.id));
    expect(room.game?.phase).toBe('gameOver');
    return { ...made, alice, bob, carol };
  }

  it('离开房间不产生失去影响力或淘汰事件，玩家直接移除', () => {
    const { room, bob } = finishedRoom();
    expect(room.leavePlayer(bob.id, 'sock2')).toEqual([]);
    expect(room.players.has(bob.id)).toBe(false);
    expect(room.getPublicState()?.players.find((p) => p.id === bob.id)?.alive).toBe(true);
  });

  it('房主发起再来一局后回到大厅阶段且在场玩家不变；非房主被拒', () => {
    const { room, alice, bob } = finishedRoom();
    const before = room.playerList;
    expect(() => room.rematch(bob.id, 'sock2')).toThrow('hostOnly');
    room.rematch(alice.id, 'sock1');
    expect(room.game).toBeNull();
    expect(room.getDeadlineMs()).toBeNull();
    expect(room.playerList).toEqual(before);
    room.addPlayer('Dave', 'sock4');
    room.startGame(alice.id, 'sock1');
    expect(room.game?.players).toHaveLength(4);
  });

  const crowned = (room: Room) => room.playerList.filter((p) => p.isPreviousWinner).map((p) => p.name);

  it('再来一局后大厅阶段以皇冠标出上局获胜者', () => {
    const { room, alice } = finishedRoom();
    room.rematch(alice.id, 'sock1');
    expect(crowned(room)).toEqual(['Bob']);
  });

  it('上局获胜者离开房间即清除皇冠，重新加入也不再带皇冠', () => {
    const { room, alice, bob } = finishedRoom();
    room.rematch(alice.id, 'sock1');
    room.leavePlayer(bob.id, 'sock2');
    expect(room.previousWinnerId).toBeNull();
    room.addPlayer('Bob', 'sock2b', { id: bob.id, secret: bob.secret });
    expect(crowned(room)).toEqual([]);
  });

  it('上局获胜者断线重连后保留皇冠', () => {
    vi.useFakeTimers();
    const { room, alice, bob } = finishedRoom();
    room.markDisconnected(bob.id, 'sock2');
    room.rematch(alice.id, 'sock1');
    room.addPlayer('Bob', 'sock2b', { id: bob.id, secret: bob.secret });
    expect(crowned(room)).toEqual(['Bob']);
  });

  it('下一局结束时皇冠换给新的获胜者', () => {
    const { room, alice, bob, carol } = finishedRoom();
    room.rematch(alice.id, 'sock1');
    room.startGame(alice.id, 'sock1');
    expect(crowned(room)).toEqual(['Bob']);
    room.apply((g) => forfeit(g, bob.id));
    room.apply((g) => forfeit(g, carol.id));
    expect(crowned(room)).toEqual(['Alice']);
  });

  it('牌局进行中不能再来一局', () => {
    const { room } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    room.addPlayer('Bob', 'sock2');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    expect(() => room.rematch(alice.id, 'sock1')).toThrow('illegalIntent');
  });

  it('房主离线时再来一局权利立即交给下一位在线玩家', () => {
    vi.useFakeTimers();
    const { room, alice, bob, carol } = finishedRoom();
    room.markDisconnected(alice.id, 'sock1');
    expect(room.hostId).toBe(bob.id);
    expect(() => room.rematch(alice.id, 'sock1')).toThrow('illegalIntent');
    room.markDisconnected(bob.id, 'sock2');
    expect(room.hostId).toBe(carol.id);
    room.rematch(carol.id, 'sock3');
    expect(room.game).toBeNull();
  });

  it('房主在牌局结束前已离线，结束时权利立即转交', () => {
    vi.useFakeTimers();
    const { room } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    room.markDisconnected(alice.id, 'sock1');
    expect(room.hostId).toBe(alice.id);
    room.apply((g) => forfeit(g, alice.id));
    expect(room.hostId).toBe(bob.id);
  });

  it('全员离线时牌局结束，第一位重连的玩家立即获得再来一局权利', () => {
    vi.useFakeTimers();
    const { room, alice, bob, carol } = finishedRoom();
    for (const [p, sock] of [[alice, 'sock1'], [bob, 'sock2'], [carol, 'sock3']] as const) room.markDisconnected(p.id, sock);
    room.addPlayer('Bob', 'sock2b', { id: bob.id, secret: bob.secret });
    expect(room.hostId).toBe(bob.id);
  });

  it('牌局中宽限期已到而弃权的离线玩家不会被带进再来一局，移除时广播', () => {
    vi.useFakeTimers();
    const { room, events } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    const carol = room.addPlayer('Carol', 'sock3');
    const dave = room.addPlayer('Dave', 'sock4');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    room.markDisconnected(carol.id, 'sock3');
    vi.advanceTimersByTime(90_000);
    room.apply((g) => forfeit(g, bob.id));
    room.markDisconnected(dave.id, 'sock4'); // 宽限期未到，仍可重连
    room.apply((g) => forfeit(g, dave.id));
    expect(room.game?.phase).toBe('gameOver');

    room.rematch(alice.id, 'sock1');
    expect([...room.players.keys()]).toEqual([alice.id, bob.id, dave.id]);

    events.onBroadcast.mockClear();
    vi.advanceTimersByTime(90_000);
    expect([...room.players.keys()]).toEqual([alice.id, bob.id]);
    expect(events.onBroadcast).toHaveBeenCalledWith(room, []);
  });
});

describe('Room 电脑玩家', () => {
  afterEach(() => vi.useRealTimers());

  function lobby() {
    const made = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = made.room.addPlayer('Alice', 'sock1');
    const bob = made.room.addPlayer('Bob', 'sock2');
    return { ...made, alice, bob };
  }
  const computers = (room: Room) => room.playerList.filter((p) => p.isComputer);

  it('房主在大厅阶段一次加一个电脑玩家，名字取自固定名单且不重复，标为电脑、不显示离线', () => {
    const { room, events, alice } = lobby();
    room.addComputer(alice.id, 'sock1');
    room.addComputer(alice.id, 'sock1');
    expect(events.onBroadcast).toHaveBeenLastCalledWith(room, []);
    const added = computers(room);
    expect(added).toHaveLength(2);
    expect(new Set(added.map((p) => p.name)).size).toBe(2);
    expect(added.every((p) => p.connected && !p.isHost)).toBe(true);
    expect(room.playerList.filter((p) => !p.isComputer).map((p) => p.name)).toEqual(['Alice', 'Bob']);
  });

  it('新加的电脑玩家一律普通，房主在大厅阶段逐个改强度，名单上人人看得到；非房主、牌局中、目标不是电脑或不认识的强度被拒绝', () => {
    const { room, events, alice, bob } = lobby();
    room.addComputer(alice.id, 'sock1');
    room.addComputer(alice.id, 'sock1');
    const [first, second] = computers(room);
    room.setComputerStrength(alice.id, 'sock1', second.id, 'strong');
    expect(events.onBroadcast).toHaveBeenLastCalledWith(room, []);
    expect(computers(room).map((p) => [p.name, p.strength])).toEqual([[first.name, 'standard'], [second.name, 'strong']]);
    expect(room.playerList.filter((p) => !p.isComputer).some((p) => 'strength' in p)).toBe(false);
    expect(() => room.setComputerStrength(bob.id, 'sock2', first.id, 'strong')).toThrow('hostOnly');
    expect(() => room.setComputerStrength(alice.id, 'sock1', bob.id, 'strong')).toThrow('illegalIntent');
    expect(() => room.setComputerStrength(alice.id, 'sock1', first.id, 'godlike')).toThrow('illegalIntent');
    room.startGame(alice.id, 'sock1');
    expect(() => room.setComputerStrength(alice.id, 'sock1', first.id, 'strong')).toThrow('illegalIntent');
    expect(computers(room).map((p) => p.strength)).toEqual(['standard', 'strong']);
  });

  it('非房主、牌局中或满 6 座时添加被拒绝', () => {
    const { room, alice, bob } = lobby();
    expect(() => room.addComputer(bob.id, 'sock2')).toThrow('hostOnly');
    for (let i = 0; i < 4; i += 1) room.addComputer(alice.id, 'sock1');
    expect(() => room.addComputer(alice.id, 'sock1')).toThrow('roomFull');
    room.removeComputer(alice.id, 'sock1', computers(room)[0].id);
    room.startGame(alice.id, 'sock1');
    expect(() => room.addComputer(alice.id, 'sock1')).toThrow('illegalIntent');
    expect(room.players.size).toBe(5);
  });

  it('房主按玩家 ID 移除电脑玩家；非房主、牌局中或目标不是电脑时被拒绝', () => {
    const { room, alice, bob } = lobby();
    room.addComputer(alice.id, 'sock1');
    const [computer] = computers(room);
    expect(() => room.removeComputer(bob.id, 'sock2', computer.id)).toThrow('hostOnly');
    expect(() => room.removeComputer(alice.id, 'sock1', bob.id)).toThrow('illegalIntent');
    expect(() => room.removeComputer(alice.id, 'sock1', 'nobody')).toThrow('illegalIntent');
    room.startGame(alice.id, 'sock1');
    expect(() => room.removeComputer(alice.id, 'sock1', computer.id)).toThrow('illegalIntent');
    room.game = null;
    room.removeComputer(alice.id, 'sock1', computer.id);
    expect(computers(room)).toEqual([]);
  });

  it('满 6 座且有电脑玩家时，新的真人加入让最后加入的电脑让座；重连不让座', () => {
    const { room, alice } = lobby();
    for (let i = 0; i < 4; i += 1) room.addComputer(alice.id, 'sock1');
    const [first, , , last] = computers(room);
    room.addPlayer('Alice', 'sock1b', { id: alice.id, secret: alice.secret });
    expect(room.players.size).toBe(6);

    const carol = room.addPlayer('Carol', 'sock3');
    expect(room.players.has(last.id)).toBe(false);
    expect(room.players.has(first.id)).toBe(true);
    expect([...room.players.keys()].at(-1)).toBe(carol.id);
    expect(room.players.size).toBe(6);
  });

  it('电脑玩家永远不当房主：房主离开或离线时跳过电脑，只剩电脑时没有房主，下一位真人加入即成为房主', () => {
    vi.useFakeTimers();
    const { room } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    room.addComputer(alice.id, 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.markDisconnected(alice.id, 'sock1');
    expect(room.hostId).toBe(bob.id);
    room.addPlayer('Alice', 'sock1b', { id: alice.id, secret: alice.secret });
    room.leavePlayer(bob.id, 'sock2');
    room.leavePlayer(alice.id, 'sock1b');
    const dave = room.addPlayer('Dave', 'sock4');
    room.leavePlayer(dave.id, 'sock4'); // Dave 是房主，离开时只剩电脑
    expect(room.playerList.some((p) => p.isHost)).toBe(false);

    const carol = room.addPlayer('Carol', 'sock3');
    room.addPlayer('Erin', 'sock5');
    room.leavePlayer(carol.id, 'sock3'); // 最早加入的是电脑，继承跳过它
    expect(room.playerList.find((p) => p.isHost)?.name).toBe('Erin');
  });

  it('在场只算真人：只剩电脑玩家的房间按空房处理，5 分钟后回收', () => {
    vi.useFakeTimers();
    const { room, events, alice } = lobby();
    room.addComputer(alice.id, 'sock1');
    room.leavePlayer(room.playerList[1].id, 'sock2');
    room.leavePlayer(alice.id, 'sock1');
    vi.advanceTimersByTime(5 * 60_000);
    expect(events.onEmpty).toHaveBeenCalledWith(room);
  });

  it('再来一局后电脑玩家留在房间里', () => {
    const { room, alice, bob } = lobby();
    room.addComputer(alice.id, 'sock1');
    room.startGame(alice.id, 'sock1');
    room.leavePlayer(bob.id, 'sock2');
    room.apply((g) => forfeit(g, computers(room)[0].id));
    expect(room.game?.phase).toBe('gameOver');
    room.rematch(alice.id, 'sock1');
    expect(computers(room)).toHaveLength(1);
  });

  function soloGame() {
    // 电脑随机源固定：宽限期里电脑照常出手，牌局走向要确定
    const made = makeRoom({ startingPlayerRandom: () => 0, computerRandom: () => 0 });
    const alice = made.room.addPlayer('Alice', 'sock1');
    made.room.addComputer(alice.id, 'sock1');
    made.room.addComputer(alice.id, 'sock1');
    made.room.startGame(alice.id, 'sock1');
    return { ...made, alice };
  }

  it('牌局中最后一位真人离开：牌局作废回到大厅阶段，电脑留座，只剩空房回收计时', () => {
    vi.useFakeTimers();
    const { room, events, alice } = soloGame();
    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'income' }); // 轮到电脑，它的出手已排上
    room.leavePlayer(alice.id, 'sock1');
    expect(room.game).toBeNull();
    expect(computers(room)).toHaveLength(2);
    expect(room.getDeadlineMs()).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(5 * 60_000);
    expect(events.onEmpty).toHaveBeenCalledWith(room);
  });

  it('最后一位真人断线宽限期到：牌局作废，其座位移除，凭旧凭证回来只能作为新玩家进大厅', () => {
    vi.useFakeTimers();
    const { room, alice } = soloGame();
    room.markDisconnected(alice.id, 'sock1');
    vi.advanceTimersByTime(90_000);
    expect(room.game).toBeNull();
    expect([...room.players.values()].every((p) => p.isComputer)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    const back = room.addPlayer('Alice', 'sock1b', { id: alice.id, secret: alice.secret });
    expect(back.id).not.toBe(alice.id);
    expect(room.hostId).toBe(back.id);
    room.startGame(back.id, 'sock1b');
    expect(room.game?.players).toHaveLength(3);
  });

  it('真人只是被淘汰、仍在房间里旁观时牌局继续', () => {
    const { room, alice, bob } = lobby();
    room.addComputer(alice.id, 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.startGame(alice.id, 'sock1');
    room.apply((g) => forfeit(g, bob.id));
    room.leavePlayer(alice.id, 'sock1');
    expect(room.game?.phase).not.toBe('gameOver');
    expect(room.getDeadlineMs()).not.toBeNull();
  });
});

describe('Room 电脑出手', () => {
  afterEach(() => vi.useRealTimers());

  it('开局第一手：电脑等发牌展示的顺延加选行动延迟后才出手', () => {
    vi.useFakeTimers();
    const { room, events } = makeRoom({ startingPlayerRandom: () => 0.5, computerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.startGame(alice.id, 'sock1');
    const computerId = room.game!.currentPlayerId;
    expect(computerId).not.toBe(alice.id);

    vi.advanceTimersByTime(4_999); // 发牌展示顺延 3 秒 + 选行动最短 2 秒
    expect(room.game!.currentPlayerId).toBe(computerId);
    vi.advanceTimersByTime(1);
    expect(events.onBroadcast).toHaveBeenLastCalledWith(room, expect.arrayContaining([expect.objectContaining({ type: 'actionChosen', actorId: computerId })]));
    expect(room.game!.currentPlayerId).toBe(alice.id);
  });

  it('房里的真人全被淘汰、只剩旁观时，电脑 1 秒一步，不按选行动的 2 秒起步', () => {
    vi.useFakeTimers();
    const { room, events } = makeRoom({ startingPlayerRandom: () => 0, computerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.startGame(alice.id, 'sock1');
    room.apply((g) => forfeit(g, alice.id)); // Alice 被淘汰但留在房里
    const computerId = room.game!.currentPlayerId;

    vi.advanceTimersByTime(999);
    expect(room.game!.currentPlayerId).toBe(computerId);
    vi.advanceTimersByTime(1);
    expect(events.onBroadcast).toHaveBeenLastCalledWith(room, expect.arrayContaining([expect.objectContaining({ type: 'actionChosen', actorId: computerId })]));
  });

  it('电脑记得本局的公开事件：报复最近打过自己的玩家；下一局不记得', () => {
    vi.useFakeTimers();
    // 随机源恒为 0.999：电脑不凭概率质疑或假装阻挡，选目标时的随机项对谁都一样
    const { room } = makeRoom({ startingPlayerRandom: () => 0.34, computerRandom: () => 0.999, computerDelayMs: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.addComputer(alice.id, 'sock1');
    const computerId = room.playerList.find((p) => p.isComputer)!.id;
    const coins = (id: string, n: number) => (room.game!.players.find((p) => p.id === id)!.coins = n);
    // Bob 先手；Alice 金币最多，是领先者
    const start = () => {
      room.startGame(alice.id, 'sock1');
      coins(alice.id, 5);
      coins(computerId, 12); // 被偷走 2 枚仍有 10 枚：轮到它必政变
    };

    start();
    room.dispatch(bob.id, 'sock2', { type: 'chooseAction', action: 'steal', targetId: computerId });
    room.dispatch(alice.id, 'sock1', { type: 'passChallenge' });
    vi.advanceTimersToNextTimer(); // 电脑放弃质疑
    vi.advanceTimersToNextTimer(); // 电脑阻挡（手里有对应角色）或放弃
    if (room.game!.phase === 'awaitingChallenge') {
      room.dispatch(alice.id, 'sock1', { type: 'passChallenge' });
      room.dispatch(bob.id, 'sock2', { type: 'passChallenge' });
    }
    vi.advanceTimersToNextTimer(); // 电脑的回合：政变
    expect(room.game!.lossToResolve?.playerId).toBe(bob.id);

    room.apply((g) => forfeit(g, computerId));
    room.apply((g) => forfeit(g, bob.id));
    room.rematch(alice.id, 'sock1');
    start();
    room.dispatch(bob.id, 'sock2', { type: 'chooseAction', action: 'income' });
    vi.advanceTimersToNextTimer();
    expect(room.game!.lossToResolve?.playerId).toBe(alice.id);
  });

  it('注入零延迟：1 位真人（只靠默认行动）加 3 个电脑的牌局打到 gameOver，不留计时器', () => {
    vi.useFakeTimers();
    let seed = 1;
    const computerRandom = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const { room, events } = makeRoom({ startingPlayerRandom: () => 0, computerRandom, computerDelayMs: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    for (let i = 0; i < 3; i += 1) room.addComputer(alice.id, 'sock1');
    room.startGame(alice.id, 'sock1');
    for (let step = 0; step < 2_000 && room.game!.phase !== 'gameOver'; step += 1) vi.advanceTimersToNextTimer();
    expect(room.game!.phase).toBe('gameOver');
    expect(vi.getTimerCount()).toBe(0);
    // 默认行动只会收入或政变：出现别的行动，说明是电脑自己在出手，而不是超时替它出
    const chosen = events.onBroadcast.mock.calls.flatMap(([, evs]) => evs).filter((e) => e.type === 'actionChosen' && e.actorId !== alice.id);
    expect(chosen.some((e) => e.action !== 'income' && e.action !== 'coup')).toBe(true);
  });

  // 出手节奏（#73）。把随机源固定成 u，在 0～1 上均匀取 100 个 u 各量一次：得到的就是延迟分布的 100 个等概率样本
  const QUANTILES = Array.from({ length: 100 }, (_, i) => (i + 0.5) / 100);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b) / xs.length;
  const median = (xs: number[]) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return (sorted[xs.length / 2 - 1] + sorted[xs.length / 2]) / 2;
  };
  // Alice 先手，其后是 Bob（如有）和 1 个电脑
  function table(options: RoomOptions, withBob = true) {
    vi.useFakeTimers();
    vi.clearAllTimers(); // 一个用例里连开多桌：上一桌留下的计时器不带过来
    const made = makeRoom({ startingPlayerRandom: () => 0, ...options });
    const alice = made.room.addPlayer('Alice', 'sock1');
    const bob = withBob ? made.room.addPlayer('Bob', 'sock2') : undefined;
    made.room.addComputer(alice.id, 'sock1');
    made.room.startGame(alice.id, 'sock1');
    return { ...made, alice, bob, computerId: made.room.playerList.find((p) => p.isComputer)!.id };
  }
  // 电脑的出手是最近的计时器（阶段时限至少 20 秒）：走到它，返回等了多久
  function untilComputerMoves() {
    const before = Date.now();
    vi.advanceTimersToNextTimer();
    return Date.now() - before;
  }

  it('选行动的延迟右偏：都在 2～6 秒内，中位数低于区间中点 4 秒，仍有超过中点的长考', () => {
    const delays = QUANTILES.map((u) => {
      const { room, events, alice, computerId } = table({ computerRandom: () => u }, false);
      room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'income' });
      const delay = untilComputerMoves();
      expect(events.onBroadcast).toHaveBeenLastCalledWith(room, expect.arrayContaining([expect.objectContaining({ type: 'actionChosen', actorId: computerId })]));
      return delay;
    });
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(2_000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(6_000);
    expect(median(delays)).toBeLessThan(4_000);
    expect(Math.max(...delays)).toBeGreaterThan(4_000);
  });

  type Table = ReturnType<typeof table>;
  const income = ({ room }: Table, id: string, socketId: string) => room.dispatch(id, socketId, { type: 'chooseAction', action: 'income' });
  it.each<[string, (t: Table) => void, (t: Table) => void]>([
    [
      '偷窃的声称，目标是电脑或是 Bob',
      ({ room, alice, computerId }) => room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'steal', targetId: computerId }),
      ({ room, alice, bob }) => room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'steal', targetId: bob!.id }),
    ],
    [
      'Alice 声称公爵阻挡外援，拦的是电脑的或是 Bob 的',
      (t) => {
        income(t, t.alice.id, 'sock1');
        income(t, t.bob!.id, 'sock2');
        t.room.apply((g) => chooseAction(g, t.computerId, 'foreignAid'));
        t.room.dispatch(t.alice.id, 'sock1', { type: 'block', role: 'duke' });
      },
      (t) => {
        income(t, t.alice.id, 'sock1');
        t.room.dispatch(t.bob!.id, 'sock2', { type: 'chooseAction', action: 'foreignAid' });
        t.room.dispatch(t.alice.id, 'sock1', { type: 'block', role: 'duke' });
      },
    ],
  ])('问询窗口里冲着自己来的声称出手更慢（%s）：两边都在 1.5～5 秒内、中位数低于中点 3.25 秒，冲着自己来的平均更慢', (_, aimedAtComputer, aimedElsewhere) => {
    const sample = (claim: (t: Table) => void) =>
      QUANTILES.map((u) => {
        const t = table({ computerRandom: () => u });
        claim(t);
        expect(t.room.game!.phase).toBe('awaitingChallenge');
        const delay = untilComputerMoves();
        expect(t.room.game!.phase === 'showdown' || t.room.game!.passed.includes(t.computerId)).toBe(true); // 电脑质疑了，或放弃了
        return delay;
      });
    const [aimed, elsewhere] = [sample(aimedAtComputer), sample(aimedElsewhere)];
    for (const delays of [aimed, elsewhere]) {
      expect(Math.min(...delays)).toBeGreaterThanOrEqual(1_500);
      expect(Math.max(...delays)).toBeLessThanOrEqual(5_000);
      expect(median(delays)).toBeLessThan(3_250);
      expect(Math.max(...delays)).toBeGreaterThan(3_250);
    }
    expect(mean(aimed)).toBeGreaterThan(mean(elsewhere));
  });

  // 把一位玩家的暗牌换成指定角色：和牌堆或别人手里的牌对调，整副牌不变
  function giveHand(g: GameState, id: string, roles: Role[]) {
    const hand = g.players.find((p) => p.id === id)!.hand;
    const piles = [hand, g.deck, ...g.players.filter((p) => p.id !== id).map((p) => p.hand)];
    roles.forEach((role, slot) => {
      for (const pile of piles) {
        const at = pile.findIndex((c, i) => c.role === role && (pile !== hand || i >= slot));
        if (at < 0) continue;
        [hand[slot], pile[at]] = [pile[at], hand[slot]];
        return;
      }
    });
  }

  it.each<[string, (t: Table) => void, Role[], Role[]]>([
    ['质疑窗口：Alice 声称公爵征税', ({ room, alice }) => room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'tax' }), ['duke', 'duke'], ['captain', 'contessa']],
    ['阻挡窗口：Alice 拿外援', ({ room, alice }) => room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'foreignAid' }), ['duke', 'contessa'], ['captain', 'contessa']],
  ])('出手快慢不泄露暗牌（%s）：公开局面相同时改暗牌不改变延迟，最终质疑或阻挡的和放弃的等得一样久', (_, open, oneHand, otherHand) => {
    const sample = (roles: Role[]) =>
      QUANTILES.map((u) => {
        const t = table({ computerRandom: () => u });
        giveHand(t.room.game!, t.computerId, roles);
        open(t);
        const delay = untilComputerMoves();
        const moved: GameEvent[] = t.events.onBroadcast.mock.lastCall![1];
        const spoke = moved.some((e) => e.type === 'challenged' || e.type === 'blocked');
        expect(spoke || t.room.game!.passed.includes(t.computerId)).toBe(true); // 电脑质疑或阻挡了，或放弃了
        return { delay, spoke };
      });
    const [one, other] = [sample(oneHand), sample(otherHand)];
    expect(one.map((s) => s.delay)).toEqual(other.map((s) => s.delay));
    // 同一个随机数下，一手牌质疑（阻挡）了，另一手牌放弃了
    expect(one.some((s, i) => s.spoke !== other[i].spoke)).toBe(true);
  });

  it.each(['电脑', 'Bob'])('排一次出手只抽一个随机数（偷窃的目标是%s）：注入延迟时不抽，电脑随机源的调用恰好少 1 次', (target) => {
    const draws = (options: RoomOptions) => {
      let count = 0;
      const { room, alice, bob, computerId } = table({ computerRandom: () => ((count += 1), 0.5), ...options });
      room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'steal', targetId: target === 'Bob' ? bob!.id : computerId });
      return count;
    };
    expect(draws({}) - draws({ computerDelayMs: () => 0 })).toBe(1);
  });
});

describe('Room 推送', () => {
  it('每次改变房间都经 onBroadcast 推送，并带上对应事件', () => {
    const { room, events } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.hostId = alice.id;

    room.startGame(alice.id, 'sock1');
    expect(events.onBroadcast).toHaveBeenLastCalledWith(room, [expect.objectContaining({ type: 'started' })]);

    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'income' });
    expect(events.onBroadcast).toHaveBeenLastCalledWith(room, expect.arrayContaining([expect.objectContaining({ type: 'actionChosen' })]));

    room.leavePlayer(bob.id, 'sock2');
    expect(events.onBroadcast).toHaveBeenLastCalledWith(room, expect.arrayContaining([expect.objectContaining({ type: 'gameOver' })]));

    room.rematch(alice.id, 'sock1');
    expect(events.onBroadcast).toHaveBeenLastCalledWith(room, []);
    expect(events.onBroadcast).toHaveBeenCalledTimes(4);
  });
});

describe('Room 对质悬停同步', () => {
  afterEach(() => vi.useRealTimers());

  it('只转发被质疑者的合法牌位，过密的消息丢弃，非法牌位报错', () => {
    vi.useFakeTimers();
    const { room } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    expect(room.focusShowdownCard(alice.id, 'sock1', 0)).toBeNull();

    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'tax' });
    room.dispatch(bob.id, 'sock2', { type: 'challenge' });
    expect(room.focusShowdownCard(bob.id, 'sock2', 0)).toBeNull();
    expect(room.focusShowdownCard(alice.id, 'sock1', 1)).toEqual({ slot: 1 });
    expect(room.focusShowdownCard(alice.id, 'sock1', 0)).toBeNull();
    vi.advanceTimersByTime(100);
    expect(room.focusShowdownCard(alice.id, 'sock1', null)).toEqual({ slot: null });
    expect(() => room.focusShowdownCard(alice.id, 'sock1', 2)).toThrow('illegalIntent');
    expect(() => room.focusShowdownCard(alice.id, 'sock1', '0')).toThrow('illegalIntent');
  });
});

describe('Room 电脑翻牌前的犹豫', () => {
  afterEach(() => vi.useRealTimers());

  const lehmer = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // Alice 先手、电脑第二：电脑声称公爵征税，Alice 质疑，走到电脑翻牌。
  // 返回对质开始后全房间收到的电脑对准（带时刻）、翻牌时刻和翻开的牌位
  function showdown(options: RoomOptions, roles?: Role[]) {
    vi.useFakeTimers();
    vi.clearAllTimers();
    const made = makeRoom({ startingPlayerRandom: () => 0, ...options });
    const { room, events } = made;
    const alice = room.addPlayer('Alice', 'sock1');
    room.addComputer(alice.id, 'sock1');
    const computerId = room.playerList.find((p) => p.isComputer)!.id;
    room.startGame(alice.id, 'sock1');
    const hand = room.game!.players.find((p) => p.id === computerId)!.hand;
    // 只改角色、不对调牌：整副牌的构成和这场对质无关
    if (roles) {
      room.game!.deck.push(...hand.splice(roles.length));
      roles.forEach((role, i) => (hand[i].role = role));
    }
    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'income' });
    room.apply((g) => chooseAction(g, computerId, 'tax'));
    const start = Date.now();
    const focuses: { at: number; slot: number | null }[] = [];
    events.onShowdownFocus.mockImplementation((_, focus: { slot: number | null }) => focuses.push({ at: Date.now() - start, ...focus }));
    room.dispatch(alice.id, 'sock1', { type: 'challenge' });
    const deadlineMs = room.getDeadlineMs();
    while (room.game!.phase === 'showdown') vi.advanceTimersToNextTimer();
    const revealAt = Date.now() - start;
    const resolved = events.onBroadcast.mock.lastCall![1].find((e: GameEvent) => e.type === 'challengeResolved');
    return { ...made, alice, computerId, focuses, revealAt, deadlineMs, slot: resolved.slot as number };
  }

  it('两张暗牌：翻牌前全房间收到对准，在两个牌位之间移动，最后一次落在翻开的那张上', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const { focuses, revealAt, slot } = showdown({ speechRandom: lehmer(seed) });
      expect(new Set(focuses.map((f) => f.slot))).toEqual(new Set([0, 1]));
      expect(focuses.at(-1)!.slot).toBe(slot);
      expect(focuses.at(-1)!.at).toBeLessThan(revealAt);
    }
  });

  it('只剩一张暗牌：只对准它', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const { focuses } = showdown({ speechRandom: lehmer(seed) }, ['captain']);
      expect(focuses.length).toBeGreaterThan(0);
      expect(focuses.every((f) => f.slot === 0)).toBe(true);
    }
  });

  it('固定发言种子，改暗牌：落点之前的游移序列和时刻不变，落点随翻开的牌变', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const options = { computerRandom: () => 0.5, speechRandom: lehmer(seed) };
      const first = showdown({ ...options, speechRandom: lehmer(seed) }, ['duke', 'captain']);
      const second = showdown({ ...options, speechRandom: lehmer(seed) }, ['contessa', 'duke']);
      expect([first.slot, second.slot]).toEqual([0, 1]);
      expect(second.focuses.slice(0, -1)).toEqual(first.focuses.slice(0, -1));
      expect(second.focuses.at(-1)!.at).toBe(first.focuses.at(-1)!.at);
      expect(second.revealAt).toBe(first.revealAt);
    }
  });

  it('游移多寡不改变翻牌时刻和行动随机源的抽取：翻牌仍在 2～4 秒内，对质时限仍是 20 秒', () => {
    for (let i = 0; i < 100; i += 1) {
      const u = (i + 0.5) / 100;
      const run = (speech: number) => {
        let draws = 0;
        const { focuses, revealAt, deadlineMs } = showdown({ computerRandom: () => ((draws += 1), u), speechRandom: () => speech }, ['duke', 'captain']);
        return { wanders: focuses.length, revealAt, deadlineMs, draws };
      };
      const [busy, calm] = [run(0), run(0.999)];
      expect(busy.wanders).toBeGreaterThan(calm.wanders);
      expect(calm.wanders).toBeGreaterThanOrEqual(3); // 至少游移两次再落点
      expect(busy.revealAt).toBe(calm.revealAt);
      expect(busy.draws).toBe(calm.draws);
      expect(busy.revealAt).toBeGreaterThanOrEqual(2_000);
      expect(busy.revealAt).toBeLessThanOrEqual(4_000);
      expect(busy.deadlineMs).toBe(20_000);
    }
  });

  it('对质结束后不再对准；电脑犹豫时牌局结束、再来一局、牌局作废都不留计时器', () => {
    const { events, focuses } = showdown({ speechRandom: lehmer(1) });
    const count = focuses.length;
    vi.advanceTimersByTime(60_000);
    expect(focuses.length).toBe(count);

    // 对质开始 1 秒：电脑还在游移
    const begin = (computers: number) => {
      vi.useFakeTimers();
      vi.clearAllTimers();
      const made = makeRoom({ startingPlayerRandom: () => 0 });
      const alice = made.room.addPlayer('Alice', 'sock1');
      for (let i = 0; i < computers; i += 1) made.room.addComputer(alice.id, 'sock1');
      const computerId = made.room.playerList.find((p) => p.isComputer)!.id;
      made.room.startGame(alice.id, 'sock1');
      made.room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'income' });
      made.room.apply((g) => chooseAction(g, computerId, 'tax'));
      made.room.dispatch(alice.id, 'sock1', { type: 'challenge' });
      vi.advanceTimersByTime(1_000);
      expect(made.room.game!.phase).toBe('showdown');
      return { ...made, alice, computerId };
    };
    const ended = begin(1);
    ended.room.apply((g) => forfeit(g, ended.computerId));
    expect(ended.room.game!.phase).toBe('gameOver');
    expect(vi.getTimerCount()).toBe(0);
    ended.room.rematch(ended.alice.id, 'sock1');
    expect(vi.getTimerCount()).toBe(0);

    const voided = begin(2); // Alice 走后还剩两个电脑，牌局没结束，作废
    voided.room.leavePlayer(voided.alice.id, 'sock1');
    expect(voided.room.game).toBeNull();
    expect(vi.getTimerCount()).toBe(1); // 只剩空房回收
    expect(events.onShowdownFocus).toHaveBeenCalledTimes(count);
  });

  it('房里的真人全被淘汰、电脑 1 秒一步时不游移', () => {
    vi.useFakeTimers();
    const { room, events } = makeRoom({ startingPlayerRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.addComputer(alice.id, 'sock1');
    const [first, second] = room.playerList.filter((p) => p.isComputer).map((p) => p.id);
    room.startGame(alice.id, 'sock1');
    room.apply((g) => forfeit(g, alice.id));
    room.apply((g) => chooseAction(g, first, 'tax'));
    room.apply((g) => challenge(g, second));
    expect(room.game!.showdown?.claimantId).toBe(first);
    vi.advanceTimersByTime(1_000);
    expect(room.game!.phase).not.toBe('showdown');
    expect(events.onShowdownFocus).not.toHaveBeenCalled();
  });
});

describe('Room 表态', () => {
  afterEach(() => vi.useRealTimers());

  function playingRoom() {
    const made = makeRoom({ startingPlayerRandom: () => 0 });
    const { room } = made;
    const alice = room.addPlayer('Alice', 'sock1');
    const bob = room.addPlayer('Bob', 'sock2');
    const carol = room.addPlayer('Carol', 'sock3');
    room.hostId = alice.id;
    room.startGame(alice.id, 'sock1');
    return { ...made, alice, bob, carol };
  }

  it('牌局中的短语表态校验后交给传输层转发，不改变牌局', () => {
    const { room, bob, events } = playingRoom();
    const before = room.game;
    events.onBroadcast.mockClear();
    expect(room.react(bob.id, 'sock2', { kind: 'phrase', phrase: 'sure' })).toEqual({
      playerId: bob.id,
      reaction: { kind: 'phrase', phrase: 'sure' },
    });
    expect(room.game).toBe(before);
    expect(events.onBroadcast).not.toHaveBeenCalled();
  });

  it('大厅阶段没有座位，不能表态', () => {
    const { room } = makeRoom();
    const alice = room.addPlayer('Alice', 'sock1');
    expect(() => room.react(alice.id, 'sock1', { kind: 'phrase', phrase: 'sure' })).toThrow('gameNotStarted');
  });

  it('拒绝格式不对或不在预设里的表态：自写文字进不来', () => {
    const { room, bob } = playingRoom();
    for (const bad of [
      null,
      'sure',
      { kind: 'phrase', phrase: '随便写点什么' },
      { kind: 'phrase', phrase: 'framed' }, // 「冤枉啊」已从预设里删除
      { kind: 'phrase' },
      { kind: 'chat', text: 'hello' },
      { kind: 'announcement', action: 'nap' },
      { kind: 'verbalClaim', has: true, role: 'king' },
      { kind: 'verbalClaim', has: 'yes', role: 'duke' },
    ]) {
      expect(() => room.react(bob.id, 'sock2', bad), JSON.stringify(bad)).toThrow('illegalIntent');
    }
  });

  it('行动预告：针对性行动只能指向对手，非针对性行动不带目标；目标已被淘汰时静默丢弃', () => {
    const { room, alice, bob, carol } = playingRoom();
    room.apply((g) => forfeit(g, carol.id));
    expect(room.react(bob.id, 'sock2', { kind: 'announcement', action: 'assassinate', targetId: alice.id })).toEqual({
      playerId: bob.id,
      reaction: { kind: 'announcement', action: 'assassinate', targetId: alice.id },
    });
    expect(room.react(alice.id, 'sock1', { kind: 'announcement', action: 'tax' })?.reaction).toEqual({
      kind: 'announcement',
      action: 'tax',
    });
    // 客户端选目标时 Carol 还在，到服务器时已被淘汰：不报错，只是不转发
    expect(room.react(alice.id, 'sock1', { kind: 'announcement', action: 'coup', targetId: carol.id })).toBeNull();
    for (const bad of [
      { kind: 'announcement', action: 'steal' },
      { kind: 'announcement', action: 'steal', targetId: bob.id },
      { kind: 'announcement', action: 'coup', targetId: 'nobody' },
      { kind: 'announcement', action: 'income', targetId: alice.id },
    ]) {
      expect(() => room.react(bob.id, 'sock2', bad), JSON.stringify(bad)).toThrow('illegalIntent');
    }
  });

  it('被淘汰的玩家和牌局结束后只能用短语：其余表态静默丢弃', () => {
    const { room, alice, bob, carol } = playingRoom();
    const claim = { kind: 'verbalClaim', has: true, role: 'duke' };
    const income = { kind: 'announcement', action: 'income' };
    room.apply((g) => forfeit(g, carol.id));
    expect(room.react(carol.id, 'sock3', claim)).toBeNull();
    expect(room.react(carol.id, 'sock3', income)).toBeNull();
    expect(room.react(carol.id, 'sock3', { kind: 'phrase', phrase: 'mercy' })).not.toBeNull();

    room.apply((g) => forfeit(g, alice.id));
    expect(room.game?.phase).toBe('gameOver');
    expect(room.react(bob.id, 'sock2', claim)).toBeNull();
    expect(room.react(bob.id, 'sock2', { kind: 'phrase', phrase: 'respect' })).not.toBeNull();
  });

  it('按玩家限流：同一人 1.5 秒内的第二条直接丢弃，不影响其他人', () => {
    vi.useFakeTimers();
    const { room, alice, bob } = playingRoom();
    const sure = { kind: 'phrase', phrase: 'sure' };
    expect(room.react(bob.id, 'sock2', sure)).not.toBeNull();
    vi.advanceTimersByTime(1_499);
    expect(room.react(bob.id, 'sock2', sure)).toBeNull();
    expect(room.react(alice.id, 'sock1', sure)).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(room.react(bob.id, 'sock2', sure)).not.toBeNull();
  });

  it('被接管的旧连接不能表态', () => {
    const { room, bob } = playingRoom();
    room.addPlayer('Bob', 'sock2b', { id: bob.id, secret: bob.secret });
    expect(() => room.react(bob.id, 'sock2', { kind: 'phrase', phrase: 'sure' })).toThrow();
  });
});

describe('Room 电脑表态', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Alice 先手，其后是 1 个电脑。Alice 收入后轮到电脑，测试让它直接声称公爵征税（不等它自己决定）
  function claimTable(options: RoomOptions = {}) {
    vi.useFakeTimers();
    vi.clearAllTimers();
    const made = makeRoom({ startingPlayerRandom: () => 0, speechRandom: () => 0, ...options });
    const alice = made.room.addPlayer('Alice', 'sock1');
    made.room.addComputer(alice.id, 'sock1');
    made.room.startGame(alice.id, 'sock1');
    const computerId = made.room.playerList.find((p) => p.isComputer)!.id;
    const income = () => made.room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'income' });
    income();
    const claim = () => made.room.apply((g) => chooseAction(g, computerId, 'tax'));
    // Alice 不质疑，征税结算，Alice 再收入，又轮到电脑
    const nextRound = () => {
      made.room.dispatch(alice.id, 'sock1', { type: 'passChallenge' });
      income();
    };
    return { ...made, alice, computerId, claim, nextRound };
  }
  type Events = ReturnType<typeof makeRoom>['events'];
  const spoken = (events: Events, id: string) => events.onReaction.mock.calls.filter(([, r]) => r.playerId === id).map(([, r]) => r.reaction);

  it('电脑作出声称后、问询窗口还开着时，从表态出口发给全房间；不改变牌局，不进事件记录', () => {
    const { room, events, computerId, claim } = claimTable();
    claim();
    const game = room.game;
    events.onBroadcast.mockClear();
    vi.advanceTimersByTime(1_500);
    expect(events.onReaction).toHaveBeenCalledTimes(1);
    expect(events.onReaction).toHaveBeenCalledWith(room, { playerId: computerId, reaction: expect.objectContaining({ kind: expect.stringMatching(/^(phrase|verbalClaim)$/) }) });
    expect(room.game).toBe(game);
    expect(room.game!.phase).toBe('awaitingChallenge');
    expect(events.onBroadcast).not.toHaveBeenCalled();
  });

  it('真人的表态也从同一个出口发给全房间', () => {
    const { room, events, alice } = claimTable();
    room.react(alice.id, 'sock1', { kind: 'phrase', phrase: 'sure' });
    expect(events.onReaction).toHaveBeenCalledWith(room, { playerId: alice.id, reaction: { kind: 'phrase', phrase: 'sure' } });
  });

  it('发出前问询窗口已结束则取消，不留计时器', () => {
    const { room, events, alice, claim } = claimTable();
    claim();
    room.dispatch(alice.id, 'sock1', { type: 'passChallenge' });
    expect(vi.getTimerCount()).toBe(1); // 只剩 Alice 回合的时限
    vi.advanceTimersByTime(1_500);
    expect(events.onReaction).not.toHaveBeenCalled();
  });

  it('牌局作废、牌局结束（之后再来一局）时取消未发出的表态', () => {
    const voided = claimTable();
    voided.claim();
    voided.room.leavePlayer(voided.alice.id, 'sock1');
    expect(vi.getTimerCount()).toBe(1); // 只剩空房回收
    vi.advanceTimersByTime(1_500);
    expect(voided.events.onReaction).not.toHaveBeenCalled();

    const ended = claimTable();
    ended.claim();
    ended.room.apply((g) => forfeit(g, ended.alice.id));
    expect(ended.room.game!.phase).toBe('gameOver');
    expect(vi.getTimerCount()).toBe(0);
    ended.room.rematch(ended.alice.id, 'sock1');
    vi.advanceTimersByTime(1_500);
    expect(ended.events.onReaction).not.toHaveBeenCalled();
  });

  it('电脑也受每位玩家 1.5 秒的限流', () => {
    // 发言随机源恒为 0：每次声称都开口，都在声称后 0.5 秒
    const { events, computerId, claim, nextRound } = claimTable();
    claim();
    vi.advanceTimersByTime(500);
    expect(spoken(events, computerId)).toHaveLength(1);
    nextRound();
    claim();
    vi.advanceTimersByTime(500); // 离上一条 0.5 秒：丢弃
    expect(spoken(events, computerId)).toHaveLength(1);
    nextRound();
    vi.advanceTimersByTime(500);
    claim();
    vi.advanceTimersByTime(500); // 离上一条 1.5 秒
    expect(spoken(events, computerId)).toHaveLength(2);
  });

  // 把电脑的暗牌改成指定角色（只为造出不同的暗牌，整副牌对不对不要紧）
  const setHand = (room: Room, id: string, roles: Role[]) => room.game!.players.find((p) => p.id === id)!.hand.forEach((c, i) => (c.role = roles[i]));

  it('信息边界：公开经历和发言随机源相同时，改暗牌和性格，说什么、什么时候说都不变；暗牌里有没有公爵，说「我有公爵」的概率相同', () => {
    const QUANTILES = Array.from({ length: 50 }, (_, i) => (i + 0.5) / 50);
    const sample = (roles: Role[], computerRandom: number) =>
      QUANTILES.map((u) => {
        const { room, events, computerId, claim } = claimTable({ speechRandom: () => u, computerRandom: () => computerRandom });
        setHand(room, computerId, roles);
        claim();
        const at = Date.now();
        let said: [number, unknown] | null = null;
        events.onReaction.mockImplementation((_, r) => (said = [Date.now() - at, r.reaction]));
        vi.advanceTimersByTime(1_500);
        return said;
      });
    const honest = sample(['duke', 'duke'], 0.1);
    const bluffing = sample(['captain', 'contessa'], 0.9);
    expect(bluffing).toEqual(honest);
    expect(honest).toContainEqual([expect.any(Number), { kind: 'verbalClaim', has: true, role: 'duke' }]);
    expect(honest).toContainEqual(null); // 也有沉默的时候
  });

  it('启停发言、真人刷不刷表态，电脑的行动和行动随机源的抽取都不变', () => {
    // 零延迟、1 位真人（只靠默认行动）加 3 个电脑打到 gameOver；洗牌和默认政变的目标也固定下来
    const run = (speechRandom: () => number, spam: boolean) => {
      vi.useFakeTimers();
      vi.clearAllTimers();
      let seed = 7;
      vi.spyOn(Math, 'random').mockImplementation(() => (seed = (seed * 48271) % 2147483647) / 2147483647);
      let draw = 1;
      const draws: number[] = [];
      const computerRandom = () => (draws.push((draw = (draw * 16807) % 2147483647)), draw / 2147483647);
      const { room, events } = makeRoom({ startingPlayerRandom: () => 0, computerRandom, computerDelayMs: () => 0, speechRandom });
      const alice = room.addPlayer('Alice', 'sock1');
      for (let i = 0; i < 3; i += 1) room.addComputer(alice.id, 'sock1');
      room.startGame(alice.id, 'sock1');
      for (let step = 0; step < 5_000 && room.game!.phase !== 'gameOver'; step += 1) {
        vi.advanceTimersToNextTimer();
        if (spam) room.react(alice.id, 'sock1', { kind: 'phrase', phrase: 'doubt' });
      }
      expect(room.game!.phase).toBe('gameOver');
      const computerSpoke = events.onReaction.mock.calls.some(([, r]) => r.playerId !== alice.id);
      // 玩家 id 每间房都是新抽的：换成座位号再比
      const seats = [...room.players.keys()];
      const moves = JSON.stringify(events.onBroadcast.mock.calls.flatMap(([, evs]) => evs)).replace(/"[0-9a-f]{16}"/g, (id) => `seat${seats.indexOf(JSON.parse(id))}`);
      vi.restoreAllMocks(); // 也清掉上面这些 vi.fn 的调用记录，所以先取出来
      return { moves, draws, computerSpoke };
    };
    const talkative = run(() => 0, true);
    const silent = run(() => 0.999_999, false);
    expect(talkative.computerSpoke).toBe(true);
    expect(silent.computerSpoke).toBe(false);
    expect(talkative.moves).toEqual(silent.moves);
    expect(talkative.draws).toEqual(silent.draws);
  });
});
