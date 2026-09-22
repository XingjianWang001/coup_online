import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ActionType, Card, LobbyPlayer, PublicState, Role } from '@coup/shared';
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
import { ROLE_DESC, ROLE_NAMES, RULES } from './rules.ts';
import { describeCountdown, describePending, effectiveRemainingMs, estimateServerOffset, groupLog, nameOf, remainingSinceReceipt } from './narration.ts';
import type { LogEntry } from './narration.ts';
import { copyToClipboard } from './clipboard.ts';

const ACTIONS: { type: ActionType; label: string; needsTarget: boolean; cost?: string }[] = [
  { type: 'income', label: '收入 +1', needsTarget: false },
  { type: 'foreignAid', label: '外援 +2', needsTarget: false },
  { type: 'coup', label: '政变 (7币)', needsTarget: true, cost: '7' },
  { type: 'tax', label: '征税 +3 (公爵)', needsTarget: false },
  { type: 'assassinate', label: '暗杀 (3币)', needsTarget: true, cost: '3' },
  { type: 'steal', label: '偷窃 (队长)', needsTarget: true },
  { type: 'exchange', label: '交换 (大使)', needsTarget: false },
];

interface CountdownSnapshot {
  remainingMs: number | null;
  deadlineAt: number | null;
  receivedAt: number;
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

export function App() {
  const socket = useMemo(() => connect(), []);
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
  const [error, setError] = useState('');
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [showRules, setShowRules] = useState(false);
  const [selectedAction, setSelectedAction] = useState<ActionType | null>(null);
  const [selectedKeep, setSelectedKeep] = useState<string[]>([]);
  const [leftReason, setLeftReason] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [countdownSnapshot, setCountdownSnapshot] = useState<CountdownSnapshot | null>(null);
  const [serverOffsetMs, setServerOffsetMs] = useState<number | null>(null);
  const [clockTick, setClockTick] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logIdRef = useRef(0);

  useEffect(() => {
    const off = onMessage(socket, (msg: ServerMessage) => {
      switch (msg.type) {
        case 'joined':
          setJoined(msg.roomCode);
          setHostId(msg.hostId);
          setPlayers(msg.players);
          setTunnelUrl(msg.tunnelUrl ?? null);
          setIdentity({ playerId: msg.playerId, name: nameRef.current, secret: msg.secret });
          saveIdentity({ playerId: msg.playerId, name: nameRef.current, secret: msg.secret });
          saveRoomCode(msg.roomCode);
          setLeftReason('');
          break;
        case 'lobby':
          setHostId(msg.hostId);
          setPlayers(msg.players);
          break;
        case 'gameStarted':
          setNotice('游戏开始！');
          setLog([]);
          logIdRef.current = 0;
          break;
        case 'publicState':
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
          for (const e of msg.events) {
            if (e.type === 'gameOver') setNotice('游戏结束');
            if (e.type === 'eliminated') setNotice('有玩家被淘汰');
            if (e.type === 'challengeResolved') setNotice(e.truth ? '质疑失败' : '质疑成功');
            if (e.type === 'influenceLost') setNotice('有玩家失去影响力');
          }
          {
            const entries = msg.events.map((event) => ({ id: logIdRef.current++, event }));
            setLog((prev) => [...prev, ...entries].slice(-500));
          }
          break;
        case 'error':
          setError(msg.message);
          setTunnelLoading(false);
          break;
        case 'tunnelUrl':
          setTunnelUrl(msg.url);
          setTunnelLoading(false);
          break;
        case 'left':
          setLeftReason(msg.reason);
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

  // 提示自动清除
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

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
    setError('');
    send(socket, { type: 'createRoom', name, playerId: identity?.playerId, secret: identity?.secret });
  }

  function joinRoom() {
    setError('');
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
    setError('');
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

  // 对局中离开需确认（视为弃权）；大厅阶段直接离开。
  function requestLeave() {
    if (publicState) setConfirmLeave(true);
    else leaveRoom();
  }

  // 规则说明：首次进入询问
  useEffect(() => {
    if (joined && !identity && !localStorage.getItem('coup_seen_rules')) {
      setShowRules(true);
      localStorage.setItem('coup_seen_rules', '1');
    }
  }, [joined, identity]);

  return (
    <div className="app">
      <header className="header">
        <h1>政变 Coup</h1>
        <div className="header-actions">
          <button className="ghost" onClick={() => setShowRules((v) => !v)}>
            {showRules ? '关闭规则' : '规则'}
          </button>
          {joined && (
            <button className="ghost" onClick={requestLeave}>
              离开房间
            </button>
          )}
        </div>
      </header>

      {showRules && <RulesPanel onClose={() => setShowRules(false)} />}

      {confirmLeave && (
        <div className="overlay" onClick={() => setConfirmLeave(false)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <p>确认离开房间？对局中离开将视为弃权。</p>
            <button onClick={leaveRoom}>确认离开</button>
            <button className="ghost" onClick={() => setConfirmLeave(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {!joined ? (
        <Lobby
          name={name}
          setName={setName}
          roomCode={roomCode}
          setRoomCode={setRoomCode}
          onCreate={createRoom}
          onJoin={joinRoom}
          error={error}
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
          leftReason={leftReason}
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
          tunnelLoading={tunnelLoading}
          onStartTunnel={startTunnel}
        />
      )}
    </div>
  );
}

function RulesPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel rules" onClick={(e) => e.stopPropagation()}>
        <h2>规则说明</h2>
        {RULES.map((r) => (
          <div key={r.title} className="rule">
            <b>{r.title}</b>
            <p>{r.body}</p>
          </div>
        ))}
        <h3>角色</h3>
        {Object.entries(ROLE_NAMES).map(([role, label]) => (
          <div key={role} className="rule">
            <b>{label}</b>
            <p>{ROLE_DESC[role as Role]}</p>
          </div>
        ))}
        <button className="ghost" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}

function Lobby(props: {
  name: string;
  setName: (v: string) => void;
  roomCode: string;
  setRoomCode: (v: string) => void;
  onCreate: () => void;
  onJoin: () => void;
  error: string;
}) {
  return (
    <div className="lobby">
      <label>
        昵称
        <input value={props.name} onChange={(e) => props.setName(e.target.value)} placeholder="你的昵称" />
      </label>
      <button className="primary" onClick={props.onCreate} disabled={!props.name.trim()}>
        创建房间
      </button>
      <div className="divider">或</div>
      <label>
        房间码
        <input
          value={props.roomCode}
          onChange={(e) => props.setRoomCode(e.target.value.toUpperCase())}
          placeholder="6 位房间码"
          maxLength={6}
        />
      </label>
      <button className="ghost" onClick={props.onJoin} disabled={!props.name.trim() || props.roomCode.trim().length < 3}>
        加入房间
      </button>
      {props.error && <div className="error">{props.error}</div>}
    </div>
  );
}

function InviteLink(props: { roomCode: string; url: string | null; loading: boolean; onStart: () => void }) {
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
        <span className="invite-label">加入链接</span>
        <div className="row">
          <input className="invite-input" readOnly value={fullUrl} onFocus={(e) => e.currentTarget.select()} />
          <button onClick={copy}>{copied ? '已复制' : copyFailed ? '复制失败' : '复制'}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="invite">
      <button onClick={props.onStart} disabled={props.loading}>
        {props.loading ? '正在启动隧道…' : '生成加入链接'}
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
  notice: string;
  leftReason: string;
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
  tunnelLoading: boolean;
  onStartTunnel: () => void;
}

function RoomView(props: RoomViewProps) {
  const { publicState, me } = props;
  const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (!publicState) {
    return (
      <div className="room">
        <div className="roomcode">
          房间码 <b>{props.roomCode}</b>（把此码或链接发给朋友）
        </div>
        {me === props.hostId && isLocal && (
          <InviteLink
            roomCode={props.roomCode}
            url={props.tunnelUrl}
            loading={props.tunnelLoading}
            onStart={props.onStartTunnel}
          />
        )}
        <h3>玩家（{props.players.length}）</h3>
        <ul className="playerlist">
          {props.players.map((p) => (
            <li key={p.id} className={p.isHost ? 'host' : ''}>
              {p.name}
              {p.isHost && ' (房主)'}
              {!p.connected && ' (离线)'}
            </li>
          ))}
        </ul>
        {me === props.hostId && (
          <button className="primary" onClick={props.onStart} disabled={props.players.length < 2}>
            开始游戏（需 ≥2 人）
          </button>
        )}
        {props.leftReason && <div className="error">你已离开：{props.leftReason}</div>}
      </div>
    );
  }

  return (
    <GameBoard
      state={publicState}
      hand={props.hand}
      me={me}
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
    />
  );
}

function CardView({ role, unavailable }: { role: Role; unavailable?: boolean }) {
  return <div className={`card card--${role}${unavailable ? ' unavailable' : ''}`}>{ROLE_NAMES[role]}</div>;
}

function CardBack() {
  return <div className="card-back" role="img" aria-label="暗牌" />;
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

function GameBoard(props: {
  state: PublicState;
  hand: Card[];
  me: string | undefined;
  notice: string;
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

  const narration = describePending(state);
  const countdown = describeCountdown(props.remainingMs, props.deadlineAt, props.serverNow);
  const effectiveRemaining = effectiveRemainingMs(props.remainingMs, props.deadlineAt, props.serverNow);
  const urgent = effectiveRemaining != null && effectiveRemaining <= 3000;

  // 控制区内容切换的键：变化时重挂载以触发入场动画（避免行动选项闪现）
  let controlMode = 'waiting';
  if (state.phase === 'choosingAction' && isMyTurn) controlMode = 'action';
  else if (canChallenge) controlMode = 'challenge';
  else if (canBlock) controlMode = 'block';
  else if (amLosing) controlMode = 'loss';
  else if (amExchanging) controlMode = 'exchange';
  const controlKey = `${controlMode}:${state.currentPlayerId ?? ''}:${pending?.actorId ?? ''}:${state.lossPlayerId ?? ''}`;

  const groups = groupLog(props.log, state).reverse();
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
      {props.notice && (
        <div className="notice" key={props.notice}>
          {props.notice}
        </div>
      )}

      {state.phase === 'gameOver' && (
        <div className="notice big"><CrownIcon /> {state.players.find((p) => p.id === state.winnerId)?.name} 获胜！</div>
      )}

      {narration ? (
        <div className="narration">
          <span className="narration-text">{narration}</span>
          {countdown && (
            <span className={`narration-timer${urgent ? ' urgent' : ''}`}>{countdown}</span>
          )}
        </div>
      ) : isMyTurn && state.phase === 'choosingAction' && countdown ? (
        <div className="narration">
          <span className="narration-text">轮到你了</span>
          <span className={`narration-timer${urgent ? ' urgent' : ''}`}>{countdown}</span>
        </div>
      ) : null}

      <div className="table">
        {state.players.map((p) => (
          <div key={p.id} className={`seat ${p.id === state.currentPlayerId ? 'current' : ''} ${!p.alive ? 'dead' : ''}`}>
            <div className="name">
              {p.name}
              {p.id === me && ' (你)'}
            </div>
            <div className="coins"><CoinIcon /> {p.coins}</div>
            <div className="cards-row">
              {p.id === me
                ? props.hand.map((c) => <CardView key={c.id} role={c.role} />)
                : Array.from({ length: p.handCount }, (_, i) => <CardBack key={`back-${i}`} />)}
              {p.revealed.map((role, i) => (
                <CardView key={`rev-${i}`} role={role} unavailable />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="controls" key={controlKey}>
        {state.phase === 'choosingAction' && isMyTurn && (
          <Actions
            coins={myView?.coins ?? 0}
            selectedAction={props.selectedAction}
            onSelect={props.setSelectedAction}
            targets={aliveOthers}
            onAction={props.onAction}
          />
        )}

        {canChallenge && (
          <div className="row">
            <button onClick={() => props.onIntent({ type: 'challenge' })}>质疑！</button>
            <button className="ghost" onClick={() => props.onIntent({ type: 'passChallenge' })}>
              不质疑
            </button>
          </div>
        )}

        {canBlock && (
          <div className="row">
            {canBlockRoles.map((r) => (
              <button key={r} className={`role-btn role--${r}`} onClick={() => props.onIntent({ type: 'block', role: r })}>
                用{ROLE_NAMES[r]}阻挡
              </button>
            ))}
            <button className="ghost" onClick={() => props.onIntent({ type: 'passBlock' })}>
              不阻挡
            </button>
          </div>
        )}

        {amLosing && (
          <div className="row">
            <p>请选择一张暗牌公开翻开：</p>
            {props.hand.map((c) => (
              <button
                key={c.id}
                className={`role-btn role--${c.role}`}
                onClick={() => props.onIntent({ type: 'resolveLoss', cardId: c.id })}
              >
                翻开 {ROLE_NAMES[c.role]}
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
          />
        )}

        {!isMyTurn && !canChallenge && !canBlock && !amLosing && !amExchanging && state.phase !== 'gameOver' && (
          <div className="waiting">等待 {nameOf(state, state.currentPlayerId)} 行动…</div>
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
  );
}

function Actions(props: {
  coins: number;
  selectedAction: ActionType | null;
  onSelect: (a: ActionType | null) => void;
  targets: { id: string; name: string }[];
  onAction: (a: ActionType, targetId?: string) => void;
}) {
  const sel = ACTIONS.find((a) => a.type === props.selectedAction);
  return (
    <div className="actions">
      {ACTIONS.map((a) => {
        const mustCoup = props.coins >= 10;
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
            {a.label}
          </button>
        );
      })}
      {sel?.needsTarget && (
        <div className="row">
          <span>选择目标：</span>
          {props.targets.map((t) => (
            <button key={t.id} onClick={() => props.onAction(sel.type, t.id)}>
              {t.name}
            </button>
          ))}
          <button className="ghost" onClick={() => props.onSelect(null)}>
            取消
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
      <p>交换：请选择保留的 {props.keepCount} 张牌</p>
      {props.hand.map((c) => {
        const keep = props.selectedKeep.includes(c.id);
        return (
          <button
            key={c.id}
            className={`role-btn role--${c.role}${keep ? ' active' : ''}${confirming && !keep ? ' discard' : ''}`}
            onClick={() => toggle(c.id)}
            disabled={confirming}
          >
            {ROLE_NAMES[c.role]}
          </button>
        );
      })}
      <button
        disabled={props.selectedKeep.length !== props.keepCount || confirming}
        onClick={() => confirm(props.selectedKeep)}
      >
        确认保留
      </button>
    </div>
  );
}

