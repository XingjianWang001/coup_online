/// <reference types="vite/client" />
// PROTOTYPE, throwaway: coin + crown icons, current (A) vs filled-silhouette B style (B). ?variant=A|B
// Run: pnpm proto:status-icons  (opens /prototype-status-icons.html). Not included in the app build.
import { useEffect, useState, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import './style.css';

const VARIANTS = { A: '现状', B: '实心剪影（与角色图标统一）' } as const;
type Variant = keyof typeof VARIANTS;

// --- A：现有实现原样复制 ---
const CoinA = () => (
  <svg className="inline-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="8" cy="8" r="3.5" fill="none" stroke="currentColor" strokeWidth="1" />
  </svg>
);
const CrownA = () => (
  <svg className="inline-icon" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M3 14 L3 6.5 L6.6 9.5 L10 4.5 L13.4 9.5 L17 6.5 L17 14 Z" fill="currentColor" />
  </svg>
);

// --- B：与角色图标同一套 24 格、.f 实心 / .d 镂空 ---
const Glyph = ({ children, size }: { children: ReactNode; size: number }) => (
  <svg className="role-icon inline-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    {children}
  </svg>
);
// 银元：实心圆饼 + 镂空内圈
const COIN_B = (
  <>
    <circle className="f" cx="12" cy="12" r="9.5" />
    <circle className="d" cx="12" cy="12" r="6.2" />
  </>
);
// 皇冠：三尖带珠 + 镂空冠带
const CROWN_B = (
  <g transform="translate(0 1.5)">
    <path className="f" d="M4.5 18.5 L3 8 L8.5 12 L12 5 L15.5 12 L21 8 L19.5 18.5 Z" />
    <circle className="f" cx="3" cy="7" r="1.6" />
    <circle className="f" cx="12" cy="4" r="1.6" />
    <circle className="f" cx="21" cy="7" r="1.6" />
    <line className="d" x1="6.5" y1="15.5" x2="17.5" y2="15.5" />
  </g>
);
const CoinB = () => <Glyph size={16}>{COIN_B}</Glyph>;
const CrownB = () => <Glyph size={22}>{CROWN_B}</Glyph>;

// 对照用：两个角色图标（自正式代码复制）
const ANCHOR = (
  <>
    <circle cx="12" cy="4.3" r="2" />
    <line x1="12" y1="6.3" x2="12" y2="21" />
    <line x1="8" y1="9.5" x2="16" y2="9.5" />
    <path d="M4 14 Q4.5 21 12 21 Q19.5 21 20 14" />
    <path d="M2.5 16 L4 13 L6.5 15" />
    <path d="M21.5 16 L20 13 L17.5 15" />
  </>
);
const SCROLL = (
  <>
    <rect className="f" x="5.5" y="6.5" width="13" height="11" />
    <rect className="f" x="2.5" y="4.5" width="3.5" height="15" rx="1.75" />
    <rect className="f" x="18" y="4.5" width="3.5" height="15" rx="1.75" />
    <line className="d" x1="8.5" y1="9.5" x2="15.5" y2="9.5" />
    <line className="d" x1="8.5" y1="12" x2="15.5" y2="12" />
    <line className="d" x1="8.5" y1="14.5" x2="13" y2="14.5" />
  </>
);
const Card = ({ role, glyph }: { role: string; glyph: ReactNode }) => (
  <div className={`card card--${role}`}>
    <svg className="role-icon" viewBox="0 0 24 24" aria-hidden="true">{glyph}</svg>
  </div>
);

function Showcase({ variant }: { variant: Variant }) {
  const Coin = variant === 'A' ? CoinA : CoinB;
  const Crown = variant === 'A' ? CrownA : CrownB;
  return (
    <>
      <section>
        <h3>自己的座位（桌面）</h3>
        <div className="seat self">
          <div className="seat-head">
            <span className="name">Alice (you)</span>
            <span className="coins"><Coin /> 7 coins</span>
          </div>
          <div className="cards-row">
            <Card role="captain" glyph={ANCHOR} />
            <Card role="ambassador" glyph={SCROLL} />
          </div>
        </div>
      </section>
      <section>
        <h3>对手座位（桌面 / 手机字号）</h3>
        <div className="proto-row">
          <div className="seat opponent">
            <div className="seat-head">
              <span className="name">Bartholomew</span>
              <span className="coins"><Coin /> 2 coins</span>
            </div>
            <div className="cards-row"><div className="card-back" /><div className="card-back" /></div>
          </div>
          <div className="seat opponent mobile">
            <div className="seat-head">
              <span className="name">Carol</span>
              <span className="coins"><Coin /> 10 coins</span>
            </div>
            <div className="cards-row"><div className="card-back" /><div className="card-back" /></div>
          </div>
        </div>
      </section>
      <section>
        <h3>胜者公告</h3>
        <div className="notice big"><Crown /> Dmitri wins!</div>
      </section>
      <section>
        <h3>放大 64px 对照（银元 · 皇冠 · 船锚 · 卷轴）</h3>
        <div className="proto-row big">
          <span style={{ color: 'var(--gold)' }}>{variant === 'A' ? <BigA kind="coin" /> : <Glyph size={64}>{COIN_B}</Glyph>}</span>
          <span style={{ color: 'var(--gold)' }}>{variant === 'A' ? <BigA kind="crown" /> : <Glyph size={64}>{CROWN_B}</Glyph>}</span>
          <span style={{ color: 'var(--captain)' }}><Glyph size={64}>{ANCHOR}</Glyph></span>
          <span style={{ color: 'var(--ambassador)' }}><Glyph size={64}>{SCROLL}</Glyph></span>
        </div>
      </section>
    </>
  );
}

const BigA = ({ kind }: { kind: 'coin' | 'crown' }) => (
  <span className="big-a">{kind === 'coin' ? <CoinA /> : <CrownA />}</span>
);

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
  const [variant, setVariant] = useState<Variant>(initial && initial in VARIANTS ? (initial as Variant) : 'B');
  const change = (v: Variant) => {
    const url = new URL(location.href);
    url.searchParams.set('variant', v);
    history.replaceState(null, '', url);
    setVariant(v);
  };
  return (
    <main className="proto">
      <h2>状态图标原型 · {variant}：{VARIANTS[variant]}</h2>
      <Showcase variant={variant} />
      <Switcher current={variant} onChange={change} />
      <style>{CSS}</style>
    </main>
  );
}

