/// <reference types="vite/client" />
// PROTOTYPE, throwaway: three treatments of role icons on card faces, switchable via ?variant=A|B|C.
// Run: pnpm proto:role-icons  (opens /prototype-role-icons.html). Not included in the app build.
import { useEffect, useState, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import type { Role } from '@coup/shared';
import { ROLES, roleName, roleDescription } from './rules.ts';
import type { Locale } from './localization.ts';
import './style.css';

// 24×24 geometry shared by all variants. .f = closed shape (filled in B), .d = inner detail (cut out in B).
const GLYPHS: Record<Role, ReactNode> = {
  // 权杖：竖直杆 + 宝珠 + 十字
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
  // 匕首：斜置
  assassin: (
    <g transform="rotate(45 12 12)">
      <path className="f" d="M12 1.5 L14 5 V14 H10 V5 Z" />
      <line className="d" x1="12" y1="5" x2="12" y2="12.5" />
      <line x1="7.5" y1="14.5" x2="16.5" y2="14.5" />
      <line x1="12" y1="15" x2="12" y2="19.5" />
      <circle className="f" cx="12" cy="21" r="1.5" />
    </g>
  ),
  // 船锚：对称倒 T
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
  // 卷轴：横向，两端卷筒
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
  // 折扇：扇形 + 扇骨
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

const Glyph = ({ role, className }: { role: Role; className?: string }) => (
  <svg className={`glyph ${className ?? ''}`} viewBox="0 0 24 24" aria-hidden="true">
    {GLYPHS[role]}
  </svg>
);

const VARIANTS = {
  A: '线描居中',
  B: '实心剪影',
  C: '徽章 + 角标',
} as const;
type Variant = keyof typeof VARIANTS;

type Size = 'self' | 'opp' | 'mini';

function Card({ role, size, locale, revealed }: { role: Role; size: Size; locale: Locale; revealed?: boolean }) {
  const name = roleName(locale, role);
  return (
    <div className={`card card--${role} sz-${size}${revealed ? ' unavailable' : ''}`} role="img" aria-label={name} title={name}>
      <Glyph role={role} className="main" />
      <Glyph role={role} className="pip tl" />
      <Glyph role={role} className="pip br" />
    </div>
  );
}

const Back = ({ size }: { size: Size }) => <div className={`card-back sz-${size}`} />;

function Showcase({ locale }: { locale: Locale }) {
  return (
    <>
      <section>
        <h3>你的座位 · 72×102（两张暗牌 + 一张明牌）</h3>
        <div className="cards-row">
          <Card role="duke" size="self" locale={locale} />
          <Card role="contessa" size="self" locale={locale} />
          <Card role="assassin" size="self" locale={locale} revealed />
        </div>
      </section>
      <section>
        <h3>对手座位（桌面）· 58×82</h3>
        <div className="cards-row">
          <Back size="opp" />
          <Card role="captain" size="opp" locale={locale} revealed />
          <span className="gap" />
          <Card role="ambassador" size="opp" locale={locale} revealed />
          <Card role="duke" size="opp" locale={locale} revealed />
        </div>
      </section>
      <section>
        <h3>对手座位（手机）· 40×56</h3>
        <div className="cards-row tight">
          <Back size="mini" />
          {ROLES.map((r) => <Card key={r} role={r} size="mini" locale={locale} revealed />)}
        </div>
      </section>
      <section>
        <h3>五个角色 × 三种尺寸（未翻开状态，用于比较轮廓）</h3>
        {(['self', 'opp', 'mini'] as const).map((s) => (
          <div key={s} className="cards-row tight">
            {ROLES.map((r) => <Card key={r} role={r} size={s} locale={locale} />)}
          </div>
        ))}
      </section>
      <section className="rule-section role-reference">
        <h3>规则中心 · 角色对照</h3>
        <div className="role-reference-list">
          {ROLES.map((role) => (
            <div key={role} className={`role-reference-item proto-ref card--${role}`}>
              <Glyph role={role} className="ref-icon" />
              <div>
                <b>{roleName(locale, role)}</b>
                <p>{roleDescription(locale, role)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function Switcher({ current, onChange }: { current: Variant; onChange: (v: Variant) => void }) {
  const keys = Object.keys(VARIANTS) as Variant[];
  const step = (d: number) => onChange(keys[(keys.indexOf(current) + d + keys.length) % keys.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!import.meta.env.DEV) return null;
  return (
    <div className="proto-switcher">
      <button onClick={() => step(-1)}>←</button>
      <span>{current} ({VARIANTS[current]})</span>
      <button onClick={() => step(1)}>→</button>
    </div>
  );
}

function Prototype() {
  const initial = new URLSearchParams(location.search).get('variant');
  const [variant, setVariant] = useState<Variant>(initial && initial in VARIANTS ? (initial as Variant) : 'A');
  const [locale, setLocale] = useState<Locale>('en');
  const change = (v: Variant) => {
    const url = new URL(location.href);
    url.searchParams.set('variant', v);
    history.replaceState(null, '', url);
    setVariant(v);
  };
  return (
    <main className={`proto v-${variant}`}>
      <header>
        <h2>角色图标原型 · {variant}：{VARIANTS[variant]}</h2>
        <button onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}>语言：{locale}（影响悬停名与规则表）</button>
      </header>
      <Showcase locale={locale} />
      <Switcher current={variant} onChange={change} />
      <style>{CSS}</style>
    </main>
  );
}

const CSS = `
.proto { max-width: 760px; margin: 0 auto; padding: 24px 16px 96px; color: var(--text); }
.proto header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
.proto header button, .proto-switcher button { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line-2); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.proto section { margin-top: 28px; }
.proto h3 { font-size: 13px; font-weight: 500; opacity: 0.7; margin: 0 0 10px; }
.proto .cards-row { justify-content: flex-start; flex-wrap: wrap; margin-bottom: 10px; }
.proto .cards-row.tight { gap: 4px; }
.proto .gap { width: 16px; }

.proto .sz-self { width: 72px; height: 102px; }
.proto .sz-opp  { width: 58px; height: 82px; }
.proto .sz-mini { width: 40px; height: 56px; border-radius: var(--r-sm); }
.proto .card.sz-mini { border-width: 1.5px; }

.proto .card { position: relative; }
.glyph { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.proto .card .main { width: 56%; }
.proto .pip { display: none; }

/* B：实心剪影，细节镂空成底色 */
.v-B .glyph .f { fill: currentColor; }
.v-B .glyph { stroke-width: 2; }
.v-B .card .glyph .d { stroke: color-mix(in srgb, currentColor 10%, var(--canvas)); stroke-width: 1.4; }
.v-B .proto-ref .glyph .d { stroke: var(--canvas); }
.v-B .card .main { width: 64%; }

/* C：圆形徽章 + 扑克式角标；手机小牌去掉角标 */
.v-C .card .main { width: 44%; padding: 14%; border: 1.5px solid currentColor; border-radius: 50%; box-sizing: content-box;
  background: color-mix(in srgb, currentColor 14%, transparent); }
.v-C .card.sz-mini .main { width: 58%; padding: 10%; border-width: 1px; }
.v-C .card:not(.sz-mini) .pip { display: block; position: absolute; width: 22%; stroke-width: 2.2; }
.v-C .pip.tl { top: 5%; left: 6%; }
.v-C .pip.br { bottom: 5%; right: 6%; transform: rotate(180deg); }

.proto-ref { display: grid !important; grid-template-columns: 36px 1fr; align-items: start; column-gap: 12px; }
.proto-ref .ref-icon { width: 32px; margin-top: 2px; }
.v-C .proto-ref .ref-icon { width: 22px; padding: 4px; border: 1.5px solid currentColor; border-radius: 50%; }
.proto-ref p { color: var(--text); opacity: 0.8; margin: 4px 0 0; }

.proto-switcher { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; align-items: center;
  background: #fff; color: #111; padding: 8px 12px; border-radius: 999px; box-shadow: 0 6px 24px rgb(0 0 0 / 0.5); font: 14px system-ui; z-index: 99; }
.proto-switcher button { background: #eee; border-color: #ccc; color: #111; }
`;

ReactDOM.createRoot(document.getElementById('root')!).render(<Prototype />);
