/// <reference types="vite/client" />
import type { LocaleStorage } from './localization.ts';

// 牌面风格只换大牌的画风；某角色没有该风格的画时，style.css 里没有对应规则，自然回退到默认。
export const CARD_STYLES = ['default', 'totem'] as const;
export type CardStyle = (typeof CARD_STYLES)[number];

const STYLE_KEY = 'coup.cardStyle';

// 大牌的画由 style.css 按需请求，要等第一次亮牌才开始下载；选中图腾时先把五张画拉进缓存。
// 画放在 src/ 下由 Vite 打进带哈希的 assets/，服务端对 assets/ 长期缓存，再次访问不用重下。
const TOTEM_ART = Object.values(import.meta.glob<string>('./card-styles/totem/*.webp', { eager: true, query: '?url', import: 'default' }));

export function preloadCardStyle(style: CardStyle): void {
  if (style === 'totem') for (const src of TOTEM_ART) new Image().src = src;
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
