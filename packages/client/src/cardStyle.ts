import type { LocaleStorage } from './localization.ts';

// 牌面风格只换大牌的画风；某角色没有该风格的画时，style.css 里没有对应规则，自然回退到默认。
export const CARD_STYLES = ['default', 'totem'] as const;
export type CardStyle = (typeof CARD_STYLES)[number];

const DEBUG_KEY = 'coup.debug';
const STYLE_KEY = 'coup.cardStyle';

// 调试开关：网址带 ?debug=1 打开、?debug=0 关闭，记在本浏览器；不带参数时沿用上次。存储被禁用时只看这次的网址。
export function loadDebug(storage: LocaleStorage | null, search: string): boolean {
  const flag = new URLSearchParams(search).get('debug');
  try {
    if (flag === '1' || flag === '0') storage?.setItem(DEBUG_KEY, flag);
    return (flag ?? storage?.getItem(DEBUG_KEY)) === '1';
  } catch {
    return flag === '1';
  }
}

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
