import type { GameState, GameEvent, Role, ActionType, Phase } from '@coup/engine';
import { randomBytes } from 'node:crypto';
import {
  ACTION_CLAIM,
  FORCED_COUP_COINS,
  GameRuleError,
  MAX_PLAYERS,
  ROLE_ORDER,
  needsTarget,
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
  resolveExchangeTimeout,
  resolveLoss,
  resolveLossTimeout,
  resolveShowdownTimeout,
  revealPostGameCard,
  revealShowdownCard,
} from '@coup/engine';
import type { GameRepository } from './repository.ts';
import { PHRASES, STRENGTHS, type LobbyPlayer, type Phrase, type Reaction, type Strength } from '@coup/shared';
import { ClientError } from './errors.ts';
import { TUNINGS, decideComputerIntent, drawTemperament, type ComputerIntent, type Returned, type Temperament } from './computer.ts';
import { afterOwnClaim, onOwnTurn, speak, stagger, temper, type Moment, type Said } from './speech.ts';

const ACTION_TIMEOUT_MS = 60_000;
const WINDOW_TIMEOUT_MS = 20_000;
// 对质揭晓后客户端要播完翻牌、换牌或落回座位的动画（约 6 秒），下一段计时顺延这么久，免得倒计时被动画吃掉。
// 与 client/src/App.tsx 对质舞台的动画时长（SUSPENSE_MS 等）一起改
const REVEAL_MS = 6_000;
const FOCUS_MIN_INTERVAL_MS = 50;
// 客户端发完表态冷却 2 秒；服务器按玩家只拦 1.5 秒，留 0.5 秒给网络抖动，正常冷却后的表态不会被误丢
const REACTION_MIN_INTERVAL_MS = 1_500;
const DISCONNECT_GRACE_MS = 90_000;
const MAX_NAME_LENGTH = 32;
// 电脑玩家的名字不分语言（ADR 0008：文字归客户端，名字不翻译）。6 个够用：加第 6 位时房里只有 5 个名字可能撞上
const COMPUTER_NAMES = ['Ada', 'Alan', 'Grace', 'Hedy', 'Linus', 'Edsger'];

// 每个进行中的阶段都要有时限和超时后的处理，否则在线却不操作的玩家能让牌局永远卡住（#24）。
// 用 Record 而不是 switch：新增阶段时漏写这里会编译报错。
type TimedPhase = Exclude<Phase, 'gameOver'>;
const PHASE_TIMEOUTS: Record<TimedPhase, { ms: number; resolve: (g: GameState) => GameEvent[] }> = {
  choosingAction: { ms: ACTION_TIMEOUT_MS, resolve: autoAction },
  awaitingChallenge: { ms: WINDOW_TIMEOUT_MS, resolve: resolveChallengeTimeout },
  awaitingBlock: { ms: WINDOW_TIMEOUT_MS, resolve: resolveBlockTimeout },
  showdown: { ms: WINDOW_TIMEOUT_MS, resolve: resolveShowdownTimeout },
  choosingLoss: { ms: WINDOW_TIMEOUT_MS, resolve: resolveLossTimeout },
  choosingExchange: { ms: ACTION_TIMEOUT_MS, resolve: resolveExchangeTimeout },
};
const isTimed = (phase: Phase): phase is TimedPhase => phase in PHASE_TIMEOUTS;

// 电脑出手前等待的区间（毫秒）。同一个问询窗口里质疑、阻挡、放弃用同一个分布，出手快慢不泄露手牌
const COMPUTER_DELAY_MS: Record<TimedPhase, [number, number]> = {
  choosingAction: [2_000, 6_000],
  awaitingChallenge: [1_500, 5_000],
  awaitingBlock: [1_500, 5_000],
  showdown: [2_000, 4_000],
  choosingLoss: [2_000, 4_000],
  choosingExchange: [2_000, 4_000],
};
// 开局第一手另加的等待：发牌展示要真人自己点掉
const COMPUTER_FIRST_MOVE_MS = 3_000;
// 房里的真人全被淘汰、只剩旁观时，电脑约 1 秒一步
const COMPUTER_SPECTATED_MS = 1_000;
// 出手延迟右偏：0～1 的均匀随机数取幂后再铺到区间上，多数时候偏快、偶尔长考，指数越大越快。
// 问询窗口里，声称冲着自己来时想得久一些，不冲着自己来时更快。起始值，靠试玩校准
const COMPUTER_DELAY_SKEW = { aimedAtSelf: 1.5, aimedElsewhere: 3, otherPhases: 2 };
// 对质翻牌前的犹豫：每隔这么久（区间内均匀）换一次对准；落到要翻的那张后停这么久再翻。
// 出手延迟最短 2 秒时也至少游移两次（550 + 550 + 250 ≤ 2000 - 600）。起始值，靠试玩校准
const WANDER_GAP_MS = [250, 550] as const;
const LAND_HOLD_MS = 600;

