import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ACTION_CLAIM, ASSASSINATE_COST, BLOCK_ROLES, COUP_COST, FORCED_COUP_COINS, isValidNickname, MAX_PLAYERS, parseServerError, STRENGTHS, type ActionType, type Card, type LobbyPlayer, type PublicState, type Reaction, type Role, type ServerError, type Strength } from '@coup/shared';
import { clearIdentity, clearRoomCode, connect, loadIdentity, loadRoomCode, onMessage, saveIdentity, saveRoomCode, send, type ServerMessage } from './socket.ts';
import { actionName, ACTIONS, coinLegend, roleDescription, roleName, ROLES, roleShortName, rulesFor, type RuleLevel } from './rules.ts';
import { describePending, describeReaction, describeWaiting, estimateServerOffset, groupLog, nameOf, reactionText, type LogEntry } from './narration.ts';
import { copyToClipboard } from './clipboard.ts';
import { useDialogFocus } from './dialog.ts';
import { scheduleAutoDismiss } from './transient.ts';
import { prefersReducedMotion, useSmoothHeight } from './motion.ts';
import { closeShowdown, dropMotion, initialSession, reduceSession, rejoinIntent, type SeatMotion, type Session } from './session.ts';
import { placeSeats, type PlacedSeat, type SeatSide } from './seating.ts';
import { CARD_STYLES, loadCardStyle, loadDebug, persistCardStyle, type CardStyle } from './cardStyle.ts';
import { LANGUAGE_OPTIONS, loadLocale, localizeCoinCount, localizeNotice, localizeServerError, persistLocale, translate, type Locale, type NoticeDescriptor } from './localization.ts';
import { DecisionTimer, type Clock } from './clock.tsx';
import { DealShowcase } from './DealShowcase.tsx';
import { AddComputerIcon, CoinIcon, ComputerBadge, CrownIcon, Glyph, RoleIcon } from './icons.tsx';
import { ReactionTray } from './ReactionTray.tsx';
import { ExchangeStage, LossStage, ShowdownStage } from './ShowdownStage.tsx';

interface TransientNoticeState {
  id: number;
  descriptor: NoticeDescriptor;
}

// 表态：每位玩家最多一条，新的顶掉旧的，REACTION_MS 后自己消失
interface ReactionBubble {
  id: number;
  reaction: Reaction;
}
// 最近一条表态单独留着给读屏朗读：气泡过期时不能让更早的一条被重新朗读
interface LatestReaction extends ReactionBubble {
  playerId: string;
}
const REACTION_MS = 3000; // 与 style.css 里 .nameplate-text 的淡出时刻对齐
const CONTROLS_ARM_MS = 500; // 控制区换内容后多久才收输入，见 GameBoard 的 armedKey

interface TransientErrorState {
  id: number;
  // 离开房间/座位被接管不是服务器错误，但与错误共用同一条红色提示。
  error: ServerError | { notice: 'leftRoomNotice' | 'replacedRoomNotice' };
}

type SessionAction = { msg: ServerMessage; now: number } | { patch: Partial<Session> } | { closeShowdown: true } | { dropMotion: number };

function sessionReducer(s: Session, a: SessionAction): Session {
  if ('closeShowdown' in a) return closeShowdown(s);
  if ('dropMotion' in a) return dropMotion(s, a.dropMotion);
  return 'msg' in a ? reduceSession(s, a.msg, a.now) : { ...s, ...a.patch };
}

// 加入链接的 ?room= 参数：仅首次加载读取一次，读后从 URL 清除，避免刷新时重复触发。
const LINK_ROOM = (() => {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room')?.toUpperCase() ?? null;
  if (room) {
    params.delete('room');
    const qs = params.toString();
    const clean = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, '', clean);
  }
  return room;
})();
// 加入任意房间后链接已用完，之后断线重连按本地保存的房间码自动回到原座位。
let pendingLinkRoom = LINK_ROOM;
// 座位被其他标签页接管后，本标签页断线重连不再自动加入，直到用户在这里重新进房。
let replaced = false;

// 调试开关打开时，设置里才出现牌面风格；关掉后大牌一律按默认风格显示，选过的风格留着下次用。
const DEBUG = loadDebug(browserStorage(), window.location.search, window.location.hostname);

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function useAutoDismiss<T extends { id: number }>(
  value: T | null,
  setValue: (update: (current: T | null) => T | null) => void,
) {
  useEffect(() => {
    if (!value) return;
    return scheduleAutoDismiss(value, setValue);
  }, [setValue, value]);
}

