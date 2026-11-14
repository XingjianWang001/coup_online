// PROTOTYPE（抛弃型，只在 prototype/reaction 分支）：表态 Reaction 的发言行与表态面板。
// 问题：每个座位预留一行发言行时，放在哪里、长什么样，才既不挡信息、又一眼看出是谁在说？
// 三个变体共用同一个表态面板（记录上方、可展开），只换发言行：
//   A 题注：座位底部，细线分隔的一行字
//   B 对白：座位顶部，尾巴指向名字的气泡
//   C 铭牌：贴在座位下沿的一条底带
// 打开：pnpm dev:client，访问 /?prototype=reaction&variant=A；← → 切换变体。不连服务器，对手的表态是本地模拟的。
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ActionType, Card, PublicState, Role } from '@coup/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { GameBoard } from './App.tsx';
import { useSmoothHeight } from './motion.ts';
import { actionName, roleName, ROLES } from './rules.ts';
import { loadLocale, persistLocale, translate, type Locale } from './localization.ts';
import type { LogEntry } from './narration.ts';
import './reaction-prototype.css';

const VARIANTS = [
  { key: 'A', zh: '题注', en: 'Caption' },
  { key: 'B', zh: '对白', en: 'Speech' },
  { key: 'C', zh: '铭牌', en: 'Nameplate' },
] as const;
type Scenario = 'window' | 'myTurn' | 'gameOver';

const BUBBLE_MS = 3000;
const COOLDOWN_MS = 2000;

const PHRASES = {
  doubt: { 'zh-CN': '我信你个鬼', en: 'Yeah, right.' },
  sure: { 'zh-CN': '你确定？', en: 'You sure?' },
  dare: { 'zh-CN': '来质疑我啊', en: 'Go on, challenge me.' },
  honest: { 'zh-CN': '我是老实人', en: "I'm an honest player." },
  framed: { 'zh-CN': '冤枉啊', en: "I've been framed!" },
  mercy: { 'zh-CN': '手下留情', en: 'Have mercy.' },
  close: { 'zh-CN': '好险', en: 'That was close.' },
  respect: { 'zh-CN': '佩服', en: 'Well played.' },
} satisfies Record<string, Record<Locale, string>>;
type PhraseKey = keyof typeof PHRASES;
const PHRASE_KEYS = Object.keys(PHRASES) as PhraseKey[];

const ACTION_ROLE: Partial<Record<ActionType, Role>> = { tax: 'duke', assassinate: 'assassin', steal: 'captain', exchange: 'ambassador' };

const ANNOUNCE_ACTIONS: { type: ActionType; needsTarget: boolean }[] = [
  { type: 'income', needsTarget: false },
  { type: 'foreignAid', needsTarget: false },
  { type: 'coup', needsTarget: true },
  { type: 'tax', needsTarget: false },
  { type: 'assassinate', needsTarget: true },
  { type: 'steal', needsTarget: true },
  { type: 'exchange', needsTarget: false },
];

type Reaction =
  | { kind: 'phrase'; key: PhraseKey }
  | { kind: 'announce'; action: ActionType; targetId?: string }
  | { kind: 'verbal'; has: boolean; role: Role };
type Tab = Reaction['kind'];
interface Bubble { id: number; reaction: Reaction }

const COPY = {
  'zh-CN': {
    toggle: '表态', tabs: { phrase: '短语', announce: '行动预告', verbal: '口头声称' },
    has: '我有', hasNot: '我没有', pickTarget: (a: string) => `预告${a}：选目标`, cancel: '取消',
    endedHint: '牌局已结束，只能用短语', eliminatedHint: '你已出局，只能用短语', dismiss: '点击收起',
  },
  en: {
    toggle: 'React', tabs: { phrase: 'Phrases', announce: 'Announce', verbal: 'Verbal claim' },
    has: 'I have', hasNot: "I don't have", pickTarget: (a: string) => `Announce ${a}: pick a target`, cancel: 'Cancel',
    endedHint: 'The game is over: phrases only', eliminatedHint: "You're out: phrases only", dismiss: 'Click to hide',
  },
} as const;

