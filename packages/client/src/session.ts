import type { ActionType, Card, LobbyPlayer, PublicState, ServerMessage } from '@coup/shared';
import type { LogEntry } from './narration.ts';

export interface CountdownSnapshot {
  remainingMs: number | null;
  deadlineAt: number | null;
  receivedAt: number;
}

// 发牌展示：开局所发的牌，或声称属实被质疑后换牌（cards 为换后手牌，slot 位置原是 returned）。
export type Showcase =
  | { kind: 'deal'; cards: Card[] }
  | { kind: 'swap'; cards: Card[]; slot: number; returned: Card };

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
        countdown: { remainingMs: msg.remainingMs, deadlineAt: msg.deadlineAt, receivedAt: now },
      };
    }
    case 'privateState':
      return { ...s, hand: msg.hand, awaitingShowcase: null, showcase: showcaseFor(s, msg.hand) ?? s.showcase };
    case 'events': {
      const entries = msg.events.map((event, i) => ({ id: s.nextLogId + i, event }));
      const swapped = msg.events.some((e) => e.type === 'challengeResolved' && e.truth && e.claimantId === s.playerId);
      return {
        ...s,
        log: [...s.log, ...entries].slice(-500),
        nextLogId: s.nextLogId + entries.length,
        awaitingShowcase: swapped ? 'swap' : s.awaitingShowcase,
      };
    }
    case 'error':
      // 房间已被释放（服务器重启、空房回收）：会话随之结束，退回入口。
      return msg.code === 'roomNotFound' ? initialSession : { ...s, tunnelLoading: false };
    case 'tunnelUrl':
      return { ...s, tunnelUrl: msg.url, tunnelLoading: false };
    case 'left':
      return initialSession;
  }
}

function showcaseFor(s: Session, hand: Card[]): Showcase | null {
  if (s.awaitingShowcase === 'deal') return { kind: 'deal', cards: hand };
  if (s.awaitingShowcase !== 'swap') return null;
  // 引擎把新抽的牌追加在手牌末尾；被换掉的牌可能又被抽回（同 id），所以按「旧手牌里不在保留部分的那张」定位
  const drawn = hand[hand.length - 1];
  const kept = new Set(hand.slice(0, -1).map((c) => c.id));
  const slot = s.hand.findIndex((c) => !kept.has(c.id));
  if (!drawn || slot < 0) return null;
  return { kind: 'swap', cards: s.hand.map((c, i) => (i === slot ? drawn : c)), slot, returned: s.hand[slot] };
}
