import type { ReactNode } from 'react';
import type { Role, Strength } from '@coup/shared';
import { roleName } from './rules.ts';
import { translate, type Locale } from './localization.ts';

// 角色图标：24 格几何，.f 为实心块，.d 为镂空细节（见 Glyph）
const ROLE_GLYPHS: Record<Role, ReactNode> = {
  // 权杖
  duke: (
    <>
      <path className="f" d="M12 1 L13.4 3.2 L12 5.4 L10.6 3.2 Z" />
      <circle className="f" cx="12" cy="7.6" r="2.3" />
      <line x1="8.6" y1="11" x2="15.4" y2="11" />
      <line x1="12" y1="11" x2="12" y2="21" />
      <line x1="10.4" y1="15.5" x2="13.6" y2="15.5" />
      <line x1="10.6" y1="21.4" x2="13.4" y2="21.4" />
    </>
  ),
  // 匕首
  assassin: (
    <g transform="rotate(45 12 12)">
      <path className="f" d="M12 1.5 L14 5 V14 H10 V5 Z" />
      <line className="d" x1="12" y1="5" x2="12" y2="12.5" />
      <line x1="7.5" y1="14.5" x2="16.5" y2="14.5" />
      <line x1="12" y1="15" x2="12" y2="19.5" />
      <circle className="f" cx="12" cy="21" r="1.5" />
    </g>
  ),
  // 船锚
  captain: (
    <>
      <circle cx="12" cy="4.3" r="2" />
      <line x1="12" y1="6.3" x2="12" y2="21" />
      <line x1="8" y1="9.5" x2="16" y2="9.5" />
      <path d="M4 14 Q4.5 21 12 21 Q19.5 21 20 14" />
      <path d="M2.5 16 L4 13 L6.5 15" />
      <path d="M21.5 16 L20 13 L17.5 15" />
    </>
  ),
  // 卷轴
  ambassador: (
    <>
      <rect className="f" x="5.5" y="6.5" width="13" height="11" />
      <rect className="f" x="2.5" y="4.5" width="3.5" height="15" rx="1.75" />
      <rect className="f" x="18" y="4.5" width="3.5" height="15" rx="1.75" />
      <line className="d" x1="8.5" y1="9.5" x2="15.5" y2="9.5" />
      <line className="d" x1="8.5" y1="12" x2="15.5" y2="12" />
      <line className="d" x1="8.5" y1="14.5" x2="13" y2="14.5" />
    </>
  ),
  // 折扇
  contessa: (
    <g transform="translate(0 -2.5)">
      <path className="f" d="M12 20 L3.5 11.5 A12 12 0 0 1 20.5 11.5 Z" />
      <line className="d" x1="12" y1="20" x2="7.4" y2="8.9" />
      <line className="d" x1="12" y1="20" x2="12" y2="8" />
      <line className="d" x1="12" y1="20" x2="16.6" y2="8.9" />
      <path className="d" d="M8.5 16.5 A5 5 0 0 1 15.5 16.5" />
      <circle className="f" cx="12" cy="20" r="1.2" />
    </g>
  ),
};

export function Glyph({ children, size, className = '' }: { children: ReactNode; size?: number; className?: string }) {
  return (
    <svg className={`glyph ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

export function RoleIcon({ role }: { role: Role }) {
  return <Glyph>{ROLE_GLYPHS[role]}</Glyph>;
}

export function BigCard({ role, locale, className = '' }: { role: Role; locale: Locale; className?: string }) {
  return (
    <span className={`big-card card--${role} ${className}`}>
      <Glyph className="pip tl">{ROLE_GLYPHS[role]}</Glyph>
      <span className="medallion"><Glyph>{ROLE_GLYPHS[role]}</Glyph></span>
      <span className="big-card-name">{roleName(locale, role)}</span>
      <Glyph className="pip br">{ROLE_GLYPHS[role]}</Glyph>
    </span>
  );
}

// 沙漏
export function HourglassIcon() {
  return (
    <Glyph size={16} className="inline-icon">
      <line x1="6" y1="2.5" x2="18" y2="2.5" />
      <line x1="6" y1="21.5" x2="18" y2="21.5" />
      <path className="f" d="M7.5 3 H16.5 Q16.5 8.5 12 12 Q7.5 8.5 7.5 3 Z" />
      <path d="M12 12 Q16.5 15.5 16.5 21 H7.5 Q7.5 15.5 12 12 Z" />
    </Glyph>
  );
}

// 银元
export function CoinIcon() {
  return (
    <Glyph size={16} className="inline-icon">
      <circle className="f" cx="12" cy="12" r="9.5" />
      <circle className="d" cx="12" cy="12" r="6.2" />
    </Glyph>
  );
}

// 电脑玩家的徽标：两档同一个图形，进阶电脑只换成淡金色；可访问名称随语言
export function ComputerBadge({ strength, locale }: { strength: Strength; locale: Locale }) {
  const label = translate(locale, strength === 'strong' ? 'strongComputerPlayer' : 'computerPlayer');
  return (
    <span className={`computer-badge${strength === 'strong' ? ' advanced' : ''}`} role="img" aria-label={label} title={label}>
      <Glyph size={16} className="inline-icon">
        <line x1="12" y1="2.5" x2="12" y2="6" />
        <rect x="4" y="6" width="16" height="13" rx="3" />
        <circle className="f" cx="9" cy="12" r="1.6" />
        <circle className="f" cx="15" cy="12" r="1.6" />
        <line x1="9" y1="16" x2="15" y2="16" />
      </Glyph>{' '}
    </span>
  );
}

// 离线：三道信号弧被一道斜线划断；可访问名称随语言
export function OfflineBadge({ locale }: { locale: Locale }) {
  const label = translate(locale, 'offline');
  return (
    <span className="offline-badge" role="img" aria-label={label} title={label}>
      <Glyph size={16} className="inline-icon">
        <path d="M2.5 9.5a14 14 0 0 1 19 0" />
        <path d="M6 13a9 9 0 0 1 12 0" />
        <path d="M9.4 16.5a4 4 0 0 1 5.2 0" />
        <circle className="f" cx="12" cy="20" r="1.4" />
        <line x1="4" y1="3" x2="20" y2="21" />
      </Glyph>
    </span>
  );
}

// 添加电脑玩家：缩小的普通徽标，右下角一个＋，两者不相交
export function AddComputerIcon() {
  return (
    <Glyph size={22} className="robot-glyph">
      <line x1="8.5" y1="3" x2="8.5" y2="6" />
      <rect x="2" y="6" width="13" height="11" rx="2.6" />
      <circle className="f" cx="6.2" cy="11" r="1.3" />
      <circle className="f" cx="10.8" cy="11" r="1.3" />
      <line x1="6.5" y1="14.2" x2="10.5" y2="14.2" />
      <line x1="19.5" y1="16" x2="19.5" y2="23" />
      <line x1="16" y1="19.5" x2="23" y2="19.5" />
    </Glyph>
  );
}

// 皇冠：下移 1.5 使视觉居中
export function CrownIcon() {
  return (
    <Glyph size={22} className="inline-icon">
      <g transform="translate(0 1.5)">
        <path className="f" d="M4.5 18.5 L3 8 L8.5 12 L12 5 L15.5 12 L21 8 L19.5 18.5 Z" />
        <circle className="f" cx="3" cy="7" r="1.6" />
        <circle className="f" cx="12" cy="4" r="1.6" />
        <circle className="f" cx="21" cy="7" r="1.6" />
        <line className="d" x1="6.5" y1="15.5" x2="17.5" y2="15.5" />
      </g>
    </Glyph>
  );
}
