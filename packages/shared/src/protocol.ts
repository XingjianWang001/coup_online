import type { ActionType, GameEvent, PublicState, PrivateState, Role, Card } from '@coup/engine';

// 客户端 → 服务器 的意图
export type ClientIntent =
  | { type: 'createRoom'; name: string; playerId?: string; secret?: string }
  | { type: 'joinRoom'; roomCode: string; name: string; playerId?: string; secret?: string }
  | { type: 'startGame' }
  | { type: 'chooseAction'; action: ActionType; targetId?: string }
  | { type: 'challenge' }
  | { type: 'passChallenge' }
  | { type: 'block'; role: Role }
  | { type: 'passBlock' }
  | { type: 'resolveLoss'; cardId: string }
  | { type: 'resolveExchange'; keepIds: string[] }
  | { type: 'leaveRoom' };

// 大厅玩家（开局前）
export interface LobbyPlayer {
  id: string;
  name: string;
  isHost: boolean;
  connected: boolean;
}

// 服务器 → 客户端 的消息
export type ServerMessage =
  | { type: 'joined'; roomCode: string; playerId: string; secret: string; players: LobbyPlayer[]; hostId: string }
  | { type: 'lobby'; players: LobbyPlayer[]; hostId: string }
  | { type: 'gameStarted'; turnOrder: string[] }
  | { type: 'publicState'; state: PublicState }
  | { type: 'privateState'; hand: Card[] }
  | { type: 'events'; events: GameEvent[] }
  | { type: 'error'; message: string }
  | { type: 'left'; reason: string };

export type { ActionType, GameEvent, PublicState, PrivateState, Role, Card };
