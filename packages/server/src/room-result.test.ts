// packages/server/src/room-result.test.ts
// 表 5（#82）：结果公开后电脑的表态在 Room 里什么时候说、说几次
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room, type RoomOptions } from './room.ts';
import { challenge, chooseAction, resolveLoss, revealShowdownCard } from '@coup/engine';
import type { GameRepository } from './repository.ts';

function makeRoom(options?: RoomOptions) {
  const repo = { save: vi.fn(), delete: vi.fn() } as unknown as GameRepository;
  const events = { onBroadcast: vi.fn(), onEmpty: vi.fn(), onReaction: vi.fn(), onShowdownFocus: vi.fn() };
  const room = new Room('ABC123', '', repo, events, options);
  return { room, repo, events };
}

describe('Room 结果公开后的表态', () => {
  afterEach(() => vi.useRealTimers());

  // Alice 先手征税（真有公爵），对面的电脑质疑后输掉对质。电脑总说第一候选；它在窗口里 15 秒才出手
  function lostChallenge() {
    vi.useFakeTimers();
    vi.clearAllTimers();
    const made = makeRoom({ startingPlayerRandom: () => 0, speechRandom: () => 0, computerDelayMs: () => 15_000 });
    const alice = made.room.addPlayer('Alice', 'sock1');
    made.room.addComputer(alice.id, 'sock1');
    made.room.startGame(alice.id, 'sock1');
    const computerId = made.room.playerList.find((p) => p.isComputer)!.id;
    const hand = made.room.game!.players.find((p) => p.id === alice.id)!.hand;
    hand[0].role = 'duke';
    made.room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'tax' });
    made.room.apply((g) => challenge(g, computerId));
    vi.advanceTimersByTime(3_000); // 试探等之前的表态都说完
    made.events.onReaction.mockClear();
    made.room.dispatch(alice.id, 'sock1', { type: 'revealShowdownCard', cardId: hand[0].id });
    const spoken = () => made.events.onReaction.mock.calls.filter(([, r]) => r.playerId === computerId).map(([, r]) => r.reaction);
    return { ...made, computerId, spoken };
  }

  it('对质的结果等揭晓动画播完再说', () => {
    const { spoken } = lostChallenge();
    vi.advanceTimersByTime(6_000);
    expect(spoken()).toEqual([]);
    vi.advanceTimersByTime(2_100);
    expect(spoken()).toEqual([{ kind: 'phrase', phrase: 'respect' }]);
  });

  it('一次结算只开口一次：电脑随后选丢哪张时不再说', () => {
    const { spoken, room, computerId } = lostChallenge();
    vi.advanceTimersByTime(29_000);
    expect(room.game!.players.find((p) => p.id === computerId)!.hand).toHaveLength(1); // 已丢了那张
    expect(spoken()).toEqual([{ kind: 'phrase', phrase: 'respect' }]);
  });

  // 电脑征税（真有公爵），Alice 质疑后输掉对质
  function provenClaim() {
    vi.useFakeTimers();
    vi.clearAllTimers();
    const made = makeRoom({ startingPlayerRandom: () => 0.99, speechRandom: () => 0, computerDelayMs: () => 600_000 });
    const alice = made.room.addPlayer('Alice', 'sock1');
    made.room.addComputer(alice.id, 'sock1');
    made.room.startGame(alice.id, 'sock1');
    const computerId = made.room.playerList.find((p) => p.isComputer)!.id;
    const duke = made.room.game!.players.find((p) => p.id === computerId)!.hand[0];
    duke.role = 'duke';
    made.room.apply((g) => chooseAction(g, computerId, 'tax'));
    made.room.dispatch(alice.id, 'sock1', { type: 'challenge' });
    made.events.onReaction.mockClear();
    made.room.apply((g) => revealShowdownCard(g, computerId, duke.id));
    const spoken = () => made.events.onReaction.mock.calls.filter(([, r]) => r.playerId === computerId).map(([, r]) => r.reaction);
    return { ...made, alice, computerId, spoken };
  }

  it('揭晓动画期间真人选了丢哪张、接着行动，结果的表态照说', () => {
    const { room, alice, spoken } = provenClaim();
    vi.advanceTimersByTime(1_000);
    room.dispatch(alice.id, 'sock1', { type: 'resolveLoss', cardId: room.game!.players.find((p) => p.id === alice.id)!.hand[0].id });
    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'income' });
    vi.advanceTimersByTime(6_000);
    expect(spoken()).toContainEqual({ kind: 'phrase', phrase: 'honest' }); // 自己的声称被证明为真，之前没说话
  });

  it('下一次结算出来后，上一次结果的表态作废', () => {
    const { room, alice, computerId, spoken } = provenClaim();
    vi.advanceTimersByTime(1_000);
    room.dispatch(alice.id, 'sock1', { type: 'resolveLoss', cardId: room.game!.players.find((p) => p.id === alice.id)!.hand[0].id });
    room.game!.players.find((p) => p.id === alice.id)!.coins = 7;
    room.dispatch(alice.id, 'sock1', { type: 'chooseAction', action: 'coup', targetId: computerId });
    room.apply((g) => resolveLoss(g, computerId, g.players.find((p) => p.id === computerId)!.hand[0].id));
    vi.advanceTimersByTime(6_000);
    expect(spoken()).not.toContainEqual({ kind: 'phrase', phrase: 'honest' });
  });
});
