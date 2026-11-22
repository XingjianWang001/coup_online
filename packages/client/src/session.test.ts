import { describe, expect, it } from 'vitest';
import type { PublicState, ServerMessage } from '@coup/shared';
import recorded from '@coup/shared/fixtures/message-flows.json';
import { closeShowdown, dropMotion, initialSession, reduceSession, rejoinIntent, type Session } from './session.ts';

// 服务端真实推送的消息序列，由 server/src/message-flows.test.ts 录下（`pnpm fixtures` 重新生成）。
// 每条流程按步骤记每位玩家（a、b、c）的连接收到的消息；各流程演的是什么见那里的注释
type Flow = 'duel' | 'turns' | 'trio' | 'seats';
const flows = recorded as unknown as Record<Flow, { step: string; to: Record<string, ServerMessage[]> }[]>;

// viewer 在 flow 里收到的消息：after 那一步之后（不给时从头）到 until 那一步为止（含）
function received(flow: Flow, viewer: string, until: string, after?: string): ServerMessage[] {
  const steps = flows[flow];
  const index = (step: string) => {
    const i = steps.findIndex((s) => s.step === step);
    if (i < 0) throw new Error(`${flow} 里没有「${step}」这一步`);
    return i;
  };
  return steps.slice(after === undefined ? 0 : index(after) + 1, index(until) + 1).flatMap((s) => s.to[viewer] ?? []);
}

function run(messages: ServerMessage[], from: Session = initialSession): Session {
  return messages.reduce((s, msg) => reduceSession(s, msg, 0), from);
}