// 行动名按该行动要声称的角色上色（收入、外援、政变没有角色，保持象牙色）
function announceText(locale: Locale, action: ActionType, target: ReactNode): ReactNode {
  const role = ACTION_ROLE[action];
  const w = <span className={role ? `speech-role role--${role}` : undefined}>{actionName(locale, action)}</span>;
  if (locale === 'zh-CN') {
    switch (action) {
      case 'income': case 'foreignAid': return <>我要拿{w}</>;
      case 'tax': case 'exchange': return <>我要{w}</>;
      case 'coup': case 'assassinate': case 'steal': return <>我要{w} {target}</>;
    }
  }
  switch (action) {
    case 'income': case 'foreignAid': return <>I'll take {w}.</>;
    case 'tax': case 'exchange': return <>I'll {w}.</>;
    case 'coup': case 'assassinate': return <>I'll {w} {target}.</>;
    case 'steal': return <>I'll {w} from {target}.</>;
  }
}

function reactionText(locale: Locale, r: Reaction, nameOf: (id: string) => string): ReactNode {
  if (r.kind === 'phrase') return PHRASES[r.key][locale];
  if (r.kind === 'verbal') {
    const role = <span className={`speech-role role--${r.role}`}>{roleName(locale, r.role)}</span>;
    if (locale === 'zh-CN') return <>{r.has ? '我有' : '我没有'}{role}</>;
    return r.has ? <>I'm the {role}.</> : <>I'm not the {role}.</>;
  }
  return announceText(locale, r.action, r.targetId ? <b className="speech-target">{nameOf(r.targetId)}</b> : null);
}

// 读屏用的纯文本版：渲染一次再取文字
function reactionPlain(locale: Locale, r: Reaction, nameOf: (id: string) => string): string {
  const el = document.createElement('div');
  el.innerHTML = renderToStaticMarkup(<>{reactionText(locale, r, nameOf)}</>);
  return el.textContent ?? '';
}

const ME = 'p0';
const HAND: Card[] = [{ id: 'c1', role: 'duke' }, { id: 'c2', role: 'contessa' }];

function fixture(scenario: Scenario): { state: PublicState; hand: Card[] } {
  const p = (id: string, name: string, coins: number, handCount: number, revealed: Role[] = []) =>
    ({ id, name, coins, handCount, revealed, alive: handCount > 0, postGameRevealed: [] });
  const base = {
    pending: null, challengeSubject: null, showdown: null, lossPlayerId: null,
    exchangeKeepCount: null, passed: [] as string[], winnerId: null,
  };
  if (scenario === 'gameOver') {
    return {
      hand: [],
      state: {
        ...base, phase: 'gameOver', currentPlayerId: null, winnerId: 'p5',
        players: [
          p(ME, '林夕', 4, 0, ['duke', 'contessa']), p('p1', 'Van', 0, 0, ['captain', 'assassin']),
          p('p2', '小林', 2, 0, ['ambassador', 'duke']), p('p3', 'Bartholomew the Third', 6, 0, ['contessa', 'captain']),
          p('p4', '阿杰', 1, 0, ['assassin', 'ambassador']), p('p5', 'Mia', 9, 1, ['duke']),
        ],
      },
    };
  }
  const players = [
    p(ME, '林夕', 4, 2), p('p1', 'Van', 5, 2), p('p2', '小林', 2, 1, ['ambassador']),
    p('p3', 'Bartholomew the Third', 6, 2), p('p4', '阿杰', 1, 0, ['assassin', 'ambassador']), p('p5', 'Mia', 3, 2),
  ];
  if (scenario === 'myTurn') {
    return { hand: HAND, state: { ...base, phase: 'choosingAction', currentPlayerId: ME, players } };
  }
  return {
    hand: HAND,
    state: {
      ...base, phase: 'awaitingChallenge', currentPlayerId: 'p1', players,
      pending: { action: 'tax', actorId: 'p1', claimedRole: 'duke' }, challengeSubject: 'action',
    },
  };
}

const LOG: LogEntry[] = [
  { id: 1, event: { type: 'actionChosen', actorId: 'p5', action: 'income' } },
  { id: 2, event: { type: 'coinsChanged', playerId: 'p5', coins: 3 } },
  { id: 3, event: { type: 'turnChanged', playerId: 'p1' } },
  { id: 4, event: { type: 'actionChosen', actorId: 'p1', action: 'tax', claimedRole: 'duke' } },
];

