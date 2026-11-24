import { describe, expect, it } from 'vitest';
import { cardStylesAvailable, loadCardStyle, persistCardStyle } from './cardStyle.ts';
import type { LocaleStorage } from './localization.ts';

function memoryStorage(): LocaleStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

describe('card style', () => {
  it('is offered on surwhy and local hosts only', () => {
    expect(cardStylesAvailable('coup.surwhy.com')).toBe(true);
    expect(cardStylesAvailable('localhost')).toBe(true);
    expect(cardStylesAvailable('coup.davidxjwang.com')).toBe(false);
  });

  it('falls back to the default style when storage is denied', () => {
    const denied: LocaleStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadCardStyle(denied)).toBe('default');
  });

  it('remembers the chosen card style and ignores unknown values', () => {
    const storage = memoryStorage();
    expect(loadCardStyle(storage)).toBe('default');
    persistCardStyle(storage, 'totem');
    expect(loadCardStyle(storage)).toBe('totem');
    storage.setItem('coup.cardStyle', 'neon');
    expect(loadCardStyle(storage)).toBe('default');
  });
});
