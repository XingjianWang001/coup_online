// packages/server/src/room-probe.test.ts
// 表 3（#75）：别人作出声称后，电脑在问询窗口前段的试探
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomOptions } from './room.ts';
import { passChallenge, type Role } from '@coup/engine';
import type { GameRepository } from './repository.ts';

function makeRoom(options?: RoomOptions) {
  const repo = { save: vi.fn(), delete: vi.fn() } as unknown as GameRepository;
  const events = { onBroadcast: vi.fn(), onEmpty: vi.fn(), onReaction: vi.fn() };
  const room = new Room('ABC123', '', repo, events, options);
  return { room, repo, events };
}

describe('Room 电脑试探', () => {
  afterEach(() => vi.useRealTimers());

  // Alice 先手声称公爵征税；之后坐着电脑，withBob 时再加真人 Bob（让电脑放弃后窗口还开着）
  function probeTable(options: RoomOptions = {}, withBob = false) {
    vi.useFakeTimers();
    vi.clearAllTimers();
    const made = makeRoom({ startingPlayerRandom: () => 0, speechRandom: () => 0, ...options });
    const alice = made.room.addPlayer('Alice', 'sock1');
    made.room.addComputer(alice.id, 'sock1');
    const bob = withBob ? made.room.addPlayer('Bob', 'sock2') : null;
    made.room.startGame(alice.id, 'sock1');
    const computerId = made.room.playerList.find((p) => p.isComputer)!.id;
    const tax = () => made.room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'tax' });
    return { ...made, alice, bob, computerId, tax };
  }
  const spoken = (events: ReturnType<typeof makeRoom>['events'], id: string) =>
    events.onReaction.mock.calls.filter(([, r]) => r.playerId === id).map(([, r]) => r.reaction);
  // 电脑不在窗口里出手，只看它说不说
  const HOLD = { computerDelayMs: () => 15_000 };

  it('别人作出声称后，有资格质疑的电脑在窗口前段试探一句', () => {
    const { events, computerId, tax } = probeTable(HOLD, true);
    tax();
    vi.advanceTimersByTime(1_400);
    expect(spoken(events, computerId)).toEqual([{ kind: 'phrase', phrase: 'sure' }]);
  });

  it.each<[string, (t: ReturnType<typeof probeTable>) => void]>([
    ['自己已放弃', (t) => t.room.apply((g) => passChallenge(g, t.computerId))],
    ['别人已发起质疑', (t) => t.room.dispatch(t.bob!.id, 'sock2', { type: 'challenge' })],
    [
      '窗口已结束',
      (t) => {
        t.room.dispatch(t.bob!.id, 'sock2', { type: 'passChallenge' });
        t.room.apply((g) => passChallenge(g, t.computerId));
      },
    ],
  ])('发送时%s则取消', (_, interrupt) => {
    const t = probeTable(HOLD, true);
    t.tax();
    interrupt(t);
    vi.advanceTimersByTime(1_400);
    expect(spoken(t.events, t.computerId)).toEqual([]);
  });

  // 一个电脑对着 Alice 的征税：记下它说没说、质疑还是放弃、什么时候出手，以及窗口的时限
  function respond(computerRandom: number, speechRandom: number) {
    const { room, events, computerId, tax } = probeTable({ computerRandom: () => computerRandom, speechRandom: () => speechRandom });
    const log: string[] = [];
    let movedAt = 0;
    // 只记出手之前的：放弃之后轮到电脑，它会为自己的回合另说话
    events.onReaction.mockImplementation((_, r) => r.playerId === computerId && !movedAt && log.push('spoke'));
    tax();
    const start = Date.now();
    const deadline = room.getDeadlineAt();
    events.onBroadcast.mockImplementation((_, evs: { type: string }[]) => {
      if (movedAt) return;
      movedAt = Date.now() - start;
      log.push(evs.some((e) => e.type === 'challenged') ? 'challenge' : 'pass');
    });
    vi.advanceTimersByTime(6_000);
    return { log: log.join(' then '), movedAt, deadline: deadline! - start, challenged: log.includes('challenge') };
  }
  const QUANTILES = [0, ...Array.from({ length: 20 }, (_, i) => (i + 0.5) / 20)];

  it('表态或沉默 × 质疑或放弃四种组合都会出现；有无试探，质疑与否、出手时刻、窗口时限都相同', () => {
    const combos = new Set<string>();
    for (const u of QUANTILES) {
      const talk = respond(u, 0);
      const quiet = respond(u, 0.999);
      combos.add(talk.log).add(quiet.log);
      expect(talk.challenged).toBe(quiet.challenged);
      expect(talk.movedAt).toBe(quiet.movedAt);
      expect(talk.deadline).toBe(quiet.deadline);
    }
    expect([...combos].sort()).toEqual(['challenge', 'pass', 'spoke then challenge', 'spoke then pass']);
  });

  it('信息边界：发言随机源相同时，改电脑的暗牌和性格，试探的选择和时刻都不变', () => {
    const sample = (roles: Role[], computerRandom: number) =>
      QUANTILES.map((u) => {
        const { room, events, computerId, tax } = probeTable({ ...HOLD, speechRandom: () => u, computerRandom: () => computerRandom }, true);
        room.game!.players.find((p) => p.id === computerId)!.hand.forEach((c, i) => (c.role = roles[i]));
        tax();
        const start = Date.now();
        let said: [number, unknown] | null = null;
        events.onReaction.mockImplementation((_, r) => (said = [Date.now() - start, r.reaction]));
        vi.advanceTimersByTime(1_400);
        return said;
      });
    const holdsDuke = sample(['duke', 'duke'], 0.1);
    const lacksDuke = sample(['captain', 'contessa'], 0.9);
    expect(lacksDuke).toEqual(holdsDuke);
    expect(holdsDuke).toContainEqual([expect.any(Number), { kind: 'phrase', phrase: 'sure' }]);
    expect(holdsDuke).toContainEqual(null);
  });
});