function randomReaction(state: PublicState, from: string, phrasesOnly: boolean): Reaction {
  const roll = Math.random();
  if (phrasesOnly || roll < 0.5) return { kind: 'phrase', key: PHRASE_KEYS[Math.floor(Math.random() * PHRASE_KEYS.length)] };
  if (roll < 0.78) {
    const a = ANNOUNCE_ACTIONS[Math.floor(Math.random() * ANNOUNCE_ACTIONS.length)];
    const targets = state.players.filter((x) => x.alive && x.id !== from);
    return { kind: 'announce', action: a.type, targetId: a.needsTarget ? targets[Math.floor(Math.random() * targets.length)]?.id : undefined };
  }
  return { kind: 'verbal', has: Math.random() < 0.6, role: ROLES[Math.floor(Math.random() * ROLES.length)] };
}

function ReactionTray(props: {
  locale: Locale;
  state: PublicState;
  coolingDown: boolean;
  onSend: (r: Reaction) => void;
}) {
  const c = COPY[props.locale];
  // 牌局结束或自己已出局：只能用短语
  const ended = props.state.phase === 'gameOver';
  const eliminated = !props.state.players.find((p) => p.id === ME)?.alive;
  const phrasesOnly = ended || eliminated;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('phrase');
  const [targeting, setTargeting] = useState<ActionType | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const activeTab: Tab = phrasesOnly ? 'phrase' : tab;

  // 按钮区换内容（进出选目标、切标签）时高度平滑过渡；收起状态下不做
  const gridRef = useRef<HTMLDivElement>(null);
  useSmoothHeight(gridRef, [activeTab, targeting, phrasesOnly, open, props.locale], { enabled: open, fade: true });

  const targets = props.state.players.filter((p) => p.alive && p.id !== ME);

  // 收起时只改 open；选目标状态等收起动画结束再复位，免得面板边收边换内容
  const close = useCallback(() => {
    setOpen(false);
    toggleRef.current?.focus();
  }, []);
  const onCollapseEnd = (e: React.TransitionEvent) => {
    if (e.target !== e.currentTarget || e.propertyName !== 'grid-template-rows') return;
    // 展开完成后滚进视口；手机上 scroll-margin 让出底部吸附的操作栏
    if (open) trayRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    else setTargeting(null);
  };
  const send = (r: Reaction) => {
    props.onSend(r);
    close();
  };

  const grid = () => {
    if (activeTab === 'phrase') {
      return PHRASE_KEYS.map((k) => (
        <button key={k} disabled={props.coolingDown} onClick={() => send({ kind: 'phrase', key: k })}>{PHRASES[k][props.locale]}</button>
      ));
    }
    if (activeTab === 'announce') {
      if (targeting) {
        return (
          <>
            <p id="reaction-target-heading">{c.pickTarget(actionName(props.locale, targeting))}</p>
            {targets.map((t, i) => (
              <button key={t.id} autoFocus={i === 0} disabled={props.coolingDown} onClick={() => send({ kind: 'announce', action: targeting, targetId: t.id })}>
                <span className="reaction-name">{t.name}</span>
              </button>
            ))}
            <button className="ghost" onClick={() => setTargeting(null)}>{c.cancel}</button>
          </>
        );
      }
      return ANNOUNCE_ACTIONS.map((a) => (
        <button key={a.type} disabled={props.coolingDown} onClick={() => (a.needsTarget ? setTargeting(a.type) : send({ kind: 'announce', action: a.type }))}>
          {actionName(props.locale, a.type)}
        </button>
      ));
    }
    return [true, false].map((has) => (
      <div key={String(has)} className="reaction-verbal-row" role="group" aria-label={has ? c.has : c.hasNot}>
        <span className="reaction-verbal-label">{has ? c.has : c.hasNot}</span>
        {ROLES.map((role) => (
          <button key={role} disabled={props.coolingDown} onClick={() => send({ kind: 'verbal', has, role })}>{roleName(props.locale, role)}</button>
        ))}
      </div>
    ));
  };

  return (
    <section className={`reaction${open ? ' open' : ''}`} onKeyDown={(e) => { if (e.key === 'Escape' && open) close(); }}>
      <button
        ref={toggleRef}
        className="reaction-toggle"
        aria-expanded={open}
        aria-controls="reaction-tray"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className={`log-chevron${open ? ' open' : ''}`} aria-hidden="true">▸</span>
        {c.toggle}
      </button>
      {/* 常驻挂载，高度在 0fr ↔ 1fr 之间过渡（同 .notice-region 的做法）；收起时 inert，读屏和 Tab 都跳过 */}
      <div className="reaction-collapse" onTransitionEnd={onCollapseEnd} {...{ inert: open ? undefined : '' }}>
        <div className="reaction-collapse-inner">
        <div id="reaction-tray" ref={trayRef} className="reaction-tray">
          <div className="reaction-tabs" role="tablist" aria-label={c.toggle}>
            {(['phrase', 'announce', 'verbal'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={activeTab === t}
                disabled={phrasesOnly && t !== 'phrase'}
                onClick={() => { setTab(t); setTargeting(null); }}
              >
                {c.tabs[t]}
              </button>
            ))}
          </div>
          {phrasesOnly && <p className="reaction-hint">{ended ? c.endedHint : c.eliminatedHint}</p>}
          <div
            ref={gridRef}
            className={`reaction-grid reaction-grid--${activeTab}${targeting ? ' is-targeting' : ''}`}
            role={targeting ? 'group' : undefined}
            aria-labelledby={targeting ? 'reaction-target-heading' : undefined}
          >
            {grid()}
          </div>
        </div>
        </div>
      </div>
    </section>
  );
}

