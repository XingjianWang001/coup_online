/// <reference types="vite/client" />
// PROTOTYPE, throwaway: 声称时座位上浮现的「背后灵」（?variant=A|B|C）。Run: pnpm proto:ghost. Not in the app build.
// 问题：新声称（角色行动或阻挡）时，角色图标在声称者座位上短暂显现、放大、消失，哪种动法最像「背后灵」又不挡牌？
// 牌桌是真实的 GameBoard + 假的公开状态；背后灵画在按座位 getBoundingClientRect 定位的 fixed 层上（只为原型省事，
// 正式实现放进座位内部）。
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import type { ActionType, PublicState, Role } from '@coup/shared';
import { GameBoard, RoleIcon } from './App.tsx';
import { roleName } from './rules.ts';
import './style.css';

const VARIANTS = {
  A: '缩放淡出',
  B: '雾中凝形',
  C: '升腾飘散',
} as const;
type Variant = keyof typeof VARIANTS;
const KEYS = Object.keys(VARIANTS) as Variant[];

const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
type Frames = { keyframes: Keyframe[]; options: KeyframeAnimationOptions };
const MOTION: Record<Variant, Frames> = {
  A: {
    keyframes: [
      { transform: 'scale(0.7)', opacity: 0 },
      { transform: 'scale(1.05)', opacity: 0.5, offset: 0.3 },
      { transform: 'scale(1.5)', opacity: 0 },
    ],
    options: { duration: 1000, easing: EASE },
  },
  B: {
    keyframes: [
      { transform: 'scale(0.9)', opacity: 0, filter: 'blur(6px)' },
      { transform: 'scale(1.1)', opacity: 0.55, filter: 'blur(0px)', offset: 0.35 },
      { transform: 'scale(1.3)', opacity: 0, filter: 'blur(4px)' },
    ],
    options: { duration: 900, easing: 'ease-out' },
  },
  C: {
    keyframes: [
      { transform: 'translateY(10%) scale(0.8)', opacity: 0 },
      { transform: 'translateY(-15%) scale(1.05)', opacity: 0.5, offset: 0.3 },
      { transform: 'translateY(-60%) scale(1.3)', opacity: 0 },
    ],
    options: { duration: 900, easing: EASE },
  },
};
const REDUCED: Frames = {
  keyframes: [{ opacity: 0 }, { opacity: 0.35, offset: 0.4 }, { opacity: 0 }],
  options: { duration: 600, easing: 'linear' },
};

const NAMES = ['我', 'Van', 'Mio', 'Kai', 'Rin', 'Zoe'];
type Claim = { action: ActionType; role: Role; targeted?: boolean } | { block: Role; against: ActionType };
const CLAIMS: Claim[] = [
  { action: 'tax', role: 'duke' },
  { action: 'assassinate', role: 'assassin', targeted: true },
  { action: 'steal', role: 'captain', targeted: true },
  { action: 'exchange', role: 'ambassador' },
  { block: 'contessa', against: 'assassinate' },
  { block: 'duke', against: 'foreignAid' },
];

function makeState(count: number, claimer: number, claim: Claim): PublicState {
  const players = NAMES.slice(0, count).map((name, i) => ({
    id: `p${i}`, name, coins: [2, 5, 3, 7, 1, 4][i], handCount: i === 2 ? 1 : 2,
    revealed: i === 2 ? (['captain'] as Role[]) : [], alive: true, postGameRevealed: [],
  }));
  const other = `p${(claimer + 1) % count}`;
  const me = `p${claimer}`;
  const pending = 'block' in claim
    ? { action: claim.against, actorId: other, targetId: claim.against === 'foreignAid' ? undefined : me, claimedRole: claim.against === 'assassinate' ? 'assassin' as Role : undefined, blockById: me, blockRole: claim.block }
    : { action: claim.action, actorId: me, targetId: claim.targeted ? other : undefined, claimedRole: claim.role };
  return {
    phase: 'awaitingChallenge', players, currentPlayerId: pending.actorId, pending,
    challengeSubject: 'block' in claim ? 'block' : 'action', showdown: null, lossPlayerId: null,
    exchangeKeepCount: null, passed: [], winnerId: null,
  };
}

type Ghost = { id: number; role: Role; seat: string; honest: boolean };
const HAND: { id: string; role: Role }[] = [{ id: 'c1', role: 'duke' }, { id: 'c2', role: 'contessa' }];

