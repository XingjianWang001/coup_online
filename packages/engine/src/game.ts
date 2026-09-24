import type {
  ActionType,
  Card,
  ChallengeSubject,
  GameEvent,
  GameState,
  LossContinuation,
  Player,
  PrivateState,
  PublicState,
  Role,
} from './types.ts';

const ROLE_ORDER: Role[] = ['duke', 'assassin', 'captain', 'ambassador', 'contessa'];

const DECK: Role[] = ROLE_ORDER.flatMap((r) => [r, r, r]); // 5 角色 × 3 = 15 张

const START_COINS = 2;
const START_CARDS = 2;
const COUP_COST = 7;
const ASSASSINATE_COST = 3;
const STEAL_AMOUNT = 2;
const EXCHANGE_DRAW = 2;

// 行动声称的角色（null = 不声称角色）
const ACTION_CLAIM: Record<ActionType, Role | null> = {
  income: null,
  foreignAid: null,
  coup: null,
  tax: 'duke',
  assassinate: 'assassin',
  steal: 'captain',
  exchange: 'ambassador',
};

// 各行动可被哪些角色阻挡（空数组 = 不可阻挡）
const BLOCK_ROLES: Record<ActionType, Role[]> = {
  income: [],
  foreignAid: ['duke'],
  coup: [],
  tax: [],
  assassinate: ['contessa'],
  steal: ['captain', 'ambassador'],
  exchange: [],
};

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getPlayer(state: GameState, id: string): Player {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new Error(`player ${id} not found`);
  return p;
}

const alive = (s: GameState) => s.players.filter((p) => p.alive);

function nextAliveAfter(state: GameState, id: string | null): Player {
  const idx = id == null ? -1 : state.turnOrder.indexOf(id);
  const n = state.turnOrder.length;
  for (let step = 1; step <= n; step++) {
    const p = getPlayer(state, state.turnOrder[(idx + step) % n]);
    if (p.alive) return p;
  }
  // 只剩一个存活者时由 checkWin 处理，这里不应到达
  throw new Error('no alive player');
}

// 检查是否只剩一个存活者 → 结束游戏
function checkWin(state: GameState): GameEvent[] {
  const al = alive(state);
  if (al.length === 1) {
    state.phase = 'gameOver';
    state.winnerId = al[0].id;
    state.currentPlayerId = null;
    state.pending = null;
    state.challengeSubject = null;
    state.lossToResolve = null;
    state.exchangeKeepCount = null;
    state.passed = [];
    return [{ type: 'gameOver', winnerId: al[0].id }];
  }
  return [];
}

// 从牌堆抽 n 张；牌堆不足时用明牌（弃牌）回填再抽。
function draw(state: GameState, n: number): Card[] {
  const out: Card[] = [];
  for (let i = 0; i < n; i++) {
    if (state.deck.length === 0) {
      const revealed = state.players.flatMap((p) => p.revealed);
      state.players.forEach((p) => (p.revealed = []));
      state.deck = shuffle(revealed);
      if (state.deck.length === 0) break;
    }
    out.push(state.deck.pop()!);
  }
  return out;
}

function addCoins(state: GameState, id: string, delta: number): GameEvent[] {
  const p = getPlayer(state, id);
  p.coins += delta;
  return [{ type: 'coinsChanged', playerId: id, coins: p.coins }];
}

// 声称被质疑且为真时：把声称的牌放回牌堆、洗牌、重抽一张（手牌保持隐藏）
function swapClaimedCard(state: GameState, id: string, role: Role): void {
  const p = getPlayer(state, id);
  const i = p.hand.findIndex((c) => c.role === role);
  if (i < 0) throw new Error(`${id} 手牌中没有 ${role}`);
  const [card] = p.hand.splice(i, 1);
  state.deck.push(card);
  shuffle(state.deck);
  const [newCard] = draw(state, 1);
  p.hand.push(newCard);
}