export function App() {
  const socket = useMemo(() => connect(), []);
  const [locale, setLocale] = useState<Locale>(() =>
    loadLocale(browserStorage(), navigator.languages.length ? navigator.languages : [navigator.language]),
  );
  const [identity, setIdentity] = useState(() => loadIdentity());
  // 每次（重新）进房加一：离线时点下的选择被 send 丢弃了，选择对话框要重新挂载，不能还锁在「已发送」
  const [joinCount, setJoinCount] = useState(0);
  const [name, setName] = useState(() => identity?.name ?? '');
  const nameRef = useRef(name);
  nameRef.current = name;
  const [roomCode, setRoomCode] = useState(() => LINK_ROOM ?? loadRoomCode() ?? '');
  const [session, dispatchSession] = useReducer(sessionReducer, initialSession);
  const {
    roomCode: joined,
    hostId,
    players,
    publicState,
    hand,
    log,
    countdown: countdownSnapshot,
    tunnelUrl,
    canStartTunnel,
    tunnelLoading,
    selectedAction,
    showcase,
    showdown,
    motions,
  } = session;
  const setSelectedAction = useCallback((a: ActionType | null) => dispatchSession({ patch: { selectedAction: a } }), []);
  const [error, setError] = useState<TransientErrorState | null>(null);
  const errorIdRef = useRef(0);
  const [notice, setNotice] = useState<TransientNoticeState | null>(null);
  const noticeIdRef = useRef(0);
  const [reactions, setReactions] = useState<Record<string, ReactionBubble>>({});
  const [latestReaction, setLatestReaction] = useState<LatestReaction | null>(null);
  const reactionIdRef = useRef(0);
  const reactionTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // id 缺省：不管是哪一条都收起（玩家点掉）；给了 id：只在仍是这一条时收起（到时自动消失，不误删新顶上来的）
  const dropReaction = useCallback((playerId: string, id?: number) => {
    setReactions((current) => {
      if (!current[playerId] || (id !== undefined && current[playerId].id !== id)) return current;
      const next = { ...current };
      delete next[playerId];
      return next;
    });
  }, []);
  const [showRules, setShowRules] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [serverOffsetMs, setServerOffsetMs] = useState<number | null>(null);
  const closeRules = useCallback(() => setShowRules(false), []);
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const closeLeaveConfirmation = useCallback(() => setConfirmLeave(false), []);
  const closeShowcase = useCallback(() => dispatchSession({ patch: { showcase: null } }), []);
  const finishShowdown = useCallback(() => dispatchSession({ closeShowdown: true }), []);
  const finishMotion = useCallback((id: number) => dispatchSession({ dropMotion: id }), []);

  function changeLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    persistLocale(browserStorage(), nextLocale);
  }

  const [cardStyle, setCardStyle] = useState(() => loadCardStyle(browserStorage()));
  function changeCardStyle(nextStyle: CardStyle) {
    setCardStyle(nextStyle);
    persistCardStyle(browserStorage(), nextStyle);
  }

  const showError = (error: TransientErrorState['error']) => {
    errorIdRef.current += 1;
    setError({ id: errorIdRef.current, error });
  };

  const showNotice = (descriptor: NoticeDescriptor) => {
    noticeIdRef.current += 1;
    setNotice({ id: noticeIdRef.current, descriptor });
  };

  // 会话状态由 reduceSession 推导；这里只处理副作用：身份持久化、错误与提示。
  useEffect(() => {
    const off = onMessage(socket, (msg: ServerMessage) => {
      dispatchSession({ msg, now: performance.now() });
      switch (msg.type) {
        case 'joined':
          setError(null);
          setJoinCount((n) => n + 1);
          setIdentity({ playerId: msg.playerId, name: nameRef.current, secret: msg.secret });
          saveIdentity({ playerId: msg.playerId, name: nameRef.current, secret: msg.secret });
          saveRoomCode(msg.roomCode);
          pendingLinkRoom = null;
          replaced = false;
          break;
        case 'gameStarted':
          setError(null);
          showNotice({ key: 'gameStarted' });
          setReactions({});
          setLatestReaction(null);
          break;
        case 'reaction': {
          const id = ++reactionIdRef.current;
          setReactions((current) => ({ ...current, [msg.playerId]: { id, reaction: msg.reaction } }));
          setLatestReaction({ id, playerId: msg.playerId, reaction: msg.reaction });
          clearTimeout(reactionTimers.current.get(msg.playerId));
          reactionTimers.current.set(msg.playerId, setTimeout(() => {
            dropReaction(msg.playerId, id);
            // 读屏文字随铭牌一起清掉：否则之后切换语言会把这条旧表态再读一遍
            setLatestReaction((latest) => (latest?.id === id ? null : latest));
          }, REACTION_MS));
          break;
        }
        case 'events':
          setError(null);
          for (const e of msg.events) {
            if (e.type === 'gameOver') showNotice({ key: 'gameEnded' });
            if (e.type === 'eliminated') showNotice({ key: 'playerEliminated' });
            if (e.type === 'influenceLost') showNotice({ key: 'influenceLostNotice' });
          }
          break;
        case 'error':
          showError(parseServerError(msg));
          if (msg.code === 'roomNotFound') clearRoomCode();
          if (!msg.inRoom) setConfirmLeave(false);
          break;
        case 'tunnelUrl':
          setError(null);
          break;
        case 'left':
          showError({ notice: msg.reason === 'replaced' ? 'replacedRoomNotice' : 'leftRoomNotice' });
          replaced = msg.reason === 'replaced';
          // 被其他标签页接管时，localStorage 里的身份属于新标签页，不能清掉。
          if (msg.reason === 'left') {
            clearRoomCode();
            clearIdentity();
          }
          setIdentity(null);
          setConfirmLeave(false);
          break;
      }
    });
    return off;
  }, [socket]);

  // 重连：socket 重新连接后，若本地有身份与房间码，自动重新加入
  useEffect(() => {
    const onConnect = () => {
      const intent = rejoinIntent(loadIdentity(), loadRoomCode(), pendingLinkRoom, replaced);
      if (intent) send(socket, intent);
    };
    socket.on('connect', onConnect);
    return () => {
      socket.off('connect', onConnect);
    };
  }, [socket]);

  useAutoDismiss(error, setError);
  useAutoDismiss(notice, setNotice);

  // 用一次往返估计客户端与服务器的时钟偏差，取最近几次中延迟最低的样本。
  useEffect(() => {
    let samples: { rtt: number; offset: number }[] = [];
    const sample = () => {
      if (!socket.connected) return;
      const sentAt = Date.now();
      socket.timeout(5000).emit('timeSync', (error: Error | null, serverNow: number) => {
        if (error || !Number.isFinite(serverNow)) return;
        const receivedAt = Date.now();
        const rtt = receivedAt - sentAt;
        if (rtt < 0) return;
        samples = [...samples.slice(-7), { rtt, offset: estimateServerOffset(sentAt, receivedAt, serverNow) }];
        setServerOffsetMs(samples.reduce((best, current) => current.rtt < best.rtt ? current : best).offset);
      });
    };
    const onConnect = () => {
      samples = [];
      setServerOffsetMs(null);
      sample();
    };
    socket.on('connect', onConnect);
    if (socket.connected) onConnect();
    const interval = setInterval(sample, 10_000);
    return () => {
      socket.off('connect', onConnect);
      clearInterval(interval);
    };
  }, [socket]);

  // 倒计时的 tick 留在显示它的小组件里（useCountdown），App 只传快照，免得整棵树每 250ms 重渲染（#17）
  const clock = useMemo<Clock>(() => ({ snapshot: countdownSnapshot, serverOffsetMs }), [countdownSnapshot, serverOffsetMs]);

  const me = identity?.playerId;
  // 发牌展示期间倒计时照走：轮到我行动时在展示里给出剩余时间
  const myMove = !!publicState && (
    (publicState.phase === 'choosingAction' && publicState.currentPlayerId === me) ||
    (publicState.phase === 'choosingExchange' && publicState.pending?.actorId === me)
  );

  function createRoom() {
    setError(null);
    send(socket, { type: 'createRoom', name });
  }

  function joinRoom() {
    setError(null);
    send(socket, {
      type: 'joinRoom',
      roomCode: roomCode.trim(),
      name,
      playerId: identity?.playerId,
      secret: identity?.secret,
    });
  }

  function startGame() {
    send(socket, { type: 'startGame' });
  }

  function startTunnel() {
    dispatchSession({ patch: { tunnelLoading: true } });
    setError(null);
    send(socket, { type: 'startTunnel' });
  }

  function chooseAction(action: ActionType, targetId?: string) {
    setSelectedAction(null);
    send(socket, { type: 'chooseAction', action, targetId });
  }

  function leaveRoom() {
    setConfirmLeave(false);
    clearRoomCode(); // 断线时也算数：重连后不再自动回到这个房间
    send(socket, { type: 'leaveRoom' });
  }

  // 牌局进行中离开需确认（视为弃权）；大厅阶段或牌局结束后直接离开。
  function requestLeave() {
    if (publicState && publicState.phase !== 'gameOver') setConfirmLeave(true);
    else leaveRoom();
  }

  useEffect(() => {
    document.title = translate(locale, 'appTitle');
    document.documentElement.lang = locale;
  }, [locale]);

  // 大牌的画风全在 style.css 里按这个属性切换，组件不用知道风格
  useEffect(() => {
    document.documentElement.dataset.cardStyle = DEBUG ? cardStyle : 'default';
  }, [cardStyle]);

  return (
    <div className="app">
      <header className="header">
        <h1>{translate(locale, 'appTitle')}</h1>
        <div className="header-actions">
          <button className="ghost" onClick={() => setShowRules((v) => !v)}>
            {translate(locale, showRules ? 'closeRules' : 'rules')}
          </button>
          <button className="ghost" onClick={() => setShowSettings(true)}>
            {translate(locale, 'settings')}
          </button>
          {joined && (
            <button className="ghost" onClick={requestLeave}>
              {translate(locale, 'leaveRoom')}
            </button>
          )}
        </div>
      </header>

      {showRules && <RulesPanel locale={locale} onLocaleChange={changeLocale} onClose={closeRules} />}

      {showSettings && (
        <SettingsPanel
          locale={locale}
          onLocaleChange={changeLocale}
          cardStyle={DEBUG ? cardStyle : undefined}
          onCardStyleChange={changeCardStyle}
          onClose={closeSettings}
        />
      )}

      {confirmLeave && (
        <LeaveConfirmation locale={locale} onConfirm={leaveRoom} onClose={closeLeaveConfirmation} />
      )}

      {showcase && (
        <DealShowcase
          showcase={showcase}
          locale={locale}
          clock={myMove ? clock : null}
          onClose={closeShowcase}
        />
      )}

      {showdown && publicState && (
        <ShowdownStage
          key={`${showdown.id}:${joinCount}`}
          view={showdown}
          state={publicState}
          me={me}
          locale={locale}
          clock={publicState.phase === 'showdown' ? clock : null}
          onFocus={(slot) => send(socket, { type: 'focusShowdownCard', slot })}
          onReveal={(cardId) => send(socket, { type: 'revealShowdownCard', cardId })}
          onDone={finishShowdown}
        />
      )}

      {!showdown && publicState?.phase === 'choosingLoss' && publicState.lossPlayerId === me && (
        <LossStage
          key={`${publicState.lossPlayerId}:${joinCount}`}
          hand={hand}
          locale={locale}
          clock={clock}
          onLose={(cardId) => send(socket, { type: 'resolveLoss', cardId })}
        />
      )}

      {/* 公开状态先于手牌到达：等抽到的牌进了手牌再开，免得先闪一下旧手牌 */}
      {!showdown && publicState?.phase === 'choosingExchange' && publicState.pending?.actorId === me && hand.length > (publicState.exchangeKeepCount ?? 0) && (
        <ExchangeStage
          key={joinCount}
          hand={hand}
          keepCount={publicState.exchangeKeepCount ?? 0}
          locale={locale}
          clock={clock}
          onKeep={(keepIds) => send(socket, { type: 'resolveExchange', keepIds })}
        />
      )}

      <TransientMessage
        value={error}
        className="error"
        regionClassName="error-region"
        role="alert"
        ariaLive="assertive"
        render={({ error }) => ('notice' in error ? translate(locale, error.notice) : localizeServerError(locale, error))}
      />

      {!joined ? (
        <>
          <EntryForm
            name={name}
            setName={setName}
            roomCode={roomCode}
            setRoomCode={setRoomCode}
            onCreate={createRoom}
            onJoin={joinRoom}
            locale={locale}
          />
          <FilingFooter />
        </>
      ) : (
        <RoomView
          roomCode={joined}
          hostId={hostId}
          me={me}
          players={players}
          publicState={publicState}
          hand={hand}
          notice={notice}
          reactions={reactions}
          latestReaction={latestReaction}
          onDismissReaction={dropReaction}
          clock={showcase || showdown ? null : clock}
          log={log}
          motions={motions}
          onMotionDone={finishMotion}
          selectedAction={selectedAction}
          setSelectedAction={setSelectedAction}
          onStart={startGame}
          onAction={chooseAction}
          socket={socket}
          tunnelUrl={tunnelUrl}
          canStartTunnel={canStartTunnel}
          tunnelLoading={tunnelLoading}
          onStartTunnel={startTunnel}
          locale={locale}
        />
      )}
    </div>
  );
}

