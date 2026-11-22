import { useEffect, useRef, useState, type TransitionEvent as ReactTransitionEvent } from 'react';
import { PHRASES, REACTION_MIN_INTERVAL_MS, type ActionType, type PublicState, type Reaction } from '@coup/shared';
import { actionName, ACTIONS, roleName, ROLES } from './rules.ts';
import { describeReaction, reactionText } from './narration.ts';
import { useSmoothHeight } from './motion.ts';
import { translate, type Locale, type MessageKey } from './localization.ts';

// 比服务器的限流多留 0.5 秒给网络抖动，正常冷却后的表态不会被服务器误丢
const REACTION_COOLDOWN_MS = REACTION_MIN_INTERVAL_MS + 500;

// 表态面板：记录上方，收起时只有一行。三类表态在同一块按钮区里切换；需要目标的行动预告沿用控制区「选目标」的做法。
// 发出后收起并冷却 REACTION_COOLDOWN_MS；自己的铭牌等服务器转发回来才亮，与别人看到的一致
export function ReactionTray(props: {
  state: PublicState;
  me: string | undefined;
  locale: Locale;
  onReact: (reaction: Reaction) => void;
}) {
  type Tab = Reaction['kind'];
  const TAB_LABELS: Record<Tab, MessageKey> = {
    phrase: 'reactionTabPhrase', announcement: 'reactionTabAnnouncement', verbalClaim: 'reactionTabVerbalClaim',
  };
  const { state, locale } = props;
  const ended = state.phase === 'gameOver';
  // 牌局结束或自己已出局：没有下一步可预告、也没有角色可声称，只剩短语
  const phrasesOnly = ended || !state.players.find((p) => p.id === props.me)?.alive;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('phrase');
  const [pickingTargetFor, setPickingTargetFor] = useState<ActionType | null>(null);
  const [coolingDown, setCoolingDown] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const activeTab: Tab = phrasesOnly ? 'phrase' : tab;
  // 选目标途中牌局结束或自己被淘汰：标签退回短语，选目标随之作废
  const targeting = activeTab === 'announcement' ? pickingTargetFor : null;
  const targets = state.players.filter((p) => p.alive && p.id !== props.me);
  useSmoothHeight(gridRef, [activeTab, targeting, phrasesOnly, open, locale], { enabled: open, fade: true });

  useEffect(() => {
    if (!coolingDown) return;
    const timeout = setTimeout(() => setCoolingDown(false), REACTION_COOLDOWN_MS);
    return () => clearTimeout(timeout);
  }, [coolingDown]);

  // 收起只改 open；选目标的状态等收起动画结束再复位，免得面板边收边换内容
  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };
  const send = (reaction: Reaction) => {
    props.onReact(reaction);
    setCoolingDown(true);
    close();
  };
  const onCollapseEnd = (e: ReactTransitionEvent) => {
    if (e.target !== e.currentTarget || e.propertyName !== 'grid-template-rows') return;
    // 展开完成后滚进视口；手机上 scroll-margin 让出底部吸附的操作栏
    if (open) trayRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    else setPickingTargetFor(null);
  };

  const buttons = () => {
    if (activeTab === 'phrase') {
      return PHRASES.map((phrase) => (
        <button key={phrase} disabled={coolingDown} onClick={() => send({ kind: 'phrase', phrase })}>
          {reactionText(describeReaction(locale, { kind: 'phrase', phrase }, () => ''))}
        </button>
      ));
    }
    if (activeTab === 'announcement') {
      if (targeting) {
        return (
          <>
            <p id="reaction-target-heading">{translate(locale, 'reactionPickTarget', { action: actionName(locale, targeting) })}</p>
            {targets.map((t, i) => (
              <button key={t.id} autoFocus={i === 0} disabled={coolingDown} onClick={() => send({ kind: 'announcement', action: targeting, targetId: t.id })}>
                <span className="reaction-name">{t.name}</span>
              </button>
            ))}
            <button className="ghost" onClick={() => setPickingTargetFor(null)}>{translate(locale, 'cancel')}</button>
          </>
        );
      }
      return ACTIONS.map((a) => (
        <button
          key={a.type}
          disabled={coolingDown}
          onClick={() => (a.needsTarget ? setPickingTargetFor(a.type) : send({ kind: 'announcement', action: a.type }))}
        >
          {actionName(locale, a.type)}
        </button>
      ));
    }
    return [true, false].map((has) => {
      const label = translate(locale, has ? 'reactionHasLabel' : 'reactionHasNotLabel');
      return (
        <div key={String(has)} className="reaction-verbal-row" role="group" aria-label={label}>
          <span className="reaction-verbal-label" aria-hidden="true">{label}</span>
          {ROLES.map((role) => (
            <button key={role} disabled={coolingDown} onClick={() => send({ kind: 'verbalClaim', has, role })}>
              {roleName(locale, role)}
            </button>
          ))}
        </div>
      );
    });
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
        {translate(locale, 'reactionToggle')}
      </button>
      {/* 常驻挂载，高度在 0fr ↔ 1fr 之间过渡（同 .notice-region）；收起时 inert，读屏和 Tab 跳过 */}
      <div className={`collapse reaction-collapse${open ? ' open' : ''}`} onTransitionEnd={onCollapseEnd} {...{ inert: open ? undefined : '' }}>
        <div className="reaction-collapse-inner">
          <div id="reaction-tray" ref={trayRef} className="reaction-tray">
            <div className="reaction-tabs" role="tablist" aria-label={translate(locale, 'reactionToggle')}>
              {(['phrase', 'announcement', 'verbalClaim'] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={activeTab === t}
                  disabled={phrasesOnly && t !== 'phrase'}
                  onClick={() => { setTab(t); setPickingTargetFor(null); }}
                >
                  {translate(locale, TAB_LABELS[t])}
                </button>
              ))}
            </div>
            <div
              ref={gridRef}
              className={`reaction-grid reaction-grid--${activeTab}`}
              role={targeting ? 'group' : undefined}
              aria-labelledby={targeting ? 'reaction-target-heading' : undefined}
            >
              {phrasesOnly && <p className="reaction-hint">{translate(locale, ended ? 'reactionGameOverHint' : 'reactionEliminatedHint')}</p>}
              {buttons()}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
