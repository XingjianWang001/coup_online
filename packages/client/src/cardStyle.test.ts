import { describe, expect, it } from 'vitest';
import { loadCardStyle, loadDebug, persistCardStyle } from './cardStyle.ts';
import type { LocaleStorage } from './localization.ts';

function memoryStorage(): LocaleStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

describe('debug switch and card style', () => {
  it('turns on with ?debug=1, stays on without the parameter, and turns off with ?debug=0', () => {
    const storage = memoryStorage();
    expect(loadDebug(storage, '')).toBe(false);
    expect(loadDebug(storage, '?debug=1')).toBe(true);
    expect(loadDebug(storage, '?room=ABCD')).toBe(true);
    expect(loadDebug(storage, '?debug=0')).toBe(false);
    expect(loadDebug(storage, '')).toBe(false);
  });

  it('still honours the URL when storage is denied', () => {
    const denied: LocaleStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadDebug(denied, '?debug=1')).toBe(true);
    expect(loadDebug(denied, '')).toBe(false);
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
