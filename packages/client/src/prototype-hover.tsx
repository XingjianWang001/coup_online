/// <reference types="vite/client" />
// PROTOTYPE, throwaway: instant hover names on cards (fixed behavior) + three ways to show
// action details as icons on hover (?variant=A|B|C). Run: pnpm proto:hover. Not in the app build.
// Touch screens have no hover: keyboard focus mirrors hover here, tap behavior is an open question.
import { Fragment, useEffect, useState, type CSSProperties } from 'react';
import ReactDOM from 'react-dom/client';
import type { ActionType, Role } from '@coup/shared';
import { CoinIcon, RoleIcon } from './App.tsx';
import { actionName, roleName } from './rules.ts';
import type { Locale } from './localization.ts';
import './style.css';

const VARIANTS = {
  A: '气泡提示',
  B: '按钮内替换',
  C: '共享详情栏',
} as const;
type Variant = keyof typeof VARIANTS;
type NameLayout = 'h' | 'v';

// ---------- 卡牌：大牌悬浮换成名字，小牌悬浮弹出同色气泡 ----------
type Size = 'self' | 'selfMobile' | 'opp' | 'mini';

function ProtoCard({ role, size, locale, revealed }: { role: Role; size: Size; locale: Locale; revealed?: boolean }) {
  const name = roleName(locale, role);
  const big = size === 'self' || size === 'selfMobile';
  return (
    <span className={`pc-wrap ${big ? 'pc-big' : 'pc-small'}`} tabIndex={0} style={{ '--tip': `var(--${role})` } as CSSProperties}>
      <span className={`card card--${role} sz-${size}${revealed ? ' unavailable' : ''}`} role="img" aria-label={name}>
        <span className="pc-icon"><RoleIcon role={role} /></span>
        {big && <span className="pc-name" style={{ '--len': name.length } as CSSProperties}>{name}</span>}
      </span>
      {!big && <span className="pc-tip" aria-hidden="true">{name}</span>}
    </span>
  );
}

const Back = ({ size }: { size: Size }) => <span className={`card-back sz-${size}`} />;

// ---------- 行动详情：银元增减 + 需声称的角色 ----------
const ACTIONS: ActionType[] = ['income', 'foreignAid', 'coup', 'tax', 'assassinate', 'steal', 'exchange'];
const DETAILS: Record<ActionType, { coins?: string; claim?: Role }> = {
  income: { coins: '+1' },
  foreignAid: { coins: '+2' },
  coup: { coins: '−7' },
  tax: { coins: '+3', claim: 'duke' },
  assassinate: { coins: '−3', claim: 'assassin' },
  steal: { coins: '+2', claim: 'captain' },
  exchange: { claim: 'ambassador' },
};

function Detail({ action }: { action: ActionType }) {
  const { coins, claim } = DETAILS[action];
  return (
    <span className="ad">
      {coins && <span className="ad-coin"><CoinIcon />{coins}</span>}
      {claim && <span className={`ad-claim role--${claim}`}><RoleIcon role={claim} /></span>}
    </span>
  );
}

