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
    expect(s).toMatchObject({ roomCode: 'ABC123', tunnelUrl: 'https://t', publicState: null, countdown: null, hand: [], log: [], selectedAction: null, selectedKeep: [] });
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
});
