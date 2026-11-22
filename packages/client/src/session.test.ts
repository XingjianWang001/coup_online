import { describe, expect, it } from 'vitest';
import type { ActionType, PublicState, Role, ServerMessage } from '@coup/shared';
import { closeShowdown, dropMotion, initialSession, reduceSession, rejoinIntent, type Session } from './session.ts';

const players = [{ id: 'a', name: '张三', isHost: true, connected: true, isPreviousWinner: false, isComputer: false }];
const table = { phase: 'choosingAction' } as PublicState;

function run(messages: ServerMessage[], from: Session = initialSession): Session {
  return messages.reduce((s, msg) => reduceSession(s, msg, 0), from);
}

// 两人局：服务器至少两人才能开局，回合也才能真的交给另一位玩家
const pair = [players[0], { id: 'b', name: '李四', isHost: false, connected: true, isPreviousWinner: false, isComputer: false }];

// 一次收入的完整推送：events → publicState → privateState
const income = (actorId: string, nextId: string, coins: number, state: PublicState = table): ServerMessage[] => [
  { type: 'events', events: [{ type: 'actionChosen', actorId, action: 'income' }, { type: 'coinsChanged', playerId: actorId, coins }, { type: 'turnChanged', playerId: nextId }] },
  { type: 'publicState', state, remainingMs: 1000, deadlineAt: 6000, hostId: 'a' },
  { type: 'privateState', hand: [{ id: 'c1', role: 'duke' }] },
];

const inGame = run([
  { type: 'joined', roomCode: 'ABC123', playerId: 'a', secret: 's', players: pair, hostId: 'a', tunnelUrl: 'https://t', canStartTunnel: true, gameNumber: 0 },
  { type: 'gameStarted', turnOrder: ['a', 'b'], gameNumber: 1 },
  { type: 'publicState', state: { ...table, currentPlayerId: 'a' }, remainingMs: 1000, deadlineAt: 5000, hostId: 'a' },
  { type: 'privateState', hand: [{ id: 'c1', role: 'duke' }] },
  ...income('a', 'b', 3),
]);

// b 离线超过宽限期而弃权，两张牌都翻开，a 获胜
const ended = run([
  { type: 'events', events: [{ type: 'influenceLost', playerId: 'b', role: 'duke' }, { type: 'influenceLost', playerId: 'b', role: 'captain' }, { type: 'eliminated', playerId: 'b' }, { type: 'gameOver', winnerId: 'a' }] },
  { type: 'publicState', state: { ...table, phase: 'gameOver' }, remainingMs: null, deadlineAt: null, hostId: 'a' },
], inGame);

// 房主点「再来一局」回到大厅，再开下一局
const rematch: ServerMessage[] = [
  { type: 'lobby', players: pair, hostId: 'a' },
  { type: 'gameStarted', turnOrder: ['a', 'b'], gameNumber: 2 },
  { type: 'publicState', state: { ...table, currentPlayerId: 'a' }, remainingMs: 1000, deadlineAt: 5000, hostId: 'a' },
];