function Actions({ variant, locale, coins }: { variant: Variant; locale: Locale; coins: number }) {
  const [hovered, setHovered] = useState<ActionType | null>(null);
  return (
    <div className="controls proto-controls">
      {variant === 'C' && (
        <div className="ab-strip" aria-live="polite">
          {hovered ? (
            <Fragment key={hovered}>
              <b>{actionName(locale, hovered)}</b>
              <Detail action={hovered} />
            </Fragment>
          ) : (
            <span className="ab-strip-empty">悬浮行动查看银元与所需角色</span>
          )}
        </div>
      )}
      <div className="actions">
        {ACTIONS.map((a) => {
          const disabled = a === 'coup' ? coins < 7 : a === 'assassinate' ? coins < 3 : false;
          const name = actionName(locale, a);
          return (
            <span
              key={a}
              className="ab-wrap"
              onMouseEnter={() => setHovered(a)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(a)}
              onBlur={() => setHovered(null)}
            >
              <button disabled={disabled} className="ab">
                <span className="ab-name">{name}</span>
                {variant === 'B' && <span className="ab-detail"><Detail action={a} /></span>}
              </button>
              {variant === 'A' && <span className="ab-tip" aria-hidden="true"><Detail action={a} /></span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ---------- 页面 ----------
function Showcase({ variant, locale }: { variant: Variant; locale: Locale }) {
  return (
    <>
      <section>
        <h3>自己的牌（大牌）· 悬浮：图标换成名字 · 桌面 72×102 / 手机 58×82</h3>
        <div className="seat self">
          <div className="seat-head">
            <span className="name">Alice (you)</span>
            <span className="coins"><CoinIcon /> 5</span>
          </div>
          <div className="cards-row">
            <ProtoCard role="ambassador" size="self" locale={locale} />
            <ProtoCard role="contessa" size="self" locale={locale} />
            <ProtoCard role="assassin" size="self" locale={locale} revealed />
          </div>
        </div>
        <div className="cards-row proto-row">
          {(['duke', 'assassin', 'captain', 'ambassador', 'contessa'] as const).map((r) => (
            <ProtoCard key={r} role={r} size="selfMobile" locale={locale} />
          ))}
        </div>
      </section>
      <section>
        <h3>对手的明牌（小牌）· 悬浮：同色气泡即时显示名字 · 桌面 58×82 / 手机 40×56</h3>
        <div className="proto-row">
          <div className="seat opponent">
            <div className="seat-head">
              <span className="name">Bartholomew</span>
              <span className="coins"><CoinIcon /> 2</span>
            </div>
            <div className="cards-row">
              <Back size="opp" />
              <ProtoCard role="captain" size="opp" locale={locale} revealed />
            </div>
          </div>
          <div className="seat opponent">
            <div className="seat-head">
              <span className="name">Carol</span>
              <span className="coins"><CoinIcon /> 10</span>
            </div>
            <div className="cards-row">
              <ProtoCard role="duke" size="mini" locale={locale} revealed />
              <ProtoCard role="ambassador" size="mini" locale={locale} revealed />
            </div>
          </div>
          <div className="cards-row">
            {(['duke', 'assassin', 'captain', 'ambassador', 'contessa'] as const).map((r) => (
              <ProtoCard key={r} role={r} size="mini" locale={locale} />
            ))}
          </div>
        </div>
      </section>
      <section>
        <h3>行动区（{variant}：{VARIANTS[variant]}）· 你有 5 银元，政变不可用</h3>
        <Actions variant={variant} locale={locale} coins={5} />
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
  const params = new URLSearchParams(location.search);
  const initial = params.get('variant');
  const [variant, setVariant] = useState<Variant>(initial && initial in VARIANTS ? (initial as Variant) : 'A');
  const [locale, setLocale] = useState<Locale>('en');
  const [layout, setLayout] = useState<NameLayout>('h');
  const change = (v: Variant) => {
    const url = new URL(location.href);
    url.searchParams.set('variant', v);
    history.replaceState(null, '', url);
    setVariant(v);
  };
  return (
    <main className={`proto layout-${layout}`}>
      <header>
        <h2>悬浮原型 · 行动详情 {variant}：{VARIANTS[variant]}</h2>
        <div className="proto-toggles">
          <button onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}>语言：{locale}</button>
          <button onClick={() => setLayout(layout === 'h' ? 'v' : 'h')}>大牌名字：{layout === 'h' ? '横排缩放' : '竖排'}</button>
        </div>
      </header>
      <Showcase variant={variant} locale={locale} />
      <Switcher current={variant} onChange={change} />
      <style>{CSS}</style>
    </main>
  );
}

const CSS = `
.proto { max-width: 820px; margin: 0 auto; padding: 24px 16px 120px; color: var(--text); }
.proto header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
.proto-toggles { display: flex; gap: 8px; }
.proto section { margin-top: 32px; }
.proto h3 { font-size: 13px; font-weight: 500; opacity: 0.7; margin: 0 0 12px; }
.proto-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; margin-top: 16px; }
.proto .seat { position: static; transform: none; }
.proto .cards-row { justify-content: flex-start; }

.proto .sz-self { width: 72px; height: 102px; }
.proto .sz-selfMobile, .proto .sz-opp { width: 58px; height: 82px; }
.proto .sz-mini { width: 40px; height: 56px; border-radius: var(--r-sm); }
.proto .card.sz-mini { border-width: 1.5px; }

/* 卡牌悬浮：零延迟 */
.pc-wrap { position: relative; display: inline-flex; outline: none; border-radius: var(--r-md); }
.pc-wrap:focus-visible { box-shadow: 0 0 0 2px var(--gold); }
.pc-wrap .card { container-type: size; position: relative; }
.pc-icon { display: contents; }
.pc-icon .glyph { transition: opacity 150ms ease; }
.pc-name { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 150ms ease; font-family: 'Noto Serif SC', 'Noto Serif', Georgia, serif; font-weight: 600; line-height: 1.1; white-space: nowrap; }
.layout-h .pc-name { font-size: min(17px, calc(150cqi / var(--len))); }
.layout-v .pc-name { writing-mode: vertical-rl; margin: auto; font-size: min(17px, calc(140cqh / var(--len))); }
.pc-big:is(:hover, :focus-visible) .pc-icon .glyph { opacity: 0; }
.pc-big:is(:hover, :focus-visible) .pc-name { opacity: 1; }

/* 小牌：同色气泡（深色字保证对比度） */
.pc-tip { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); z-index: 10;
  background: var(--tip); color: var(--canvas); padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: 600;
  white-space: nowrap; pointer-events: none; opacity: 0; box-shadow: 0 4px 12px rgb(0 0 0 / 0.35);
  translate: 0 4px; transition: opacity 150ms ease, translate 150ms ease; }
.pc-tip::after { content: ''; position: absolute; top: 100%; left: 50%; margin-left: -5px; border: 5px solid transparent; border-top-color: var(--tip); }
.pc-small:is(:hover, :focus-visible) .pc-tip { opacity: 1; translate: 0 0; }

/* 行动详情 */
.proto-controls { position: static; }
.proto .actions button { --surface: var(--panel-2); width: 100%; }
.proto .actions button:hover:not(:disabled) { --surface: var(--felt); }
.ab-wrap { position: relative; display: block; }
.ad { display: inline-flex; align-items: center; gap: 10px; }
.ad-coin { display: inline-flex; align-items: center; gap: 4px; color: var(--gold); font-variant-numeric: tabular-nums; font-weight: 600; }
.ad-claim .glyph { width: 22px; height: 22px; display: block; }

/* A：气泡 */
.ab-tip { --surface: oklch(0.12 0.01 155); position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); z-index: 10;
  background: var(--surface); border: 1px solid var(--line); padding: 6px 12px; border-radius: 8px; white-space: nowrap;
  pointer-events: none; opacity: 0; box-shadow: 0 6px 16px rgb(0 0 0 / 0.4);
  translate: 0 4px; transition: opacity 150ms ease, translate 150ms ease; }
.ab-tip::after { content: ''; position: absolute; top: 100%; left: 50%; margin-left: -6px; border: 6px solid transparent; border-top-color: var(--surface); }
.ab-wrap:is(:hover, :focus-within) .ab-tip { opacity: 1; translate: 0 0; }

/* B：按钮内替换 */
.ab { position: relative; }
.ab-name { transition: opacity 150ms ease; }
.ab-detail { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 150ms ease; }
.ab-wrap:is(:hover, :focus-within) .ab-detail { opacity: 1; }
.ab-wrap:is(:hover, :focus-within) .ab-name:has(+ .ab-detail) { opacity: 0; }

/* C：共享详情栏 */
.ab-strip { --surface: var(--panel); display: flex; align-items: center; justify-content: center; gap: 14px; min-height: 40px; margin-bottom: 8px; }
.ab-strip > * { animation: strip-fade 150ms ease; }
@keyframes strip-fade { from { opacity: 0; } }
.ab-strip b { font-size: 16px; }
.ab-strip-empty { opacity: 0.5; font-size: 14px; }

@media (prefers-reduced-motion: reduce) {
  .pc-tip, .ab-tip { translate: none; transition: opacity 150ms ease; }
}

.proto-toggles button, .proto-switcher button { font: inherit; }
.proto-switcher { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; align-items: center;
  background: #fff; color: #111; padding: 8px 12px; border-radius: 999px; box-shadow: 0 6px 24px rgb(0 0 0 / 0.5); font: 14px system-ui; z-index: 99; }
.proto-switcher button { background: #eee; border: 1px solid #ccc; border-radius: 6px; padding: 4px 10px; color: #111; cursor: pointer; min-height: 0; }
`;

ReactDOM.createRoot(document.getElementById('root')!).render(<Prototype />);