export function ReactionPrototype() {
  const params = new URLSearchParams(location.search);
  const [variant, setVariant] = useState(params.get('variant') ?? 'A');
  const [scenario, setScenario] = useState<Scenario>((params.get('scenario') as Scenario) ?? 'window');
  const [auto, setAuto] = useState(params.get('auto') !== '0');
  const [locale, setLocale] = useState<Locale>(() => loadLocale(localStorage, navigator.languages));
  const [bubbles, setBubbles] = useState<Record<string, Bubble>>({});
  const [announcement, setAnnouncement] = useState('');
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [selectedAction, setSelectedAction] = useState<ActionType | null>(null);
  const [now, setNow] = useState(Date.now());
  const seq = useRef(0);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const { state, hand } = useMemo(() => fixture(scenario), [scenario]);
  const nameOf = useCallback((id: string) => state.players.find((p) => p.id === id)?.name ?? '?', [state]);
  // 倒计时每 20 秒重新起算，问询窗口永远在走
  const [clockEpoch, setClockEpoch] = useState(0);
  useEffect(() => { const t = setInterval(() => setClockEpoch((v) => v + 1), 20_000); return () => clearInterval(t); }, []);
  const clock = useMemo(
    () => ({ snapshot: { remainingMs: scenario === 'gameOver' ? null : 20_000, deadlineAt: null, receivedAt: performance.now() }, serverOffsetMs: null }),
    [scenario, clockEpoch],
  );

  const show = useCallback((playerId: string, reaction: Reaction) => {
    const id = ++seq.current;
    setBubbles((b) => ({ ...b, [playerId]: { id, reaction } }));
    clearTimeout(timers.current[playerId]);
    timers.current[playerId] = setTimeout(() => {
      setBubbles((b) => (b[playerId]?.id === id ? (({ [playerId]: _, ...rest }) => rest)(b) : b));
    }, BUBBLE_MS);
    if (playerId !== ME) setAnnouncement(`${nameOf(playerId)}：${reactionPlain(locale, reaction, nameOf)}`);
  }, [locale, nameOf]);

  const dismiss = (playerId: string) => {
    clearTimeout(timers.current[playerId]);
    setBubbles(({ [playerId]: _, ...rest }) => rest);
  };

  // 模拟其他玩家（含已淘汰的阿杰）陆续表态
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => {
      const others = state.players.filter((p) => p.id !== ME);
      const from = others[Math.floor(Math.random() * others.length)];
      show(from.id, randomReaction(state, from.id, state.phase === 'gameOver' || !from.alive));
    }, 1400);
    return () => clearInterval(t);
  }, [auto, state, show]);

  useEffect(() => {
    if (cooldownUntil <= now) return;
    const t = setTimeout(() => setNow(Date.now()), cooldownUntil - Date.now());
    return () => clearTimeout(t);
  }, [cooldownUntil, now]);

  // URL 跟着变体走，刷新后不丢
  useEffect(() => {
    const u = new URL(location.href);
    u.searchParams.set('variant', variant);
    u.searchParams.set('scenario', scenario);
    history.replaceState(null, '', u);
  }, [variant, scenario]);

  const cycle = useCallback((dir: 1 | -1) => {
    setVariant((v) => {
      const i = VARIANTS.findIndex((x) => x.key === v);
      return VARIANTS[(i + dir + VARIANTS.length) % VARIANTS.length].key;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement | null)?.isContentEditable) return;
      if (e.key === 'ArrowLeft') cycle(-1);
      if (e.key === 'ArrowRight') cycle(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycle]);

  const speech = (playerId: string) => {
    const b = bubbles[playerId];
    return (
      // 内容由 live region 朗读，这里对读屏隐藏；点掉只是鼠标/触屏的便利，不放进 Tab 顺序
      <div className="speech" aria-hidden="true" onClick={b ? () => dismiss(playerId) : undefined} title={b ? COPY[locale].dismiss : undefined}>
        {b && (
          <span key={b.id} className={`speech-bubble speech-bubble--${b.reaction.kind}`}>
            <span className="speech-text">{reactionText(locale, b.reaction, nameOf)}</span>
          </span>
        )}
      </div>
    );
  };

  const current = VARIANTS.find((v) => v.key === variant) ?? VARIANTS[0];
  const t = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en);

  return (
    <div className="app">
      <header className="header">
        <h1>{translate(locale, 'appTitle')}</h1>
        <div className="header-actions">
          <button className="ghost">{translate(locale, 'rules')}</button>
          <button className="ghost">{translate(locale, 'settings')}</button>
          <button className="ghost">{translate(locale, 'leaveRoom')}</button>
        </div>
      </header>

      <GameBoard
        proto={{
          variant: current.key,
          speech,
          tray: (
            <ReactionTray
              key={scenario}
              locale={locale}
              state={state}
              coolingDown={cooldownUntil > now}
              onSend={(r) => {
                show(ME, r);
                const until = Date.now() + COOLDOWN_MS;
                setCooldownUntil(until);
                setNow(Date.now());
              }}
            />
          ),
        }}
        state={state}
        hand={hand}
        me={ME}
        hostId={ME}
        notice={null}
        selectedAction={selectedAction}
        setSelectedAction={setSelectedAction}
        // 原型：行动选定后切到「问询中」，演示操作区换模式时的高度过渡
        onAction={() => { setSelectedAction(null); setScenario('window'); }}
        onIntent={() => {}}
        clock={clock}
        log={LOG}
        locale={locale}
      />

      <div className="proto-sr" aria-live="polite">{announcement}</div>

      <div className="proto-bar" role="toolbar" aria-label="Prototype">
        <button onClick={() => cycle(-1)} aria-label="Previous variant">‹</button>
        <span className="proto-label">{current.key} · {t(current.zh, current.en)}</span>
        <button onClick={() => cycle(1)} aria-label="Next variant">›</button>
        <span className="proto-sep" />
        {(['window', 'myTurn', 'gameOver'] as const).map((s) => (
          <button key={s} aria-pressed={scenario === s} onClick={() => { setScenario(s); setSelectedAction(null); setBubbles({}); }}>
            {s === 'window' ? t('问询中', 'Window') : s === 'myTurn' ? t('轮到我', 'My turn') : t('已结束', 'Over')}
          </button>
        ))}
        <span className="proto-sep" />
        <button aria-pressed={auto} onClick={() => setAuto((v) => !v)}>{t('模拟', 'Sim')}</button>
        <button onClick={() => { const next = locale === 'zh-CN' ? 'en' : 'zh-CN'; persistLocale(localStorage, next); setLocale(next); }}>
          {locale === 'zh-CN' ? 'EN' : '中'}
        </button>
      </div>
    </div>
  );
}
