import type { LocaleStorage } from './localization.ts';

// 牌面风格只换大牌的画风；某角色没有该风格的画时，style.css 里没有对应规则，自然回退到默认。
export const CARD_STYLES = ['default', 'totem'] as const;
export type CardStyle = (typeof CARD_STYLES)[number];

const STYLE_KEY = 'coup.cardStyle';

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