describe('房间会话', () => {
  const myTurn = (selectedAction: Session['selectedAction']) => ({
    ...run([
      { type: 'joined', roomCode: 'ABC123', playerId: 'a', secret: 's', players: pair, hostId: 'a', canStartTunnel: true, gameNumber: 0 },
      { type: 'gameStarted', turnOrder: ['a', 'b'], gameNumber: 1 },
      { type: 'publicState', state: { ...table, currentPlayerId: 'a' }, remainingMs: 1000, deadlineAt: 5000, hostId: 'a' },
      { type: 'privateState', hand: [{ id: 'c1', role: 'duke' }] },
    ]),
    selectedAction,
  });

  it('默认行动替你收入、轮到下一位后，收起没提交的目标选择', () => {
    const s = run([
      { type: 'events', events: [{ type: 'actionChosen', actorId: 'a', action: 'income' }, { type: 'coinsChanged', playerId: 'a', coins: 3 }, { type: 'turnChanged', playerId: 'b' }] },
      { type: 'publicState', state: { ...table, currentPlayerId: 'b' }, remainingMs: 1000, deadlineAt: 6000, hostId: 'a' },
    ], myTurn('assassinate'));
    expect(s.selectedAction).toBeNull();
  });

  it('自己的回合内收到新的牌局状态时保留目标选择', () => {
    const s = run([{ type: 'publicState', state: { ...table, currentPlayerId: 'a' }, remainingMs: 900, deadlineAt: 5000, hostId: 'a' }], myTurn('assassinate'));
    expect(s.selectedAction).toBe('assassinate');
  });

  it('断线重连后即使又轮到自己，也收起离线前的目标选择', () => {
    const s = run([
      { type: 'joined', roomCode: 'ABC123', playerId: 'a', secret: 's', players: pair, hostId: 'a', canStartTunnel: true, gameNumber: 1 },
      { type: 'publicState', state: { ...table, currentPlayerId: 'a' }, remainingMs: 1000, deadlineAt: 9000, hostId: 'a' },
      { type: 'privateState', hand: [{ id: 'c1', role: 'duke' }] },
    ], myTurn('assassinate'));
    expect(s.selectedAction).toBeNull();
  });

  it('再来一局回到大厅阶段：清空牌桌与选择，保留房间信息', () => {
    const s = run([{ type: 'lobby', players, hostId: 'a' }], { ...inGame, selectedAction: 'coup' });
    expect(s).toMatchObject({ roomCode: 'ABC123', tunnelUrl: 'https://t', publicState: null, countdown: null, hand: [], log: [], selectedAction: null, showcase: null });
  });

  it('离开后回到初始会话', () => {
    expect(run([{ type: 'left', reason: 'replaced' }], inGame)).toEqual(initialSession);
  });

  it('房间已被释放时回到初始会话，其它错误不影响会话', () => {
    expect(run([{ type: 'error', code: 'roomNotFound', inRoom: false }], inGame)).toEqual(initialSession);
    expect(run([{ type: 'error', code: 'hostOnly', inRoom: true }], inGame).roomCode).toBe('ABC123');
  });

  it('大厅里离线超过宽限期被移出、房主随后开局：重连时自动加入失败，退回入口；房主双击开始的报错不影响会话', () => {
    const lobby = run([{ type: 'lobby', players: [...players, { id: 'b', name: '李四', isHost: false, connected: true, isPreviousWinner: false, isComputer: false }], hostId: 'a' }], {
      ...initialSession,
      roomCode: 'ABC123',
      playerId: 'b',
      hostId: 'a',
    });
    // 服务器顺序：b 的新连接发 joinRoom → 座位已不在、牌局已开始 → 只回一条 error，不发 joined
    expect(run([{ type: 'error', code: 'gameAlreadyStarted', inRoom: false }], lobby)).toEqual(initialSession);
    // 房主双击「开始」：第一次开局的 gameStarted → publicState → privateState 之后，第二次回 error
    expect(run([{ type: 'error', code: 'gameAlreadyStarted', inRoom: true }], inGame)).toMatchObject({ roomCode: 'ABC123', publicState: table });
  });

  it('开局重置日志，后续事件的日志 id 从 0 递增', () => {
    const s = run([...rematch, { type: 'privateState', hand: [{ id: 'c1', role: 'duke' }] }, ...income('a', 'b', 3), ...income('b', 'a', 3)], ended);
    expect(s.log.map((e) => e.id)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('牌局状态记录收到时刻供倒计时使用', () => {
    const s = reduceSession(initialSession, { type: 'publicState', state: table, remainingMs: 1000, deadlineAt: 5000, hostId: 'a' }, 42);
    expect(s.countdown).toEqual({ remainingMs: 1000, deadlineAt: 5000, receivedAt: 42 });
  });

  it('开局后收到手牌即发牌展示；刷新重连只收到手牌时不展示', () => {
    const hand = [{ id: 'c1', role: 'duke' as const }, { id: 'c2', role: 'captain' as const }];
    const dealt = run([...rematch, { type: 'privateState', hand }], ended);
    expect(dealt.showcase).toEqual({ kind: 'deal', cards: hand });
    expect(run([{ type: 'privateState', hand }], dealt).showcase).toEqual({ kind: 'deal', cards: hand });
    const rejoined = run([
      { type: 'joined', roomCode: 'ABC123', playerId: 'a', secret: 's', players, hostId: 'a', canStartTunnel: false, gameNumber: 1 },
      { type: 'publicState', state: table, remainingMs: 1000, deadlineAt: 5000, hostId: 'a' },
      { type: 'privateState', hand },
    ]);
    expect(rejoined.showcase).toBeNull();
  });

  it('离线期间上一局结束、再来一局已开局：重连后不沿用上一局的日志；同一局内重连仍保留', () => {
    // a 看到上一局结束后断线；宽限期内房主再来一局并开局，a 错过 lobby 与 gameStarted
    const rejoin = (gameNumber: number) => run([
      { type: 'joined', roomCode: 'ABC123', playerId: 'a', secret: 's', players: pair, hostId: 'a', canStartTunnel: false, gameNumber },
      { type: 'publicState', state: table, remainingMs: 1000, deadlineAt: 5000, hostId: 'a' },
      { type: 'privateState', hand: [{ id: 'c1', role: 'duke' }] },
    ], ended);
    expect(rejoin(2).log).toEqual([]);
    expect(rejoin(1).log).toEqual(ended.log);
  });

  it('牌局结束或自己被淘汰时，收起仍开着的发牌展示', () => {
    const showing = { ...inGame, showcase: { kind: 'deal' as const, cards: [{ id: 'c1', role: 'duke' as const }] } };
    const over = { phase: 'gameOver', players: [{ id: 'a', alive: true }] } as PublicState;
    const eliminated = { phase: 'choosingAction', players: [{ id: 'a', alive: false }] } as PublicState;
    const alive = { phase: 'choosingAction', players: [{ id: 'a', alive: true }] } as PublicState;
    const push = (state: PublicState): ServerMessage => ({ type: 'publicState', state, remainingMs: null, deadlineAt: null, hostId: 'a' });
    expect(run([push(over)], showing).showcase).toBeNull();
    expect(run([push(eliminated)], showing).showcase).toBeNull();
    expect(run([push(alive)], showing).showcase).not.toBeNull();
  });


});

describe('对质', () => {
  const [duke, captain, ambassador] = [{ id: 'c1', role: 'duke' as const }, { id: 'c2', role: 'captain' as const }, { id: 'c9', role: 'ambassador' as const }];
  const showdown = { challengerId: 'b', claimantId: 'a', role: 'duke' as const };
  const push = (state: Partial<PublicState>): ServerMessage => ({
    type: 'publicState',
    state: { players: [{ id: 'a', alive: true, handCount: 2 }, { id: 'b', alive: true, handCount: 1 }], showdown: null, ...state } as PublicState,
    remainingMs: null,
    deadlineAt: null,
    hostId: 'a',
  });
  // 一次状态变化的真实消息顺序：events → publicState → privateState
  const challenge = (sd: typeof showdown): ServerMessage[] => [
    { type: 'events', events: [{ type: 'challenged', challengerId: sd.challengerId, targetId: sd.claimantId }] },
    push({ phase: 'showdown', showdown: sd }),
    { type: 'privateState', hand: [duke, captain] },
  ];
  const holding = run([{ type: 'privateState', hand: [duke, captain] }], { ...inGame, showcase: null });
  const open = run(challenge(showdown), holding);
  const resolved: ServerMessage = { type: 'events', events: [{ type: 'challengeResolved', truth: true, loserId: 'b', claimantId: 'a', role: 'duke', slot: 0 }] };

  it('进入对质即打开舞台：被质疑者记下翻牌前的手牌，旁观者收到同步的悬停牌位', () => {
    expect(open.showdown).toEqual({ ...showdown, id: expect.any(Number), slots: 2, hand: [duke, captain], focus: null, reveal: null, newCard: null });
    const watching = run(challenge({ ...showdown, claimantId: 'b', challengerId: 'a' }), holding);
    expect(watching.showdown).toMatchObject({ slots: 1, hand: null });
    expect(run([{ type: 'showdownFocus', slot: 0 }], watching).showdown?.focus).toBe(0);
  });

  it('被质疑者在对质中刷新重连，手牌到达后仍能选牌', () => {
    const rejoined = run([
      { type: 'joined', roomCode: 'ABC123', playerId: 'a', secret: 's', players, hostId: 'a', canStartTunnel: false, gameNumber: 1 },
      push({ phase: 'showdown', showdown }),
      { type: 'privateState', hand: [duke, captain] },
    ], { ...initialSession });
    expect(rejoined.showdown?.hand).toEqual([duke, captain]);
  });

  it('旁观对质时断线、离线期间换成自己被质疑：重连后打开新的对质，能选牌', () => {
    // 三人局：a 质疑 b 的公爵后断线；离线期间 b 虚张、失去最后一张牌出局，轮到 a 偷钱，被 c 质疑
    const three = (state: Partial<PublicState>, bCards: number): ServerMessage => ({
      type: 'publicState',
      state: { players: [{ id: 'a', alive: true, handCount: 2 }, { id: 'b', alive: bCards > 0, handCount: bCards }, { id: 'c', alive: true, handCount: 2 }], showdown: null, ...state } as PublicState,
      remainingMs: null,
      deadlineAt: null,
      hostId: 'a',
    });
    const first = { challengerId: 'a', claimantId: 'b', role: 'duke' as const };
    const second = { challengerId: 'c', claimantId: 'a', role: 'captain' as const };
    const seated = ['a', 'b', 'c'].map((id) => ({ id, name: id, isHost: id === 'a', connected: true, isPreviousWinner: false, isComputer: false }));
    const watching = run([
      { type: 'events', events: [{ type: 'challenged', challengerId: 'a', targetId: 'b' }] },
      three({ phase: 'showdown', showdown: first }, 1),
      { type: 'privateState', hand: [duke, captain] },
    ], holding);
    const rejoined = run([
      { type: 'joined', roomCode: 'ABC123', playerId: 'a', secret: 's', players: seated, hostId: 'a', canStartTunnel: false, gameNumber: 1 },
      three({ phase: 'showdown', showdown: second }, 0),
      { type: 'privateState', hand: [duke, captain] },
    ], watching);
    expect(rejoined.showdown).toMatchObject({ ...second, slots: 2, hand: [duke, captain], reveal: null });
  });

  it('揭晓动画期间下一场对质也已揭晓：舞台保留第一场的结果，动画播完即收起', () => {
    // 旁观者切到后台标签页时动画停住，期间又有一场对质开始并结束
    const first = run([resolved, push({ phase: 'choosingAction' })], open);
    const next: ServerMessage = { type: 'events', events: [{ type: 'challengeResolved', truth: false, loserId: 'b', claimantId: 'b', role: 'contessa', slot: 1 }] };
    const s = run([...challenge({ challengerId: 'a', claimantId: 'b', role: 'duke' }), next, push({ phase: 'choosingAction' })], first);
    expect(s.showdown?.reveal).toBe(first.showdown?.reveal);
    expect(closeShowdown(s).showdown).toBeNull();
  });

  it('揭晓后舞台留到动画播完；换来的新牌记在原牌位，不再另弹换牌展示', () => {
    const s = run([resolved, push({ phase: 'choosingLoss', lossPlayerId: 'b' }), { type: 'privateState', hand: [ambassador, captain] }], open);
    expect(s.showdown).toMatchObject({ reveal: { slot: 0, role: 'duke', truth: true }, newCard: ambassador });
    expect(s.showcase).toBeNull();
  });

  // a 的公爵属实：b 私下失去影响力 → a 征税结算 → 轮到 b
  const afterTruth: ServerMessage[] = [
    resolved,
    push({ phase: 'choosingLoss', lossPlayerId: 'b' }),
    { type: 'privateState', hand: [ambassador, captain] },
    { type: 'events', events: [{ type: 'influenceLost', playerId: 'b', role: 'captain' }, { type: 'coinsChanged', playerId: 'a', coins: 5 }, { type: 'turnChanged', playerId: 'b' }] },
    push({ phase: 'choosingAction', currentPlayerId: 'b' }),
    { type: 'privateState', hand: [ambassador, captain] },
  ];

  it('动画播完关闭舞台时，若下一场对质已经开始则接着打开它', () => {
    const next = { ...showdown, challengerId: 'a', claimantId: 'b' };
    const animating = run([
      ...afterTruth,
      { type: 'events', events: [{ type: 'actionChosen', actorId: 'b', action: 'tax', claimedRole: 'duke' }] },
      push({ phase: 'awaitingChallenge', challengeSubject: 'action', currentPlayerId: 'b' }),
      { type: 'privateState', hand: [ambassador, captain] },
      ...challenge(next),
    ], open);
    expect(animating.showdown?.reveal).not.toBeNull();
    expect(closeShowdown(animating).showdown).toMatchObject({ ...next, reveal: null });
    expect(closeShowdown(run(afterTruth, open)).showdown).toBeNull();
  });

  it('对质没有揭晓就结束（被质疑者弃权）时收起舞台', () => {
    const forfeited = run([
      { type: 'events', events: [
        { type: 'influenceLost', playerId: 'a', role: 'duke' },
        { type: 'influenceLost', playerId: 'a', role: 'captain' },
        { type: 'eliminated', playerId: 'a' },
        { type: 'turnChanged', playerId: 'b' },
      ] },
      push({
        phase: 'choosingAction',
        currentPlayerId: 'b',
        players: [{ id: 'a', alive: false, handCount: 0 }, { id: 'b', alive: true, handCount: 1 }] as PublicState['players'],
      }),
      { type: 'privateState', hand: [] },
    ], open);
    expect(forfeited.showdown).toBeNull();
  });
});

describe('断线重连', () => {
  const id = { playerId: 'a', name: '张三', secret: 's' };
  it.each([
    ['刷新后本机有身份和房间码：回到原座位', id, 'ABC123', null, false, 'ABC123'],
    ['本机没有身份：不自动加入', null, 'ABC123', null, false, null],
    ['链接指定了别的房间：仅预填，不回旧房间', id, 'ABC123', 'DEF456', false, null],
    ['链接就是本机保存的房间：回到原座位', id, 'ABC123', 'ABC123', false, 'ABC123'],
    ['座位已被其他标签页接管：不抢回来', id, 'ABC123', null, true, null],
  ])('%s', (_name, identity, savedRoom, linkRoom, replaced, expected) => {
    expect(rejoinIntent(identity, savedRoom, linkRoom, replaced)?.roomCode ?? null).toBe(expected);
  });

  it('重连带上本机保存的身份', () => {
    expect(rejoinIntent(id, 'ABC123', null, false)).toEqual({ type: 'joinRoom', roomCode: 'ABC123', name: '张三', playerId: 'a', secret: 's' });
  });
});

describe('座位动效', () => {
  // a 是自己（手里公爵 + 女伯爵），b 是对手；金币 a 2、b 0
  const seated = (coins: [number, number], extra: Partial<PublicState> = {}): ServerMessage => ({
    type: 'publicState',
    state: {
      ...table,
      players: [{ id: 'a', coins: coins[0], alive: true, handCount: 2 }, { id: 'b', coins: coins[1], alive: true, handCount: 2 }] as PublicState['players'],
      ...extra,
    },
    remainingMs: 1000,
    deadlineAt: 5000,
    hostId: 'a',
  });
  const start = run([
    { type: 'joined', roomCode: 'ABC123', playerId: 'a', secret: 's', players: pair, hostId: 'a', canStartTunnel: true, gameNumber: 0 },
    { type: 'gameStarted', turnOrder: ['a', 'b'], gameNumber: 1 },
    seated([2, 0]),
    { type: 'privateState', hand: [{ id: 'c1', role: 'duke' }, { id: 'c2', role: 'contessa' }] },
  ]);
  const events = (...list: Extract<ServerMessage, { type: 'events' }>['events']): ServerMessage => ({ type: 'events', events: list });
  const claim = (actorId: string, role: Role, action: ActionType = 'tax') => events({ type: 'actionChosen', actorId, action, claimedRole: role });
  const brief = (s: Session) => s.motions.map(({ id: _id, ...m }) => m);

  it('金币差额按变化前的状态计算，同批合并，0 不显示', () => {
    // 对手从 0 金币的人那里偷：自己 +0 不显示；随后对手又拿了一次收入，两条合并
    const s = run([events(
      { type: 'actionChosen', actorId: 'b', action: 'steal', targetId: 'a' },
      { type: 'coinsChanged', playerId: 'a', coins: 2 },
      { type: 'coinsChanged', playerId: 'b', coins: 2 },
      { type: 'coinsChanged', playerId: 'b', coins: 3 },
    )], start);
    expect(brief(s)).toContainEqual({ playerId: 'b', kind: 'coins', delta: 3 });
    expect(s.motions.some((m) => m.playerId === 'a' && m.kind === 'coins')).toBe(false);
  });

  it('同一座位的新动效替换还没播完的旧动效', () => {
    const s = run([
      events({ type: 'coinsChanged', playerId: 'a', coins: 3 }),
      seated([3, 0]),
      events({ type: 'coinsChanged', playerId: 'a', coins: 0 }),
    ], start);
    expect(brief(s)).toEqual([{ playerId: 'a', kind: 'coins', delta: -3 }]);
  });

  it('新声称才放背后灵：故事里已有的角色不重放，实际交换后从头讲', () => {
    const first = run([claim('b', 'duke')], start);
    expect(brief(first)).toEqual([{ playerId: 'b', kind: 'ghost', role: 'duke', honest: false }]);
    const again = run([claim('b', 'duke')], first);
    expect(again.motions).toEqual(first.motions);
    const exchanged = run([
      claim('b', 'ambassador', 'exchange'),
      events({ type: 'exchangeDrew', playerId: 'b', count: 2 }),
      claim('b', 'duke'),
    ], again);
    expect(brief(exchanged).at(-1)).toEqual({ playerId: 'b', kind: 'ghost', role: 'duke', honest: false });
  });

  it('阻挡也是声称；自己手里有这张才算真声称', () => {
    const s = run([
      events({ type: 'actionChosen', actorId: 'b', action: 'assassinate', targetId: 'a', claimedRole: 'assassin' }, { type: 'blocked', blockerId: 'a', role: 'contessa' }),
    ], start);
    expect(brief(s)).toContainEqual({ playerId: 'a', kind: 'ghost', role: 'contessa', honest: true });
    expect(brief(run([claim('a', 'captain', 'steal')], start))).toEqual([{ playerId: 'a', kind: 'ghost', role: 'captain', honest: false }]);
  });

  it('对质那一批的动效等舞台收起后才放出来', () => {
    const challenged = run([
      claim('b', 'duke'),
      seated([2, 0], { phase: 'showdown', showdown: { challengerId: 'a', claimantId: 'b', role: 'duke' } as PublicState['showdown'] }),
    ], start);
    const resolved = run([events(
      { type: 'challengeResolved', truth: true, loserId: 'a', claimantId: 'b', role: 'duke', slot: 0 },
      { type: 'coinsChanged', playerId: 'b', coins: 3 },
    )], challenged);
    expect(resolved.motions.some((m) => m.kind === 'coins')).toBe(false);
    expect(brief(closeShowdown(resolved))).toContainEqual({ playerId: 'b', kind: 'coins', delta: 3 });
  });

  it('播完的动效可以移除；重连不补播，开新局清空故事', () => {
    const s = run([claim('b', 'duke')], start);
    expect(dropMotion(s, s.motions[0].id).motions).toEqual([]);
    expect(run([{ type: 'joined', roomCode: 'ABC123', playerId: 'a', secret: 's', players: pair, hostId: 'a', canStartTunnel: true, gameNumber: 1 }], s).motions).toEqual([]);
    const next = run([{ type: 'lobby', players: pair, hostId: 'a' }, { type: 'gameStarted', turnOrder: ['a', 'b'], gameNumber: 2 }, seated([2, 0]), claim('b', 'duke')], s);
    expect(brief(next)).toEqual([{ playerId: 'b', kind: 'ghost', role: 'duke', honest: false }]);
  });
});
