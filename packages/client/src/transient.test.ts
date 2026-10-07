import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleAutoDismiss } from './transient.ts';

describe('transient messages', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps a replacement visible for four seconds without an older timer clearing it', () => {
    vi.useFakeTimers();
    let current: { id: number } | null = { id: 1 };
    const setCurrent = (update: (value: { id: number } | null) => { id: number } | null) => {
      current = update(current);
    };

    scheduleAutoDismiss(current, setCurrent);
    vi.advanceTimersByTime(2000);

    current = { id: 2 };
    scheduleAutoDismiss(current, setCurrent);
    vi.advanceTimersByTime(2000);
    expect(current).toEqual({ id: 2 });

    vi.advanceTimersByTime(2000);
    expect(current).toBeNull();
  });
});
