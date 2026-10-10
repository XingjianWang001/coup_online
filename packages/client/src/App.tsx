import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { parseServerError } from '@coup/shared';
import type { ActionType, Card, LobbyPlayer, PublicState, Role, ServerError } from '@coup/shared';
import {
  clearIdentity,
  clearRoomCode,
  connect,
  loadIdentity,
  loadRoomCode,
  onMessage,
  saveIdentity,
  saveRoomCode,
  send,
} from './socket.ts';
import type { ServerMessage } from './socket.ts';
import { actionName, coinLegend, roleDescription, roleName, roleShortName, ROLES, rulesFor, type RuleLevel } from './rules.ts';
import { describeCountdown, describePending, effectiveRemainingMs, estimateServerOffset, groupLog, nameOf, remainingSinceReceipt } from './narration.ts';
import type { LogEntry } from './narration.ts';
import { copyToClipboard } from './clipboard.ts';
import { wrappedDialogFocus } from './dialog.ts';
import { scheduleAutoDismiss } from './transient.ts';
import { placeSeats, type PlacedSeat, type SeatSide } from './seating.ts';
import {
  LANGUAGE_OPTIONS,
  loadLocale,
  localizeCoinCount,
  localizeNotice,
  localizeServerError,
  persistLocale,
  translate,
  type Locale,
  type NoticeDescriptor,
} from './localization.ts';

// coins / claim 只用于悬浮气泡里的图标说明
const ACTIONS: { type: ActionType; needsTarget: boolean; coins?: string; claim?: Role }[] = [
  { type: 'income', needsTarget: false, coins: '+1' },
  { type: 'foreignAid', needsTarget: false, coins: '+2' },
  { type: 'coup', needsTarget: true, coins: '−7' },
  { type: 'tax', needsTarget: false, coins: '+3', claim: 'duke' },
  { type: 'assassinate', needsTarget: true, coins: '−3', claim: 'assassin' },
  { type: 'steal', needsTarget: true, coins: '+2', claim: 'captain' },
  { type: 'exchange', needsTarget: false, claim: 'ambassador' },
];

interface CountdownSnapshot {
  remainingMs: number | null;
  deadlineAt: number | null;
  receivedAt: number;
}

interface TransientNoticeState {
  id: number;
  descriptor: NoticeDescriptor;
}

