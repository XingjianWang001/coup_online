import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { Card, PublicState } from '@coup/shared';
import { roleName } from './rules.ts';
import { nameOf } from './narration.ts';
import { useDialogFocus } from './dialog.ts';
import { animate, prefersReducedMotion, REVEAL_STEPS_MS } from './motion.ts';
import type { ShowdownView } from './session.ts';
import { translate, type Locale } from './localization.ts';
import { DecisionTimer, type Clock } from './clock.tsx';
import { BigCard, RoleIcon } from './icons.tsx';

// ---------- 对质舞台与私下选牌（动效：聚光、静止的牌带发热边框、快速翻牌、盖章；原型分支未归档） ----------
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 翻牌器从 180°（牌背朝外）转到 0°（牌面朝外）
const flipTo = (deg: number): Keyframe => ({ transform: `perspective(1000px) rotateY(${deg}deg)` });

const FOCUS_SEND_MS = 100;

// 放大展示的一张牌：down 是翻开前朝外的一面，up 是翻开后的牌面；incoming 是质疑失败后换来的新牌
function StageCard(props: {
  down: ReactNode;
  up: ReactNode;
  incoming?: ReactNode;
  focus: boolean;
  picked: boolean;
  interactive: boolean;
  label?: string;
  onFocus?: (on: boolean) => void;
  onPick?: () => void;
  slotRef: (el: HTMLElement | null) => void;
}) {
  const body = (
    <>
      <span className="stage-ring" />
      <span className="stage-card">
        <span className="stage-heat" />
        <span className="stage-flipper">
          <span className="stage-down">{props.down}</span>
          <span className="stage-up">{props.up}</span>
        </span>
      </span>
      {props.incoming && <span className="stage-incoming">{props.incoming}</span>}
    </>
  );
  const data = { 'data-focus': props.focus || undefined, 'data-picked': props.picked || undefined };
  // 标签在整场里不能变，否则揭晓动画会落在被卸载的旧节点上：交互与否只看 aria-disabled
  if (props.label === undefined) {
    return <div ref={props.slotRef} className="stage-slot" {...data}>{body}</div>;
  }
  return (
    <button
      ref={props.slotRef as (el: HTMLButtonElement | null) => void}
      type="button"
      className="stage-slot"
      {...data}
      aria-pressed={props.picked}
      aria-disabled={!props.interactive}
      aria-label={props.label}
      onMouseEnter={() => props.interactive && props.onFocus?.(true)}
      onMouseLeave={() => props.interactive && props.onFocus?.(false)}
      onFocus={() => props.interactive && props.onFocus?.(true)}
      onBlur={() => props.interactive && props.onFocus?.(false)}
      onClick={() => props.interactive && props.onPick?.()}
    >
      {body}
    </button>
  );
}

const StageBack = () => <span className="card-back stage-back" aria-hidden="true" />;

