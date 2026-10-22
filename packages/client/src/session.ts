import type { ActionType, Card, LobbyPlayer, PublicState, Role, ServerMessage } from '@coup/shared';
import type { LogEntry } from './narration.ts';

export interface CountdownSnapshot {
  remainingMs: number | null;
  deadlineAt: number | null;
  receivedAt: number;
}

// 发牌展示：开局所发的牌。对质里换的牌在对质舞台上展示。
export type Showcase = { kind: 'deal'; cards: Card[] };

// 对质舞台：进入对质时打开，揭晓后留到动画播完由舞台自己关闭（ShowdownStage 的 onDone）。
export interface ShowdownView {
  id: number; // 每场对质唯一（取开场时的日志序号），舞台以它为 key，连续两场对质也会重新挂载
  challengerId: string;
  claimantId: string;
  role: Role;
  slots: number; // 被质疑者翻牌前的暗牌数（舞台上放大展示的牌数）
  hand: Card[] | null; // 自己是被质疑者时，翻牌前的手牌（牌面朝自己）
  focus: number | null; // 被质疑者当前对准的牌位（悬停同步）
  reveal: { slot: number; role: Role; truth: boolean } | null;
  newCard: Card | null; // 自己质疑失败后在原牌位换来的新牌
}

// 房间会话：服务器下发的「这个房间」的状态，加上随牌局一起重置的本地选择。
export interface Session {
  roomCode: string | null;
  playerId: string;
  hostId: string;
  players: LobbyPlayer[];
  publicState: PublicState | null;
  hand: Card[];
  log: LogEntry[];
  nextLogId: number;
  countdown: CountdownSnapshot | null;
  tunnelUrl: string | null;
  canStartTunnel: boolean;
  tunnelLoading: boolean;
  selectedAction: ActionType | null;
  selectedKeep: string[];
  // 下一份手牌到达时要展示的发牌类型
  awaitingShowcase: Showcase['kind'] | null;
  showcase: Showcase | null;
  showdown: ShowdownView | null;
}

export const initialSession: Session = {
  roomCode: null,
  playerId: '',
  hostId: '',
  players: [],
  publicState: null,
  hand: [],
  log: [],
  nextLogId: 0,
  countdown: null,
  tunnelUrl: null,
  canStartTunnel: false,
  tunnelLoading: false,
  selectedAction: null,
  selectedKeep: [],
  awaitingShowcase: null,
  showcase: null,
  showdown: null,
};

// now 为收到消息时的 performance.now()，用于倒计时按实际经过时间递减。
// 一次状态变化的消息顺序见 server/src/index.ts 的 publish()：gameStarted 或 events → publicState → 各人的 privateState。
export function reduceSession(s: Session, msg: ServerMessage, now: number): Session {
  switch (msg.type) {
    case 'joined':
      return {
        ...s,
        roomCode: msg.roomCode,
        playerId: msg.playerId,
        awaitingShowcase: null,
        hostId: msg.hostId,
        players: msg.players,
        tunnelUrl: msg.tunnelUrl ?? null,
        canStartTunnel: msg.canStartTunnel,
      };
    case 'lobby':
      // 服务器只在大厅阶段发送 lobby：再来一局后清掉上一局的牌桌。
      return {
        ...s,
        hostId: msg.hostId,
        players: msg.players,
        publicState: null,
        countdown: null,
        hand: [],
        log: [],
        selectedAction: null,
        selectedKeep: [],
        awaitingShowcase: null,
        showcase: null,
        showdown: null,
      };
    case 'gameStarted':
      return { ...s, log: [], nextLogId: 0, awaitingShowcase: 'deal' };
    case 'publicState': {
      // 牌局结束或自己被淘汰：手里已没有可看的牌，收起发牌展示
      const out = msg.state.phase === 'gameOver' || msg.state.players?.find((p) => p.id === s.playerId)?.alive === false;
      return {
        ...s,
        hostId: msg.hostId,
        publicState: msg.state,
        showcase: out ? null : s.showcase,
        showdown: showdownFor(s, msg.state),
        countdown: { remainingMs: msg.remainingMs, deadlineAt: msg.deadlineAt, receivedAt: now },
      };
    }
    case 'privateState': {
      return {
        ...s,
        hand: msg.hand,
        awaitingShowcase: null,
        showcase: s.awaitingShowcase === 'deal' ? { kind: 'deal', cards: msg.hand } : s.showcase,
        showdown: s.showdown && showdownWithHand(s.showdown, msg.hand),
      };
    }
    case 'events': {
      const entries = msg.events.map((event, i) => ({ id: s.nextLogId + i, event }));
      const resolved = msg.events.find((e) => e.type === 'challengeResolved');
      return {
        ...s,
        log: [...s.log, ...entries].slice(-500),
        nextLogId: s.nextLogId + entries.length,
        showdown: s.showdown && resolved ? { ...s.showdown, reveal: { slot: resolved.slot, role: resolved.role, truth: resolved.truth } } : s.showdown,
      };
    }
    case 'showdownFocus':
      return s.showdown && !s.showdown.reveal ? { ...s, showdown: { ...s.showdown, focus: msg.slot } } : s;
    case 'error':
      // 房间已被释放（服务器重启、空房回收）：会话随之结束，退回入口。
      return msg.code === 'roomNotFound' ? initialSession : { ...s, tunnelLoading: false };
    case 'tunnelUrl':
      return { ...s, tunnelUrl: msg.url, tunnelLoading: false };
    case 'left':
      return initialSession;
  }
}

// 自己是被质疑者时：翻牌前跟上最新手牌（对质中刷新重连时，手牌在公开状态之后才到）；揭晓后记下原牌位换来的新牌
function showdownWithHand(sd: ShowdownView, hand: Card[]): ShowdownView {
  if (!sd.hand) return sd;
  if (!sd.reveal) return { ...sd, hand };
  return sd.reveal.truth ? { ...sd, newCard: hand[sd.reveal.slot] ?? null } : sd;
}

// 舞台动画播完：收起这场对质；若下一场对质已经开始（动画期间收到了它的状态），接着打开它
export function closeShowdown(s: Session): Session {
  const closed = { ...s, showdown: null };
  return { ...closed, showdown: s.publicState ? showdownFor(closed, s.publicState) : null };
}

// 进入对质时打开舞台；已揭晓的舞台留到动画播完；没揭晓就离开对质（有人弃权）则收起
function showdownFor(s: Session, state: PublicState): ShowdownView | null {
  if (s.showdown?.reveal) return s.showdown;
  if (state.phase !== 'showdown' || !state.showdown) return null;
  if (s.showdown) return s.showdown;
  const mine = state.showdown.claimantId === s.playerId;
  const slots = state.players.find((p) => p.id === state.showdown!.claimantId)?.handCount ?? 0;
  return { ...state.showdown, id: s.nextLogId, slots, hand: mine ? s.hand : null, focus: null, reveal: null, newCard: null };
}
