import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ACTION_CLAIM, ASSASSINATE_COST, BLOCK_ROLES, COUP_COST, FORCED_COUP_COINS, MAX_PLAYERS, STRENGTHS, type ActionType, type Card, type LobbyPlayer, type PublicState, type Reaction, type Role, type Strength } from '@coup/shared';
import { connect, send } from './socket.ts';
import { actionName, ACTIONS, roleName, roleShortName } from './rules.ts';
import { describePending, describeReaction, describeWaiting, groupLog, nameOf, reactionText, type LogEntry } from './narration.ts';
import { copyToClipboard } from './clipboard.ts';
import { prefersReducedMotion, useSmoothHeight } from './motion.ts';
import type { SeatMotion } from './session.ts';
import { placeSeats, type PlacedSeat, type SeatSide } from './seating.ts';
import { localizeCoinCount, localizeNotice, translate, type Locale, type NoticeDescriptor } from './localization.ts';
import { DecisionTimer, type Clock } from './clock.tsx';
import { AddComputerIcon, CoinIcon, ComputerBadge, CrownIcon, Glyph, RoleIcon } from './icons.tsx';
import { ReactionTray } from './ReactionTray.tsx';

export interface TransientNoticeState {
  id: number;
  descriptor: NoticeDescriptor;
}

// 表态：每位玩家最多一条，新的顶掉旧的，REACTION_MS 后自己消失
export interface ReactionBubble {
  id: number;
  reaction: Reaction;
}

// 最近一条表态单独留着给读屏朗读：气泡过期时不能让更早的一条被重新朗读
export interface LatestReaction extends ReactionBubble {
  playerId: string;
}

const CONTROLS_ARM_MS = 500; // 控制区换内容后多久才收输入，见 GameBoard 的 armedKey

