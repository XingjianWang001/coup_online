import type { ActionType, Card, LobbyPlayer, PublicState, ServerMessage } from '@coup/shared';
import type { LogEntry } from './narration.ts';

export interface CountdownSnapshot {
  remainingMs: number | null;
  deadlineAt: number | null;
  receivedAt: number;
}

// 房间会话：服务器下发的「这个房间」的状态，加上随牌局一起重置的本地选择。
export interface Session {
  roomCode: string | null;
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
}

export const initialSession: Session = {
  roomCode: null,
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
};

// now 为收到消息时的 performance.now()，用于倒计时按实际经过时间递减。
export function reduceSession(s: Session, msg: ServerMessage, now: number): Session {
  switch (msg.type) {
    case 'joined':
      return {
        ...s,
        roomCode: msg.roomCode,
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
      };
    case 'gameStarted':
      return { ...s, log: [], nextLogId: 0 };
    case 'publicState':
      return {
        ...s,
        hostId: msg.hostId,
        publicState: msg.state,
        countdown: { remainingMs: msg.remainingMs, deadlineAt: msg.deadlineAt, receivedAt: now },
      };
    case 'privateState':
      return { ...s, hand: msg.hand };
    case 'events': {
      const entries = msg.events.map((event, i) => ({ id: s.nextLogId + i, event }));
      return { ...s, log: [...s.log, ...entries].slice(-500), nextLogId: s.nextLogId + entries.length };
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
