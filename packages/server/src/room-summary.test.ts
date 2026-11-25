// 牌局摘要（#113、ADR 0015）：每局开局后留下一条，打完或中途结束时交给 onGameSummary
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { forfeit } from '@coup/engine';
import { Room } from './room.ts';
import type { GameRepository } from './repository.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-24T08:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

// Alice 和两位电脑（一普通一强）开一局，一分钟后的事交给 end
function playOneGame() {
  const repo = { save: vi.fn(), delete: vi.fn() } as unknown as GameRepository;
  const events = { onBroadcast: vi.fn(), onEmpty: vi.fn(), onReaction: vi.fn(), onShowdownFocus: vi.fn(), onGameSummary: vi.fn() };
  const room = new Room('ABC123', '', repo, events, { computerDelayMs: () => 600_000 });
  const alice = room.addPlayer('Alice', 'sock1');
  room.addComputer(alice.id, 'sock1');
  room.addComputer(alice.id, 'sock1');
  const [weak, strong] = room.playerList.filter((p) => p.isComputer).map((p) => p.id);
  room.setComputerStrength(alice.id, 'sock1', strong, 'strong');
  room.startGame(alice.id, 'sock1');
  vi.setSystemTime(new Date('2026-11-24T08:01:00.000Z'));
  return { room, events, alice, weak, strong };
}

const base = { startedAt: '2026-11-24T08:00:00.000Z', endedAt: '2026-11-24T08:01:00.000Z', humans: 1, computers: ['standard', 'strong'] };

it('打完一局写一条带获胜者类型的摘要，之后的赛后变化和回收不再写', () => {
  const { room, events, alice, weak, strong } = playOneGame();
  room.apply((g) => forfeit(g, weak));
  room.apply((g) => forfeit(g, strong));
  expect(events.onGameSummary.mock.calls).toEqual([[{ ...base, endedEarly: false, winner: 'human' }]]);
  room.leavePlayer(alice.id, 'sock1');
  vi.advanceTimersByTime(5 * 60_000);
  expect(events.onEmpty).toHaveBeenCalled();
  expect(events.onGameSummary).toHaveBeenCalledTimes(1);
});

it('电脑赢了记为电脑获胜', () => {
  const { room, events, alice, weak } = playOneGame();
  room.apply((g) => forfeit(g, weak));
  room.apply((g) => forfeit(g, alice.id));
  expect(events.onGameSummary.mock.calls).toEqual([[{ ...base, endedEarly: false, winner: 'computer' }]]);
});

it('真人都出局后再来一局，写一条中途结束、没有获胜者的摘要', () => {
  const { room, events, alice } = playOneGame();
  room.apply((g) => forfeit(g, alice.id));
  room.rematch(alice.id, 'sock1');
  expect(events.onGameSummary.mock.calls).toEqual([[{ ...base, endedEarly: true, winner: null }]]);
});

it('牌局中最后一位真人离开，牌局作废，写一条中途结束的摘要', () => {
  const { room, events, alice } = playOneGame();
  room.leavePlayer(alice.id, 'sock1');
  expect(events.onGameSummary.mock.calls).toEqual([[{ ...base, endedEarly: true, winner: null }]]);
  vi.advanceTimersByTime(5 * 60_000);
  expect(events.onGameSummary).toHaveBeenCalledTimes(1);
});
