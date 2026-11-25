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
    expect(translate('en', 'playersCount', { count: 3, maximum: 6 })).toBe('Players 3/6');
    expect(translate('zh-CN', 'playersCount', { count: 3, maximum: 6 })).toBe('玩家 3/6');
  });

  it('localizes the leave-room notice without exposing a server reason', () => {
    expect(translate('en', 'leftRoomNotice')).toBe('You left the room.');
    expect(translate('zh-CN', 'leftRoomNotice')).toBe('你已离开房间。');
  });

  it('localizes parameterized server errors in the current locale', () => {
    const error = { code: 'minimumPlayers', params: { minimum: 2 } } as const;

    expect(localizeServerError('en', error)).toBe('At least 2 players are required to start.');
    expect(localizeServerError('zh-CN', error)).toBe('至少需要 2 名玩家才能开始。');
    // 房间已满不再报上限：进不来的人用不上这个数，房间里的人看名单的 n/6
    expect(localizeServerError('zh-CN', { code: 'roomFull', params: { maximum: 6 } })).toBe('房间已满。');
  });

  it('uses a generic localized message for unknown server error input', () => {
    const unknown = { code: 'futureError', message: 'database password leaked' };

    expect(localizeServerError('en', unknown)).toBe('Something went wrong. Please try again.');
    expect(localizeServerError('zh-CN', unknown)).toBe('发生错误，请重试。');
  });

  it('formats a stable transient-notice descriptor in the current locale', () => {
    const notice = { key: 'challengeSucceeded' } as const;

    expect(localizeNotice('en', notice, undefined, () => '')).toBe('Challenge succeeded');
    expect(localizeNotice('zh-CN', notice, undefined, () => '')).toBe('质疑成功');
    expect(notice).toEqual({ key: 'challengeSucceeded' });
  });

  it('names the player in influence notices and says you for yourself', () => {
    const names = (id: string) => (id === 'p1' ? 'Van' : 'Me');
    expect(localizeNotice('zh-CN', { key: 'influenceLostNotice', playerId: 'p1' }, 'p2', names)).toBe('Van 失去影响力');
    expect(localizeNotice('zh-CN', { key: 'playerEliminated', playerId: 'p1' }, 'p2', names)).toBe('Van 被淘汰');
    expect(localizeNotice('en', { key: 'playerEliminated', playerId: 'p2' }, 'p2', names)).toBe('You were eliminated');
    expect(localizeNotice('en', { key: 'influenceLostNotice', playerId: 'p2' }, 'p2', names)).toBe('You lost influence');
  });

  it('names computer players and the host controls for them in both locales', () => {
    expect(translate('en', 'computerPlayer')).toBe('Computer player');
    expect(translate('zh-CN', 'computerPlayer')).toBe('电脑玩家');
    expect(translate('en', 'addComputer')).toBe('Add computer player');
    expect(translate('zh-CN', 'addComputer')).toBe('添加电脑玩家');
    expect(translate('en', 'removeComputer', { name: 'Ada' })).toBe('Remove Ada');
    expect(translate('zh-CN', 'removeComputer', { name: 'Ada' })).toBe('移除 Ada');
    expect(translate('en', 'computerStrength', { name: 'Ada' })).toBe('Strength of Ada');
    expect(translate('zh-CN', 'computerStrength', { name: 'Ada' })).toBe('Ada 的强度');
  });

  it('uses grammatical singular and plural coin displays', () => {
    expect(localizeCoinCount('en', 1)).toBe('1 coin');
    expect(localizeCoinCount('en', 2)).toBe('2 coins');
    expect(localizeCoinCount('zh-CN', 1)).toBe('1 金币');
  });
});
