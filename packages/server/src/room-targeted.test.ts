// packages/server/src/room-targeted.test.ts
// 表 4（#79）：电脑成为偷窃、暗杀、政变的目标时的表态
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomOptions } from './room.ts';
import { passChallenge, type GameEvent, type Role } from '@coup/engine';
import type { GameRepository } from './repository.ts';

function makeRoom(options?: RoomOptions) {
  const repo = { save: vi.fn(), delete: vi.fn() } as unknown as GameRepository;
  const events = { onBroadcast: vi.fn(), onEmpty: vi.fn(), onReaction: vi.fn(), onShowdownFocus: vi.fn() };
  const room = new Room('ABC123', '', repo, events, options);
  return { room, repo, events };
}

describe('Room 电脑成为目标时的表态', () => {
  afterEach(() => vi.useRealTimers());

  // Alice 先手，对面坐一个电脑
  function targetTable(options: RoomOptions = {}) {
    vi.useFakeTimers();
    vi.clearAllTimers();
    const made = makeRoom({ startingPlayerRandom: () => 0, speechRandom: () => 0, ...options });
    const alice = made.room.addPlayer('Alice', 'sock1');
    made.room.addComputer(alice.id, 'sock1');
    made.room.startGame(alice.id, 'sock1');
    const computerId = made.room.playerList.find((p) => p.isComputer)!.id;
    const act = (action: 'steal' | 'assassinate' | 'coup') => {
      made.room.game!.players.find((p) => p.id === alice.id)!.coins = 7;
      made.room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action, targetId: computerId });
    };
    return { ...made, alice, computerId, act };
  }
  const spoken = (events: ReturnType<typeof makeRoom>['events'], id: string) =>
    events.onReaction.mock.calls.filter(([, r]) => r.playerId === id).map(([, r]) => r.reaction);
  // 电脑不在窗口里出手，只看它说不说
  const HOLD = { computerDelayMs: () => 15_000 };

  it.each<['steal' | 'assassinate', string]>([
    ['steal', 'mercy'],
    ['assassinate', 'sure'],
  ])('被%s时在问询窗口前段表态', (action, phrase) => {
    const { events, computerId, act } = targetTable(HOLD);
    act(action);
    vi.advanceTimersByTime(1_400);
    expect(spoken(events, computerId)).toEqual([{ kind: 'phrase', phrase }]);
  });

  it('被政变后、选丢哪张之前表态', () => {
    const { events, computerId, act, room } = targetTable(HOLD);
    room.game!.players.find((p) => p.id === computerId)!.coins = 7;
    act('coup');
    vi.advanceTimersByTime(1_400);
    expect(spoken(events, computerId)).toEqual([{ kind: 'announcement', action: 'coup', targetId: expect.any(String) }]);
  });

  it('自己已回应则取消', () => {
    const { events, computerId, act, room } = targetTable(HOLD);
    act('steal');
    room.apply((g) => passChallenge(g, computerId));
    vi.advanceTimersByTime(1_400);
    expect(spoken(events, computerId)).toEqual([]);
  });

  // 电脑在被偷后的质疑窗口和阻挡窗口里怎么回应、什么时候回应：到轮到下一位为止
  function respond(computerRandom: number, speechRandom: number, roles: Role[]) {
    const { events, computerId, act, room } = targetTable({ computerRandom: () => computerRandom, speechRandom: () => speechRandom });
    room.game!.players.forEach((p) => p.hand.forEach((c, i) => (c.role = p.id === computerId ? roles[i] : 'duke'))); // 发牌是随机的，这里定下来
    act('steal');
    const start = Date.now();
    const moves: [number, string][] = [];
    let done = false;
    events.onBroadcast.mockImplementation((_, evs: GameEvent[]) => {
      if (done) return;
      for (const e of evs) moves.push([Date.now() - start, e.type]);
      // 质疑、阻挡之后轮到 Alice 回应，生效之后轮到电脑自己（它会为自己的回合另说话）：都到此为止
      done = evs.some((e) => ['turnChanged', 'challenged', 'blocked', 'gameOver'].includes(e.type));
    });
    vi.advanceTimersByTime(20_000);
    // 被偷时没声称过：表 4 的第一候选是手下留情
    const first = spoken(events, computerId)[0];
    return { moves, spoke: first?.kind === 'phrase' && first.phrase === 'mercy' };
  }

  it('有无表态，电脑之后的质疑、阻挡和出手时刻都相同', () => {
    let spoke = 0;
    const outcomes = new Set<string>();
    for (const roles of [['captain', 'duke'], ['contessa', 'assassin']] as Role[][]) {
      for (const u of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
        const talk = respond(u, 0, roles);
        const quiet = respond(u, 0.999_999, roles);
        expect(quiet.spoke).toBe(false);
        spoke += talk.spoke ? 1 : 0;
        expect(talk.moves).toEqual(quiet.moves);
        expect(talk.moves.length).toBeGreaterThan(0);
        outcomes.add(talk.moves.at(-1)![1]);
      }
    }
    expect(spoke).toBe(14);
    expect(outcomes.size).toBeGreaterThan(1); // 既有阻挡或质疑，也有照常生效
  });
});
