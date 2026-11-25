import { ACTION_CLAIM, ROLE_ORDER, type ActionType, type GameEvent, type PublicState, type PrivateState, type Role, type Card } from '@coup/engine';

// 两端都按同一份时长行事：服务器据此计时、限流，客户端据此写规则说明、排动画、设冷却。改这里两端一起生效
export const ACTION_TIMEOUT_MS = 60_000;
export const WINDOW_TIMEOUT_MS = 20_000;
export const DISCONNECT_GRACE_MS = 90_000;
// 对质揭晓后下一段计时顺延这么久，留给客户端播完翻牌、换牌或落回座位的动画（client/src/motion.ts 的测试守着这个上限）
export const REVEAL_MS = 6_000;
// 服务器按玩家拦截更密的表态
export const REACTION_MIN_INTERVAL_MS = 1_500;

// 表态：协议里只传短语的 key、行动、角色和目标玩家 ID，文字由各端按自己的语言渲染（ADR 0008）
export const PHRASES = ['doubt', 'sure', 'dare', 'honest', 'mercy', 'close', 'respect'] as const;
export type Phrase = (typeof PHRASES)[number];

// 电脑玩家的强度：新加的一律普通，房主在大厅阶段逐个改；所有人都看得到
export const STRENGTHS = ['standard', 'strong'] as const;
export type Strength = (typeof STRENGTHS)[number];

export type Reaction =
  | { kind: 'phrase'; phrase: Phrase }
  | { kind: 'announcement'; action: ActionType; targetId?: string }
  | { kind: 'verbalClaim'; has: boolean; role: Role };

// 客户端 → 服务器 的意图
export type ClientIntent =
  | { type: 'createRoom'; name: string }
  // via：经加入链接还是手输房间码进房，只用于记访问（ADR 0015）。缺省或不认识时按房间码算，旧客户端照常进房
  | { type: 'joinRoom'; roomCode: string; name: string; playerId?: string; secret?: string; via?: 'link' | 'code' }
  | { type: 'startTunnel' }
  | { type: 'startGame' }
  | { type: 'rematch' }
  // 大厅阶段房主添加电脑玩家（一律普通）/ 按玩家 ID 移除或改强度
  | { type: 'addComputer' }
  | { type: 'removeComputer'; playerId: string }
  | { type: 'setComputerStrength'; playerId: string; strength: Strength }
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

const isString = (value: unknown): value is string => typeof value === 'string';
const isOptionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string';
const isAction = (value: unknown): value is ActionType => typeof value === 'string' && Object.hasOwn(ACTION_CLAIM, value);
const isRole = (value: unknown): value is Role => (ROLE_ORDER as readonly unknown[]).includes(value);
const isPhrase = (value: unknown): value is Phrase => (PHRASES as readonly unknown[]).includes(value);
const isStrength = (value: unknown): value is Strength => (STRENGTHS as readonly unknown[]).includes(value);

// 表态来自客户端：只认预设内容，按已知字段重新组装，多余字段（比如自写文字）不会被转发出去
export function parseReaction(raw: unknown): Reaction | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.kind === 'phrase' && isPhrase(r.phrase)) return { kind: 'phrase', phrase: r.phrase };
  if (r.kind === 'announcement' && isAction(r.action) && isOptionalString(r.targetId)) {
    return r.targetId === undefined
      ? { kind: 'announcement', action: r.action }
      : { kind: 'announcement', action: r.action, targetId: r.targetId };
  }
  if (r.kind === 'verbalClaim' && typeof r.has === 'boolean' && isRole(r.role)) {
    return { kind: 'verbalClaim', has: r.has, role: r.role };
  }
  return null;
}

// 意图来自不可信的 socket：只在这里检查形状，按已知字段重新组装，不认识的返回 null。
// 之后房间与引擎只判断合不合规则（轮到谁、目标在不在、牌在不在手里），不再对字段做类型断言
export function parseClientIntent(raw: unknown): ClientIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case 'startTunnel':
    case 'startGame':
    case 'rematch':
    case 'addComputer':
    case 'challenge':
    case 'passChallenge':
    case 'passBlock':
    case 'leaveRoom':
      return { type: r.type };
    case 'createRoom':
      return isString(r.name) ? { type: 'createRoom', name: r.name } : null;
    case 'joinRoom':
      return isString(r.roomCode) && isString(r.name) && isOptionalString(r.playerId) && isOptionalString(r.secret)
        ? { type: 'joinRoom', roomCode: r.roomCode, name: r.name, playerId: r.playerId, secret: r.secret, via: r.via === 'link' ? 'link' : 'code' }
        : null;
    case 'removeComputer':
      return isString(r.playerId) ? { type: 'removeComputer', playerId: r.playerId } : null;
    case 'setComputerStrength':
      return isString(r.playerId) && isStrength(r.strength) ? { type: 'setComputerStrength', playerId: r.playerId, strength: r.strength } : null;
    case 'chooseAction':
      return isAction(r.action) && isOptionalString(r.targetId) ? { type: 'chooseAction', action: r.action, targetId: r.targetId } : null;
    case 'block':
      return isRole(r.role) ? { type: 'block', role: r.role } : null;
    case 'revealShowdownCard':
    case 'resolveLoss':
    case 'revealPostGameCard':
      return isString(r.cardId) ? { type: r.type, cardId: r.cardId } : null;
    case 'focusShowdownCard': {
      const slot = r.slot;
      return slot === null || (typeof slot === 'number' && Number.isInteger(slot) && slot >= 0) ? { type: 'focusShowdownCard', slot } : null;
    }
    case 'react': {
      const reaction = parseReaction(r.reaction);
      return reaction ? { type: 'react', reaction } : null;
    }
    case 'resolveExchange':
      return Array.isArray(r.keepIds) && r.keepIds.every(isString) ? { type: 'resolveExchange', keepIds: [...r.keepIds] } : null;
    default:
      return null;
  }
}

// 大厅玩家（开局前）。joined 也带这份名单，牌局中按 id 查 isComputer 给座位铭牌用：电脑玩家只在大厅阶段增减
export interface LobbyPlayer {
  id: string;
  name: string;
  isHost: boolean;
  connected: boolean;
  isPreviousWinner: boolean;
  isComputer: boolean;
  strength?: Strength; // 只有电脑玩家有
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

// fixtures/message-flows.json 的形状：每条流程按步骤记每位玩家（a、b、c）的连接收到的消息。
// server/src/message-flows.test.ts 按它录制、client/src/session.test.ts 按它重放，流程名或形状一变两边都过不了类型检查
export type MessageFlows = Record<'duel' | 'turns' | 'trio' | 'seats' | 'bystander', { step: string; to: Record<string, ServerMessage[]> }[]>;

export type { ActionType, GameEvent, PublicState, PrivateState, Role, Card };
