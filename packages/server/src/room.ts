import type { GameState, GameEvent, Role, ActionType } from '@coup/engine';
import { randomBytes } from 'node:crypto';
import {
  GameRuleError,
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
import { ClientError } from './errors.ts';

const ACTION_TIMEOUT_MS = 60_000;
const WINDOW_TIMEOUT_MS = 20_000;
const DISCONNECT_GRACE_MS = 90_000;
const MAX_PLAYERS = 6;
const MAX_NAME_LENGTH = 32;

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
  onBroadcast(room: Room, events: GameEvent[]): void;
  onEmpty(room: Room): void;
}

export interface RoomOptions {
  startingPlayerRandom?: () => number;
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

  constructor(
    code: string,
    hostId: string,
    private repo: GameRepository,
    private events: RoomEvents,
    private options: RoomOptions = {},
  ) {
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
    if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new ClientError({ code: 'invalidName' });
    }
    name = name.trim();
    if (reconnect) {
      const existing = this.players.get(reconnect.id);
      if (existing && existing.secret === reconnect.secret) {
        existing.socketId = socketId;
        existing.connected = true;
        if (name) existing.name = name;
        this.clearDisconnectTimer(reconnect.id);
        this.handOffOfflineHost();
        return existing;
      }
    }
    // 新玩家：服务器生成全新 id 与 secret。开局后禁止新玩家加入，保证 room.players 是 game.players 的子集。
    if (this.game) throw new ClientError({ code: 'gameAlreadyStarted' });
    if (this.players.size >= MAX_PLAYERS) {
      throw new ClientError({ code: 'roomFull', params: { maximum: MAX_PLAYERS } });
    }
    const p: RoomPlayer = { id: genId(), secret: genSecret(), name, socketId, connected: true };
    this.players.set(p.id, p);
    return p;
  }

  isCurrentConnection(id: string, socketId: string): boolean {
    const p = this.players.get(id);
    return !!p && p.connected && p.socketId === socketId;
  }

  private requireCurrentConnection(id: string, socketId: string): void {
    if (!this.isCurrentConnection(id, socketId)) throw new ClientError({ code: 'illegalIntent' });
  }

  markDisconnected(id: string, socketId: string): boolean {
    if (!this.isCurrentConnection(id, socketId)) return false;
    const p = this.players.get(id)!;
    p.connected = false;
    this.handOffOfflineHost();
    const t = setTimeout(() => {
      if (this.players.get(id) !== p || p.connected || p.socketId !== socketId) return;
      // 游戏结束后（gameOver）断连：对局已定胜负，forfeit 无意义，直接移除玩家让房间能排空回收。
      if (!this.game || this.game.phase === 'gameOver') {
        this.removePlayer(id);
        this.events.onBroadcast(this, []);
      } else {
        const events = this.apply((g) => forfeit(g, id));
        this.events.onBroadcast(this, events);
      }
      this.disconnectTimers.delete(id);
    }, DISCONNECT_GRACE_MS);
    this.disconnectTimers.set(id, t);
    return true;
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
      this.handOffOfflineHost();
    }
  }

  // 牌局结束后房主离线：再来一局的权利立即交给最早加入的在线玩家，不等宽限期。
  private handOffOfflineHost(): void {
    if (this.game?.phase !== 'gameOver' || this.players.get(this.hostId)?.connected) return;
    const next = [...this.players.values()].find((p) => p.connected);
    if (next) this.hostId = next.id;
  }

  rematch(playerId: string, socketId: string): void {
    this.requireCurrentConnection(playerId, socketId);
    if (this.game?.phase !== 'gameOver') throw new ClientError({ code: 'illegalIntent' });
    if (playerId !== this.hostId) throw new ClientError({ code: 'hostOnly' });
    // 牌局中宽限期已到而弃权的玩家仍占着座位且没有计时器，不带进新的大厅阶段。
    for (const p of [...this.players.values()]) {
      if (!p.connected && !this.disconnectTimers.has(p.id)) this.removePlayer(p.id);
    }
    this.game = null;
    this.repo.delete(this.code);
    this.clearTimer();
  }

  startGame(playerId: string, socketId: string): GameEvent[] {
    this.requireCurrentConnection(playerId, socketId);
    if (playerId !== this.hostId) throw new ClientError({ code: 'hostOnly' });
    if (this.players.size < 2) {
      throw new ClientError({ code: 'minimumPlayers', params: { minimum: 2 } });
    }
    const entries = [...this.players.values()];
    const random = (this.options.startingPlayerRandom ?? Math.random)();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw new Error('starting player random value must be between 0 and 1');
    }
    const startingPlayerId = entries[Math.floor(random * entries.length)].id;
    this.game = createGame(entries.map((p) => ({ id: p.id, name: p.name })), {
      startingPlayerId,
    });
    this.repo.save(this.code, this.game);
    this.startTimer(ACTION_TIMEOUT_MS);
    return [{ type: 'started', turnOrder: entries.map((p) => p.id) }];
  }

  leavePlayer(playerId: string, socketId: string): GameEvent[] {
    this.requireCurrentConnection(playerId, socketId);
    // 牌局结束后离开不算弃权，直接移除。
    const events = this.game && this.game.phase !== 'gameOver' ? this.apply((g) => forfeit(g, playerId)) : [];
    this.removePlayer(playerId);
    return events;
  }

  apply(fn: (g: GameState) => GameEvent[]): GameEvent[] {
    if (!this.game) throw new ClientError({ code: 'gameNotStarted' });
    const events = fn(this.game);
    this.repo.save(this.code, this.game);
    this.afterMutation(events);
    return events;
  }

  private afterMutation(_events: GameEvent[]): void {
    if (!this.game) return;
    this.handOffOfflineHost();
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

  getDeadlineAt(): number | null {
    return this.deadlineAt;
  }

  private onTimeout(): void {
    if (!this.game) return;
    try {
      let events: GameEvent[];
      if (this.game.phase === 'choosingAction') {
        events = this.autoAction();
      } else if (this.game.phase === 'awaitingChallenge') {
        events = this.apply((g) => resolveChallengeTimeout(g));
      } else if (this.game.phase === 'awaitingBlock') {
        events = this.apply((g) => resolveBlockTimeout(g));
      } else {
        return;
      }
      this.events.onBroadcast(this, events);
    } catch (e) {
      console.error('timeout error', e);
    }
  }

  private autoAction(): GameEvent[] {
    const g = this.game!;
    const cur = g.currentPlayerId!;
    const curPlayer = g.players.find((p) => p.id === cur)!;
    if (curPlayer.coins >= 10) {
      const targets = g.players.filter((p) => p.alive && p.id !== cur);
      const target = targets[Math.floor(Math.random() * targets.length)];
      return this.apply((s) => chooseAction(s, cur, 'coup', target.id));
    } else {
      return this.apply((s) => chooseAction(s, cur, 'income'));
    }
  }

  // 客户端意图分发
  dispatch(playerId: string, socketId: string, intent: { type: string } & Record<string, unknown>): GameEvent[] {
    this.requireCurrentConnection(playerId, socketId);
    try {
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
          throw new ClientError({ code: 'illegalIntent' });
      }
    } catch (error) {
      if (error instanceof ClientError) throw error;
      if (error instanceof GameRuleError) {
        throw new ClientError({ code: 'invalidGameAction' }, { cause: error });
      }
      throw error;
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
