import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionType, Card, LobbyPlayer, PublicState, Role } from '@coup/shared';
import {
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
import { describeCountdown, describePending, nameOf } from './narration.ts';

const ACTIONS: { type: ActionType; label: string; needsTarget: boolean; cost?: string }[] = [
  { type: 'income', label: '收入 +1', needsTarget: false },
  { type: 'foreignAid', label: '外援 +2', needsTarget: false },
  { type: 'coup', label: '政变 (7币)', needsTarget: true, cost: '7' },
  { type: 'tax', label: '征税 +3 (公爵)', needsTarget: false },
  { type: 'assassinate', label: '暗杀 (3币)', needsTarget: true, cost: '3' },
  { type: 'steal', label: '偷窃 (队长)', needsTarget: true },
  { type: 'exchange', label: '交换 (大使)', needsTarget: false },
];

export function App() {
  const socket = useMemo(() => connect(), []);
  const [identity, setIdentity] = useState(() => loadIdentity());
  const [name, setName] = useState(() => identity?.name ?? '');
  const nameRef = useRef(name);
  nameRef.current = name;
  const [roomCode, setRoomCode] = useState(() => loadRoomCode() ?? '');
  const [joined, setJoined] = useState<string | null>(null);
  const [hostId, setHostId] = useState('');
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [publicState, setPublicState] = useState<PublicState | null>(null);
  const [hand, setHand] = useState<Card[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showRules, setShowRules] = useState(false);
  const [selectedAction, setSelectedAction] = useState<ActionType | null>(null);
  const [selectedKeep, setSelectedKeep] = useState<string[]>([]);
  const [leftReason, setLeftReason] = useState('');
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    const off = onMessage(socket, (msg: ServerMessage) => {
      switch (msg.type) {
        case 'joined':
          setJoined(msg.roomCode);
          setHostId(msg.hostId);
          setPlayers(msg.players);
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
          setPublicState((s) => (s ? s : null));
          setNotice('游戏开始！');
          break;
        case 'publicState':
          setPublicState(msg.state);
          setRemainingMs(msg.remainingMs);
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
          break;
        case 'error':
          setError(msg.message);
          break;
        case 'left':
          setLeftReason(msg.reason);
          break;
      }
    });
    return off;
  }, [socket]);

  // 重连：socket 重新连接后，若本地有身份与房间码，自动重新加入
  useEffect(() => {
    const onConnect = () => {
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

  // 倒计时本地递减：服务器广播的权威剩余毫秒数，每秒往下数
  useEffect(() => {
    if (remainingMs == null || remainingMs <= 0) return;
    const t = setTimeout(() => setRemainingMs((v) => (v == null ? null : Math.max(0, v - 1000))), 1000);
    return () => clearTimeout(t);
  }, [remainingMs]);

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

  function chooseAction(action: ActionType, targetId?: string) {
    setSelectedAction(null);
    send(socket, { type: 'chooseAction', action, targetId });
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
        <button className="ghost" onClick={() => setShowRules((v) => !v)}>
          {showRules ? '关闭规则' : '规则'}
        </button>
      </header>

      {showRules && <RulesPanel onClose={() => setShowRules(false)} />}

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
          selectedAction={selectedAction}
          setSelectedAction={setSelectedAction}
          selectedKeep={selectedKeep}
          setSelectedKeep={setSelectedKeep}
          onStart={startGame}
          onAction={chooseAction}
          socket={socket}
          identity={identity}
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
      <button onClick={props.onCreate} disabled={!props.name.trim()}>
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
      <button onClick={props.onJoin} disabled={!props.name.trim() || props.roomCode.trim().length < 3}>
        加入房间
      </button>
      {props.error && <div className="error">{props.error}</div>}
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
}

function RoomView(props: RoomViewProps) {
  const { publicState, me } = props;
  if (!publicState) {
    return (
      <div className="room">
        <div className="roomcode">
          房间码 <b>{props.roomCode}</b>（把此码或链接发给朋友）
        </div>
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
          <button onClick={props.onStart} disabled={props.players.length < 2}>
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
      selectedAction={props.selectedAction}
      setSelectedAction={props.setSelectedAction}
      selectedKeep={props.selectedKeep}
      setSelectedKeep={props.setSelectedKeep}
      onAction={props.onAction}
      onIntent={(i) => send(props.socket, i)}
    />
  );
}

function CardView({ role }: { role: Role }) {
  return <div className={`card card--${role}`}>{ROLE_NAMES[role]}</div>;
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
  const countdown = describeCountdown(props.remainingMs);

  return (
    <div className="board">
      {props.notice && <div className="notice">{props.notice}</div>}

      {state.phase === 'gameOver' && (
        <div className="notice big"><CrownIcon /> {state.players.find((p) => p.id === state.winnerId)?.name} 获胜！</div>
      )}

      {narration ? (
        <div className="narration">
          <span className="narration-text">{narration}</span>
          {countdown && <span className="narration-timer">{countdown}</span>}
        </div>
      ) : isMyTurn && state.phase === 'choosingAction' && countdown ? (
        <div className="narration">
          <span className="narration-text">轮到你了</span>
          <span className="narration-timer">{countdown}</span>
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
            <div className="revealed">
              {p.revealed.map((role, i) => (
                <CardView key={i} role={role} />
              ))}
            </div>
            <div className="hand-pile">
              <span className="card-back">暗牌 × {p.handCount}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="myhand">
        <h3>你的暗牌</h3>
        <div className="cards">
          {props.hand.map((c) => (
            <CardView key={c.id} role={c.role} />
          ))}
        </div>
      </div>

      <div className="controls">
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
              <button key={r} onClick={() => props.onIntent({ type: 'block', role: r })}>
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
              <button key={c.id} onClick={() => props.onIntent({ type: 'resolveLoss', cardId: c.id })}>
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
  const toggle = (id: string) => {
    if (props.selectedKeep.includes(id)) {
      props.setSelectedKeep(props.selectedKeep.filter((x) => x !== id));
    } else if (props.selectedKeep.length < props.keepCount) {
      props.setSelectedKeep([...props.selectedKeep, id]);
    }
  };
  return (
    <div className="row">
      <p>交换：请选择保留的 {props.keepCount} 张牌</p>
      {props.hand.map((c) => (
        <button key={c.id} className={props.selectedKeep.includes(c.id) ? 'active' : ''} onClick={() => toggle(c.id)}>
          {ROLE_NAMES[c.role]}
          {props.selectedKeep.includes(c.id) ? ' ✓' : ''}
        </button>
      ))}
      <button disabled={props.selectedKeep.length !== props.keepCount} onClick={() => props.onConfirm(props.selectedKeep)}>
        确认保留
      </button>
    </div>
  );
}