interface TransientErrorState {
  id: number;
  error: ServerError;
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

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function useDialogFocus(
  onClose: () => void,
  dialogRef: RefObject<HTMLDivElement>,
  initialFocusRef: RefObject<HTMLElement>,
) {
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const target = wrappedDialogFocus(
        focusable,
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
        event.shiftKey,
      );
      if (target) {
        event.preventDefault();
        target.focus();
      }
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    initialFocusRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [dialogRef, initialFocusRef, onClose]);
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
  const [name, setName] = useState(() => identity?.name ?? '');
  const nameRef = useRef(name);
  nameRef.current = name;
  const [roomCode, setRoomCode] = useState(() => LINK_ROOM ?? loadRoomCode() ?? '');
  const [joined, setJoined] = useState<string | null>(null);
  const [hostId, setHostId] = useState('');
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [publicState, setPublicState] = useState<PublicState | null>(null);
  const [hand, setHand] = useState<Card[]>([]);
  const [error, setError] = useState<TransientErrorState | null>(null);
  const errorIdRef = useRef(0);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [canStartTunnel, setCanStartTunnel] = useState(false);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [notice, setNotice] = useState<TransientNoticeState | null>(null);
  const noticeIdRef = useRef(0);
  const [showRules, setShowRules] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedAction, setSelectedAction] = useState<ActionType | null>(null);
  const [selectedKeep, setSelectedKeep] = useState<string[]>([]);
  const [hasLeftRoom, setHasLeftRoom] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [countdownSnapshot, setCountdownSnapshot] = useState<CountdownSnapshot | null>(null);
  const [serverOffsetMs, setServerOffsetMs] = useState<number | null>(null);
  const [clockTick, setClockTick] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logIdRef = useRef(0);
  const closeRules = useCallback(() => setShowRules(false), []);
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const closeLeaveConfirmation = useCallback(() => setConfirmLeave(false), []);

  function changeLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    persistLocale(browserStorage(), nextLocale);
  }

  const showNotice = (descriptor: NoticeDescriptor) => {
    noticeIdRef.current += 1;
    setNotice({ id: noticeIdRef.current, descriptor });
  };

  useEffect(() => {
    const off = onMessage(socket, (msg: ServerMessage) => {
      switch (msg.type) {
        case 'joined':
          setError(null);
          setJoined(msg.roomCode);
          setHostId(msg.hostId);
          setPlayers(msg.players);
          setTunnelUrl(msg.tunnelUrl ?? null);
          setCanStartTunnel(msg.canStartTunnel);
          setIdentity({ playerId: msg.playerId, name: nameRef.current, secret: msg.secret });
          saveIdentity({ playerId: msg.playerId, name: nameRef.current, secret: msg.secret });
          saveRoomCode(msg.roomCode);
          setHasLeftRoom(false);
          break;
        case 'lobby':
          // 服务器只在大厅阶段发送 lobby：再来一局后清掉上一局的牌桌。
          setHostId(msg.hostId);
          setPlayers(msg.players);
          setPublicState(null);
          setCountdownSnapshot(null);
          setHand([]);
          setLog([]);
          setSelectedAction(null);
          setSelectedKeep([]);
          break;
        case 'gameStarted':
          setError(null);
          showNotice({ key: 'gameStarted' });
          setLog([]);
          logIdRef.current = 0;
          break;
        case 'publicState':
          setHostId(msg.hostId);
          setPublicState(msg.state);
          setCountdownSnapshot({
            remainingMs: msg.remainingMs,
            deadlineAt: msg.deadlineAt,
            receivedAt: performance.now(),
          });
          break;
        case 'privateState':
          setHand(msg.hand);
          break;
        case 'events':
          setError(null);
          for (const e of msg.events) {
            if (e.type === 'gameOver') showNotice({ key: 'gameEnded' });
            if (e.type === 'eliminated') showNotice({ key: 'playerEliminated' });
            if (e.type === 'challengeResolved') showNotice({ key: e.truth ? 'challengeFailed' : 'challengeSucceeded' });
            if (e.type === 'influenceLost') showNotice({ key: 'influenceLostNotice' });
          }
          {
            const entries = msg.events.map((event) => ({ id: logIdRef.current++, event }));
            setLog((prev) => [...prev, ...entries].slice(-500));
          }
          break;
        case 'error':
          errorIdRef.current += 1;
          setError({ id: errorIdRef.current, error: parseServerError(msg) });
          setTunnelLoading(false);
          break;
        case 'tunnelUrl':
          setError(null);
          setTunnelUrl(msg.url);
          setTunnelLoading(false);
          break;
        case 'left':
          setError(null);
          setHasLeftRoom(true);
          setJoined(null);
          clearRoomCode();
          clearIdentity();
          setIdentity(null);
          setPublicState(null);
          setCountdownSnapshot(null);
          setHand([]);
          setPlayers([]);
          setHostId('');
          setTunnelUrl(null);
          setCanStartTunnel(false);
          setTunnelLoading(false);
          setSelectedAction(null);
          setSelectedKeep([]);
          setConfirmLeave(false);
          break;
      }
    });
    return off;
  }, [socket]);

  // 重连：socket 重新连接后，若本地有身份与房间码，自动重新加入
  useEffect(() => {
    const onConnect = () => {
      if (LINK_ROOM) return; // 链接指定了房间：仅预填，不自动重连旧房间
      const id = loadIdentity();
      const code = loadRoomCode();
      if (id && code) {
        send(socket, { type: 'joinRoom', roomCode: code, name: id.name, playerId: id.playerId, secret: id.secret });
      }
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

  // 浏览器暂停计时器后按实际经过时间重新计算，避免每次回调只减一秒造成滞后。
  useEffect(() => {
    if (countdownSnapshot?.remainingMs == null) return;
    const interval = setInterval(() => setClockTick((value) => value + 1), 250);
    return () => clearInterval(interval);
  }, [countdownSnapshot]);

  const remainingMs = useMemo(() => {
    if (!countdownSnapshot) return null;
    return remainingSinceReceipt(countdownSnapshot.remainingMs, countdownSnapshot.receivedAt, performance.now());
  }, [countdownSnapshot, clockTick]);
  const serverNow = serverOffsetMs == null ? null : Date.now() + serverOffsetMs;

  const me = identity?.playerId;

  function createRoom() {
    setError(null);
    send(socket, { type: 'createRoom', name, playerId: identity?.playerId, secret: identity?.secret });
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
    setTunnelLoading(true);
    setError(null);
    send(socket, { type: 'startTunnel' });
  }

  function chooseAction(action: ActionType, targetId?: string) {
    setSelectedAction(null);
    send(socket, { type: 'chooseAction', action, targetId });
  }

  function leaveRoom() {
    setConfirmLeave(false);
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
        <SettingsPanel locale={locale} onLocaleChange={changeLocale} onClose={closeSettings} />
      )}

      {confirmLeave && (
        <LeaveConfirmation locale={locale} onConfirm={leaveRoom} onClose={closeLeaveConfirmation} />
      )}

      <TransientMessage
        value={error}
        className="error"
        regionClassName="error-region"
        role="alert"
        ariaLive="assertive"
        render={(visibleError) => localizeServerError(locale, visibleError.error)}
      />

      {!joined ? (
        <EntryForm
          name={name}
          setName={setName}
          roomCode={roomCode}
          setRoomCode={setRoomCode}
          onCreate={createRoom}
          onJoin={joinRoom}
          locale={locale}
        />
      ) : (
        <RoomView
          roomCode={joined}
          hostId={hostId}
          me={me}
          players={players}
          publicState={publicState}
          hand={hand}
          notice={notice}
          hasLeftRoom={hasLeftRoom}
          remainingMs={remainingMs}
          deadlineAt={countdownSnapshot?.deadlineAt ?? null}
          serverNow={serverNow}
          log={log}
          selectedAction={selectedAction}
          setSelectedAction={setSelectedAction}
          selectedKeep={selectedKeep}
          setSelectedKeep={setSelectedKeep}
          onStart={startGame}
          onAction={chooseAction}
          socket={socket}
          identity={identity}
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
  const canCreate = !!props.name.trim();
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
          maxLength={32}
        />
      </label>
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
  hasLeftRoom: boolean;
  selectedAction: ActionType | null;
  setSelectedAction: (a: ActionType | null) => void;
  selectedKeep: string[];
  setSelectedKeep: (ids: string[]) => void;
  onStart: () => void;
  onAction: (action: ActionType, targetId?: string) => void;
  socket: ReturnType<typeof connect>;
  identity: { playerId: string; name: string } | null;
  remainingMs: number | null;
  deadlineAt: number | null;
  serverNow: number | null;
  log: LogEntry[];
  tunnelUrl: string | null;
  canStartTunnel: boolean;
  tunnelLoading: boolean;
  onStartTunnel: () => void;
  locale: Locale;
}

function RoomView(props: RoomViewProps) {
  const { publicState, me } = props;
  const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
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
        <h3>{translate(props.locale, 'playersCount', { count: props.players.length })}</h3>
        <ul className="playerlist">
          {props.players.map((p) => (
            <li key={p.id} className={p.isHost ? 'host' : ''}>
              {p.name}
              {p.isHost && translate(props.locale, 'hostSuffix')}
              {!p.connected && translate(props.locale, 'offlineSuffix')}
            </li>
          ))}
        </ul>
        {me === props.hostId && (
          <button className="primary" onClick={props.onStart} disabled={props.players.length < 2}>
            {translate(props.locale, 'startGame')} ({translate(props.locale, 'startGameRequirement')})
          </button>
        )}
        {props.hasLeftRoom && (
          <div className="left-room-notice">
            {translate(props.locale, 'leftRoomNotice')}
          </div>
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
      notice={props.notice}
      remainingMs={props.remainingMs}
      deadlineAt={props.deadlineAt}
      serverNow={props.serverNow}
      log={props.log}
      selectedAction={props.selectedAction}
      setSelectedAction={props.setSelectedAction}
      selectedKeep={props.selectedKeep}
      setSelectedKeep={props.setSelectedKeep}
      onAction={props.onAction}
      onIntent={(i) => send(props.socket, i)}
      locale={props.locale}
    />
  );
}

// 明牌只靠视觉暗淡区分；读屏另给「已翻开」文案，界面不加字。
// 悬浮看名字：自己的大牌把图标换成名字，对手的小牌弹出同色气泡（仅限有悬浮的设备）。
function CardView({ role, locale, unavailable, small }: { role: Role; locale: Locale; unavailable?: boolean; small?: boolean }) {
  const label = roleName(locale, role);
  const card = (
    <div
      className={`card card--${role}${unavailable ? ' unavailable' : ''}`}
      role="img"
      aria-label={translate(locale, unavailable ? 'cardRevealed' : 'cardFace', { role: label })}
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

function Glyph({ children, size, className = '' }: { children: ReactNode; size?: number; className?: string }) {
  return (
    <svg className={`glyph ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

function RoleIcon({ role }: { role: Role }) {
  return <Glyph>{ROLE_GLYPHS[role]}</Glyph>;
}

function CardBack({ locale }: { locale: Locale }) {
  return <div className="card-back" role="img" aria-label={translate(locale, 'cardBack')} />;
}

// 银元
function CoinIcon() {
  return (
    <Glyph size={16} className="inline-icon">
      <circle className="f" cx="12" cy="12" r="9.5" />
      <circle className="d" cx="12" cy="12" r="6.2" />
    </Glyph>
  );
}

// 皇冠：下移 1.5 使视觉居中
function CrownIcon() {
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

function GameBoard(props: {
  state: PublicState;
  hand: Card[];
  me: string | undefined;
  hostId: string;
  notice: TransientNoticeState | null;
  selectedAction: ActionType | null;
  setSelectedAction: (a: ActionType | null) => void;
  selectedKeep: string[];
  setSelectedKeep: (ids: string[]) => void;
  onAction: (action: ActionType, targetId?: string) => void;
  onIntent: (i: Parameters<typeof send>[1]) => void;
  remainingMs: number | null;
  deadlineAt: number | null;
  serverNow: number | null;
  log: LogEntry[];
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

  const canChallenge = state.phase === 'awaitingChallenge' && !!myView?.alive && !meIsClaimant;

  let canBlock = false;
  let canBlockRoles: Role[] = [];
  if (state.phase === 'awaitingBlock' && pending) {
    if (pending.action === 'foreignAid') {
      canBlock = pending.actorId !== me && !!myView?.alive;
      canBlockRoles = ['duke'];
    } else {
      canBlock = pending.targetId === me && !!myView?.alive;
      canBlockRoles =
        pending.action === 'assassinate' ? ['contessa'] : pending.action === 'steal' ? ['captain', 'ambassador'] : [];
    }
  }

  const amLosing = state.phase === 'choosingLoss' && state.lossPlayerId === me;
  const amExchanging = state.phase === 'choosingExchange' && pending?.actorId === me;

  const narration = describePending(state, props.locale);
  const countdown = describeCountdown(props.remainingMs, props.deadlineAt, props.serverNow);
  const effectiveRemaining = effectiveRemainingMs(props.remainingMs, props.deadlineAt, props.serverNow);
  const urgent = effectiveRemaining != null && effectiveRemaining <= 3000;
  const centerText = narration ?? (isMyTurn && state.phase === 'choosingAction' ? translate(props.locale, 'yourTurn') : null);

  type SeatPlayer = PublicState['players'][number];
  const seats = placeSeats(state.players, me);
  const rails: Record<SeatSide, PlacedSeat<SeatPlayer>[]> = { left: [], top: [], right: [] };
  for (const s of seats.opponents) rails[s.side].push(s);

  // angle 缺省即自己的座位（近端）
  const renderSeat = (p: SeatPlayer, angle?: number) => {
    const isCurrent = p.id === state.currentPlayerId;
    return (
      <div
        key={p.id}
        className={`seat ${angle == null ? 'self' : 'opponent'}${isCurrent ? ' current' : ''}${p.alive ? '' : ' dead'}`}
        aria-current={isCurrent ? 'true' : undefined}
        style={angle == null ? undefined : ({ '--seat-angle': `${angle}deg` } as CSSProperties)}
      >
        <div className="seat-head">
          <span className="name">
            {p.name}
            {p.id === me && translate(props.locale, 'selfMarker')}
          </span>
          <span className="coins" role="img" aria-label={localizeCoinCount(props.locale, p.coins)}><CoinIcon /> {p.coins}</span>
        </div>
        <div className="cards-row" role="group" aria-label={translate(props.locale, 'influenceCount', { count: p.handCount })}>
          {p.id === me
            ? props.hand.map((c) => <CardView key={c.id} role={c.role} locale={props.locale} />)
            : Array.from({ length: p.handCount }, (_, i) => <CardBack key={`back-${i}`} locale={props.locale} />)}
          {p.revealed.map((role, i) => (
            <CardView key={`rev-${i}`} role={role} locale={props.locale} unavailable small={p.id !== me} />
          ))}
        </div>
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
        {(['left', 'top', 'right'] as const).map((side) => (
          <div key={side} className={`rail rail--${side}`}>
            {rails[side].map((s) => renderSeat(s.player, s.angle))}
          </div>
        ))}
        {/* 牌桌中央：live 区常驻，内容换行时淡入；倒计时放在 live 区外，避免读屏每秒播报 */}
        <div className={`narration${centerText ? '' : ' is-empty'}`}>
          <span className="narration-text" aria-live="polite">
            {centerText && <span key={centerText} className="narration-line">{centerText}</span>}
          </span>
          {centerText && countdown && (
            <span className={`narration-timer${urgent ? ' urgent' : ''}`}>{countdown}</span>
          )}
        </div>
      </div>

      {seats.self && renderSeat(seats.self)}

      <div className="controls" key={controlKey}>
        {state.phase === 'choosingAction' && isMyTurn && (
          <Actions
            coins={myView?.coins ?? 0}
            selectedAction={props.selectedAction}
            onSelect={props.setSelectedAction}
            targets={aliveOthers}
            onAction={props.onAction}
            locale={props.locale}
          />
        )}

        {canChallenge && (
          <div className="row">
            <button onClick={() => props.onIntent({ type: 'challenge' })}>{translate(props.locale, 'challenge')}</button>
            <button className="ghost" onClick={() => props.onIntent({ type: 'passChallenge' })}>
              {translate(props.locale, 'passChallenge')}
            </button>
          </div>
        )}

        {canBlock && (
          <div className="row">
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

        {amLosing && (
          <div className="row">
            <p>{translate(props.locale, 'chooseInfluenceLoss')}</p>
            {props.hand.map((c) => (
              <button
                key={c.id}
                className={`role-btn role--${c.role}`}
                onClick={() => props.onIntent({ type: 'resolveLoss', cardId: c.id })}
              >
                {translate(props.locale, 'revealRole', { role: roleName(props.locale, c.role) })}
              </button>
            ))}
          </div>
        )}

        {amExchanging && (
          <ExchangeControl
            hand={props.hand}
            keepCount={state.exchangeKeepCount ?? 0}
            selectedKeep={props.selectedKeep}
            setSelectedKeep={props.setSelectedKeep}
            onConfirm={(ids) => props.onIntent({ type: 'resolveExchange', keepIds: ids })}
            locale={props.locale}
          />
        )}

        {state.phase === 'gameOver' && (me === props.hostId ? (
          <button className="primary" onClick={() => props.onIntent({ type: 'rematch' })}>
            {translate(props.locale, 'rematch')}
          </button>
        ) : (
          <div className="waiting">{translate(props.locale, 'waitingForRematch', { name: nameOf(state, props.hostId) })}</div>
        ))}

        {!isMyTurn && !canChallenge && !canBlock && !amLosing && !amExchanging && state.phase !== 'gameOver' && (
          <div className="waiting">{translate(props.locale, 'waitingForAction', { name: nameOf(state, state.currentPlayerId) })}</div>
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
                  {expanded.has(g.id) && g.entries.length > 0 && (
                    <div className="log-entries">
                      {g.entries.map((en) => (
                        <div key={en.id} className="log-entry">
                          {en.text}
                        </div>
                      ))}
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
  coins: number;
  selectedAction: ActionType | null;
  onSelect: (a: ActionType | null) => void;
  targets: { id: string; name: string }[];
  onAction: (a: ActionType, targetId?: string) => void;
  locale: Locale;
}) {
  const sel = ACTIONS.find((a) => a.type === props.selectedAction);
  const mustCoup = props.coins >= 10;
  const label = (action: ActionType): string => {
    const name = actionName(props.locale, action);
    switch (action) {
      case 'income': return `${name} +1`;
      case 'foreignAid': return `${name} +2`;
      case 'coup': return `${name} (${localizeCoinCount(props.locale, 7)})`;
      case 'tax': return `${name} +3 (${roleName(props.locale, 'duke')})`;
      case 'assassinate': return `${name} (${localizeCoinCount(props.locale, 3)})`;
      case 'steal': return `${name} (${roleName(props.locale, 'captain')})`;
      case 'exchange': return `${name} (${roleName(props.locale, 'ambassador')})`;
    }
  };
  return (
    <div className="actions">
      {mustCoup && <p role="status">{translate(props.locale, 'mandatoryCoup')}</p>}
      {ACTIONS.map((a) => {
        const disabled =
          a.type === 'coup'
            ? props.coins < 7
            : a.type === 'assassinate'
              ? props.coins < 3 || mustCoup
              : mustCoup;
        return (
          <span key={a.type} className="action-tip-anchor">
            <button
              className={props.selectedAction === a.type ? 'active' : ''}
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
      {sel?.needsTarget && (
        <div className="row">
          <span>{translate(props.locale, 'chooseTarget')}</span>
          {props.targets.map((t) => (
            <button key={t.id} onClick={() => props.onAction(sel.type, t.id)}>
              {t.name}
            </button>
          ))}
          <button className="ghost" onClick={() => props.onSelect(null)}>
            {translate(props.locale, 'cancel')}
          </button>
        </div>
      )}
    </div>
  );
}

function ExchangeControl(props: {
  hand: Card[];
  keepCount: number;
  selectedKeep: string[];
  setSelectedKeep: (ids: string[]) => void;
  onConfirm: (ids: string[]) => void;
  locale: Locale;
}) {
  const [confirming, setConfirming] = useState(false);
  const toggle = (id: string) => {
    if (props.selectedKeep.includes(id)) {
      props.setSelectedKeep(props.selectedKeep.filter((x) => x !== id));
    } else if (props.selectedKeep.length < props.keepCount) {
      props.setSelectedKeep([...props.selectedKeep, id]);
    }
  };
  const confirm = (ids: string[]) => {
    setConfirming(true);
    props.onConfirm(ids);
  };
  return (
    <div className="row">
      <p>{translate(props.locale, 'exchangePrompt', { count: props.keepCount })}</p>
      {props.hand.map((c) => {
        const keep = props.selectedKeep.includes(c.id);
        return (
          <button
            key={c.id}
            className={`role-btn role--${c.role}${keep ? ' active' : ''}${confirming && !keep ? ' discard' : ''}`}
            onClick={() => toggle(c.id)}
            disabled={confirming}
          >
            {roleName(props.locale, c.role)}
          </button>
        );
      })}
      <button
        disabled={props.selectedKeep.length !== props.keepCount || confirming}
        onClick={() => confirm(props.selectedKeep)}
      >
        {translate(props.locale, 'confirmKeep')}
      </button>
    </div>
  );
}

