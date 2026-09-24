import type { ActionType, GameEvent, PublicState, PrivateState, Role, Card } from '@coup/engine';

// 客户端 → 服务器 的意图
export type ClientIntent =
  | { type: 'createRoom'; name: string; playerId?: string; secret?: string }
  | { type: 'joinRoom'; roomCode: string; name: string; playerId?: string; secret?: string }
  | { type: 'startTunnel' }
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

const SIMPLE_SERVER_ERROR_CODES = [
  'roomNotFound',
  'gameAlreadyStarted',
  'hostOnly',
  'tunnelUnauthorized',
  'tunnelStartup',
  'illegalIntent',
  'invalidGameAction',
  'gameNotStarted',
  'unexpected',
] as const;

type SimpleServerErrorCode = (typeof SIMPLE_SERVER_ERROR_CODES)[number];

export type ServerError =
  | { code: SimpleServerErrorCode }
  | { code: 'minimumPlayers'; params: { minimum: number } }
  | { code: 'roomFull'; params: { maximum: number } };

const SIMPLE_ERROR_CODES = new Set<string>(SIMPLE_SERVER_ERROR_CODES);

function isSimpleServerErrorCode(value: string): value is SimpleServerErrorCode {
  return SIMPLE_ERROR_CODES.has(value);
}

export function parseServerError(value: unknown): ServerError {
  if (!value || typeof value !== 'object') return { code: 'unexpected' };
  const candidate = value as { code?: unknown; params?: { minimum?: unknown; maximum?: unknown } };
  if (typeof candidate.code !== 'string') return { code: 'unexpected' };
  if (isSimpleServerErrorCode(candidate.code)) return { code: candidate.code };
  if (candidate.code === 'minimumPlayers' && typeof candidate.params?.minimum === 'number') {
    return { code: 'minimumPlayers', params: { minimum: candidate.params.minimum } };
  }
  if (candidate.code === 'roomFull' && typeof candidate.params?.maximum === 'number') {
    return { code: 'roomFull', params: { maximum: candidate.params.maximum } };
  }
  return { code: 'unexpected' };
}

// 服务器 → 客户端 的消息
export type ServerMessage =
  | { type: 'joined'; roomCode: string; playerId: string; secret: string; players: LobbyPlayer[]; hostId: string; tunnelUrl?: string }
  | { type: 'tunnelUrl'; url: string }
  | { type: 'lobby'; players: LobbyPlayer[]; hostId: string }
  | { type: 'gameStarted'; turnOrder: string[] }
  | { type: 'publicState'; state: PublicState; remainingMs: number | null; deadlineAt: number | null }
  | { type: 'privateState'; hand: Card[] }
  | { type: 'events'; events: GameEvent[] }
  | ({ type: 'error' } & ServerError)
  | { type: 'left'; reason: string };

export type { ActionType, GameEvent, PublicState, PrivateState, Role, Card };
