import { describe, expect, it } from 'vitest';
import { detectLocale, loadLocale, persistLocale, translate, type LocaleStorage } from './localization.ts';

function memoryStorage(initial: Record<string, string> = {}): LocaleStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('locale selection', () => {
  it('selects Simplified Chinese when Chinese is the leading supported browser preference', () => {
    expect(detectLocale(['fr-CA', 'zh-Hant-TW', 'en-US'])).toBe('zh-CN');
  });

  it('falls back to English when browser preferences are unsupported', () => {
    expect(detectLocale(['fr-CA', 'ja-JP'])).toBe('en');
  });

  it('uses a stored explicit choice before browser preferences', () => {
    const storage = memoryStorage({ 'coup.locale': 'en' });

    expect(loadLocale(storage, ['zh-CN'])).toBe('en');
  });

  it('persists a choice for a later visit', () => {
    const storage = memoryStorage();

    persistLocale(storage, 'zh-CN');

    expect(loadLocale(storage, ['en-US'])).toBe('zh-CN');
  });
});

describe('translate', () => {
  it('interpolates typed values into localized copy', () => {
    expect(translate('en', 'playersCount', { count: 3 })).toBe('Players (3)');
    expect(translate('zh-CN', 'playersCount', { count: 3 })).toBe('玩家（3）');
  });
});