function SettingsPanel(props: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  cardStyle?: CardStyle;
  onCardStyleChange: (style: CardStyle) => void;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(props.onClose, dialogRef, closeButtonRef);

  return (
    <div className="overlay settings-overlay" onClick={props.onClose}>
      <div
        ref={dialogRef}
        className="panel settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-heading">
          <h2 id="settings-title">{translate(props.locale, 'settingsTitle')}</h2>
          <button ref={closeButtonRef} className="ghost" onClick={props.onClose}>
            {translate(props.locale, 'closeSettings')}
          </button>
        </div>
        <fieldset className="language-settings">
          <legend>{translate(props.locale, 'language')}</legend>
          <div className="language-options">
            {LANGUAGE_OPTIONS.map((option) => (
              <label className="language-option" key={option.locale}>
                <input
                  type="radio"
                  name="locale"
                  value={option.locale}
                  checked={props.locale === option.locale}
                  onChange={() => props.onLocaleChange(option.locale)}
                />
                <span lang={option.locale}>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {props.cardStyle && (
          <fieldset className="language-settings">
            <legend>{translate(props.locale, 'cardStyle')}</legend>
            <div className="language-options">
              {CARD_STYLES.map((style) => (
                <label className="language-option" key={style}>
                  <input
                    type="radio"
                    name="cardStyle"
                    value={style}
                    checked={props.cardStyle === style}
                    onChange={() => props.onCardStyleChange(style)}
                  />
                  <span>{translate(props.locale, style === 'totem' ? 'cardStyleTotem' : 'cardStyleDefault')}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </div>
  );
}

function LeaveConfirmation(props: { locale: Locale; onConfirm: () => void; onClose: () => void }) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(props.onClose, dialogRef, cancelButtonRef);

  return (
    <div className="overlay" onClick={props.onClose}>
      <div
        ref={dialogRef}
        className="panel"
        role="alertdialog"
        aria-modal="true"
        aria-label={translate(props.locale, 'leaveRoom')}
        aria-describedby="leave-confirmation-description"
        onClick={(event) => event.stopPropagation()}
      >
        <p id="leave-confirmation-description">{translate(props.locale, 'leaveConfirmation')}</p>
        <button onClick={props.onConfirm}>{translate(props.locale, 'confirmLeave')}</button>
        <button ref={cancelButtonRef} className="ghost" onClick={props.onClose}>
          {translate(props.locale, 'cancel')}
        </button>
      </div>
    </div>
  );
}

function RulesPanel({
  locale,
  onLocaleChange,
  onClose,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  onClose: () => void;
}) {
  const [level, setLevel] = useState<RuleLevel>('quick');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(onClose, dialogRef, closeButtonRef);

  return (
    <div className="overlay rules-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="panel rules"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-heading rules-heading">
          <h2 id="rules-title">{translate(locale, 'rulesTitle')}</h2>
          <div className="rules-heading-actions">
            <select
              value={locale}
              aria-label={translate(locale, 'language')}
              onChange={(event) => onLocaleChange(event.currentTarget.value as Locale)}
            >
              {LANGUAGE_OPTIONS.map((option) => (
                <option key={option.locale} value={option.locale}>{option.label}</option>
              ))}
            </select>
            <button ref={closeButtonRef} className="ghost" onClick={onClose}>
              {translate(locale, 'closeRules')}
            </button>
          </div>
        </div>
        <div className="rules-level-switch" role="group" aria-label={translate(locale, 'rulesLevel')}>
          {(['quick', 'full'] as const).map((option) => (
            <button
              key={option}
              className={level === option ? 'selected' : ''}
              aria-pressed={level === option}
              onClick={() => setLevel(option)}
            >
              {translate(locale, option === 'quick' ? 'quickRules' : 'fullRules')}
            </button>
          ))}
        </div>
        <div className="rules-body">
          {rulesFor(locale, level).map((section) => (
            <Fragment key={section.id}>
              {section.roleReferenceBefore && (
                <section className="rule-section role-reference" aria-labelledby="rule-roles">
                  <h3 id="rule-roles">{translate(locale, 'rolesTitle')}</h3>
                  <div className="role-reference-list">
                    {ROLES.map((role) => (
                      <div key={role} className={`role-reference-item role--${role}`}>
                        <RoleIcon role={role} />
                        <div>
                          <b>{roleName(locale, role)}</b>
                          <p>{roleDescription(locale, role)}</p>
                        </div>
                      </div>
                    ))}
                    <div className="role-reference-item coin-legend">
                      <CoinIcon />
                      <div>
                        <b>{coinLegend(locale).name}</b>
                        <p>{coinLegend(locale).description}</p>
                      </div>
                    </div>
                  </div>
                </section>
              )}
              <section
                className={`rule-section${section.onlineOnly ? ' online-rules' : ''}`}
                aria-labelledby={`rule-${section.id}`}
              >
                <h3 id={`rule-${section.id}`}>{section.title}</h3>
                <p>{section.body}</p>
                {section.items && (
                  <ul>
                    {section.items.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                )}
              </section>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

// 创建/加入房间之前的入口（不是房间内的大厅阶段）
function EntryForm(props: {
  name: string;
  setName: (v: string) => void;
  roomCode: string;
  setRoomCode: (v: string) => void;
  onCreate: () => void;
  onJoin: () => void;
  locale: Locale;
}) {
  const canCreate = isValidNickname(props.name);
  const invalid = !!props.name && !canCreate;
  const canJoin = canCreate && props.roomCode.trim().length === 6;
  // 回车：填了完整房间码就加入，否则创建房间
  const onEnter = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    if (canJoin) props.onJoin();
    else if (canCreate && !props.roomCode.trim()) props.onCreate();
  };
  return (
    <div className="entry-form">
      <label>
        {translate(props.locale, 'nickname')}
        <input
          value={props.name}
          onChange={(e) => props.setName(e.target.value)}
          onKeyDown={onEnter}
          placeholder={translate(props.locale, 'nicknamePlaceholder')}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? 'nickname-error' : undefined}
        />
      </label>
      {invalid && <span id="nickname-error" role="status">{translate(props.locale, 'errorInvalidName')}</span>}
      <button className="primary" onClick={props.onCreate} disabled={!canCreate}>
        {translate(props.locale, 'createRoom')}
      </button>
      <div className="divider">{translate(props.locale, 'or')}</div>
      <label>
        {translate(props.locale, 'roomCode')}
        <input
          value={props.roomCode}
          onChange={(e) => props.setRoomCode(e.target.value.toUpperCase())}
          onKeyDown={onEnter}
          placeholder={translate(props.locale, 'roomCodePlaceholder')}
          maxLength={6}
        />
      </label>
      <button className="ghost" onClick={props.onJoin} disabled={!canJoin}>
        {translate(props.locale, 'joinRoom')}
      </button>
    </div>
  );
}

// 备案号为官方编号，任何语言下都不翻译；只在登记过的域名显示，未登记的域名（含 localhost、SSH 隧道）不显示页脚
const FILINGS: Record<string, { icp: string; police?: { code: string; label: string } }> = {
  'coup.davidxjwang.com': {
    icp: '粤ICP备2026157913号-1',
    police: { code: '44010602017448', label: '粤公网安备44010602017448号' },
  },
  'coup.surwhy.com': {
    icp: '粤ICP备2026157913号-2',
    police: { code: '44010602017609', label: '粤公网安备44010602017609号' },
  },
};

function FilingFooter() {
  const filing = FILINGS[location.hostname];
  if (!filing) return null;
  return (
    <footer className="filing">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
        {filing.icp}
      </a>
      {filing.police && (
        <a
          href={`https://beian.mps.gov.cn/#/query/webSearch?code=${filing.police.code}`}
          target="_blank"
          rel="noreferrer"
        >
          <img src="/beian-police.png" alt="" width={14} height={15} />
          {filing.police.label}
        </a>
      )}
    </footer>
  );
}

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

function RoomView(props: RoomViewProps) {
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

function TransientMessage<T extends { id: number }>(props: {
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