// 行动超时的默认行动：金币到了 FORCED_COUP_COINS 必须政变（随机目标），否则收入
function autoAction(g: GameState): GameEvent[] {
  const cur = g.currentPlayerId!;
  if (g.players.find((p) => p.id === cur)!.coins >= FORCED_COUP_COINS) {
    const targets = g.players.filter((p) => p.alive && p.id !== cur);
    return chooseAction(g, cur, 'coup', targets[Math.floor(Math.random() * targets.length)].id);
  }
  return chooseAction(g, cur, 'income');
}

const isAction = (value: unknown): value is ActionType => typeof value === 'string' && Object.hasOwn(ACTION_CLAIM, value);
const isRole = (value: unknown): value is Role => (ROLE_ORDER as readonly unknown[]).includes(value);

// 表态来自客户端：只认预设内容，按已知字段重新组装，多余字段（比如自写文字）不会被转发出去
function parseReaction(raw: unknown): Reaction {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.kind === 'phrase' && (PHRASES as readonly unknown[]).includes(r.phrase)) {
    return { kind: 'phrase', phrase: r.phrase as Phrase };
  }
  if (r.kind === 'announcement' && isAction(r.action) && (r.targetId === undefined || typeof r.targetId === 'string')) {
    return r.targetId === undefined
      ? { kind: 'announcement', action: r.action }
      : { kind: 'announcement', action: r.action, targetId: r.targetId };
  }
  if (r.kind === 'verbalClaim' && typeof r.has === 'boolean' && isRole(r.role)) {
    return { kind: 'verbalClaim', has: r.has, role: r.role };
  }
  throw new ClientError({ code: 'illegalIntent' });
}

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
  // 电脑玩家没有连接：connected 恒为 false，所以它不算在场、不能当房主、任何连接都冒充不了它
  isComputer: boolean;
  strength?: Strength; // 只有电脑玩家有
}

export interface RoomEvents {
  // 房间状态变化后的唯一推送出口：所有改变房间的方法结束时都会调用（加入/重连除外，由传输层在连接入房后推送）。
  onBroadcast(room: Room, events: GameEvent[]): void;
  onEmpty(room: Room): void;
  // 表态的唯一出口：真人和电脑的表态校验通过后都从这里发给整个房间（含发送者）
  onReaction(room: Room, reaction: { playerId: string; reaction: Reaction }): void;
  // 电脑对质时的对准：电脑没有连接，发给整个房间。真人的对准由 focusShowdownCard 返回、传输层转发给其他人
  onShowdownFocus(room: Room, focus: { slot: number | null }): void;
}

export interface RoomOptions {
  startingPlayerRandom?: () => number;
  // 电脑玩家的随机源，决策和出手延迟共用
  computerRandom?: () => number;
  // 电脑在该阶段出手前等多久（毫秒），替换默认区间和旁观加速；揭晓动画、开局发牌展示的顺延照加
  computerDelayMs?: (phase: Phase) => number;
  // 电脑表态的随机源（说不说、说哪条、什么时候说），和 computerRandom 分开：启停发言不改变行动的随机序列
  speechRandom?: () => number;
}