function advanceTurn(state: GameState): GameEvent[] {
  if (state.phase === 'gameOver') return [];
  const next = nextAliveAfter(state, state.currentPlayerId);
  state.currentPlayerId = next.id;
  state.phase = 'choosingAction';
  state.pending = null;
  state.challengeSubject = null;
  state.lossToResolve = null;
  state.exchangeKeepCount = null;
  state.passed = [];
  return [{ type: 'turnChanged', playerId: next.id }];
}

function startLoss(state: GameState, playerId: string, continuation: LossContinuation): void {
  state.phase = 'choosingLoss';
  state.lossToResolve = { playerId, continuation };
}

function applyContinuation(state: GameState, cont: LossContinuation): GameEvent[] {
  switch (cont.kind) {
    case 'endTurn':
      return advanceTurn(state);
    case 'proceedAction':
      return proceedAction(state);
    case 'resolveEffect':
      return resolveEffect(state);
    case 'cancelAction':
      return advanceTurn(state);
  }
}

// 行动声称通过（或外援）后继续：可阻挡则进阻挡窗口，否则结算效果
function proceedAction(state: GameState): GameEvent[] {
  const pending = state.pending!;
  if (BLOCK_ROLES[pending.type].length > 0) {
    state.phase = 'awaitingBlock';
    return [];
  }
  return resolveEffect(state);
}

// 结算行动效果（此时声称已通过、阻挡已失败或无阻挡）
function resolveEffect(state: GameState): GameEvent[] {
  const pending = state.pending!;
  const actor = getPlayer(state, pending.actorId);
  const events: GameEvent[] = [];
  switch (pending.type) {
    case 'foreignAid':
      events.push(...addCoins(state, actor.id, 2));
      break;
    case 'tax':
      events.push(...addCoins(state, actor.id, 3));
      break;
    case 'assassinate': {
      const target = getPlayer(state, pending.targetId!);
      startLoss(state, target.id, { kind: 'endTurn' });
      return events;
    }
    case 'steal': {
      const target = getPlayer(state, pending.targetId!);
      const amount = Math.min(STEAL_AMOUNT, target.coins);
      target.coins -= amount;
      actor.coins += amount;
      events.push({ type: 'coinsChanged', playerId: target.id, coins: target.coins });
      events.push({ type: 'coinsChanged', playerId: actor.id, coins: actor.coins });
      break;
    }
    case 'exchange': {
      state.exchangeKeepCount = actor.hand.length;
      const drawn = draw(state, EXCHANGE_DRAW);
      actor.hand.push(...drawn);
      state.phase = 'choosingExchange';
      events.push({ type: 'exchangeDrew', playerId: actor.id, count: drawn.length });
      return events;
    }
    case 'income':
    case 'coup':
      // income/coup 在 chooseAction 直接结算，不应到达这里
      throw new Error(`unexpected resolveEffect for ${pending.type}`);
  }
  return events.concat(advanceTurn(state));
}

export function createGame(
  players: { id: string; name: string }[],
  options: { startingPlayerId: string; hands?: Record<string, Role[]> },
): GameState {
  if (players.length < 2 || players.length > 6) {
    throw new Error('players must be 2-6');
  }
  const startingPlayerIndex = players.findIndex((player) => player.id === options.startingPlayerId);
  if (startingPlayerIndex < 0) throw new Error('starting player not found');
  let deck = DECK.map((role, i) => ({ id: `${role}-${i}`, role }));
  shuffle(deck);

  const playerStates: Player[] = players.map((p, index) => ({
    id: p.id,
    name: p.name,
    coins: players.length === 2 && index === startingPlayerIndex ? 1 : START_COINS,
    hand: [],
    revealed: [],
    alive: true,
  }));

  if (options.hands) {
    for (const ps of playerStates) {
      const roles = options.hands[ps.id] ?? [];
      for (const r of roles) {
        const idx = deck.findIndex((c) => c.role === r);
        if (idx < 0) throw new Error(`deck 中 ${r} 不足`);
        ps.hand.push(deck.splice(idx, 1)[0]);
      }
    }
  } else {
    for (let i = 0; i < START_CARDS; i++) {
      for (const ps of playerStates) ps.hand.push(deck.pop()!);
    }
  }

  return {
    phase: 'choosingAction',
    players: playerStates,
    deck,
    turnOrder: players.map((p) => p.id),
    currentPlayerId: players[startingPlayerIndex].id,
    pending: null,
    challengeSubject: null,
    lossToResolve: null,
    exchangeKeepCount: null,
    passed: [],
    winnerId: null,
  };
}

