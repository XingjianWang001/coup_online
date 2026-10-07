import { describe, expect, it } from 'vitest';
import {
  detectLocale,
  loadLocale,
  localizeNotice,
  localizeCoinCount,
  localizeServerError,
  persistLocale,
  translate,
  type LocaleStorage,
} from './localization.ts';

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

  it('localizes the leave-room notice without exposing a server reason', () => {
    expect(translate('en', 'leftRoomNotice')).toBe('You left the room.');
    expect(translate('zh-CN', 'leftRoomNotice')).toBe('你已离开房间。');
  });

  it('localizes parameterized server errors in the current locale', () => {
    const error = { code: 'roomFull', params: { maximum: 6 } } as const;

    expect(localizeServerError('en', error)).toBe('This room is full (maximum 6 players).');
    expect(localizeServerError('zh-CN', error)).toBe('房间已满（最多 6 名玩家）。');
  });

  it('uses a generic localized message for unknown server error input', () => {
    const unknown = { code: 'futureError', message: 'database password leaked' };

    expect(localizeServerError('en', unknown)).toBe('Something went wrong. Please try again.');
    expect(localizeServerError('zh-CN', unknown)).toBe('出现意外错误，请重试。');
  });

  it('formats a stable transient-notice descriptor in the current locale', () => {
    const notice = { key: 'challengeSucceeded' } as const;

    expect(localizeNotice('en', notice)).toBe('Challenge succeeded');
    expect(localizeNotice('zh-CN', notice)).toBe('质疑成功');
    expect(notice).toEqual({ key: 'challengeSucceeded' });
  });

  it('uses grammatical singular and plural coin displays', () => {
    expect(localizeCoinCount('en', 1)).toBe('1 coin');
    expect(localizeCoinCount('en', 2)).toBe('2 coins');
    expect(localizeCoinCount('zh-CN', 1)).toBe('1 金币');
  });
});
