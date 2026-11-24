import type { LocaleStorage } from './localization.ts';

// 牌面风格只换大牌的画风；某角色没有该风格的画时，style.css 里没有对应规则，自然回退到默认。
export const CARD_STYLES = ['default', 'totem'] as const;
export type CardStyle = (typeof CARD_STYLES)[number];

const STYLE_KEY = 'coup.cardStyle';

// 同一个应用也挂在 coup.davidxjwang.com 上；牌面风格切换只在这些主机上开放，其他域名的玩家永远看不到。
const CARD_STYLE_HOSTS = ['coup.surwhy.com', 'localhost', '127.0.0.1'];

export const cardStylesAvailable = (hostname: string): boolean => CARD_STYLE_HOSTS.includes(hostname);

export function loadCardStyle(storage: LocaleStorage | null): CardStyle {
  try {
    return storage?.getItem(STYLE_KEY) === 'totem' ? 'totem' : 'default';
  } catch {
    return 'default';
  }
}

export function persistCardStyle(storage: LocaleStorage | null, style: CardStyle): void {
  try {
    storage?.setItem(STYLE_KEY, style);
  } catch {
    // 存不进就只在这个页面生效
  }
}