export function chooseAction(
  state: GameState,
  actorId: string,
  action: ActionType,
  targetId?: string,
): GameEvent[] {
  if (state.phase !== 'choosingAction') throw new Error('not in choosingAction phase');
  if (actorId !== state.currentPlayerId) throw new Error('not your turn');
  const actor = getPlayer(state, actorId);
  if (!actor.alive) throw new Error('actor eliminated');

  if (actor.coins >= 10 && action !== 'coup') {
    throw new Error('持有 10 枚以上金币必须发动政变');
  }

  const needsTarget = action === 'coup' || action === 'assassinate' || action === 'steal';
  if (needsTarget && !targetId) throw new Error(`${action} 需要目标`);
  if (targetId) {
    const target = getPlayer(state, targetId);
    if (!target.alive) throw new Error('target eliminated');
    if (targetId === actorId) throw new Error('cannot target self');
  }

  const claimedRole = ACTION_CLAIM[action];
  // actionChosen 作为每回合首个事件，便于客户端按行动分组日志
  const events: GameEvent[] = [{ type: 'actionChosen', actorId, action, targetId, claimedRole: claimedRole ?? undefined }];

  if (action === 'income') {
    events.push(...addCoins(state, actorId, 1));
    return events.concat(advanceTurn(state));
  }

  if (action === 'coup') {
    if (actor.coins < COUP_COST) throw new Error('金币不足发动政变');
    events.push(...addCoins(state, actorId, -COUP_COST));
    startLoss(state, targetId!, { kind: 'endTurn' });
    return events;
  }

  if (action === 'assassinate') {
    if (actor.coins < ASSASSINATE_COST) throw new Error('金币不足发动暗杀');
    events.push(...addCoins(state, actorId, -ASSASSINATE_COST));
  }

  state.pending = { type: action, actorId, targetId, claimedRole: claimedRole ?? undefined };
  state.challengeSubject = claimedRole ? 'action' : null;
  state.passed = [];

  if (claimedRole) {
    state.phase = 'awaitingChallenge';
    return events;
  }
  // 外援：不声称角色，直接进阻挡窗口
  state.phase = 'awaitingBlock';
  return events;
}

export function challenge(state: GameState, challengerId: string): GameEvent[] {
  if (state.phase !== 'awaitingChallenge') throw new Error('not in awaitingChallenge phase');
  const pending = state.pending!;
  const subject = state.challengeSubject!;
  const claimantId = subject === 'action' ? pending.actorId : pending.blockById!;
  const claimedRole = subject === 'action' ? pending.claimedRole! : pending.blockRole!;
  if (challengerId === claimantId) throw new Error('cannot challenge self');
  if (!getPlayer(state, challengerId).alive) throw new Error('challenger eliminated');

  const claimant = getPlayer(state, claimantId);
  const truth = claimant.hand.some((c) => c.role === claimedRole);
  state.challengeSubject = null;
  state.passed = [];

  const events: GameEvent[] = [{ type: 'challenged', challengerId, targetId: claimantId }];

  if (truth) {
    swapClaimedCard(state, claimantId, claimedRole);
    startLoss(state, challengerId, subject === 'action' ? { kind: 'proceedAction' } : { kind: 'cancelAction' });
    events.push({ type: 'challengeResolved', truth, loserId: challengerId, claimantId });
  } else {
    startLoss(state, claimantId, subject === 'action' ? { kind: 'cancelAction' } : { kind: 'resolveEffect' });
    events.push({ type: 'challengeResolved', truth, loserId: claimantId, claimantId });
    if (subject === 'action' && pending.type === 'assassinate') {
      events.push(...addCoins(state, pending.actorId, ASSASSINATE_COST));
    }
  }
  return events;
}