const CSS = `
.proto { max-width: 760px; margin: 0 auto; padding: 24px 16px 96px; color: var(--text); }
.proto section { margin-top: 28px; }
.proto h3 { font-size: 13px; font-weight: 500; opacity: 0.7; margin: 0 0 10px; }
.proto-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
.proto-row.big { gap: 32px; }
.proto .seat { position: static; transform: none; }
.proto .seat.mobile .coins { font-size: 12px; }
.proto .seat.mobile .card-back { width: 40px; height: 56px; }
.proto .seat .role-icon .d { stroke: var(--felt); }
.proto .notice .role-icon .d { stroke: color-mix(in srgb, var(--gold) 13%, var(--panel)); }
.proto .proto-row.big .role-icon .d { stroke: var(--canvas); }
.big-a svg { width: 64px; height: 64px; }
.proto-switcher { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; align-items: center;
  background: #fff; color: #111; padding: 8px 12px; border-radius: 999px; box-shadow: 0 6px 24px rgb(0 0 0 / 0.5); font: 14px system-ui; z-index: 99; }
.proto-switcher button { font: inherit; background: #eee; border: 1px solid #ccc; border-radius: 6px; padding: 4px 10px; color: #111; cursor: pointer; }
`;

ReactDOM.createRoot(document.getElementById('root')!).render(<Prototype />);