type HonestMode = 'a' | 'b' | 'off';
const GLOW_MS = 1600; // 真声称的牌光：漫开约 560ms，收回约 1040ms
const HONEST: Record<HonestMode, string> = { a: 'a 从牌升起+光晕', b: 'b 更实', off: '关' };
const SOLID: Frames = {
  keyframes: [
    { transform: 'scale(0.7)', opacity: 0, filter: 'drop-shadow(0 0 0 transparent)' },
    { transform: 'scale(1.05)', opacity: 0.8, filter: 'drop-shadow(0 0 8px currentColor)', offset: 0.3 },
    { transform: 'scale(1.5)', opacity: 0, filter: 'drop-shadow(0 0 0 transparent)' },
  ],
  options: { duration: 1000, easing: EASE },
};
const REDUCED_SOLID: Frames = {
  keyframes: [{ opacity: 0 }, { opacity: 0.6, offset: 0.4 }, { opacity: 0 }],
  options: { duration: 600, easing: 'linear' },
};

function GhostLayer({ ghost, variant, reduced, honestMode }: { ghost: Ghost | null; variant: Variant; reduced: boolean; honestMode: HonestMode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const seat = ghost && document.querySelector(`[data-seat="${ghost.seat}"]`);
    if (!el || !seat) return;
    const r = seat.getBoundingClientRect();
    const size = r.height * 1.2;
    // 真声称（只有自己的屏幕知道）：a 从那张牌升起 + 牌亮光晕；b 原位但更实
    const cards = ghost.honest ? [...seat.querySelectorAll<HTMLElement>(`.cards-row .card--${ghost.role}:not(.unavailable)`)] : [];
    const from = honestMode === 'a' && cards[0] ? cards[0].getBoundingClientRect() : r;
    Object.assign(el.style, { left: `${from.left + from.width / 2 - size / 2}px`, top: `${from.top + from.height / 2 - size / 2}px`, width: `${size}px`, height: `${size}px` });
    let frames = reduced ? REDUCED : MOTION[variant];
    if (cards.length && honestMode === 'b') frames = reduced ? REDUCED_SOLID : SOLID;
    el.animate(frames.keyframes, { ...frames.options, fill: 'both' });
    if (honestMode === 'a') {
      // 牌亮一下：参照对质「属实」的角色色漫开（.stage-flood），但漫开后再收回。
      // 一团角色色径向光以 screen 混合叠在牌上，同时把牌本身提亮；两段都用平滑缓动，没有硬起硬落。
      for (const c of cards) {
        const cr = c.getBoundingClientRect();
        const glow = document.createElement('div');
        const d = cr.width * 3.4;
        Object.assign(glow.style, {
          position: 'fixed', zIndex: '29', pointerEvents: 'none', borderRadius: '50%', mixBlendMode: 'screen',
          left: `${cr.left + cr.width / 2 - d / 2}px`, top: `${cr.top + cr.height / 2 - d / 2}px`, width: `${d}px`, height: `${d}px`,
          background: `radial-gradient(circle, color-mix(in srgb, var(--${ghost.role}) 65%, transparent), transparent 62%)`,
          opacity: '0',
        });
        document.body.append(glow);
        const spread = reduced
          ? [{ opacity: 0, easing: 'ease-in-out' }, { opacity: 0.7, offset: 0.35, easing: 'ease-in-out' }, { opacity: 0 }]
          : [
              { opacity: 0, transform: 'scale(0.3)', easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
              { opacity: 0.85, transform: 'scale(1)', offset: 0.35, easing: 'cubic-bezier(0.45, 0, 0.55, 1)' },
              { opacity: 0, transform: 'scale(0.5)' },
            ];
        glow.animate(spread, { duration: GLOW_MS, easing: 'linear' }).finished.then(() => glow.remove());
        c.animate([
          { filter: 'brightness(1) saturate(1)', easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
          { filter: 'brightness(1.45) saturate(1.2)', offset: 0.35, easing: 'cubic-bezier(0.45, 0, 0.55, 1)' },
          { filter: 'brightness(1) saturate(1)' },
        ], { duration: GLOW_MS, easing: 'linear' });
      }
    }
  }, [ghost, variant, reduced, honestMode]);
  if (!ghost) return null;
  return (
    <div ref={ref} key={ghost.id} className={`proto-ghost role--${ghost.role}`} aria-hidden="true">
      <RoleIcon role={ghost.role} />
    </div>
  );
}

function Prototype() {
  const params = new URLSearchParams(location.search);
  const [variant, setVariant] = useState<Variant>((KEYS.includes(params.get('variant') as Variant) ? params.get('variant') : 'A') as Variant);
  const [count, setCount] = useState(5);
  const [auto, setAuto] = useState(true);
  const [reduced, setReduced] = useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [honestMode, setHonestMode] = useState<HonestMode>((params.get('honest') as HonestMode) in HONEST ? params.get('honest') as HonestMode : 'a');
  const [onlyMe, setOnlyMe] = useState(true);
  const [step, setStep] = useState(0);
  const claimer = onlyMe ? 0 : step % count;
  const claim = CLAIMS[step % CLAIMS.length];
  const state = makeState(count, claimer, claim);
  const role = 'block' in claim ? claim.block : claim.role;
  const honest = claimer === 0 && HAND.some((c) => c.role === role);
  const [ghost, setGhost] = useState<Ghost | null>(null);

  const play = useCallback(() => setStep((s) => s + 1), []);
  useEffect(() => { setGhost({ id: step, role, seat: `p${claimer}`, honest }); }, [step, count, onlyMe]);
  const pickHonest = (m: HonestMode) => {
    setHonestMode(m);
    const p = new URLSearchParams(location.search);
    p.set('honest', m);
    history.replaceState(null, '', `?${p}`);
  };
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(play, 1800);
    return () => clearInterval(t);
  }, [auto, play]);

  const cycle = (d: number) => {
    const next = KEYS[(KEYS.indexOf(variant) + d + KEYS.length) % KEYS.length];
    setVariant(next);
    const p = new URLSearchParams(location.search);
    p.set('variant', next);
    history.replaceState(null, '', `?${p}`);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') cycle(-1);
      if (e.key === 'ArrowRight') cycle(1);
      if (e.key === ' ') { e.preventDefault(); play(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const noop = () => {};
  return (
    <div className="app">
      <header className="header"><h1>政变 Coup</h1></header>
      <GameBoard
        state={state} hand={HAND} me="p0" hostId="p0"
        computers={new Map()} notice={null} reactions={{}} latestReaction={null} onDismissReaction={noop}
        selectedAction={null} setSelectedAction={noop} onAction={noop} onIntent={noop} clock={null} log={[]} locale="zh-CN"
      />
      <GhostLayer ghost={ghost} variant={variant} reduced={reduced} honestMode={honestMode} />
      <div className="proto-bar">
        <button onClick={() => cycle(-1)} aria-label="上一个变体">←</button>
        <strong>{variant}（{VARIANTS[variant]}）</strong>
        <button onClick={() => cycle(1)} aria-label="下一个变体">→</button>
        <span className="proto-sep" />
        {[2, 3, 4, 5, 6].map((n) => (
          <button key={n} aria-pressed={n === count} onClick={() => setCount(n)}>{n}人</button>
        ))}
        <span className="proto-sep" />
        <button onClick={play}>播放一次（空格）</button>
        <label><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />连播</label>
        <label><input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} />减少动态</label>
        <span className="proto-sep" />
        真声称：
        {(Object.keys(HONEST) as HonestMode[]).map((m) => (
          <button key={m} aria-pressed={m === honestMode} onClick={() => pickHonest(m)}>{HONEST[m]}</button>
        ))}
        <label><input type="checkbox" checked={onlyMe} onChange={(e) => setOnlyMe(e.target.checked)} />只演示我</label>
        <span className="proto-state">{NAMES[claimer]} 声称{roleName('zh-CN', role)}</span>
      </div>
    </div>
  );
}

const css = document.createElement('style');
css.textContent = `
.proto-ghost { position: fixed; z-index: 30; pointer-events: none; opacity: 0; display: grid; place-items: center; }
.proto-ghost .glyph { width: 100%; height: 100%; --surface: var(--felt); }
.proto-bar { position: fixed; z-index: 100; left: 50%; top: 8px; translate: -50% 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  max-width: calc(100vw - 24px); padding: 6px 10px; border-radius: 14px; background: #fff; color: #111; font: 13px/1.2 system-ui; box-shadow: 0 4px 16px #0006; }
.proto-bar button { min-height: 28px; padding: 2px 8px; border-radius: 999px; border: 1px solid #bbb; background: #f4f4f4; color: #111; font: inherit; }
.proto-bar button[aria-pressed='true'] { background: #111; color: #fff; border-color: #111; }
.proto-bar label { display: inline-flex; gap: 4px; align-items: center; color: #111; font: inherit; }
.proto-sep { width: 1px; height: 18px; background: #ccc; }
.proto-state { color: #555; }
`;
document.head.append(css);

ReactDOM.createRoot(document.getElementById('root')!).render(<Prototype />);
