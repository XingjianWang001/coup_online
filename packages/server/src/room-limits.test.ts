import { afterEach, expect, it, vi } from 'vitest';
import { reserveRoomCreation } from './room-limits.ts';

afterEach(() => vi.useRealTimers());

it('caps active rooms and five creations per address per minute, then resets the window', () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);

  expect(() => reserveRoomCreation('busy', 100)).toThrow('serverBusy');
  for (let i = 0; i < 5; i += 1) reserveRoomCreation('guest', i);
  expect(() => reserveRoomCreation('guest', 5)).toThrow('rateLimited');
  reserveRoomCreation('another guest', 5);

  vi.setSystemTime(60_000);
  expect(() => reserveRoomCreation('guest', 5)).not.toThrow();
});
