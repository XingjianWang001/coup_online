import type { ActionType, GameEvent, PublicState, PrivateState, Role, Card } from '@coup/engine';

// 表态：协议里只传短语的 key、行动、角色和目标玩家 ID，文字由各端按自己的语言渲染（ADR 0008）
export const PHRASES = ['doubt', 'sure', 'dare', 'honest', 'framed', 'mercy', 'close', 'respect'] as const;
export type Phrase = (typeof PHRASES)[number];

export type Reaction =
  | { kind: 'phrase'; phrase: Phrase }
  | { kind: 'announcement'; action: ActionType; targetId?: string }
  | { kind: 'verbalClaim'; has: boolean; role: Role };

// 客户端 → 服务器 的意图
export type ClientIntent =
  | { type: 'createRoom'; name: string; playerId?: string; secret?: string }
  | { type: 'joinRoom'; roomCode: string; name: string; playerId?: string; secret?: string }
  | { type: 'startTunnel' }
  | { type: 'startGame' }
  | { type: 'rematch' }
  // 大厅阶段房主添加 / 按玩家 ID 移除电脑玩家
  | { type: 'addComputer' }
  | { type: 'removeComputer'; playerId: string }
  | { type: 'chooseAction'; action: ActionType; targetId?: string }
  | { type: 'challenge' }
  | { type: 'passChallenge' }
  | { type: 'block'; role: Role }
  | { type: 'passBlock' }
  | { type: 'revealShowdownCard'; cardId: string }
  // 对质中被质疑者当前对准哪张牌（悬停 / 键盘焦点 / 点选），只转发给房间，不进牌局状态
  | { type: 'focusShowdownCard'; slot: number | null }
  // 表态：服务器校验、限流后转发给房间，不进牌局状态
  | { type: 'react'; reaction: Reaction }
  | { type: 'resolveLoss'; cardId: string }
  | { type: 'resolveExchange'; keepIds: string[] }
  // 赛后揭晓：获胜者在牌局结束后向全房间公开一张暗牌
  | { type: 'revealPostGameCard'; cardId: string }
  | { type: 'leaveRoom' };

// 大厅玩家（开局前）。joined 也带这份名单，牌局中按 id 查 isComputer 给座位铭牌用：电脑玩家只在大厅阶段增减
export interface LobbyPlayer {
  id: string;
  name: string;
  isHost: boolean;
  connected: boolean;
  isPreviousWinner: boolean;
  isComputer: boolean;
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
  'invalidName',
  'rateLimited',
  'serverBusy',
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
  | { type: 'joined'; roomCode: string; playerId: string; secret: string; players: LobbyPlayer[]; hostId: string; tunnelUrl?: string; canStartTunnel: boolean; gameNumber: number }
  | { type: 'tunnelUrl'; url: string | null } // null：隧道已断开，之前的链接失效
  | { type: 'lobby'; players: LobbyPlayer[]; hostId: string }
  // gameNumber：房间里第几局（尚未开局为 0），重连时据此判断离线期间是否已换了一局
  | { type: 'gameStarted'; turnOrder: string[]; gameNumber: number }
  | { type: 'publicState'; state: PublicState; remainingMs: number | null; deadlineAt: number | null; hostId: string }
  | { type: 'privateState'; hand: Card[] }
  | { type: 'events'; events: GameEvent[] }
  | { type: 'showdownFocus'; slot: number | null }
  | { type: 'reaction'; playerId: string; reaction: Reaction }
  // inRoom：这条连接此刻是否还在房间里。不在（房间已释放、重连时座位已不在……）则会话结束，客户端不必按错误码猜
  | ({ type: 'error'; inRoom: boolean } & ServerError)
  | { type: 'left'; reason: 'left' | 'replaced' };

export type { ActionType, GameEvent, PublicState, PrivateState, Role, Card };