// 当前质疑窗口中有资格表态的玩家（存活且非声称者）
function eligibleChallengers(state: GameState): string[] {
  const pending = state.pending!;
  const subject = state.challengeSubject!;
  const claimantId = subject === 'action' ? pending.actorId : pending.blockById!;
  return state.players.filter((p) => p.alive && p.id !== claimantId).map((p) => p.id);
}

// 当前阻挡窗口中有资格阻挡的玩家
function eligibleBlockers(state: GameState): string[] {
  const pending = state.pending!;
  if (pending.type === 'foreignAid') {
    // 外援可被任意存活且非行动者的玩家阻挡
    return state.players.filter((p) => p.alive && p.id !== pending.actorId).map((p) => p.id);
  }
  // 暗杀/偷窃：仅目标可阻挡
  return state.players.filter((p) => p.alive && p.id === pending.targetId).map((p) => p.id);
}

function closeChallenge(state: GameState): GameEvent[] {
  const subject = state.challengeSubject!;
  state.challengeSubject = null;
  state.passed = [];
  return subject === 'action' ? proceedAction(state) : advanceTurn(state);
}

// 玩家放弃质疑：仅记录，所有有资格者都放弃后才关闭窗口
export function passChallenge(state: GameState, playerId: string): GameEvent[] {
  if (state.phase !== 'awaitingChallenge') throw new Error('not in awaitingChallenge phase');
  const eligible = eligibleChallengers(state);
  if (!eligible.includes(playerId)) throw new Error('无权放弃质疑');
  if (!state.passed.includes(playerId)) state.passed.push(playerId);
  if (eligible.some((id) => !state.passed.includes(id))) return [];
  return closeChallenge(state);
}

// 超时：强制关闭质疑窗口
export function resolveChallengeTimeout(state: GameState): GameEvent[] {
  if (state.phase !== 'awaitingChallenge') throw new Error('not in awaitingChallenge phase');
  return closeChallenge(state);
}

export function block(state: GameState, blockerId: string, role: Role): GameEvent[] {
  if (state.phase !== 'awaitingBlock') throw new Error('not in awaitingBlock phase');
  const pending = state.pending!;
  if (!BLOCK_ROLES[pending.type].includes(role)) throw new Error(`无法用 ${role} 阻挡 ${pending.type}`);

  if (pending.type === 'foreignAid') {
    if (blockerId === pending.actorId) throw new Error('不能阻挡自己的外援');
    if (!getPlayer(state, blockerId).alive) throw new Error('blocker eliminated');
  } else {
    if (blockerId !== pending.targetId) throw new Error('只有目标可以阻挡');
  }

  pending.blockById = blockerId;
  pending.blockRole = role;
  state.phase = 'awaitingChallenge';
  state.challengeSubject = 'block';
  state.passed = [];
  return [{ type: 'blocked', blockerId, role }];
}

// 玩家放弃阻挡：仅记录，所有有资格者都放弃后才结算
export function passBlock(state: GameState, playerId: string): GameEvent[] {
  if (state.phase !== 'awaitingBlock') throw new Error('not in awaitingBlock phase');
  const eligible = eligibleBlockers(state);
  if (!eligible.includes(playerId)) throw new Error('无权放弃阻挡');
  if (!state.passed.includes(playerId)) state.passed.push(playerId);
  if (eligible.some((id) => !state.passed.includes(id))) return [];
  state.passed = [];
  return resolveEffect(state);
}

// 超时：强制结算
export function resolveBlockTimeout(state: GameState): GameEvent[] {
  if (state.phase !== 'awaitingBlock') throw new Error('not in awaitingBlock phase');
  state.passed = [];
  return resolveEffect(state);
}

