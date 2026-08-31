import type { GameState, GameEvent, Role, ActionType } from '@coup/engine';
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
  resolveExchange,
  resolveLoss,
} from '@coup/engine';
import type { GameRepository } from './repository.ts';
import type { LobbyPlayer } from '@coup/shared';

const ACTION_TIMEOUT_MS = 60_000;
const WINDOW_TIMEOUT_MS = 20_000;
const DISCONNECT_GRACE_MS = 90_000;

export interface RoomPlayer {
  id: string;
  name: string;
  socketId: string;
  connected: boolean;
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

  addPlayer(id: string, name: string, socketId: string): RoomPlayer {
    // 重连：复用已有玩家（保持座位）
    const existing = this.players.get(id);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      if (name) existing.name = name;
      this.clearDisconnectTimer(id);
      return existing;
    }
    const p: RoomPlayer = { id, name, socketId, connected: true };
    this.players.set(p.id, p);
    return p;
  }

  markDisconnected(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    const t = setTimeout(() => {
      if (!this.game) {
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
    this.timer = setTimeout(() => this.onTimeout(), ms);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private onTimeout(): void {
    if (!this.game) return;
    try {
      if (this.game.phase === 'choosingAction') {
        this.autoAction();
      } else if (this.game.phase === 'awaitingChallenge') {
        this.apply((g) => passChallenge(g));
      } else if (this.game.phase === 'awaitingBlock') {
        this.apply((g) => passBlock(g));
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
        return this.apply((g) => passChallenge(g));
      case 'block':
        return this.apply((g) => block(g, playerId, intent.role as Role));
      case 'passBlock':
        return this.apply((g) => passBlock(g));
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
    return this.game ? privateState(this.game, playerId) : null;
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