export class Room {
  code: string;
  hostId: string;
  players = new Map<string, RoomPlayer>();
  game: GameState | null = null;
  gameNumber = 0;
  // 上局获胜者：记在房间而非牌局里，因为再来一局会清掉牌局
  previousWinnerId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private computerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // 电脑还没发出的表态和对质时的对准
  private speechTimers = new Set<ReturnType<typeof setTimeout>>();
  // 电脑本局已发出的表态（错峰、降温、重复降权用），开局清空
  private computerSpeech: Said[] = [];
  // 电脑玩家本局的性格，和它的局内记忆所依据的本局公开事件：每次开局重抽、清空，不带到下一局
  private temperaments = new Map<string, Temperament>();
  private gameEvents: GameEvent[] = [];
  // 电脑玩家本局交换时放回牌堆的牌：只有它自己看得到，和真人坐在这个座位上能记住的一样
  private returned = new Map<string, Returned[]>();
  private lastFocusAt = 0;
  // ponytail: 离开房间的玩家不删条目；一个房间至多几位玩家、空房 5 分钟后整个回收，不值得在每条移除路径上清理
  private lastReactionAt = new Map<string, number>();
  private deadlineAt: number | null = null;
  private emptyTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly computerRandom: () => number;
  private readonly speechRandom: () => number;

  constructor(
    code: string,
    hostId: string,
    private repo: GameRepository,
    private events: RoomEvents,
    private options: RoomOptions = {},
  ) {
    this.code = code;
    this.hostId = hostId;
    this.computerRandom = options.computerRandom ?? Math.random;
    this.speechRandom = options.speechRandom ?? Math.random;
  }