function InviteLink(props: {
  roomCode: string;
  url: string | null;
  loading: boolean;
  onStart: () => void;
  locale: Locale;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const fullUrl = props.url ? `${props.url}?room=${props.roomCode}` : '';
  const copy = async () => {
    const ok = await copyToClipboard(fullUrl);
    setCopied(ok);
    setCopyFailed(!ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  };
  if (props.url) {
    return (
      <div className="invite">
        <span className="invite-label">{translate(props.locale, 'inviteLink')}</span>
        <div className="row">
          <input className="invite-input" readOnly value={fullUrl} onFocus={(e) => e.currentTarget.select()} />
          <button onClick={copy}>
            {translate(props.locale, copied ? 'copied' : copyFailed ? 'copyFailed' : 'copy')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="invite">
      <button onClick={props.onStart} disabled={props.loading}>
        {translate(props.locale, props.loading ? 'tunnelStarting' : 'generateInviteLink')}
      </button>
    </div>
  );
}

interface RoomViewProps {
  roomCode: string;
  hostId: string;
  me: string | undefined;
  players: LobbyPlayer[];
  publicState: PublicState | null;
  hand: Card[];
  notice: TransientNoticeState | null;
  reactions: Record<string, ReactionBubble>;
  latestReaction: LatestReaction | null;
  onDismissReaction: (playerId: string) => void;
  selectedAction: ActionType | null;
  setSelectedAction: (a: ActionType | null) => void;
  onStart: () => void;
  onAction: (action: ActionType, targetId?: string) => void;
  socket: ReturnType<typeof connect>;
  clock: Clock | null;
  log: LogEntry[];
  motions: SeatMotion[];
  onMotionDone: (id: number) => void;
  tunnelUrl: string | null;
  canStartTunnel: boolean;
  tunnelLoading: boolean;
  onStartTunnel: () => void;
  locale: Locale;
}

export function RoomView(props: RoomViewProps) {
  const { publicState, me } = props;
  // 与服务器 canStartTunnel 认的本机页面一致（server/src/tunnel.ts）
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  if (!publicState) {
    return (
      <div className="room">
        <div
          className="roomcode"
          aria-label={`${translate(props.locale, 'roomCode')} ${props.roomCode}${translate(props.locale, 'roomCodeHelp')}`}
        >
          {translate(props.locale, 'roomCode')} <b>{props.roomCode}</b>
          {translate(props.locale, 'roomCodeHelp')}
        </div>
        {me === props.hostId && (!isLocal || props.canStartTunnel || props.tunnelUrl) && (
          <InviteLink
            roomCode={props.roomCode}
            url={isLocal ? props.tunnelUrl : window.location.origin}
            loading={props.tunnelLoading}
            onStart={props.onStartTunnel}
            locale={props.locale}
          />
        )}
        {/* 添加按钮钉在标题行右侧：人数变了它也不挪位置 */}
        <div className="roster-head">
          <h3>{translate(props.locale, 'playersCount', { count: props.players.length })}</h3>
          {me === props.hostId && (
            <button
              className="ghost icon-button"
              aria-label={translate(props.locale, 'addComputer')}
              title={translate(props.locale, 'addComputer')}
              onClick={() => send(props.socket, { type: 'addComputer' })}
              disabled={props.players.length >= MAX_PLAYERS}
            >
              <AddComputerIcon />
            </button>
          )}
        </div>
        <ul className="playerlist">
          {props.players.map((p) => (
            <li key={p.id} className={p.isHost ? 'host' : ''}>
              <span>
                {p.isPreviousWinner && (
                  <span role="img" aria-label={translate(props.locale, 'previousWinner')} title={translate(props.locale, 'previousWinner')}>
                    <CrownIcon />{' '}
                  </span>
                )}
                {p.strength && <ComputerBadge strength={p.strength} locale={props.locale} />}
                {p.name}
                {p.isHost && translate(props.locale, 'hostSuffix')}
                {!p.connected && translate(props.locale, 'offlineSuffix')}
              </span>
              {p.strength && me === props.hostId && (
                <span className="computer-controls">
                  <span className="segmented" role="group" aria-label={translate(props.locale, 'computerStrength', { name: p.name })}>
                    {STRENGTHS.map((strength) => (
                      <button
                        key={strength}
                        className={p.strength === strength ? 'selected' : ''}
                        aria-pressed={p.strength === strength}
                        onClick={() => p.strength !== strength && send(props.socket, { type: 'setComputerStrength', playerId: p.id, strength })}
                      >
                        {translate(props.locale, strength === 'strong' ? 'strongStrength' : 'standardStrength')}
                      </button>
                    ))}
                  </span>
                  <button
                    className="ghost icon-button"
                    aria-label={translate(props.locale, 'removeComputer', { name: p.name })}
                    title={translate(props.locale, 'removeComputer', { name: p.name })}
                    onClick={() => send(props.socket, { type: 'removeComputer', playerId: p.id })}
                  >
                    <Glyph size={18}>
                      <line x1="6" y1="6" x2="18" y2="18" />
                      <line x1="18" y1="6" x2="6" y2="18" />
                    </Glyph>
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {me === props.hostId && (
          <button className="primary" onClick={props.onStart} disabled={props.players.length < 2}>
            {translate(props.locale, 'startGame')} ({translate(props.locale, 'startGameRequirement')})
          </button>
        )}
      </div>
    );
  }

  return (
    <GameBoard
      state={publicState}
      hand={props.hand}
      me={me}
      hostId={props.hostId}
      computers={new Map(props.players.flatMap((p) => (p.strength ? [[p.id, p.strength] as const] : [])))}
      notice={props.notice}
      reactions={props.reactions}
      latestReaction={props.latestReaction}
      onDismissReaction={props.onDismissReaction}
      clock={props.clock}
      log={props.log}
      motions={props.motions}
      onMotionDone={props.onMotionDone}
      selectedAction={props.selectedAction}
      setSelectedAction={props.setSelectedAction}
      onAction={props.onAction}
      onIntent={(i) => send(props.socket, i)}
      locale={props.locale}
    />
  );
}

// 明牌只靠视觉暗淡区分；读屏另给「已翻开」文案，界面不加字。
// 悬浮看名字：自己的大牌把图标换成名字，对手的小牌弹出同色气泡（仅限有悬浮的设备）。
// postGameRevealed：赛后揭晓的牌，全彩牌面（不置灰），以此与明牌区分（ADR 0005）
function CardView({ role, locale, unavailable, small, postGameRevealed }: { role: Role; locale: Locale; unavailable?: boolean; small?: boolean; postGameRevealed?: boolean }) {
  const label = roleName(locale, role);
  const card = (
    <div
      className={`card card--${role}${unavailable ? ' unavailable' : ''}${postGameRevealed ? ' post-game-revealed' : ''}`}
      role="img"
      aria-label={translate(locale, unavailable ? 'cardRevealed' : postGameRevealed ? 'cardPostGameRevealed' : 'cardFace', { role: label })}
    >
      <RoleIcon role={role} />
      {!small && <CardName name={label} short={roleShortName(locale, role)} />}
    </div>
  );
  if (!small) return card;
  // 气泡放在牌外，免得随明牌一起变暗
  return (
    <span className="card-tip-anchor" style={{ '--tip': `var(--${role})` } as CSSProperties}>
      {card}
      <span className="card-tip" aria-hidden="true">{label}</span>
    </span>
  );
}

// 名字按字数缩放到占满牌宽；按每字约 2/3 em 估算，缩到 12px 以下就换缩写：
// 桌面牌（内宽 68px）容得下 8 个字母，手机牌（内宽 54px）只容得下 6 个。字数估算是有意的简化。
function CardName({ name, short }: { name: string; short?: string }) {
  const fit = !short || name.length <= 6 ? 'always' : name.length <= 8 ? 'desktop' : 'never';
  return (
    <span className="card-name" data-fit={fit} aria-hidden="true">
      <span className="full" style={{ '--len': name.length } as CSSProperties}>{name}</span>
      {short && <span className="short" style={{ '--len': short.length } as CSSProperties}>{short}</span>}
    </span>
  );
}

function CardBack({ locale }: { locale: Locale }) {
  return <div className="card-back" role="img" aria-label={translate(locale, 'cardBack')} />;
}

export function TransientMessage<T extends { id: number }>(props: {
  value: T | null;
  className: string;
  regionClassName?: string;
  role: 'alert' | 'status';
  ariaLive: 'assertive' | 'polite';
  render: (value: T) => ReactNode;
}) {
  const [renderedValue, setRenderedValue] = useState(props.value);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (props.value) {
      setRenderedValue(props.value);
      setExiting(false);
      return;
    }
    if (!renderedValue) return;

    setExiting(true);
  }, [props.value, renderedValue]);

  const visibleValue = props.value ?? renderedValue;
  if (!visibleValue) return null;

  return (
    <div
      className={`notice-region${props.regionClassName ? ` ${props.regionClassName}` : ''}${exiting && !props.value ? ' exiting' : ''}`}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== 'grid-template-rows' || !exiting || props.value) {
          return;
        }
        setRenderedValue(null);
        setExiting(false);
      }}
    >
      <div className="notice-region-inner">
        <div
          className={`${props.className} transient-message`}
          key={visibleValue.id}
          role={props.role}
          aria-live={props.ariaLive}
          aria-atomic="true"
        >
          {props.render(visibleValue)}
        </div>
      </div>
    </div>
  );
}

// 新声称：角色从声称者身后显形（prototype/claim-ghost 的变体 A）。真声称只在本机：背后灵从手里那张牌升起，
// 那张牌像对质「属实」时那样漫开一团角色色的光，再收回去。手里两张都是这个角色时两张都亮，背后灵只有一个
const GHOST_MS = 1000;

const HONEST_GLOW_MS = 1600;

const EASE_OUT_EXPO = 'cubic-bezier(0.16, 1, 0.3, 1)';

const EASE_IN_OUT = 'cubic-bezier(0.45, 0, 0.55, 1)';

function SeatGhost({ motion, onDone }: { motion: Extract<SeatMotion, { kind: 'ghost' }>; onDone: (id: number) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const ghost = ref.current!;
    const seat = ghost.parentElement!;
    const reduced = prefersReducedMotion();
    const box = seat.getBoundingClientRect();
    const center = (r: DOMRect) => ({ x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 });
    const cards = motion.honest ? [...seat.querySelectorAll<HTMLElement>(`.cards-row .card--${motion.role}:not(.unavailable)`)] : [];
    const size = box.height * 1.2;
    const at = cards[0] ? center(cards[0].getBoundingClientRect()) : { x: box.width / 2, y: box.height / 2 };
    Object.assign(ghost.style, { left: `${at.x - size / 2}px`, top: `${at.y - size / 2}px`, width: `${size}px`, height: `${size}px` });
    const runs = [
      reduced
        ? ghost.animate([{ opacity: 0 }, { opacity: 0.35, offset: 0.4 }, { opacity: 0 }], { duration: 600, fill: 'both' })
        : ghost.animate([
            { opacity: 0, transform: 'scale(0.7)' },
            { opacity: 0.5, transform: 'scale(1.05)', offset: 0.3 },
            { opacity: 0, transform: 'scale(1.5)' },
          ], { duration: GHOST_MS, easing: EASE_OUT_EXPO, fill: 'both' }),
    ];
    const glows: HTMLElement[] = [];
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      const c = center(r);
      const d = r.width * 3.4;
      const glow = document.createElement('span');
      glow.className = 'seat-glow';
      Object.assign(glow.style, { left: `${c.x - d / 2}px`, top: `${c.y - d / 2}px`, width: `${d}px`, height: `${d}px` });
      glow.style.setProperty('--glow', `var(--${motion.role})`);
      seat.append(glow);
      glows.push(glow);
      runs.push(glow.animate(reduced
        ? [{ opacity: 0, easing: EASE_IN_OUT }, { opacity: 0.7, offset: 0.35, easing: EASE_IN_OUT }, { opacity: 0 }]
        : [
            { opacity: 0, transform: 'scale(0.3)', easing: EASE_OUT_EXPO },
            { opacity: 0.85, transform: 'scale(1)', offset: 0.35, easing: EASE_IN_OUT },
            { opacity: 0, transform: 'scale(0.5)' },
          ], { duration: HONEST_GLOW_MS, fill: 'both' }));
      runs.push(card.animate([
        { filter: 'brightness(1) saturate(1)', easing: EASE_OUT_EXPO },
        { filter: 'brightness(1.45) saturate(1.2)', offset: 0.35, easing: EASE_IN_OUT },
        { filter: 'brightness(1) saturate(1)' },
      ], { duration: HONEST_GLOW_MS }));
    }
    Promise.all(runs.map((a) => a.finished)).then(() => onDone(motion.id), () => {});
    return () => {
      runs.forEach((a) => a.cancel());
      glows.forEach((g) => g.remove());
    };
  }, [motion, onDone]);
  return (
    <span ref={ref} className={`seat-ghost role--${motion.role}`} aria-hidden="true">
      <RoleIcon role={motion.role} />
    </span>
  );
}

// 针对性行动的目标在问询与对质期间被标出；进入选失去的影响力后让位给 losing
const TARGETED_PHASES: ReadonlySet<PublicState['phase']> = new Set(['awaitingChallenge', 'awaitingBlock', 'showdown']);

function GameBoard(props: {
  state: PublicState;
  hand: Card[];
  me: string | undefined;
  hostId: string;
  // 牌局中按大厅名单认出电脑玩家：电脑只在大厅阶段增减
  computers: ReadonlyMap<string, Strength>;
  notice: TransientNoticeState | null;
  reactions: Record<string, ReactionBubble>;
  latestReaction: LatestReaction | null;
  onDismissReaction: (playerId: string) => void;
  selectedAction: ActionType | null;
  setSelectedAction: (a: ActionType | null) => void;
  onAction: (action: ActionType, targetId?: string) => void;
  onIntent: (i: Parameters<typeof send>[1]) => void;
  clock: Clock | null;
  log: LogEntry[];
  motions: SeatMotion[];
  onMotionDone: (id: number) => void;
  locale: Locale;
}) {
  const { state, me } = props;
  const myView = state.players.find((p) => p.id === me);
  const isMyTurn = state.currentPlayerId === me;
  const aliveOthers = state.players.filter((p) => p.alive && p.id !== me);
  const pending = state.pending;

  const meIsClaimant =
    state.challengeSubject === 'action'
      ? pending?.actorId === me
      : state.challengeSubject === 'block'
        ? pending?.blockById === me
        : false;

  const passed = !!me && state.passed.includes(me);
  const canChallenge = state.phase === 'awaitingChallenge' && !!myView?.alive && !meIsClaimant && !passed;

  let canBlock = false;
  let canBlockRoles: readonly Role[] = [];
  if (state.phase === 'awaitingBlock' && pending) {
    // 外援人人可挡；其余可阻挡的行动只有目标能挡
    canBlock = (pending.action === 'foreignAid' ? pending.actorId !== me : pending.targetId === me) && !!myView?.alive && !passed;
    canBlockRoles = BLOCK_ROLES[pending.action];
  }

  const amLosing = state.phase === 'choosingLoss' && state.lossPlayerId === me;
  // 赛后揭晓：获胜者点暗牌向所有人翻开
  const canPostGameReveal = state.phase === 'gameOver' && !!me && state.winnerId === me;
  const postGameRevealLeft = canPostGameReveal && (myView?.postGameRevealed.length ?? 0) < props.hand.length;
  const amExchanging = state.phase === 'choosingExchange' && pending?.actorId === me;
  // 对质时等待提示由对质舞台给出，控制区不再重复
  const waiting = me && state.phase !== 'showdown' ? describeWaiting(state, me, props.locale) : null;
  const timer = <DecisionTimer clock={props.clock} locale={props.locale} />;

  const narration = describePending(state, props.locale);
  const centerText = narration ?? (isMyTurn && state.phase === 'choosingAction' ? translate(props.locale, 'yourTurn') : null);

  type SeatPlayer = PublicState['players'][number];
  const seats = placeSeats(state.players, me);
  const rails: Record<SeatSide, PlacedSeat<SeatPlayer>[]> = { left: [], top: [], right: [] };
  for (const s of seats.opponents) rails[s.side].push(s);

  const describe = (reaction: Reaction) => describeReaction(props.locale, reaction, (id) => nameOf(state, id));
  // 铭牌：贴在座位下沿常驻占位，有人表态时亮起，表态出现不会推动任何东西。
  // 文字由下方 live region 朗读，这里对读屏隐藏；点掉只是鼠标/触屏的便利，不进 Tab 顺序
  const renderNameplate = (playerId: string) => {
    const bubble = props.reactions[playerId];
    return (
      <div
        className={`nameplate${bubble ? ' speaking' : ''}`}
        aria-hidden="true"
        title={bubble ? translate(props.locale, 'reactionDismiss') : undefined}
        onClick={bubble ? () => props.onDismissReaction(playerId) : undefined}
      >
        {bubble && (
          <span key={bubble.id} className="nameplate-text">
            {describe(bubble.reaction).map((segment, i) =>
              typeof segment === 'string' ? segment : (
                <span key={i} className={segment.role ? `nameplate-role role--${segment.role}` : segment.target ? 'nameplate-target' : undefined}>
                  {segment.text}
                </span>
              ),
            )}
          </span>
        )}
      </div>
    );
  };
  const latest = props.latestReaction;

  // angle 缺省即自己的座位（近端）
  const renderSeat = (p: SeatPlayer, angle?: number) => {
    const isCurrent = p.id === state.currentPlayerId;
    // 正在私下选牌失去影响力的人：座位高亮，配合控制区的等待提示
    const isLosing = state.phase === 'choosingLoss' && p.id === state.lossPlayerId;
    // 交换选牌期间手里暂时多出抽到的牌，影响力仍是原来的张数
    const influence = state.phase === 'choosingExchange' && p.id === pending?.actorId ? (state.exchangeKeepCount ?? p.handCount) : p.handCount;
    const isTargeted = p.alive && pending?.targetId === p.id && TARGETED_PHASES.has(state.phase);
    const coinMotion = props.motions.find((m) => m.playerId === p.id && m.kind === 'coins');
    const ghost = props.motions.find((m) => m.playerId === p.id && m.kind === 'ghost');
    return (
      <div
        key={p.id}
        data-seat={p.id}
        className={`seat ${angle == null ? 'self' : 'opponent'}${isCurrent ? ' current' : ''}${isLosing ? ' losing' : ''}${isTargeted ? ' targeted' : ''}${p.alive ? '' : ' dead'}`}
        aria-current={isCurrent ? 'true' : undefined}
        style={angle == null ? undefined : ({ '--seat-angle': `${angle}deg` } as CSSProperties)}
      >
        <div className="seat-head">
          <span className="name">
            {props.computers.has(p.id) && <ComputerBadge strength={props.computers.get(p.id)!} locale={props.locale} />}
            {p.name}
            {p.id === me && translate(props.locale, 'selfMarker')}
            {isTargeted && <span className="visually-hidden">{translate(props.locale, 'targetedMarker')}</span>}
          </span>
          {p.alive ? (
            <span className="coins" role="img" aria-label={localizeCoinCount(props.locale, p.coins)}>
              <CoinIcon />
              <span key={`count-${coinMotion?.id ?? ''}`} className={coinMotion ? 'coin-count bump' : 'coin-count'}>{p.coins}</span>
              {coinMotion?.kind === 'coins' && (
                <span
                  key={`delta-${coinMotion.id}`}
                  className={`coin-delta ${coinMotion.delta > 0 ? 'gain' : 'loss'}`}
                  aria-hidden="true"
                  onAnimationEnd={() => props.onMotionDone(coinMotion.id)}
                >
                  {coinMotion.delta > 0 ? '+' : '−'}{Math.abs(coinMotion.delta)}
                </span>
              )}
            </span>
          ) : (
            <span className="seat-out">{translate(props.locale, 'eliminatedMarker')}</span>
          )}
        </div>
        <div className="cards-row" role="group" aria-label={translate(props.locale, 'influenceCount', { count: influence })}>
          {p.id === me
            ? props.hand.map((c, i) => {
                if (!canPostGameReveal) return <CardView key={c.id} role={c.role} locale={props.locale} />;
                const revealedNow = p.postGameRevealed.some((r) => r.slot === i);
                // 揭晓后仍是同一个按钮（aria-disabled），牌才能平滑落回座位一行
                return (
                  <button
                    key={c.id}
                    className="post-game-reveal"
                    aria-disabled={revealedNow || undefined}
                    aria-label={translate(props.locale, revealedNow ? 'cardPostGameRevealed' : 'cardPostGameHidden', { role: roleName(props.locale, c.role) })}
                    onClick={revealedNow ? undefined : () => props.onIntent({ type: 'revealPostGameCard', cardId: c.id })}
                  >
                    <CardView role={c.role} locale={props.locale} />
                  </button>
                );
              })
            : Array.from({ length: p.handCount }, (_, i) => {
                const shown = p.postGameRevealed.find((r) => r.slot === i);
                return shown
                  ? <CardView key={`back-${i}`} role={shown.role} locale={props.locale} small postGameRevealed />
                  : <CardBack key={`back-${i}`} locale={props.locale} />;
              })}
          {p.revealed.map((role, i) => (
            <CardView key={`rev-${i}`} role={role} locale={props.locale} unavailable small={p.id !== me} />
          ))}
        </div>
        {renderNameplate(p.id)}
        {ghost?.kind === 'ghost' && <SeatGhost key={ghost.id} motion={ghost} onDone={props.onMotionDone} />}
      </div>
    );
  };

  // 控制区内容切换的键：变化时重挂载以触发入场动画（避免行动选项闪现）
  let controlMode = 'waiting';
  if (state.phase === 'choosingAction' && isMyTurn) controlMode = 'action';
  else if (canChallenge) controlMode = 'challenge';
  else if (canBlock) controlMode = 'block';
  else if (amLosing) controlMode = 'loss';
  else if (amExchanging) controlMode = 'exchange';
  const controlKey = `${controlMode}:${state.currentPlayerId ?? ''}:${pending?.actorId ?? ''}:${state.lossPlayerId ?? ''}`;
  // 操作区外壳常驻，换内容（换模式、进出选目标、等待提示变化）时高度平滑过渡；内层按 controlKey 重挂载播入场动画
  const controlsRef = useRef<HTMLDivElement>(null);
  useSmoothHeight(controlsRef, [controlKey, props.selectedAction, waiting, props.locale]);
  // 换内容后短暂 inert：别人抢先阻挡外援时，按钮原地从「阻挡」换成「质疑」，手快的那一下不能落到新按钮上。
  // 固定时长是刻意的粗略估计：盖过入场动画和一次手快的点击，远短于决策倒计时
  const [armedKey, setArmedKey] = useState(controlKey);
  useEffect(() => {
    const timer = setTimeout(() => setArmedKey(controlKey), CONTROLS_ARM_MS);
    return () => clearTimeout(timer);
  }, [controlKey]);

  const groups = groupLog(props.log, state, props.locale).reverse();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggleGroup = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="board">
      <TransientMessage
        value={props.notice}
        className="notice"
        role="status"
        ariaLive="polite"
        render={(visibleNotice) => localizeNotice(props.locale, visibleNotice.descriptor)}
      />

      <div className="board-content">
        {state.phase === 'gameOver' && (
          <div className="notice big"><CrownIcon /> {translate(props.locale, 'winner', { name: nameOf(state, state.winnerId) })}</div>
        )}

      <div className="table" data-seats={seats.opponents.length}>
        <div className="opponent-seats">
          {(['left', 'top', 'right'] as const).map((side) => (
            <div key={side} className={`rail rail--${side}`}>
              {rails[side].map((s) => renderSeat(s.player, s.angle))}
            </div>
          ))}
        </div>
        {/* live 区常驻；倒计时放在外面，避免读屏每秒播报 */}
        <div className={`narration${centerText ? '' : ' is-empty'}`}>
          <span className="narration-text" aria-live="polite">
            {centerText && <span key={centerText} className="narration-line">{centerText}</span>}
          </span>
        </div>
      </div>

      {seats.self && renderSeat(seats.self)}

      <div className="controls" ref={controlsRef}>
      <div className="controls-body" key={controlKey} {...{ inert: armedKey === controlKey ? undefined : '' }}>
        {state.phase === 'choosingAction' && isMyTurn && (
          <Actions
            timer={timer}
            coins={myView?.coins ?? 0}
            selectedAction={props.selectedAction}
            onSelect={props.setSelectedAction}
            targets={aliveOthers}
            onAction={props.onAction}
            locale={props.locale}
          />
        )}

        {canChallenge && (
          <div className="row" role="group" aria-labelledby="challenge-heading">
            <p id="challenge-heading" className="decision-heading">{translate(props.locale, 'challengePrompt')} {timer}</p>
            <button onClick={() => props.onIntent({ type: 'challenge' })}>{translate(props.locale, 'challenge')}</button>
            <button className="ghost" onClick={() => props.onIntent({ type: 'passChallenge' })}>
              {translate(props.locale, 'passChallenge')}
            </button>
          </div>
        )}

        {canBlock && (
          <div className="row" role="group" aria-labelledby="block-heading">
            <p id="block-heading" className="decision-heading">{translate(props.locale, 'blockPrompt')} {timer}</p>
            {canBlockRoles.map((r) => (
              <button key={r} className={`role-btn role--${r}`} onClick={() => props.onIntent({ type: 'block', role: r })}>
                {translate(props.locale, 'blockWith', { role: roleName(props.locale, r) })}
              </button>
            ))}
            <button className="ghost" onClick={() => props.onIntent({ type: 'passBlock' })}>
              {translate(props.locale, 'passBlock')}
            </button>
          </div>
        )}

        {postGameRevealLeft && <div className="waiting">{translate(props.locale, 'postGameRevealHint')}</div>}

        {state.phase === 'gameOver' && (me === props.hostId ? (
          <button className="primary" onClick={() => props.onIntent({ type: 'rematch' })}>
            {translate(props.locale, 'rematch')}
          </button>
        ) : (
          <div className="waiting">{translate(props.locale, 'waitingForRematch', { name: nameOf(state, props.hostId) })}</div>
        ))}

        {waiting && <div className="waiting decision-heading"><span>{waiting}</span>{timer}</div>}
      </div>
      </div>

        <ReactionTray state={state} me={me} locale={props.locale} onReact={(reaction) => props.onIntent({ type: 'react', reaction })} />

        {/* 别人的表态读给读屏用户；自己的不读 */}
        <div className="visually-hidden" aria-live="polite">
          {latest && latest.playerId !== me && (
            <span key={latest.id}>
              {translate(props.locale, 'reactionLive', { name: nameOf(state, latest.playerId), text: reactionText(describe(latest.reaction)) })}
            </span>
          )}
        </div>

        {groups.length > 0 && (
          <div className="log">
            {groups.map((g, i) => (
              <Fragment key={g.id}>
                {i > 0 && <div className="log-sep" aria-hidden="true" />}
                <div className="log-group">
                  <button
                    className="log-header"
                    onClick={g.entries.length ? () => toggleGroup(g.id) : undefined}
                    aria-expanded={g.entries.length ? expanded.has(g.id) : undefined}
                    aria-label={g.entries.length ? translate(props.locale, expanded.has(g.id) ? 'collapseLog' : 'expandLog', { action: g.action }) : undefined}
                  >
                    {g.entries.length > 0 && (
                      <span className={`log-chevron${expanded.has(g.id) ? ' open' : ''}`}>▸</span>
                    )}
                    <span>{g.action}</span>
                  </button>
                  {/* 条目常驻，高度在 0fr ↔ 1fr 之间过渡（同 .notice-region）；收起时 inert，读屏和 Tab 跳过 */}
                  {g.entries.length > 0 && (
                    <div
                      className={`collapse${expanded.has(g.id) ? ' open' : ''}`}
                      {...{ inert: expanded.has(g.id) ? undefined : '' }}
                    >
                      <div className="log-entries">
                        {g.entries.map((en) => (
                          <div key={en.id} className="log-entry">
                            {en.text}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Actions(props: {
  timer: ReactNode;
  coins: number;
  selectedAction: ActionType | null;
  onSelect: (a: ActionType | null) => void;
  targets: { id: string; name: string }[];
  onAction: (a: ActionType, targetId?: string) => void;
  locale: Locale;
}) {
  const sel = ACTIONS.find((a) => a.type === props.selectedAction);
  const mustCoup = props.coins >= FORCED_COUP_COINS;
  const label = (action: ActionType): string => {
    const name = actionName(props.locale, action);
    const claim = ACTION_CLAIM[action];
    switch (action) {
      case 'income': return `${name} +1`;
      case 'foreignAid': return `${name} +2`;
      case 'coup': return `${name} (${localizeCoinCount(props.locale, COUP_COST)})`;
      case 'assassinate': return `${name} (${localizeCoinCount(props.locale, ASSASSINATE_COST)})`;
      case 'tax': return `${name} +3 (${roleName(props.locale, claim!)})`;
      default: return `${name} (${roleName(props.locale, claim!)})`;
    }
  };
  // 选目标时替换整个行动网格，只留目标与取消可点
  if (sel?.needsTarget) {
    const heading =
      sel.type === 'coup' ? 'chooseCoupTarget' : sel.type === 'assassinate' ? 'chooseAssassinateTarget' : 'chooseStealTarget';
    return (
      <div className="actions" role="group" aria-labelledby="target-heading">
        <p id="target-heading" className="decision-heading">{translate(props.locale, heading)} {props.timer}</p>
        {props.targets.map((t, i) => (
          <button key={t.id} autoFocus={i === 0} onClick={() => props.onAction(sel.type, t.id)}>
            {t.name}
          </button>
        ))}
        <button className="ghost" onClick={() => props.onSelect(null)}>
          {translate(props.locale, 'cancel')}
        </button>
      </div>
    );
  }
  return (
    <div className="actions">
      <p className="decision-heading">{translate(props.locale, 'chooseAction')} {props.timer}</p>
      {mustCoup && <p role="status">{translate(props.locale, 'mandatoryCoup')}</p>}
      {ACTIONS.map((a) => {
        const disabled =
          a.type === 'coup'
            ? props.coins < COUP_COST
            : a.type === 'assassinate'
              ? props.coins < ASSASSINATE_COST || mustCoup
              : mustCoup;
        return (
          <span key={a.type} className="action-tip-anchor">
            <button
              disabled={disabled}
              aria-label={label(a.type)}
              onClick={() => {
                if (a.needsTarget) props.onSelect(a.type);
                else props.onAction(a.type);
              }}
            >
              {actionName(props.locale, a.type)}
            </button>
            <span className="action-tip" aria-hidden="true">
              {a.coins && <span className="action-tip-coins"><CoinIcon />{a.coins}</span>}
              {a.claim && <span className={`role--${a.claim}`}><RoleIcon role={a.claim} /></span>}
            </span>
          </span>
        );
      })}
    </div>
  );
}