export function resolveLoss(state: GameState, playerId: string, cardId: string): GameEvent[] {
  if (state.phase !== 'choosingLoss') throw new Error('not in choosingLoss phase');
  if (state.lossToResolve?.playerId !== playerId) throw new Error('not your turn to lose influence');
  const p = getPlayer(state, playerId);
  const i = p.hand.findIndex((c) => c.id === cardId);
  if (i < 0) throw new Error('card not in hand');

  const [card] = p.hand.splice(i, 1);
  p.revealed.push(card);
  const events: GameEvent[] = [{ type: 'influenceLost', playerId, role: card.role }];

  const cont = state.lossToResolve.continuation;
  state.lossToResolve = null;

  if (p.hand.length === 0) {
    p.alive = false;
    events.push({ type: 'eliminated', playerId });
    const win = checkWin(state);
    if (win.length > 0) return events.concat(win);
  }
  return events.concat(applyContinuation(state, cont));
}

export function resolveExchange(state: GameState, playerId: string, keepIds: string[]): GameEvent[] {
  if (state.phase !== 'choosingExchange') throw new Error('not in choosingExchange phase');
  if (state.pending?.actorId !== playerId) throw new Error('not your exchange');
  const keepCount = state.exchangeKeepCount!;
  if (keepIds.length !== keepCount) throw new Error(`需要保留 ${keepCount} 张牌`);
  const p = getPlayer(state, playerId);
  const keepSet = new Set(keepIds);
  if (keepSet.size !== keepIds.length) throw new Error('重复的牌');
  if (keepIds.some((id) => !p.hand.some((c) => c.id === id))) throw new Error('keep 了不存在的牌');

  const keep = keepIds.map((id) => p.hand.find((c) => c.id === id)!);
  const rest = p.hand.filter((c) => !keepSet.has(c.id));
  p.hand = keep;
  state.deck.push(...rest);
  shuffle(state.deck);
  state.exchangeKeepCount = null;
  return advanceTurn(state);
}

// 断线弃权：翻开全部暗牌、淘汰，并清理所有指向该玩家的待处理状态，避免死锁。
export function forfeit(state: GameState, playerId: string): GameEvent[] {
  const p = getPlayer(state, playerId);
  if (!p.alive) return [];
  const events: GameEvent[] = [];
  while (p.hand.length > 0) {
    const c = p.hand.pop()!;
    p.revealed.push(c);
    events.push({ type: 'influenceLost', playerId, role: c.role });
  }
  p.alive = false;
  events.push({ type: 'eliminated', playerId });

  const win = checkWin(state);
  if (state.phase === 'gameOver') return events.concat(win);

  // 该玩家若正处于待处理状态（当前回合 / 待失去影响力 / 待交换 / 行动相关），
  // 作废当前行动并推进回合，避免游戏卡在无人可解的状态。
  const involved =
    state.currentPlayerId === playerId ||
    state.lossToResolve?.playerId === playerId ||
    (state.phase === 'choosingExchange' && state.pending?.actorId === playerId) ||
    (state.pending &&
      (state.pending.actorId === playerId ||
        state.pending.targetId === playerId ||
        state.pending.blockById === playerId));

  if (involved) return events.concat(advanceTurn(state));
  return events;
}

export function publicState(state: GameState): PublicState {
  return {
    phase: state.phase,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      coins: p.coins,
      handCount: p.hand.length,
      revealed: p.revealed.map((c) => c.role),
      alive: p.alive,
    })),
    currentPlayerId: state.currentPlayerId,
    pending: state.pending
      ? {
          action: state.pending.type,
          actorId: state.pending.actorId,
          targetId: state.pending.targetId,
          claimedRole: state.pending.claimedRole,
          blockById: state.pending.blockById,
          blockRole: state.pending.blockRole,
        }
      : null,
    challengeSubject: state.challengeSubject,
    lossPlayerId: state.lossToResolve?.playerId ?? null,
    exchangeKeepCount: state.exchangeKeepCount,
    passed: state.passed,
    winnerId: state.winnerId,
  };
}

export function privateState(state: GameState, playerId: string): PrivateState {
  const p = getPlayer(state, playerId);
  return { playerId, hand: p.hand };
}