describe('房间会话', () => {
  const inGame = run(received('duel', 'a', 'a 开局'));
  // a 的回合刚开始，已选了偷钱、还没选目标
  const myTurn = { ...run(received('turns', 'a', 'a 开局')), selectedAction: 'steal' as const };

  it('自己的回合内收到新的牌局状态时保留目标选择', () => {
    // b 断线又重连：每次都给 a 再推一遍牌局状态，回合没变
    expect(run(received('turns', 'a', 'b 重连', 'a 开局'), myTurn).selectedAction).toBe('steal');
  });

  it('默认行动替你收入、轮到下一位后，收起没提交的目标选择', () => {
    expect(run(received('turns', 'a', 'a 超时，默认收入', 'a 开局'), myTurn).selectedAction).toBeNull();
  });

  it('断线重连后即使又轮到自己，也收起离线前的目标选择', () => {
    const choosing = { ...run(received('turns', 'a', 'b 收入')), selectedAction: 'steal' as const };
    const s = run(received('turns', 'a', 'a 重连', 'b 收入'), choosing);
    expect(s.publicState?.currentPlayerId).toBe('a');
    expect(s.selectedAction).toBeNull();
  });

  it('再来一局回到大厅阶段：清空牌桌，保留房间信息', () => {
    const seated = run([{ type: 'tunnelUrl', url: 'https://t' }], run(received('duel', 'b', 'b 加入')));
    const s = run(received('duel', 'b', 'b 再来一局', 'b 加入'), seated);
    expect(s).toMatchObject({ roomCode: 'ABC123', tunnelUrl: 'https://t', publicState: null, countdown: null, hand: [], log: [], showcase: null });
  });

  it('离开后回到初始会话', () => {
    expect(run([{ type: 'left', reason: 'replaced' }], inGame)).toEqual(initialSession);
  });

  it('房间已被释放时回到初始会话，其它错误不影响会话', () => {
    expect(run([{ type: 'error', code: 'roomNotFound', inRoom: false }], inGame)).toEqual(initialSession);
    expect(run([{ type: 'error', code: 'hostOnly', inRoom: true }], inGame).roomCode).toBe('ABC123');
  });

  it('大厅里离线超过宽限期被移出、房主随后开局：重连时自动加入失败，退回入口；房主双击开始的报错不影响会话', () => {
    const lobby = run(received('duel', 'b', 'b 加入'));
    // 服务器顺序：b 的新连接发 joinRoom → 座位已不在、牌局已开始 → 只回一条 error，不发 joined
    expect(run([{ type: 'error', code: 'gameAlreadyStarted', inRoom: false }], lobby)).toEqual(initialSession);
    // 房主双击「开始」：第一次开局的 gameStarted → publicState → privateState 之后，第二次回 error
    expect(run([{ type: 'error', code: 'gameAlreadyStarted', inRoom: true }], inGame)).toMatchObject({ roomCode: 'ABC123', publicState: inGame.publicState });
  });

  it('开局重置记录，后续事件的记录 id 从 0 递增', () => {
    // b 看完上一局，再来一局开局后两人各收入一次
    const s = run(received('duel', 'b', 'b 收入'));
    expect(s.log.map((e) => e.id)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('牌局状态记录收到时刻供倒计时使用', () => {
    const s = reduceSession(initialSession, { type: 'publicState', state: { phase: 'choosingAction' } as PublicState, remainingMs: 1000, deadlineAt: 5000, hostId: 'a' }, 42);
    expect(s.countdown).toEqual({ remainingMs: 1000, deadlineAt: 5000, receivedAt: 42 });
  });

  it('开局后收到手牌即发牌展示；刷新重连只收到手牌时不展示', () => {
    const dealt = run(received('duel', 'b', 'b 开局'));
    expect(dealt.hand).toHaveLength(2);
    expect(dealt.showcase).toEqual({ kind: 'deal', cards: dealt.hand });
    // a 重连时 b 又收到一份手牌：展示不变
    expect(run(received('duel', 'b', 'a 在新一局重连', 'b 开局'), dealt).showcase).toEqual(dealt.showcase);
    // a 刷新页面后从空会话重连进这一局
    expect(run(received('duel', 'a', 'a 在新一局重连', 'a 再次断线')).showcase).toBeNull();
  });

  it('离线期间上一局结束、再来一局已开局：重连后不沿用上一局的记录；同一局内重连仍保留', () => {
    const ended = run(received('duel', 'a', 'b 翻开女伯爵，出局'));
    const sameGame = run(received('duel', 'a', 'a 赛后重连', 'b 翻开女伯爵，出局'), ended);
    expect(sameGame.log).toEqual(ended.log);
    // 再次断线后房主 b 再来一局并开局，a 错过 lobby 与 gameStarted
    expect(run(received('duel', 'a', 'a 在新一局重连', 'a 赛后重连'), sameGame).log).toEqual([]);
  });

  it('牌局结束或自己被淘汰时，收起仍开着的发牌展示', () => {
    // 牌局结束：a 获胜
    expect(run(received('duel', 'a', 'a 质疑')).showcase).not.toBeNull();
    expect(run(received('duel', 'a', 'b 翻开女伯爵，出局')).showcase).toBeNull();
    // 三人局里 b 出局，牌局继续
    const beforeOut = run(received('trio', 'b', 'c 质疑偷钱'));
    expect(beforeOut.showcase).not.toBeNull();
    const out = run(received('trio', 'b', 'b 翻开最后一张，出局', 'c 质疑偷钱'), beforeOut);
    expect(out.publicState?.phase).toBe('choosingAction');
    expect(out.showcase).toBeNull();
  });
});

describe('对质', () => {
  // a 征税被 b 质疑，a 是被质疑者。a 已收起开局的发牌展示
  const holding = { ...run(received('duel', 'a', 'a 开局')), showcase: null };
  const open = run(received('duel', 'a', 'b 质疑', 'a 开局'), holding);

  it('进入对质即打开舞台：被质疑者记下翻牌前的手牌，旁观者收到同步的悬停牌位', () => {
    expect(open.showdown).toEqual({ challengerId: 'b', claimantId: 'a', role: 'duke', id: expect.any(Number), slots: 2, hand: open.hand, focus: null, reveal: null, newCard: null });
    const watching = run(received('duel', 'b', 'b 质疑'));
    expect(watching.showdown).toMatchObject({ slots: 2, hand: null });
    expect(run([{ type: 'showdownFocus', slot: 0 }], watching).showdown?.focus).toBe(0);
  });

  it('被质疑者在对质中刷新重连，手牌到达后仍能选牌', () => {
    const rejoined = run(received('turns', 'a', 'a 对质中重连', 'a 对质中断线'));
    expect(rejoined.showdown?.hand?.map((c) => c.role)).toEqual(['duke', 'captain']);
  });

  it('旁观对质时断线、离线期间换了一场对质：重连后打开新的对质', () => {
    // 三人局：a 旁观 c 质疑 b 时断线；离线期间 b 属实、c 失去影响力，轮到 c 征税被 b 质疑
    const watching = run(received('trio', 'a', 'c 质疑'));
    expect(watching.showdown).toMatchObject({ challengerId: 'c', claimantId: 'b' });
    const rejoined = run(received('trio', 'a', 'a 重连', 'c 质疑'), watching);
    expect(rejoined.showdown).toMatchObject({ challengerId: 'b', claimantId: 'c', role: 'duke', slots: 1, hand: null, reveal: null });
  });

  it('揭晓动画期间下一场对质也已揭晓：舞台保留第一场的结果，动画播完即收起', () => {
    // 被质疑者切到后台标签页时动画停住，期间又有一场对质开始并结束
    const first = run(received('duel', 'a', 'a 翻开公爵', 'b 质疑'), open);
    const s = run(received('duel', 'a', 'b 翻开女伯爵，出局', 'a 翻开公爵'), first);
    expect(s.showdown?.reveal).toBe(first.showdown?.reveal);
    expect(closeShowdown(s).showdown).toBeNull();
  });

  it('揭晓后舞台留到动画播完；换来的新牌记在原牌位，不再另弹换牌展示', () => {
    const s = run(received('duel', 'a', 'a 翻开公爵', 'b 质疑'), open);
    expect(s.showdown).toMatchObject({ reveal: { slot: 0, role: 'duke', truth: true }, newCard: s.hand[0] });
    expect(s.showdown?.newCard?.id).not.toBe(open.hand[0].id);
    expect(s.showcase).toBeNull();
  });

  it('动画播完关闭舞台时，若下一场对质已经开始则接着打开它', () => {
    // a 的公爵属实：b 失去影响力 → a 征税结算 → 轮到 b 征税，被 a 质疑
    const animating = run(received('duel', 'a', 'a 质疑', 'b 质疑'), open);
    expect(animating.showdown?.reveal).not.toBeNull();
    expect(closeShowdown(animating).showdown).toMatchObject({ challengerId: 'a', claimantId: 'b', role: 'duke', reveal: null });
    expect(closeShowdown(run(received('duel', 'a', 'b 失去刺客', 'b 质疑'), open)).showdown).toBeNull();
  });

  it('对质没有揭晓就结束（被质疑者离开、弃权）时收起舞台', () => {
    expect(run(received('turns', 'b', 'a 对质中重连')).showdown).not.toBeNull();
    expect(run(received('turns', 'b', 'a 对质中离开')).showdown).toBeNull();
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
  // 两人局，自己是 a（手里女伯爵 + 公爵），开局金币 a 1、b 2
  const upTo = (step: string) => run(received('seats', 'a', step));
  const brief = (s: Session) => s.motions.map(({ id: _id, ...m }) => m);
  const coins = (s: Session) => brief(s).filter((m) => m.kind === 'coins');
  const ghosts = (s: Session, playerId: string) => s.motions.filter((m) => m.kind === 'ghost' && m.playerId === playerId);

  it('金币差额按变化前的状态计算，0 不显示', () => {
    // b 偷走 a 的 2 枚
    const robbed = upTo('a 不阻挡偷钱');
    expect(coins(robbed)).toContainEqual({ playerId: 'a', kind: 'coins', delta: -2 });
    expect(coins(robbed)).toContainEqual({ playerId: 'b', kind: 'coins', delta: 2 });
    // b 从没钱的 a 那里偷：两人金币都没变，不新增金币动效
    expect(coins(upTo('a 不阻挡偷空'))).toEqual(coins(upTo('a 不质疑偷空')));
  });

  it('同一座位的新动效替换还没播完的旧动效', () => {
    expect(coins(upTo('a 收入'))).toEqual([{ playerId: 'a', kind: 'coins', delta: 1 }]);
    expect(coins(upTo('a 不阻挡偷钱')).filter((m) => m.playerId === 'a')).toEqual([{ playerId: 'a', kind: 'coins', delta: -2 }]);
  });

  it('新声称才放背后灵：故事里已有的角色不重放，实际交换后从头讲', () => {
    expect(brief(upTo('b 偷 a'))).toContainEqual({ playerId: 'b', kind: 'ghost', role: 'captain', honest: false });
    // b 第二次声称船长：故事里已有，b 的背后灵还是上次的刺客
    expect(ghosts(upTo('b 再偷 a'), 'b')).toEqual(ghosts(upTo('a 不阻挡再偷'), 'b'));
    expect(ghosts(upTo('b 再偷 a'), 'b')).toMatchObject([{ role: 'assassin' }]);
    // a 声称大使交换、实际交换后故事从头讲，之后又声称船长；再声称大使时重新放背后灵
    const again = upTo('a 再交换');
    expect(ghosts(again, 'a')).not.toEqual(ghosts(upTo('a 不阻挡再偷'), 'a'));
    expect(ghosts(again, 'a')).toMatchObject([{ role: 'ambassador', honest: false }]);
  });

  it('阻挡也是声称；自己手里有这张才算真声称', () => {
    expect(brief(upTo('a 以公爵阻挡'))).toContainEqual({ playerId: 'a', kind: 'ghost', role: 'duke', honest: true });
    expect(brief(upTo('a 偷 b'))).toContainEqual({ playerId: 'a', kind: 'ghost', role: 'captain', honest: false });
  });

  it('对质那一批的动效等舞台收起后才放出来', () => {
    // b 虚张刺杀被 a 质疑，翻开船长：退回的 3 枚金币和失去影响力同一批到达
    const resolved = upTo('b 翻开船长');
    expect(coins(resolved)).not.toContainEqual({ playerId: 'b', kind: 'coins', delta: 3 });
    expect(coins(closeShowdown(resolved))).toContainEqual({ playerId: 'b', kind: 'coins', delta: 3 });
  });

  it('播完的动效可以移除；重连不补播，开新局清空故事', () => {
    const s = upTo('b 偷 a');
    const [ghost] = ghosts(s, 'b');
    expect(ghosts(dropMotion(s, ghost.id), 'b')).toEqual([]);
    const ended = run(received('duel', 'a', 'a 赛后断线'));
    expect(ended.motions).not.toEqual([]);
    expect(run(received('duel', 'a', 'a 赛后重连', 'a 赛后断线'), ended).motions).toEqual([]);
    // a 上一局声称过公爵；b 看到再来一局后 a 又声称公爵，重新放背后灵
    expect(brief(run(received('duel', 'b', 'a 新一局征税')))).toContainEqual({ playerId: 'a', kind: 'ghost', role: 'duke', honest: false });
  });
});