// 对质：全场可见。被质疑者在放大的暗牌中选一张翻开，其他人看到牌背、同步的悬停和翻牌。
// 揭晓后舞台留到动画播完再调用 onDone（会话的 showdown 由此清空）。
export function ShowdownStage(props: {
  view: ShowdownView;
  state: PublicState;
  me: string | undefined;
  locale: Locale;
  clock: Clock | null;
  onFocus: (slot: number | null) => void;
  onReveal: (cardId: string) => void;
  onDone: () => void;
}) {
  const { view, state, locale } = props;
  const mine = view.claimantId === props.me;
  const hand = mine ? view.hand ?? [] : [];
  const [hover, setHover] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const slots = useRef<(HTMLElement | null)[]>([]);
  const backRef = useRef<HTMLButtonElement>(null);
  const firstFocus = useRef<HTMLElement | null>(null);
  const onDone = useRef(props.onDone);
  onDone.current = props.onDone;
  useDialogFocus(() => {}, root, firstFocus as RefObject<HTMLElement>);

  const choosing = !view.reveal && !sent;
  // 被质疑者对准的牌：悬停优先，其次点选；旁观者看服务器转发的。揭晓时被翻开的那张保持抬起，牌不再动
  const focus = view.reveal ? (mine ? null : view.reveal.slot) : mine ? (sent ? null : hover ?? picked) : view.focus;
  // 悬停同步每 FOCUS_SEND_MS 最多发一次，尾随补发最后的位置（服务器丢弃更密的消息，丢掉末次会让旁观者看到错的牌抬着）
  const sentFocus = useRef<{ slot: number | null; at: number; timer?: ReturnType<typeof setTimeout> }>({ slot: null, at: 0 });
  useEffect(() => {
    if (!mine || !choosing) return;
    const relay = sentFocus.current;
    clearTimeout(relay.timer);
    const flush = () => {
      if (relay.slot === focus) return;
      relay.slot = focus;
      relay.at = Date.now();
      props.onFocus(focus);
    };
    const wait = FOCUS_SEND_MS - (Date.now() - relay.at);
    if (wait <= 0) flush();
    else relay.timer = setTimeout(flush, wait);
    return () => clearTimeout(relay.timer);
  }, [mine, choosing, focus]);

  useEffect(() => {
    if (asking) backRef.current?.focus();
  }, [asking]);
  // 超时由服务器默认选择后，二次确认随之作废
  useEffect(() => {
    if (view.reveal) setAsking(false);
  }, [view.reveal]);

  // 揭晓：暗场 → 牌静止、牌框升温 → 快翻 → 盖印 → 换牌或落回座位
  const played = useRef(false);
  useEffect(() => {
    const reveal = view.reveal;
    if (!reveal || played.current || !root.current) return;
    played.current = true;
    let alive = true;
    const el = root.current;
    const slot = slots.current[reveal.slot];
    if (!slot) {
      onDone.current();
      return;
    }
    const $ = (sel: string, from: Element = el) => from.querySelector<HTMLElement>(sel)!;
    const card = $('.stage-card', slot);
    const heat = $('.stage-heat', slot);
    const others = slots.current.filter((s, i) => s && i !== reveal.slot) as HTMLElement[];
    const reduced = prefersReducedMotion();
    // 焦点从牌上移回舞台本身，免得已不可选的牌还留着焦点外圈
    el.focus();

    (async () => {
      const r = slot.getBoundingClientRect();
      const spot = $('.stage-spot');
      spot.style.setProperty('--sx', `${r.left + r.width / 2}px`);
      spot.style.setProperty('--sy', `${r.top + r.height / 2}px`);
      for (const other of others) animate(other, [{ opacity: 0.15 }], { duration: 450 });
      animate($('.stage-title'), [{ opacity: 0.5 }], { duration: 450 });
      animate(spot, [{ opacity: 1 }], { duration: 600, easing: 'ease-out' });
      animate(heat, [{ opacity: 0 }, { opacity: 1 }], { duration: REVEAL_STEPS_MS.suspense, easing: 'cubic-bezier(0.6, 0, 0.9, 0.5)' });
      await sleep(REVEAL_STEPS_MS.suspense);
      if (!alive) return;
      const flipper = $('.stage-flipper', slot);
      if (reduced) flipper.animate([flipTo(0)], { duration: 0, fill: 'forwards' });
      else await animate(flipper, [flipTo(0)], { duration: REVEAL_STEPS_MS.flip, easing: 'cubic-bezier(0.3, 0, 0.1, 1)' });
      animate(heat, [{ opacity: 0 }], { duration: 500 });
      if (reveal.truth) {
        // 属实：角色色从牌后漫开
        animate($('.stage-flood', slot.parentElement!), [{ opacity: 0.95, transform: 'scale(0.3)' }, { opacity: 0.45, transform: 'scale(1)' }], {
          duration: 1100,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        });
      } else {
        animate($('.stage-up', slot), [{ filter: 'saturate(0.25) brightness(0.65)' }], { duration: 800, easing: 'ease-out' });
        if (!reduced) animate(card, [{ transform: 'translateY(14px)' }], { duration: 700, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
      }
      const verdict = $('.stage-verdict');
      animate(verdict, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
      if (!reduced) {
        animate($('.stage-stamp'), [{ transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' });
      }
      await sleep(REVEAL_STEPS_MS.verdict);
      if (!alive) return;

      if (reveal.truth) {
        // 证明牌洗回牌堆，新牌从牌堆发回：旁观者看到牌背，本人看到牌面
        const incoming = $('.stage-incoming', slot);
        if (reduced) {
          await animate(card, [{ opacity: 0 }], { duration: 250 });
          await animate(incoming, [{ opacity: 0 }, { opacity: 1 }], { duration: 250 });
        } else {
          await animate(card, [{ transform: 'translateY(-80vh) rotate(14deg)' }], { duration: REVEAL_STEPS_MS.toss, easing: 'cubic-bezier(0.7, 0, 0.84, 0)' });
          await animate(incoming, [
            { opacity: 1, transform: 'translateY(-80vh) rotate(-16deg)', easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
            { opacity: 1, transform: 'translateY(24px) rotate(-5deg)', offset: 0.65, easing: 'cubic-bezier(0.45, 0, 0.55, 1)' },
            { opacity: 1, transform: 'none' },
          ], { duration: REVEAL_STEPS_MS.deal });
        }
        await sleep(REVEAL_STEPS_MS.settle);
        if (!alive) return;
        await animate(el, [{ opacity: 0 }], { duration: REVEAL_STEPS_MS.fade });
      } else {
        // 翻开的牌缩回被质疑者座位，成为明牌
        for (const fading of [$('.stage-backdrop'), spot, $('.stage-title'), verdict, ...others]) {
          animate(fading, [{ opacity: 0 }], { duration: 450, easing: 'ease-out' });
        }
        const target = document.querySelector(`[data-seat="${view.claimantId}"] .cards-row > :last-child`)?.getBoundingClientRect();
        const cur = card.getBoundingClientRect();
        if (target && !reduced) {
          const dx = target.left + target.width / 2 - (cur.left + cur.width / 2);
          const dy = target.top + target.height / 2 - (cur.top + cur.height / 2);
          await animate(card, [{ transform: `translate(${dx}px, ${dy}px) scale(${target.width / cur.width})`, opacity: 0.4 }], {
            duration: REVEAL_STEPS_MS.shrink,
            easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
          });
        } else {
          await animate(card, [{ opacity: 0 }], { duration: 300 });
        }
      }
      if (alive) onDone.current();
    })();
    return () => {
      alive = false;
    };
  }, [view.reveal]);

  function confirm() {
    if (picked === null) return;
    if (hand.some((c) => c.role === view.role) && hand[picked].role !== view.role) setAsking(true);
    else reveal();
  }
  function reveal() {
    setAsking(false);
    setSent(true);
    props.onReveal(hand[picked!].id);
  }

  const truth = view.reveal?.truth ?? false;
  const roleLabel = roleName(locale, view.role);
  const challenger = nameOf(state, view.challengerId);
  const claimant = nameOf(state, view.claimantId);
  const title = mine
    ? translate(locale, 'showdownTitleYou', { challenger })
    : view.challengerId === props.me
      ? translate(locale, 'showdownTitleByYou', { claimant })
      : translate(locale, 'showdownTitle', { challenger, claimant });

  return (
    <div
      ref={root}
      className="overlay stage-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} ${roleLabel}`}
      tabIndex={-1}
      data-revealing={sent || !!view.reveal || undefined}
    >
      <div className="stage-backdrop" />
      <div className="stage-spot" />
      <div className="stage">
        <h2 className="stage-title">
          <span>{title}</span>
          <span className={`stage-claim role--${view.role}`}><RoleIcon role={view.role} />{roleLabel}</span>
        </h2>
        <div className="stage-cards">
          {Array.from({ length: view.slots }, (_, i) => {
            const own = hand[i];
            const upRole = own?.role ?? (view.reveal?.slot === i ? view.reveal.role : null);
            const swapped = view.reveal?.truth && view.reveal.slot === i;
            return (
              <div key={i} className="stage-cell" style={upRole ? ({ '--role': `var(--${upRole})` } as CSSProperties) : undefined}>
                <span className="stage-flood" />
                <StageCard
                  slotRef={(el) => {
                    slots.current[i] = el;
                    if (i === 0 && mine) firstFocus.current = el;
                  }}
                  down={own ? <BigCard role={own.role} locale={locale} /> : <StageBack />}
                  up={upRole ? <BigCard role={upRole} locale={locale} /> : <StageBack />}
                  incoming={swapped ? (mine && view.newCard ? <BigCard role={view.newCard.role} locale={locale} /> : <StageBack />) : undefined}
                  focus={focus === i}
                  picked={!view.reveal ? picked === i : mine && view.reveal.slot === i}
                  interactive={choosing}
                  label={own && roleName(locale, own.role)}
                  onFocus={(on) => setHover((h) => (on ? i : h === i ? null : h))}
                  onPick={() => setPicked(i)}
                />
              </div>
            );
          })}
        </div>
        <div className="stage-foot">
          {view.reveal ? (
            <div className="stage-verdict" data-truth={truth || undefined}>
              <span className="stage-stamp">{translate(locale, truth ? 'challengeFailed' : 'challengeSucceeded')}</span>
            </div>
          ) : (
            <div className="stage-status">
              {/* 旁观者必须看到在等谁，否则会以为要自己操作 */}
              {!mine && <p>{translate(locale, 'waitingForShowdown', { name: claimant })}</p>}
              <div className="stage-actions">
                {!asking && <DecisionTimer clock={props.clock} locale={locale} />}
                {mine && (
                  <button className="primary" disabled={picked === null || sent} onClick={confirm}>
                    {translate(locale, 'revealThis')}
                  </button>
                )}
              </div>
            </div>
          )}
          {asking && (
            <div className="stage-ask" role="alertdialog" aria-labelledby="stage-ask-text">
              <p id="stage-ask-text">{translate(locale, 'showdownRevealOther', { role: roleLabel })}</p>
              <div className="stage-actions">
                <DecisionTimer clock={props.clock} locale={locale} />
                <button ref={backRef} onClick={() => setAsking(false)}>{translate(locale, 'back')}</button>
                <button className="primary" onClick={reveal}>{translate(locale, 'revealAnyway')}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 失去影响力（政变、暗杀、质疑失败的质疑者）：只有本人看到的放大选牌；翻开的牌褪色下沉后才发出意图
export function LossStage(props: { hand: Card[]; locale: Locale; clock: Clock | null; onLose: (cardId: string) => void }) {
  const { hand, locale } = props;
  const [picked, setPicked] = useState<number | null>(null);
  const [sent, setSent] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const firstFocus = useRef<HTMLElement | null>(null);
  const slots = useRef<(HTMLElement | null)[]>([]);
  useDialogFocus(() => {}, root, firstFocus as RefObject<HTMLElement>);

  async function lose() {
    if (picked === null || sent) return;
    setSent(true);
    const slot = slots.current[picked];
    if (slot && !prefersReducedMotion()) {
      await animate(slot.querySelector('.stage-card')!, [{ transform: 'translateY(14px)', filter: 'saturate(0.25) brightness(0.65)' }], {
        duration: 450,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      });
    }
    props.onLose(hand[picked].id);
  }

  const title = translate(locale, 'lossTitle');
  return (
    <div ref={root} className="overlay stage-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="stage-backdrop" />
      <div className="stage">
        <h2 className="stage-title">{title}</h2>
        <div className="stage-cards">
          {hand.map((card, i) => (
            <div key={card.id} className="stage-cell">
              <StageCard
                slotRef={(el) => {
                  slots.current[i] = el;
                  if (i === 0) firstFocus.current = el;
                }}
                down={<BigCard role={card.role} locale={locale} />}
                up={<BigCard role={card.role} locale={locale} />}
                focus={false}
                picked={picked === i}
                interactive={!sent}
                label={roleName(locale, card.role)}
                onPick={() => setPicked(i)}
              />
            </div>
          ))}
        </div>
        <div className="stage-foot">
          <div className="stage-actions">
            <DecisionTimer clock={props.clock} locale={locale} />
            <button className="primary" disabled={picked === null || sent} onClick={lose}>{translate(locale, 'revealThis')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 大使交换：只有本人看到的放大选牌；弃牌像对质换牌一样飞回牌堆后才发出意图
export function ExchangeStage(props: {
  hand: Card[];
  keepCount: number;
  locale: Locale;
  clock: Clock | null;
  onKeep: (cardIds: string[]) => void;
}) {
  const { hand, keepCount, locale } = props;
  const [kept, setKept] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const firstFocus = useRef<HTMLElement | null>(null);
  const slots = useRef<(HTMLElement | null)[]>([]);
  useDialogFocus(() => {}, root, firstFocus as RefObject<HTMLElement>);

  // 选满后再点未选的牌不响应，须先取消一张
  const toggle = (id: string) =>
    setKept((k) => (k.includes(id) ? k.filter((x) => x !== id) : k.length < keepCount ? [...k, id] : k));

  async function keep() {
    if (kept.length !== keepCount || sent) return;
    setSent(true);
    const reduced = prefersReducedMotion();
    await Promise.all(
      hand.flatMap((card, i) => {
        const el = kept.includes(card.id) ? null : slots.current[i]?.querySelector('.stage-card');
        if (!el) return [];
        return reduced
          ? animate(el, [{ opacity: 0 }], { duration: 250 })
          : animate(el, [{ transform: 'translateY(-80vh) rotate(14deg)' }], { duration: 420, easing: 'cubic-bezier(0.7, 0, 0.84, 0)' });
      }),
    );
    props.onKeep(hand.filter((c) => kept.includes(c.id)).map((c) => c.id));
  }

  const title = translate(locale, 'exchangePrompt', { count: keepCount });
  return (
    <div ref={root} className="overlay stage-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="stage-backdrop" />
      <div className="stage">
        <h2 className="stage-title">{title}</h2>
        <div className="stage-cards">
          {hand.map((card, i) => (
            <div key={card.id} className="stage-cell">
              <StageCard
                slotRef={(el) => {
                  slots.current[i] = el;
                  if (i === 0) firstFocus.current = el;
                }}
                down={<BigCard role={card.role} locale={locale} />}
                up={<BigCard role={card.role} locale={locale} />}
                focus={false}
                picked={kept.includes(card.id)}
                interactive={!sent}
                label={roleName(locale, card.role)}
                onPick={() => toggle(card.id)}
              />
            </div>
          ))}
        </div>
        <div className="stage-foot">
          <div className="stage-actions">
            <DecisionTimer clock={props.clock} locale={locale} />
            <button className="primary" disabled={kept.length !== keepCount || sent} onClick={keep}>{translate(locale, 'confirmKeep')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
