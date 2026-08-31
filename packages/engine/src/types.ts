export type Role = 'duke' | 'assassin' | 'captain' | 'ambassador' | 'contessa';

export type ActionType =
  | 'income'
  | 'foreignAid'
  | 'coup'
  | 'tax'
  | 'assassinate'
  | 'steal'
  | 'exchange';

export interface Card {
  id: string;
  role: Role;
}

export interface Player {
  id: string;
  name: string;
  coins: number;
  hand: Card[]; // 暗牌（隐藏）
  revealed: Card[]; // 明牌（公开，已失去的影响力）
  alive: boolean;
}

export type Phase =
  | 'lobby'
  | 'choosingAction'
  | 'awaitingChallenge' // 有声称（行动或阻挡）等待质疑
  | 'awaitingBlock' // 行动声称通过（或外援），等待阻挡
  | 'choosingLoss' // 某人须选择亮出一张牌（失去影响力）
  | 'choosingExchange' // 大使交换选牌
  | 'gameOver';

// 当前等待质疑的声称主体
export type ChallengeSubject = 'action' | 'block';

export interface PendingAction {
  type: ActionType;
  actorId: string;
  targetId?: string;
  claimedRole?: Role; // 行动声称的角色（tax/assassinate/steal/exchange）
  blockById?: string; // 阻挡者
  blockRole?: Role; // 阻挡声称的角色
}

// 失去影响力（亮牌）之后要执行的后续动作
export type LossContinuation =
  | { kind: 'endTurn' }
  | { kind: 'proceedAction' } // 继续行动：可阻挡则进阻挡窗口，否则结算效果
  | { kind: 'resolveEffect' } // 直接结算行动效果
  | { kind: 'cancelAction' }; // 行动作废，结束回合

export interface LossToResolve {
  playerId: string;
  continuation: LossContinuation;
}

export interface GameState {
  phase: Phase;
  players: Player[];
  deck: Card[];
  turnOrder: string[]; // 玩家 id 按行动顺序
  currentPlayerId: string | null;
  pending: PendingAction | null;
  challengeSubject: ChallengeSubject | null;
  lossToResolve: LossToResolve | null;
  exchangeKeepCount: number | null; // 大使交换需保留的牌数
  passed: string[]; // 当前质疑/阻挡窗口中已放弃的玩家 id
  winnerId: string | null;
}

export type GameEvent =
  | { type: 'started'; turnOrder: string[] }
  | { type: 'actionChosen'; actorId: string; action: ActionType; targetId?: string; claimedRole?: Role }
  | { type: 'challenged'; challengerId: string; targetId: string }
  | { type: 'blocked'; blockerId: string; role: Role }
  | { type: 'challengeResolved'; truth: boolean; loserId: string; claimantId: string }
  | { type: 'influenceLost'; playerId: string; role: Role }
  | { type: 'eliminated'; playerId: string }
  | { type: 'coinsChanged'; playerId: string; coins: number }
  | { type: 'exchangeDrew'; playerId: string; count: number }
  | { type: 'turnChanged'; playerId: string }
  | { type: 'gameOver'; winnerId: string };

// 公开状态（广播给房间内所有玩家）
export interface PublicPlayerView {
  id: string;
  name: string;
  coins: number;
  handCount: number; // 暗牌数量（不暴露具体牌）
  revealed: Role[]; // 已公开翻出的明牌（只暴露角色，不暴露副本编号）
  alive: boolean;
}

export interface PublicState {
  phase: Phase;
  players: PublicPlayerView[];
  currentPlayerId: string | null;
  pending: {
    action: ActionType;
    actorId: string;
    targetId?: string;
    claimedRole?: Role;
    blockById?: string;
    blockRole?: Role;
  } | null;
  challengeSubject: ChallengeSubject | null;
  lossPlayerId: string | null;
  exchangeKeepCount: number | null;
  passed: string[];
  winnerId: string | null;
}

// 私有状态（只发给本人）
export interface PrivateState {
  playerId: string;
  hand: Card[];
}
