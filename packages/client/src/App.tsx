import { useEffect, useMemo, useState } from 'react';
import type { ActionType, Card, LobbyPlayer, PublicState, Role } from '@coup/shared';
import { connect, loadIdentity, onMessage, saveIdentity, send } from './socket.ts';
import type { ServerMessage } from './socket.ts';
import { ROLE_DESC, ROLE_NAMES, RULES } from './rules.ts';

const ACTIONS: { type: ActionType; label: string; needsTarget: boolean; cost?: string }[] = [
  { type: 'income', label: '收入 +1', needsTarget: false },
  { type: 'foreignAid', label: '外援 +2', needsTarget: false },
  { type: 'coup', label: '政变 (7币)', needsTarget: true, cost: '7' },
  { type: 'tax', label: '征税 +3 (公爵)', needsTarget: false },
  { type: 'assassinate', label: '暗杀 (3币)', needsTarget: true, cost: '3' },
  { type: 'steal', label: '偷窃 (队长)', needsTarget: true },
  { type: 'exchange', label: '交换 (大使)', needsTarget: false },
];

const ROLE_COLORS: Record<Role, string> = {
  duke: '#8d6e63',
  assassin: '#c62828',
  captain: '#1565c0',
  ambassador: '#2e7d32',
  contessa: '#6a1b9a',
};

export function App() {
  const socket = useMemo(() => connect(), []);
  const [identity, setIdentity] = useState(() => loadIdentity());
  const [name, setName] = useState(() => identity?.name ?? '');
  const [roomCode, setRoomCode] = useState('');
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

  useEffect(() => {
    onMessage(socket, (msg: ServerMessage) => {
      switch (msg.type) {
        case 'joined':
          setJoined(msg.roomCode);
          setHostId(msg.hostId);
          setPlayers(msg.players);
          setIdentity({ playerId: msg.playerId, name });
          saveIdentity({ playerId: msg.playerId, name });
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
  }, [socket, name]);

  const me = identity?.playerId;

  function createRoom() {
    setError('');
    send(socket, { type: 'createRoom', name, playerId: identity?.playerId });
  }

  function joinRoom() {
    setError('');
    send(socket, { type: 'joinRoom', roomCode: roomCode.trim(), name, playerId: identity?.playerId });
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
      selectedAction={props.selectedAction}
      setSelectedAction={props.setSelectedAction}
      selectedKeep={props.selectedKeep}
      setSelectedKeep={props.setSelectedKeep}
      onAction={props.onAction}
      onIntent={(i) => send(props.socket, i)}
    />
  );
}

function CardView({ card, dim }: { card: Card; dim?: boolean }) {
  const color = ROLE_COLORS[card.role];
  return (
    <div className="card" style={{ borderColor: color, opacity: dim ? 0.6 : 1 }}>
      <span style={{ color }}>{ROLE_NAMES[card.role]}</span>
    </div>
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

  return (
    <div className="board">
      {props.notice && <div className="notice">{props.notice}</div>}

      {state.phase === 'gameOver' && (
        <div className="notice big">🏆 {state.players.find((p) => p.id === state.winnerId)?.name} 获胜！</div>
      )}

      <div className="table">
        {state.players.map((p) => (
          <div key={p.id} className={`seat ${p.id === state.currentPlayerId ? 'current' : ''} ${!p.alive ? 'dead' : ''}`}>
            <div className="name">
              {p.name}
              {p.id === me && ' (你)'}
            </div>
            <div className="coins">💰 {p.coins}</div>
            <div className="revealed">
              {p.revealed.map((c) => (
                <CardView key={c.id} card={c} />
              ))}
            </div>
            <div className="handcount">暗牌 × {p.handCount}</div>
          </div>
        ))}
      </div>

      <div className="myhand">
        <h3>你的暗牌</h3>
        <div className="cards">
          {props.hand.map((c) => (
            <CardView key={c.id} card={c} />
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
          <div className="waiting">等待其他玩家操作…</div>
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
        const disabled =
          a.type === 'coup' ? props.coins < 7 : a.type === 'assassinate' ? props.coins < 3 : false;
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

