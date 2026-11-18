// packages/server/src/speech-stagger.test.ts —— 电脑表态的全桌错峰与降温（#74）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseAction, passChallenge } from '@coup/engine';
import { Room, type RoomOptions } from './room.ts';
import type { GameRepository } from './repository.ts';

function makeRoom(options?: RoomOptions) {
  const repo = { save: vi.fn(), delete: vi.fn() } as unknown as GameRepository;
  const events = { onBroadcast: vi.fn(), onEmpty: vi.fn(), onReaction: vi.fn() };
  const room = new Room('ABC123', '', repo, events, options);
  return { room, repo, events };
}

describe('Room 电脑表态错峰', () => {
  afterEach(() => vi.useRealTimers());

  // Alice 先手，其后两个电脑 c1、c2。电脑出手的延迟拉到很长，测试替它们走（直接调引擎）；发言随机源默认恒为 0：
  // 每次声称都开口，在声称后 0.5 秒，顺延不加抖动
  function twoComputers(options: RoomOptions = {}) {
    vi.useFakeTimers();
    vi.clearAllTimers();
    const made = makeRoom({ startingPlayerRandom: () => 0, speechRandom: () => 0, computerDelayMs: () => 600_000, ...options });
    const { room } = made;
    const alice = room.addPlayer('Alice', 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.addComputer(alice.id, 'sock1');
    room.startGame(alice.id, 'sock1');
    const [c1, c2] = room.playerList.filter((p) => p.isComputer).map((p) => p.id);
    const income = (id: string) => (id === alice.id ? room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'income' }) : room.apply((g) => chooseAction(g, id, 'income')));
    const tax = (id: string) => room.apply((g) => chooseAction(g, id, 'tax'));
    // 声称没人质疑：除声称者外都放弃
    const allow = (claimant: string) => {
      for (const id of [alice.id, c1, c2].filter((id) => id !== claimant)) {
        if (id === alice.id) room.dispatch(alice.id, 'sock1', { type: 'passChallenge' });
        else room.apply((g) => passChallenge(g, id));
      }
    };
    // 每条电脑表态发出的时刻
    const sentAt: number[] = [];
    made.events.onReaction.mockImplementation(() => sentAt.push(Date.now()));
    return { ...made, alice, c1, c2, income, tax, allow, sentAt };
  }

  it('两个电脑的表态撞在一起时，后一条顺延到离前一条至少 0.8 秒', () => {
    const { alice, c1, c2, income, tax, allow, sentAt } = twoComputers();
    const start = Date.now();
    income(alice.id);
    tax(c1); // c1 的表态在 0.5 秒
    vi.advanceTimersByTime(500);
    allow(c1);
    tax(c2); // c2 的表态原定在 1.0 秒，离 c1 只有 0.5 秒
    vi.advanceTimersByTime(2_000);
    expect(sentAt.map((t) => t - start)).toEqual([500, 1_300]);
  });
});