  get playerList(): LobbyPlayer[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.id === this.hostId,
      connected: p.connected || p.isComputer, // 名单上的 connected 只用来标离线，电脑玩家从不离线
      isPreviousWinner: p.id === this.previousWinnerId,
      isComputer: p.isComputer,
      ...(p.strength && { strength: p.strength }),
    }));
  }

  // 新加的电脑玩家一律普通，强度由房主之后逐个改
  addComputer(playerId: string, socketId: string): void {
    this.requireLobbyHost(playerId, socketId);
    if (this.players.size >= MAX_PLAYERS) {
      throw new ClientError({ code: 'roomFull', params: { maximum: MAX_PLAYERS } });
    }
    const taken = new Set([...this.players.values()].map((p) => p.name));
    const name = COMPUTER_NAMES.find((n) => !taken.has(n))!;
    const p: RoomPlayer = { id: genId(), secret: genSecret(), name, socketId: '', connected: false, isComputer: true, strength: 'standard' };
    this.players.set(p.id, p);
    this.events.onBroadcast(this, []);
  }

  removeComputer(playerId: string, socketId: string, computerId: unknown): void {
    this.requireLobbyHost(playerId, socketId);
    this.removePlayer(this.requireComputer(computerId).id);
    this.events.onBroadcast(this, []);
  }

  setComputerStrength(playerId: string, socketId: string, computerId: unknown, strength: unknown): void {
    this.requireLobbyHost(playerId, socketId);
    const computer = this.requireComputer(computerId);
    if (!STRENGTHS.includes(strength as Strength)) throw new ClientError({ code: 'illegalIntent' });
    computer.strength = strength as Strength;
    this.events.onBroadcast(this, []);
  }

  private requireComputer(computerId: unknown): RoomPlayer {
    const p = typeof computerId === 'string' ? this.players.get(computerId) : undefined;
    if (!p?.isComputer) throw new ClientError({ code: 'illegalIntent' });
    return p;
  }

  private requireLobbyHost(playerId: string, socketId: string): void {
    this.requireCurrentConnection(playerId, socketId);
    if (playerId !== this.hostId) throw new ClientError({ code: 'hostOnly' });
    if (this.game) throw new ClientError({ code: 'illegalIntent' });
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
        this.clearEmptyTimer();
        this.handOffOfflineHost();
        return existing;
      }
    }
    // 新玩家：服务器生成全新 id 与 secret。开局后禁止新玩家加入，保证 room.players 是 game.players 的子集。
    if (this.game) throw new ClientError({ code: 'gameAlreadyStarted' });
    // 满座时最后加入的电脑玩家给真人让座（重连已在上面返回，不会走到这里）
    const yielding = [...this.players.values()].filter((p) => p.isComputer).pop();
    if (this.players.size >= MAX_PLAYERS && yielding) this.removePlayer(yielding.id);
    if (this.players.size >= MAX_PLAYERS) {
      throw new ClientError({ code: 'roomFull', params: { maximum: MAX_PLAYERS } });
    }
    const p: RoomPlayer = { id: genId(), secret: genSecret(), name, socketId, connected: true, isComputer: false };
    this.players.set(p.id, p);
    // 房主已离开或离线（含最后一人离开后空房被重新加入）：由在线的玩家接任。
    this.handOffOfflineHost();
    this.clearEmptyTimer();
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
    this.events.onBroadcast(this, []);
    const t = setTimeout(() => {
      if (this.players.get(id) !== p || p.connected || p.socketId !== socketId) return;
      // 游戏结束后（gameOver）断连：牌局已定胜负，forfeit 无意义，直接移除玩家让房间能排空回收。
      if (!this.game || this.game.phase === 'gameOver') {
        this.removePlayer(id);
        this.events.onBroadcast(this, []);
      } else {
        const events = this.apply((g) => forfeit(g, id));
        this.events.onBroadcast(this, events);
      }
      this.disconnectTimers.delete(id);
      if (!this.hasPresentPlayer()) this.scheduleEmptyCleanup();
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
    if (id === this.previousWinnerId) this.previousWinnerId = null;
    this.clearDisconnectTimer(id);
    if (!this.hasPresentPlayer()) this.scheduleEmptyCleanup();
    // 房主只能是真人：只剩电脑玩家时没有房主，下一位加入的真人经 handOffOfflineHost 接任
    const heir = [...this.players.values()].find((p) => !p.isComputer);
    if (heir && id === this.hostId) {
      this.hostId = heir.id;
      this.handOffOfflineHost();
    }
  }

  // 在场：在线，或断线但仍在宽限期内。宽限期已到而弃权的座位只是留着，不算在场。
  private isPresent(p: RoomPlayer): boolean {
    return p.connected || this.disconnectTimers.has(p.id);
  }

  private hasPresentPlayer(): boolean {
    return [...this.players.values()].some((p) => this.isPresent(p));
  }

  // 大厅阶段或牌局结束后房主离线：开局或再来一局的权利立即交给最早加入的在线玩家，不等宽限期。
  private handOffOfflineHost(): void {
    if ((this.game && this.game.phase !== 'gameOver') || this.players.get(this.hostId)?.connected) return;
    const next = [...this.players.values()].find((p) => p.connected);
    if (next) this.hostId = next.id;
  }

  rematch(playerId: string, socketId: string): void {
    this.requireCurrentConnection(playerId, socketId);
    if (this.game?.phase !== 'gameOver') throw new ClientError({ code: 'illegalIntent' });
    if (playerId !== this.hostId) throw new ClientError({ code: 'hostOnly' });
    this.returnToLobby();
    this.events.onBroadcast(this, []);
  }

  private returnToLobby(): void {
    // 先清牌局：下面的 removePlayer 可能走到 scheduleEmptyCleanup，那里不能再看到进行中的牌局
    this.game = null;
    this.repo.delete(this.code);
    this.clearTimer();
    // 牌局中宽限期已到而弃权的真人玩家仍占着座位且没有计时器，不带进新的大厅阶段；电脑玩家留下。
    for (const p of [...this.players.values()]) {
      if (!p.isComputer && !this.isPresent(p)) this.removePlayer(p.id);
    }
  }

  startGame(playerId: string, socketId: string): GameEvent[] {
    this.requireCurrentConnection(playerId, socketId);
    if (playerId !== this.hostId) throw new ClientError({ code: 'hostOnly' });
    // 只有大厅阶段能开局：牌局中或结束后要走 rematch()，它会清掉已弃权的座位。
    if (this.game) throw new ClientError({ code: 'gameAlreadyStarted' });
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
    this.gameNumber += 1;
    this.temperaments = new Map(entries.filter((p) => p.isComputer).map((p) => [p.id, drawTemperament(this.computerRandom, TUNINGS[p.strength!])]));
    this.gameEvents = [];
    this.computerSpeech = [];
    this.returned.clear();
    this.repo.save(this.code, this.game);
    this.startTimer(ACTION_TIMEOUT_MS);
    this.scheduleComputers(COMPUTER_FIRST_MOVE_MS);
    const events: GameEvent[] = [{ type: 'started', turnOrder: entries.map((p) => p.id) }];
    this.events.onBroadcast(this, events);
    return events;
  }

  leavePlayer(playerId: string, socketId: string): GameEvent[] {
    this.requireCurrentConnection(playerId, socketId);
    // 牌局结束后离开不算弃权，直接移除。
    const events = this.game && this.game.phase !== 'gameOver' ? this.apply((g) => forfeit(g, playerId)) : [];
    this.removePlayer(playerId);
    this.events.onBroadcast(this, events);
    return events;
  }

  apply(fn: (g: GameState) => GameEvent[]): GameEvent[] {
    if (!this.game) throw new ClientError({ code: 'gameNotStarted' });
    const before = this.timerKey();
    const events = fn(this.game);
    this.gameEvents.push(...events);
    this.repo.save(this.code, this.game);
    this.afterMutation(events, before);
    return events;
  }

  // 计时归属：阶段 + 该阶段要行动的玩家（失去影响力者、被质疑者或当前玩家）
  private timerKey(): string {
    const g = this.game!;
    return `${g.phase}:${g.lossToResolve?.playerId ?? g.showdown?.claimantId ?? g.currentPlayerId}`;
  }

  private afterMutation(events: GameEvent[], timerKeyBefore: string): void {
    if (!this.game) return;
    if (this.game.winnerId) this.previousWinnerId = this.game.winnerId;
    this.handOffOfflineHost();
    const reveal = events.some((e) => e.type === 'challengeResolved') ? REVEAL_MS : 0;
    // 时限从进入阶段起算：有人放弃回应、已淘汰者弃权等不换阶段也不换行动者的变化不重新计时
    if (this.timerKey() !== timerKeyBefore) {
      const phase = this.game.phase;
      if (isTimed(phase)) this.startTimer(PHASE_TIMEOUTS[phase].ms + reveal);
      else this.clearTimer();
    }
    this.scheduleComputers(reveal);
    this.scheduleSpeech(events);
  }

  private startTimer(ms: number): void {
    this.clearTimer();
    this.deadlineAt = Date.now() + ms;
    this.timer = setTimeout(() => this.onTimeout(), ms);
  }

  // 阶段时限、电脑出手和电脑没发出的表态一起清：换阶段或换行动者、牌局结束、回到大厅时都不留旧的电脑计时器。
  // 表态说的是眼前的事，换了阶段或行动者就过时了
  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.deadlineAt = null;
    for (const t of [...this.computerTimers.values(), ...this.speechTimers]) clearTimeout(t);
    this.computerTimers.clear();
    this.speechTimers.clear();
  }

  // 给此刻要作决定、还没排上的电脑各排一次出手。已排上的不重排：同一窗口里别人放弃不推迟它
  private scheduleComputers(extraMs: number): void {
    const g = this.game!;
    const phase = g.phase;
    if (!isTimed(phase)) return;
    const humanAlive = this.humanAlive();
    const [min, max] = COMPUTER_DELAY_MS[phase];
    const inquiry = phase === 'awaitingChallenge' || phase === 'awaitingBlock';
    // 声称冲着谁来只看公开信息：行动的声称冲着它的目标，阻挡的声称冲着被拦的行动者
    const aimedAt = g.challengeSubject === 'block' ? g.pending!.actorId : g.pending?.targetId;
    for (const p of this.players.values()) {
      if (!p.isComputer || this.computerTimers.has(p.id) || !this.decideComputer(p.id)) continue;
      const skew = COMPUTER_DELAY_SKEW[!inquiry ? 'otherPhases' : aimedAt === p.id ? 'aimedAtSelf' : 'aimedElsewhere'];
      const delay = this.options.computerDelayMs?.(phase) ?? (humanAlive ? min + this.computerRandom() ** skew * (max - min) : COMPUTER_SPECTATED_MS);
      this.computerTimers.set(p.id, setTimeout(() => this.computerMove(p.id), delay + extraMs));
      if (phase === 'showdown' && humanAlive) this.hesitate(p.id, delay + extraMs);
    }
  }

  // 房里还有没被淘汰的真人；没有时只剩旁观，电脑 1 秒一步
  private humanAlive(): boolean {
    return [...this.players.values()].some((p) => !p.isComputer && this.game!.players.find((gp) => gp.id === p.id)?.alive);
  }

  // 对质翻牌前的犹豫（#58）：翻牌前在自己的暗牌之间游移几次，最后落在要翻的那张上，停一下再翻；翻牌时刻不变。
  // 游移的顺序和时刻只抽发言随机源、只看暗牌张数（公开），与暗牌无关；落点到点才决定，就是马上翻开的那张
  private hesitate(id: string, revealInMs: number): void {
    const handSize = this.game!.players.find((p) => p.id === id)!.hand.length;
    const landAt = revealInMs - LAND_HOLD_MS;
    if (landAt < 0) return;
    const aim = (at: number, slot: () => number | undefined) => {
      const t = setTimeout(() => {
        this.speechTimers.delete(t);
        const s = slot();
        const focus = s === undefined ? null : this.aim(id, s);
        if (focus) this.events.onShowdownFocus(this, focus);
      }, at);
      this.speechTimers.add(t);
    };
    const gap = () => WANDER_GAP_MS[0] + this.speechRandom() * (WANDER_GAP_MS[1] - WANDER_GAP_MS[0]);
    let last: number | null = null;
    for (let at = gap(); at + WANDER_GAP_MS[0] <= landAt; at += gap()) {
      // 每次换到另一张：只剩一张时一直是它，只对准一次
      const slot: number = last === null ? Math.floor(this.speechRandom() * handSize) : (last + 1 + Math.floor(this.speechRandom() * (handSize - 1))) % handSize;
      if (slot !== last) aim(at, () => slot);
      last = slot;
    }
    aim(landAt, () => {
      const intent = this.decideComputer(id); // 对质时的决定不抽随机数，到点翻的就是这张
      return intent?.type === 'revealShowdownCard' ? this.game!.players.find((p) => p.id === id)!.hand.findIndex((c) => c.id === intent.cardId) : undefined;
    });
  }

  private decideComputer(id: string): ComputerIntent | null {
    const g = this.game;
    return g
      ? decideComputerIntent(publicState(g), privateState(g, id), this.gameEvents, this.temperaments.get(id)!, this.computerRandom, TUNINGS[this.players.get(id)!.strength!], this.returned.get(id))
      : null;
  }

  // 电脑表态（#58）：每个场景在这里认出自己的时刻，交给 speech.ts 选说什么。只读公开状态和本局公开事件
  private scheduleSpeech(events: GameEvent[]): void {
    const g = this.game!;
    // 表 2：电脑刚作出声称（含阻挡），问询窗口开着
    if (g.phase === 'awaitingChallenge' && events.some((e) => e.type === 'actionChosen' || e.type === 'blocked')) {
      const claimantId = g.pending!.blockById ?? g.pending!.actorId;
      this.say(claimantId, afterOwnClaim(publicState(g), this.gameEvents, claimantId));
    }
  }

  // 电脑抽签决定说不说；说的话到点经和真人相同的校验与限流发出。计时器随 clearTimer 一起清
  private say(id: string, moment: Moment): void {
    if (!this.players.get(id)?.isComputer) return;
    const speech = speak(temper(moment, id, this.computerSpeech, Date.now()), this.speechRandom);
    if (!speech) return;
    this.sayLater(id, speech.reaction, speech.delayMs, Date.now() + speech.delayMs);
  }

  // 到点时离全桌上一条电脑表态太近就顺延、晚太多就取消（stagger）。顺延的计时器也在 speechTimers 里，照样随 clearTimer 取消
  private sayLater(id: string, reaction: Reaction, ms: number, dueAt: number): void {
    const t = setTimeout(() => {
      this.speechTimers.delete(t);
      const now = Date.now();
      const wait = stagger(now, this.computerSpeech.at(-1)?.at, dueAt, this.speechRandom);
      if (wait === null) return;
      if (wait > 0) return this.sayLater(id, reaction, wait, dueAt);
      try {
        if (this.relay(id, reaction)) this.computerSpeech.push({ playerId: id, reaction, at: now });
      } catch (e) {
        console.error('computer speech error', e);
      }
    }, ms);
    this.speechTimers.add(t);
  }

  // 到点再决定一次：这期间局面可能已变（窗口已关、已轮到别人），此刻无需它决定就什么也不做。
  // 轮到自己选行动时（表 1），决定作出后可能先预告，停顿 0.8～1.5 秒再执行留着的决定；停顿记在 computerTimers 里，
  // 换阶段、换行动者、牌局结束或作废时随 clearTimer 一起取消，所以 60 秒时限照旧。旁观加速时不预告。
  // 预告和别的表态一样降温、计入全桌错峰；它不能顺延（停顿跟着它），离上一条电脑表态太近时就不说
  private computerMove(id: string): void {
    this.computerTimers.delete(id);
    const intent = this.decideComputer(id);
    if (!intent) return;
    try {
      const now = Date.now();
      if (intent.type === 'chooseAction' && this.humanAlive() && stagger(now, this.computerSpeech.at(-1)?.at, now, this.speechRandom) === 0) {
        const speech = speak(temper(onOwnTurn(publicState(this.game!), this.gameEvents, id, intent), id, this.computerSpeech, now), this.speechRandom);
        // 被限流丢掉的预告不算说过：不停顿
        if (speech && this.relay(id, speech.reaction)) {
          this.computerSpeech.push({ playerId: id, reaction: speech.reaction, at: now });
          this.computerTimers.set(id, setTimeout(() => this.computerAct(id, intent, true), speech.delayMs));
          return;
        }
      }
      this.computerAct(id, intent);
    } catch (e) {
      console.error('computer move error', e);
    }
  }

  // 停顿之后执行：留着的决定已失效（目标刚弃权）就重新决定。只有目标会在停顿里失效：换阶段或换行动者已取消了停顿
  private computerAct(id: string, intent: ComputerIntent | null, kept = false): void {
    if (kept) {
      this.computerTimers.delete(id);
      const targetId = intent?.type === 'chooseAction' ? intent.targetId : undefined;
      if (targetId && !this.game!.players.find((p) => p.id === targetId)!.alive) intent = this.decideComputer(id);
    }
    if (!intent) return;
    if (intent.type === 'resolveExchange') this.noteReturned(id, intent.keepIds);
    try {
      this.events.onBroadcast(this, this.applyIntent(id, intent));
    } catch (e) {
      console.error('computer move error', e);
    }
  }

  // 交换选牌时没留下的牌放回牌堆；记在自己那次 exchangeDrew 事件名下，牌堆记忆从那里开始算
  private noteReturned(id: string, keepIds: readonly string[]): void {
    let at = this.gameEvents.length - 1;
    for (; at >= 0; at -= 1) {
      const e = this.gameEvents[at];
      if (e.type === 'exchangeDrew' && e.playerId === id) break;
    }
    const roles = privateState(this.game!, id).hand.filter((c) => !keepIds.includes(c.id)).map((c) => c.role);
    this.returned.set(id, [...(this.returned.get(id) ?? []), { at, roles }]);
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
    const phase = this.game?.phase;
    if (!phase || !isTimed(phase)) return;
    try {
      this.events.onBroadcast(this, this.apply(PHASE_TIMEOUTS[phase].resolve));
    } catch (e) {
      console.error('timeout error', e);
    }
  }

  // 客户端意图分发
  dispatch(playerId: string, socketId: string, intent: { type: string } & Record<string, unknown>): GameEvent[] {
    this.requireCurrentConnection(playerId, socketId);
    // 重复的放弃（例如双击）不改变牌局：既不报错，也不广播，免得恶意客户端借此让全房间不停重渲染
    const g = this.game;
    const window = intent.type === 'passChallenge' ? 'awaitingChallenge' : intent.type === 'passBlock' ? 'awaitingBlock' : null;
    if (window && g?.phase === window && g.passed.includes(playerId)) return [];
    const events = this.applyIntent(playerId, intent);
    this.events.onBroadcast(this, events);
    return events;
  }

  private applyIntent(playerId: string, intent: { type: string } & Record<string, unknown>): GameEvent[] {
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
        case 'revealShowdownCard':
          return this.apply((g) => revealShowdownCard(g, playerId, intent.cardId as string));
        case 'revealPostGameCard':
          return this.apply((g) => revealPostGameCard(g, playerId, intent.cardId as string));
        case 'resolveLoss':
          return this.apply((g) => resolveLoss(g, playerId, intent.cardId as string));
        case 'resolveExchange':
          // keepIds 来自客户端：不是数组时在这里拒绝，而不是让引擎抛 TypeError、在日志里打一份堆栈
          if (!Array.isArray(intent.keepIds)) throw new ClientError({ code: 'invalidGameAction' });
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

  // 对质悬停同步：校验后返回 { slot } 交给传输层转发（slot 为 null 表示不再对准任何牌）；不该转发时返回 null。
  // 比客户端节流还密的消息直接丢弃，挡住刷屏；转发不进牌局状态。
  focusShowdownCard(playerId: string, socketId: string, slot: unknown): { slot: number | null } | null {
    this.requireCurrentConnection(playerId, socketId);
    return this.aim(playerId, slot);
  }

  // 对准的内核，不看连接：电脑没有连接，走这里而不伪造 socket
  private aim(playerId: string, slot: unknown): { slot: number | null } | null {
    const g = this.game;
    if (g?.phase !== 'showdown' || g.showdown?.claimantId !== playerId) return null;
    const handSize = g.players.find((p) => p.id === playerId)!.hand.length;
    if (slot !== null && !(Number.isInteger(slot) && (slot as number) >= 0 && (slot as number) < handSize)) {
      throw new ClientError({ code: 'illegalIntent' });
    }
    const now = Date.now();
    if (now - this.lastFocusAt < FOCUS_MIN_INTERVAL_MS) return null;
    this.lastFocusAt = now;
    return { slot: slot as number | null };
  }

  // 真人表态：校验后经 onReaction 发给整个房间（含发送者），也返回 { playerId, reaction }；不进牌局状态。
  // 格式不对、不在预设里的内容报错；客户端点下去时还合法、到服务器时已过时的（目标刚被淘汰、自己刚被淘汰、牌局刚结束）静默丢弃，
  // 不给一条不改变牌局的表态弹错误
  react(playerId: string, socketId: string, reaction: unknown): { playerId: string; reaction: Reaction } | null {
    this.requireCurrentConnection(playerId, socketId);
    return this.relay(playerId, reaction);
  }

  // 表态的内核，不看连接：电脑没有连接，走这里而不伪造 socket。通过的经 onReaction 发给整个房间
  private relay(playerId: string, reaction: unknown): { playerId: string; reaction: Reaction } | null {
    const g = this.game;
    if (!g) throw new ClientError({ code: 'gameNotStarted' });
    const parsed = parseReaction(reaction);
    if (parsed.kind === 'announcement') {
      const target = g.players.find((p) => p.id === parsed.targetId);
      const shapeOk = needsTarget(parsed.action) ? !!target && target.id !== playerId : parsed.targetId === undefined;
      if (!shapeOk) throw new ClientError({ code: 'illegalIntent' });
      if (target && !target.alive) return null;
    }
    // 被淘汰的人和结束的牌局没有下一步行动可预告、也没有角色可声称
    const phrasesOnly = g.phase === 'gameOver' || !g.players.find((p) => p.id === playerId)?.alive;
    if (phrasesOnly && parsed.kind !== 'phrase') return null;
    // 比冷却还密的直接丢弃，挡住刷屏；不回错误，与对质悬停一致
    const now = Date.now();
    if (now - (this.lastReactionAt.get(playerId) ?? -Infinity) < REACTION_MIN_INTERVAL_MS) return null;
    this.lastReactionAt.set(playerId, now);
    const relayed = { playerId, reaction: parsed };
    this.events.onReaction(this, relayed);
    return relayed;
  }

  getPublicState() {
    return this.game ? publicState(this.game) : null;
  }

  getPrivateState(playerId: string) {
    if (!this.game) return null;
    // 防御：玩家不在牌局中时返回 null 而非抛错，避免 broadcast 因脏数据拖垮服务器。
    if (!this.game.players.some((p) => p.id === playerId)) return null;
    return privateState(this.game, playerId);
  }

  // 有人加入就重置空房计时，房间再次变空时重新计满 5 分钟。
  private clearEmptyTimer(): void {
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
  }

  // 调用时房间里已没有在场的真人。进行中的牌局作废，回到大厅阶段（同再来一局：电脑留座，弃权的真人座位移除），
  // 电脑不会靠计时器把空房一直打下去。不留着牌局等人重连：离开的人已被移除，宽限期到的人座位也随之移除，
  // 凭旧凭证回来只能作为新玩家进大厅，不会接上一局作废的牌局（不新增 #49、#51 那类沿用失效状态的路径）。
  private scheduleEmptyCleanup(): void {
    if (this.game && this.game.phase !== 'gameOver') this.returnToLobby();
    if (this.emptyTimer) return;
    this.emptyTimer = setTimeout(() => {
      if (!this.hasPresentPlayer()) {
        this.repo.delete(this.code);
        this.events.onEmpty(this);
      }
      this.emptyTimer = null;
    }, 5 * 60_000); // 无人在场 5 分钟后清理
  }
}
