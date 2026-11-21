import { describe, expect, it } from 'vitest';
import { loadCardStyle, loadDebug, persistCardStyle } from './cardStyle.ts';
import type { LocaleStorage } from './localization.ts';

const SURWHY = 'coup.surwhy.com';

function memoryStorage(): LocaleStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

describe('debug switch and card style', () => {
  it('turns on with ?debug=1, stays on without the parameter, and turns off with ?debug=0', () => {
    const storage = memoryStorage();
    expect(loadDebug(storage, '', SURWHY)).toBe(false);
    expect(loadDebug(storage, '?debug=1', SURWHY)).toBe(true);
    expect(loadDebug(storage, '?room=ABCD', SURWHY)).toBe(true);
    expect(loadDebug(storage, '?debug=0', SURWHY)).toBe(false);
    expect(loadDebug(storage, '', SURWHY)).toBe(false);
  });

  it('stays off on other domains of the same app even with ?debug=1', () => {
    const storage = memoryStorage();
    expect(loadDebug(storage, '?debug=1', 'coup.davidxjwang.com')).toBe(false);
    expect(loadDebug(storage, '', 'coup.davidxjwang.com')).toBe(false);
  });

  it('still honours the URL when storage is denied', () => {
    const denied: LocaleStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadDebug(denied, '?debug=1', SURWHY)).toBe(true);
    expect(loadDebug(denied, '', SURWHY)).toBe(false);
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
