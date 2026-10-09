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
import { actionName, roleDescription, roleName, ROLES, rulesFor, type RuleLevel } from './rules.ts';
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

const ACTIONS: { type: ActionType; needsTarget: boolean }[] = [
  { type: 'income', needsTarget: false },
  { type: 'foreignAid', needsTarget: false },
  { type: 'coup', needsTarget: true },
  { type: 'tax', needsTarget: false },
  { type: 'assassinate', needsTarget: true },
  { type: 'steal', needsTarget: true },
  { type: 'exchange', needsTarget: false },
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
                      <div key={role} className="role-reference-item">
                        <b>{roleName(locale, role)}</b>
                        <p>{roleDescription(locale, role)}</p>
                      </div>
                    ))}
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

// 明牌只靠视觉暗淡区分；读屏另给「已翻开」文案，界面不加字
function CardView({ role, locale, unavailable }: { role: Role; locale: Locale; unavailable?: boolean }) {
  const label = roleName(locale, role);
  return (
    <div
      className={`card card--${role}${unavailable ? ' unavailable' : ''}`}
      role="img"
      aria-label={translate(locale, unavailable ? 'cardRevealed' : 'cardFace', { role: label })}
    >
      {label}
    </div>
  );
}

function CardBack({ locale }: { locale: Locale }) {
  return <div className="card-back" role="img" aria-label={translate(locale, 'cardBack')} />;
}

function CoinIcon() {
  return (
    <svg className="inline-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8" cy="8" r="3.5" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function CrownIcon() {
  return (
    <svg className="inline-icon" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3 14 L3 6.5 L6.6 9.5 L10 4.5 L13.4 9.5 L17 6.5 L17 14 Z" fill="currentColor" />
    </svg>
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
          <span className="coins"><CoinIcon /> {localizeCoinCount(props.locale, p.coins)}</span>
        </div>
        <div className="cards-row" role="group" aria-label={translate(props.locale, 'influenceCount', { count: p.handCount })}>
          {p.id === me
            ? props.hand.map((c) => <CardView key={c.id} role={c.role} locale={props.locale} />)
            : Array.from({ length: p.handCount }, (_, i) => <CardBack key={`back-${i}`} locale={props.locale} />)}
          {p.revealed.map((role, i) => (
            <CardView key={`rev-${i}`} role={role} locale={props.locale} unavailable />
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
          <button
            key={a.type}
            className={props.selectedAction === a.type ? 'active' : ''}
            disabled={disabled}
            onClick={() => {
              if (a.needsTarget) props.onSelect(a.type);
              else props.onAction(a.type);
            }}
          >
            {label(a.type)}
          </button>
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

