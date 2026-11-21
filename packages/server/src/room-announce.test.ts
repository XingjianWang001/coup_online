// packages/server/src/room-announce.test.ts — 电脑轮到自己时的行动预告（#76，表 1）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomOptions } from './room.ts';
import { forfeit, type GameEvent } from '@coup/engine';
import type { Reaction } from '@coup/shared';
import type { GameRepository } from './repository.ts';

function makeRoom(options?: RoomOptions) {
  const repo = { save: vi.fn(), delete: vi.fn() } as unknown as GameRepository;
  const events = { onBroadcast: vi.fn(), onEmpty: vi.fn(), onReaction: vi.fn(), onShowdownFocus: vi.fn() };
  const room = new Room('ABC123', '', repo, events, options);
  return { room, repo, events };
}

describe('Room 电脑行动预告', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Alice 先手，其后是 Bob（如有）和 1 个电脑。电脑金币设成 10：轮到它必政变，决定只剩挑目标。
  // 零出手延迟、发言随机源恒为 0（每回合都开口，说真预告，停顿最短 0.8 秒），可覆盖
  function turnTable(options: RoomOptions = {}, withBob = false) {
    vi.useFakeTimers();
    vi.clearAllTimers();
    const made = makeRoom({ startingPlayerRandom: () => 0, computerRandom: () => 0.5, computerDelayMs: () => 0, speechRandom: () => 0, ...options });
    const alice = made.room.addPlayer('Alice', 'sock1');
    const bob = withBob ? made.room.addPlayer('Bob', 'sock2') : undefined;
    made.room.addComputer(alice.id, 'sock1');
    made.room.startGame(alice.id, 'sock1');
    const computerId = made.room.playerList.find((p) => p.isComputer)!.id;
    made.room.game!.players.find((p) => p.id === computerId)!.coins = 10;
    // 真人各收入一次，轮到电脑
    const toComputer = () => {
      made.room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'income' });
      if (bob) made.room.dispatch(bob.id, 'sock2', { type: 'chooseAction', action: 'income' });
      expect(made.room.game!.currentPlayerId).toBe(computerId);
    };
    const announced = () =>
      made.events.onReaction.mock.calls.map(([, r]) => r).filter((r): r is { playerId: string; reaction: Extract<Reaction, { kind: 'announcement' }> } => r.reaction.kind === 'announcement');
    const acted = () =>
      made.events.onBroadcast.mock.calls.flatMap(([, evs]) => evs as GameEvent[]).filter((e): e is Extract<GameEvent, { type: 'actionChosen' }> => e.type === 'actionChosen' && e.actorId === computerId);
    return { ...made, alice, bob, computerId, toComputer, announced, acted };
  }

  it('真预告发出后停顿约 0.8 秒，再执行同一个决定', () => {
    const { room, alice, computerId, toComputer, announced, acted } = turnTable();
    toComputer();
    vi.advanceTimersToNextTimer(); // 电脑作出决定，先预告
    expect(announced()).toEqual([{ playerId: computerId, reaction: { kind: 'announcement', action: 'coup', targetId: alice.id } }]);
    expect(acted()).toEqual([]);
    vi.advanceTimersByTime(799);
    expect(acted()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(acted()).toEqual([expect.objectContaining({ action: 'coup', targetId: alice.id })]);
    expect(room.game!.lossToResolve?.playerId).toBe(alice.id);
  });

  it('不预告时出手时刻与现在相同：到点就执行', () => {
    const { toComputer, announced, acted } = turnTable({ speechRandom: () => 0.999_999, computerDelayMs: () => 2_000 });
    toComputer();
    vi.advanceTimersByTime(2_000);
    expect(announced()).toEqual([]);
    expect(acted()).toHaveLength(1);
  });

  it('嘴跟着手走：不论预告真的、虚晃到另一目标还是不说，执行的都是同一个决定；真预告和虚晃之后都停顿 0.8～1.5 秒', () => {
    const QUANTILES = Array.from({ length: 50 }, (_, i) => (i + 0.5) / 50);
    const runs = QUANTILES.map((u) => {
      const { room, toComputer, announced, acted } = turnTable({ speechRandom: () => u }, true);
      toComputer();
      const start = Date.now();
      vi.advanceTimersToNextTimer();
      const said = announced()[0]?.reaction;
      while (acted().length === 0) vi.advanceTimersToNextTimer();
      const action = acted()[0];
      // 玩家 id 每间房都是新抽的：换成名字再比
      const name = (id?: string) => room.players.get(id!)!.name;
      return { said: said && `${said.action}:${name(said.targetId)}`, did: `${action.action}:${name(action.targetId)}`, pause: Date.now() - start };
    });
    const did = runs[0].did;
    expect(runs.every((r) => r.did === did)).toBe(true);
    const said = runs.map((r) => r.said);
    expect(said).toContain(did); // 真预告
    expect(said).toContain(undefined); // 沉默
    expect(said.some((s) => s && s !== did && s.startsWith('coup:'))).toBe(true); // 虚晃到另一目标
    for (const r of runs) {
      if (!r.said) expect(r.pause).toBe(0);
      else expect(r.pause >= 800 && r.pause <= 1_500).toBe(true);
    }
  });

  it('预告后目标弃权：执行时重新决定，不报错、不卡住', () => {
    const error = vi.spyOn(console, 'error');
    const { room, alice, bob, toComputer, announced, acted } = turnTable({}, true);
    toComputer();
    vi.advanceTimersToNextTimer();
    const target = announced()[0].reaction.targetId!;
    const other = target === alice.id ? bob! : alice;
    room.apply((g) => forfeit(g, target));
    vi.advanceTimersByTime(800);
    expect(acted()).toEqual([expect.objectContaining({ action: 'coup', targetId: other.id })]);
    expect(room.game!.lossToResolve?.playerId).toBe(other.id);
    expect(error).not.toHaveBeenCalled();
  });

  it('房里的真人全被淘汰、电脑 1 秒一步时不预告', () => {
    vi.useFakeTimers();
    const { room, events } = makeRoom({ startingPlayerRandom: () => 0, computerRandom: () => 0.5, speechRandom: () => 0 });
    const alice = room.addPlayer('Alice', 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.startGame(alice.id, 'sock1');
    room.apply((g) => forfeit(g, alice.id));
    const computerId = room.game!.currentPlayerId;
    vi.advanceTimersByTime(1_000);
    expect(events.onBroadcast).toHaveBeenLastCalledWith(room, expect.arrayContaining([expect.objectContaining({ type: 'actionChosen', actorId: computerId })]));
    for (let i = 0; i < 20; i += 1) vi.advanceTimersByTime(1_000);
    expect(events.onReaction.mock.calls.filter(([, r]) => r.reaction.kind === 'announcement')).toEqual([]);
  });

  it('行动时限不因预告延长：停顿跨过 60 秒时限时由超时替电脑出手，留着的决定作废', () => {
    let draw = 0;
    // 说真预告，停顿取最长：约 1.5 秒
    const { room, alice, computerId, toComputer, announced, acted } = turnTable({ computerDelayMs: () => 59_000, speechRandom: () => [0, 0.999][draw++ % 2] });
    room.game!.players.find((p) => p.id === computerId)!.coins = 2; // 不被迫政变：超时替它收入
    toComputer();
    vi.advanceTimersByTime(59_000);
    expect(announced()).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(room.game!.currentPlayerId).toBe(computerId);
    vi.advanceTimersByTime(1);
    expect(acted()).toEqual([expect.objectContaining({ action: 'income' })]);
    expect(room.game!.currentPlayerId).toBe(alice.id);
    vi.advanceTimersByTime(1_000);
    expect(acted()).toHaveLength(1);
  });

  it('牌局作废、牌局结束（之后再来一局）时取消未执行的停顿，不留计时器', () => {
    const voided = turnTable();
    voided.toComputer();
    vi.advanceTimersToNextTimer();
    expect(voided.announced()).toHaveLength(1);
    voided.room.leavePlayer(voided.alice.id, 'sock1');
    expect(vi.getTimerCount()).toBe(1); // 只剩空房回收

    const ended = turnTable();
    ended.toComputer();
    vi.advanceTimersToNextTimer();
    expect(ended.announced()).toHaveLength(1);
    ended.room.apply((g) => forfeit(g, ended.alice.id));
    expect(ended.room.game!.phase).toBe('gameOver');
    ended.room.rematch(ended.alice.id, 'sock1');
    expect(vi.getTimerCount()).toBe(0); // 赛后的表态和揭晓（#77）在再来一局时取消
    vi.advanceTimersByTime(2_000);
    expect(ended.acted()).toEqual([]);
  });

  it('启停预告，行动的随机序列和最终行动都不变', () => {
    // 零延迟、1 位真人（只靠默认行动）加 3 个电脑打到 gameOver；洗牌和默认政变的目标也固定下来
    const run = (speechRandom: () => number) => {
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
      for (let step = 0; step < 5_000 && room.game!.phase !== 'gameOver'; step += 1) vi.advanceTimersToNextTimer();
      expect(room.game!.phase).toBe('gameOver');
      const announcements = events.onReaction.mock.calls.filter(([, r]) => r.reaction.kind === 'announcement').length;
      const seats = [...room.players.keys()];
      const moves = JSON.stringify(events.onBroadcast.mock.calls.flatMap(([, evs]) => evs)).replace(/"[0-9a-f]{16}"/g, (id) => `seat${seats.indexOf(JSON.parse(id))}`);
      vi.restoreAllMocks();
      return { moves, draws, announcements };
    };
    const talkative = run(() => 0);
    const silent = run(() => 0.999_999);
    expect(talkative.announcements).toBeGreaterThan(0);
    expect(silent.announcements).toBe(0);
    expect(talkative.moves).toEqual(silent.moves);
    expect(talkative.draws).toEqual(silent.draws);
  });
});
