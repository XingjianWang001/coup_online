import type { GameState, GameEvent, Role, ActionType } from '@coup/engine';
import { randomBytes } from 'node:crypto';
import {
  block,
  challenge,
  chooseAction,
  createGame,
  forfeit,
  passBlock,
  passChallenge,
  privateState,
  publicState,
  resolveBlockTimeout,
  resolveChallengeTimeout,
  resolveExchange,
  resolveLoss,
} from '@coup/engine';
import type { GameRepository } from './repository.ts';
import type { LobbyPlayer } from '@coup/shared';

const ACTION_TIMEOUT_MS = 60_000;
const WINDOW_TIMEOUT_MS = 20_000;
const DISCONNECT_GRACE_MS = 90_000;

function genId(): string {
  return randomBytes(8).toString('hex');
}

function genSecret(): string {
  return randomBytes(16).toString('hex');
}

export interface RoomPlayer {
  id: string;
  name: string;
  socketId: string;
  connected: boolean;
  secret: string; // 重连凭证，只发给本人，不对外广播
}

export interface RoomEvents {
  onBroadcast(room: Room): void;
  onEmpty(room: Room): void;
}

export class Room {
  code: string;
  hostId: string;
  players = new Map<string, RoomPlayer>();
  game: GameState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deadlineAt: number | null = null;
  private emptyTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(code: string, hostId: string, private repo: GameRepository, private events: RoomEvents) {
    this.code = code;
    this.hostId = hostId;
  }

  get playerList(): LobbyPlayer[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.id === this.hostId,
      connected: p.connected,
    }));
  }

  // 加入或重连。reconnect 提供 id + secret，匹配才复用座位，否则视为新玩家（防劫持）。
  addPlayer(name: string, socketId: string, reconnect?: { id: string; secret: string }): RoomPlayer {
    if (reconnect) {
      const existing = this.players.get(reconnect.id);
      if (existing && existing.secret === reconnect.secret) {
        existing.socketId = socketId;
        existing.connected = true;
        if (name) existing.name = name;
        this.clearDisconnectTimer(reconnect.id);
        return existing;
      }
    }
    // 新玩家：服务器生成全新 id 与 secret。开局后禁止新玩家加入，保证 room.players 是 game.players 的子集。
    if (this.game) throw new Error('游戏已开始，无法加入');
    const p: RoomPlayer = { id: genId(), secret: genSecret(), name, socketId, connected: true };
    this.players.set(p.id, p);
    return p;
  }

  markDisconnected(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    const t = setTimeout(() => {
      // 游戏结束后（gameOver）断连：对局已定胜负，forfeit 无意义，直接移除玩家让房间能排空回收。
      if (!this.game || this.game.phase === 'gameOver') {
        this.removePlayer(id);
      } else {
        this.apply(() => forfeit(this.game!, id));
      }
      this.disconnectTimers.delete(id);
    }, DISCONNECT_GRACE_MS);
    this.disconnectTimers.set(id, t);
  }

  clearDisconnectTimer(id: string): void {
    const t = this.disconnectTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.disconnectTimers.delete(id);
    }
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    this.clearDisconnectTimer(id);
    if (this.players.size === 0) {
      this.scheduleEmptyCleanup();
    } else if (id === this.hostId) {
      this.hostId = this.players.keys().next().value!;
    }
  }

  startGame(): GameEvent[] {
    if (this.players.size < 2) throw new Error('至少 2 人才能开局');
    const entries = [...this.players.values()];
    this.game = createGame(entries.map((p) => ({ id: p.id, name: p.name })));
    this.repo.save(this.code, this.game);
    this.startTimer(ACTION_TIMEOUT_MS);
    return [{ type: 'started', turnOrder: entries.map((p) => p.id) }];
  }

  apply(fn: (g: GameState) => GameEvent[]): GameEvent[] {
    if (!this.game) throw new Error('游戏尚未开始');
    const events = fn(this.game);
    this.repo.save(this.code, this.game);
    this.afterMutation(events);
    return events;
  }

  private afterMutation(_events: GameEvent[]): void {
    if (!this.game) return;
    switch (this.game.phase) {
      case 'choosingAction':
        this.startTimer(ACTION_TIMEOUT_MS);
        break;
      case 'awaitingChallenge':
      case 'awaitingBlock':
        this.startTimer(WINDOW_TIMEOUT_MS);
        break;
      default:
        this.clearTimer();
    }
  }

  private startTimer(ms: number): void {
    this.clearTimer();
    this.deadlineAt = Date.now() + ms;
    this.timer = setTimeout(() => this.onTimeout(), ms);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.deadlineAt = null;
  }

  // 权威剩余时间（毫秒）供客户端渲染倒计时；无计时窗口时为 null。
  getDeadlineMs(): number | null {
    if (this.deadlineAt == null) return null;
    return Math.max(0, this.deadlineAt - Date.now());
  }

  private onTimeout(): void {
    if (!this.game) return;
    try {
      if (this.game.phase === 'choosingAction') {
        this.autoAction();
      } else if (this.game.phase === 'awaitingChallenge') {
        this.apply((g) => resolveChallengeTimeout(g));
      } else if (this.game.phase === 'awaitingBlock') {
        this.apply((g) => resolveBlockTimeout(g));
      }
    } catch (e) {
      console.error('timeout error', e);
    }
  }

  private autoAction(): void {
    const g = this.game!;
    const cur = g.currentPlayerId!;
    const curPlayer = g.players.find((p) => p.id === cur)!;
    if (curPlayer.coins >= 10) {
      const targets = g.players.filter((p) => p.alive && p.id !== cur);
      const target = targets[Math.floor(Math.random() * targets.length)];
      this.apply((s) => chooseAction(s, cur, 'coup', target.id));
    } else {
      this.apply((s) => chooseAction(s, cur, 'income'));
    }
  }

  // 客户端意图分发
  dispatch(playerId: string, intent: { type: string } & Record<string, unknown>): GameEvent[] {
    if (!this.game) throw new Error('游戏尚未开始');
    switch (intent.type) {
      case 'chooseAction':
        return this.apply((g) => chooseAction(g, playerId, intent.action as ActionType, intent.targetId as string | undefined));
      case 'challenge':
        return this.apply((g) => challenge(g, playerId));
      case 'passChallenge':
        return this.apply((g) => passChallenge(g, playerId));
      case 'block':
        return this.apply((g) => block(g, playerId, intent.role as Role));
      case 'passBlock':
        return this.apply((g) => passBlock(g, playerId));
      case 'resolveLoss':
        return this.apply((g) => resolveLoss(g, playerId, intent.cardId as string));
      case 'resolveExchange':
        return this.apply((g) => resolveExchange(g, playerId, intent.keepIds as string[]));
      default:
        throw new Error(`unknown intent ${intent.type}`);
    }
  }

  getPublicState() {
    return this.game ? publicState(this.game) : null;
  }

  getPrivateState(playerId: string) {
    if (!this.game) return null;
    // 防御：玩家不在对局中时返回 null 而非抛错，避免 broadcast 因脏数据拖垮服务器。
    if (!this.game.players.some((p) => p.id === playerId)) return null;
    return privateState(this.game, playerId);
  }

  private scheduleEmptyCleanup(): void {
    if (this.emptyTimer) return;
    this.emptyTimer = setTimeout(() => {
      if (this.players.size === 0) {
        this.repo.delete(this.code);
        this.events.onEmpty(this);
      }
      this.emptyTimer = null;
    }, 5 * 60_000); // 空房 5 分钟清理
  }
}
