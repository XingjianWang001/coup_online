import { describe, expect, it } from 'vitest';
import type { PublicState, ServerMessage } from '@coup/shared';
import { initialSession, reduceSession, type Session } from './session.ts';

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

  it('自己的声称属实被质疑后，展示换来的新牌及其所在牌位；别人被质疑不展示', () => {
    const [duke, captain, ambassador] = [{ id: 'c1', role: 'duke' as const }, { id: 'c2', role: 'captain' as const }, { id: 'c9', role: 'ambassador' as const }];
    const holding = run([{ type: 'privateState', hand: [duke, captain] }], { ...inGame, showcase: null });
    const challenged = (claimantId: string): ServerMessage => ({ type: 'events', events: [{ type: 'challengeResolved', truth: true, loserId: 'b', claimantId }] });

    expect(run([challenged('a'), { type: 'privateState', hand: [captain, ambassador] }], holding).showcase)
      .toEqual({ kind: 'swap', cards: [ambassador, captain], slot: 0, returned: duke });
    // 洗回去的牌又被抽回来
    expect(run([challenged('a'), { type: 'privateState', hand: [captain, duke] }], holding).showcase)
      .toEqual({ kind: 'swap', cards: [duke, captain], slot: 0, returned: duke });
    expect(run([challenged('b'), { type: 'privateState', hand: [duke, captain] }], holding).showcase).toBeNull();
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

  it('重连后不沿用断线前待展示的换牌', () => {
    const s = run([
      { type: 'events', events: [{ type: 'challengeResolved', truth: true, loserId: 'b', claimantId: 'a' }] },
      { type: 'joined', roomCode: 'ABC123', playerId: 'a', secret: 's', players, hostId: 'a', canStartTunnel: false },
      { type: 'privateState', hand: [{ id: 'c9', role: 'duke' }] },
    ], { ...inGame, showcase: null });
    expect(s.showcase).toBeNull();
  });
});
