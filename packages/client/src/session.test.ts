import { describe, expect, it } from 'vitest';
import type { PublicState, ServerMessage } from '@coup/shared';
import { closeShowdown, initialSession, reduceSession, type Session } from './session.ts';

const players = [{ id: 'a', name: '张三', isHost: true, connected: true }];
const table = { phase: 'choosingAction' } as PublicState;

function run(messages: ServerMessage[], from: Session = initialSession): Session {
  return messages.reduce((s, msg) => reduceSession(s, msg, 0), from);
}

const inGame = run([
  { type: 'joined', roomCode: 'ABC123', playerId: 'a', secret: 's', players, hostId: 'a', tunnelUrl: 'https://t', canStartTunnel: true },
  { type: 'gameStarted', turnOrder: ['a'] },
  { type: 'publicState', state: table, remainingMs: 1000, deadlineAt: 5000, hostId: 'a' },
  { type: 'privateState', hand: [{ id: 'c1', role: 'duke' }] },
  { type: 'events', events: [{ type: 'started', turnOrder: ['a'] }] },
]);

describe('房间会话', () => {
  it('再来一局回到大厅阶段：清空牌桌与选择，保留房间信息', () => {
    const s = run([{ type: 'lobby', players, hostId: 'a' }], { ...inGame, selectedAction: 'coup', selectedKeep: ['c1'] });
    expect(s).toMatchObject({ roomCode: 'ABC123', tunnelUrl: 'https://t', publicState: null, countdown: null, hand: [], log: [], selectedAction: null, selectedKeep: [], showcase: null });
  });

  it('离开后回到初始会话', () => {
    expect(run([{ type: 'left', reason: 'replaced' }], inGame)).toEqual(initialSession);
  });

  it('房间已被释放时回到初始会话，其它错误不影响会话', () => {
    expect(run([{ type: 'error', code: 'roomNotFound' }], inGame)).toEqual(initialSession);
    expect(run([{ type: 'error', code: 'hostOnly' }], inGame).roomCode).toBe('ABC123');
  });

  it('开局重置日志，后续事件的日志 id 从 0 递增', () => {
    const s = run([
      { type: 'gameStarted', turnOrder: ['a'] },
      { type: 'events', events: [{ type: 'started', turnOrder: ['a'] }, { type: 'started', turnOrder: ['a'] }] },
      { type: 'events', events: [{ type: 'started', turnOrder: ['a'] }] },
    ], inGame);
    expect(s.log.map((e) => e.id)).toEqual([0, 1, 2]);
  });

  it('牌局状态记录收到时刻供倒计时使用', () => {
    const s = reduceSession(initialSession, { type: 'publicState', state: table, remainingMs: 1000, deadlineAt: 5000, hostId: 'a' }, 42);
    expect(s.countdown).toEqual({ remainingMs: 1000, deadlineAt: 5000, receivedAt: 42 });
  });

  it('开局后收到手牌即发牌展示；刷新重连只收到手牌时不展示', () => {
    const hand = [{ id: 'c1', role: 'duke' as const }, { id: 'c2', role: 'captain' as const }];
    const dealt = run([{ type: 'gameStarted', turnOrder: ['a'] }, { type: 'privateState', hand }], inGame);
    expect(dealt.showcase).toEqual({ kind: 'deal', cards: hand });
    expect(run([{ type: 'privateState', hand }], dealt).showcase).toEqual({ kind: 'deal', cards: hand });
    const rejoined = run([
      { type: 'joined', roomCode: 'ABC123', playerId: 'a', secret: 's', players, hostId: 'a', canStartTunnel: false },
      { type: 'publicState', state: table, remainingMs: 1000, deadlineAt: 5000, hostId: 'a' },
      { type: 'privateState', hand },
    ]);
    expect(rejoined.showcase).toBeNull();
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
      { type: 'joined', roomCode: 'ABC123', playerId: 'a', secret: 's', players, hostId: 'a', canStartTunnel: false },
      push({ phase: 'showdown', showdown }),
      { type: 'privateState', hand: [duke, captain] },
    ], { ...initialSession });
    expect(rejoined.showdown?.hand).toEqual([duke, captain]);
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
