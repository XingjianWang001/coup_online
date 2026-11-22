import { afterEach, expect, it, vi } from 'vitest';
import { ACTION_TIMEOUT_MS, type Role, type ServerMessage } from '@coup/shared';
import type { GameRepository } from './repository.ts';
import { Room, type GameIntent, type RoomPlayer } from './room.ts';
import { publish, pushJoined, type Pusher } from './push.ts';

// 用真实的 Room 和 push.ts 跑几条流程，录下每位玩家的连接实际收到的消息，写进 packages/shared/fixtures/message-flows.json。
// 客户端 session.test.ts 只重放这些录下的序列。推送顺序一变，这里的比对就失败：
// 确认新顺序没错后用 `pnpm fixtures` 重新生成，再跑客户端测试看会话是否还对。

type Step = { step: string; to: Record<string, ServerMessage[]> };
type Seat = 'a' | 'b' | 'c';

interface Table {
  join(seat: Seat): void; // 首次加入，或凭 id + secret 换一条新连接重连
  drop(seat: Seat): void; // 连接断开（还在宽限期内）
  leave(seat: Seat): void;
  start(seat: Seat): void;
  rematch(seat: Seat): void;
  act(seat: Seat, intent: GameIntent): void;
  card(seat: Seat, role?: Role): string; // 手里这个角色（不给时第一张）的牌 id
  id(seat: Seat): string; // 玩家 id，用作行动目标
  wait(ms: number): void;
}

const NAMES: Record<Seat, string> = { a: '张三', b: '李四', c: '王五' };

function record(hands: Role[][], steps: [string, (t: Table) => void][]): Step[] {
  vi.useFakeTimers({ now: 0 });
  vi.spyOn(Math, 'random').mockReturnValue(0); // 洗牌、换牌固定下来
  const inbox = new Map<Seat, ServerMessage[]>();
  // 连接 id → 座位和它所在的 socket.io 房间。断开的连接不在表里，收不到任何消息
  const connections = new Map<string, { seat: Seat; rooms: Set<string> }>();
  const io: Pusher = {
    to: (target) => ({
      emit: (event, payload) => {
        // 按线上的样子序列化：undefined 字段丢掉，之后牌局状态再变也不影响已录下的消息
        const msg = JSON.parse(JSON.stringify({ type: event, ...payload })) as ServerMessage;
        for (const [id, c] of connections) if (id === target || c.rooms.has(target)) inbox.get(c.seat)?.push(msg);
      },
    }),
  };
  const repo = { save: () => {}, delete: () => {} } as unknown as GameRepository;
  const room = new Room('ABC123', '', repo, { onBroadcast: (r, events) => publish(io, r, events), onEmpty: () => {}, onReaction: () => {}, onShowdownFocus: () => {} }, {
    hands,
    startingPlayerRandom: () => 0,
  });
  const seats = new Map<Seat, RoomPlayer>();
  let connectionCount = 0;
  const player = (seat: Seat) => seats.get(seat)!;
  const table: Table = {
    join(seat) {
      const socketId = `${seat}${++connectionCount}`;
      const seated = seats.get(seat);
      const p = room.addPlayer(NAMES[seat], socketId, seated && { id: seated.id, secret: seated.secret });
      seats.set(seat, p);
      connections.set(socketId, { seat, rooms: new Set([room.code]) });
      pushJoined(io, room, p, false);
    },
    drop(seat) {
      const { socketId, id } = player(seat);
      connections.delete(socketId);
      room.markDisconnected(id, socketId);
    },
    leave(seat) {
      const { socketId, id } = player(seat);
      room.leavePlayer(id, socketId);
      connections.delete(socketId);
    },
    start: (seat) => void room.startGame(player(seat).id, player(seat).socketId),
    rematch: (seat) => room.rematch(player(seat).id, player(seat).socketId),
    act: (seat, intent) => void room.dispatch(player(seat).id, player(seat).socketId, intent),
    card: (seat, role) => room.getPrivateState(player(seat).id)!.hand.find((c) => !role || c.role === role)!.id,
    id: (seat) => player(seat).id,
    wait: (ms) => vi.advanceTimersByTime(ms),
  };
  const recorded: Step[] = [];
  for (const [step, run] of steps) {
    if (recorded.some((s) => s.step === step)) throw new Error(`duplicate step ${step}`);
    for (const seat of Object.keys(NAMES) as Seat[]) inbox.set(seat, []);
    run(table);
    const to = Object.fromEntries([...inbox].filter(([, msgs]) => msgs.length));
    recorded.push({ step, to });
  }
  // 服务器生成的 id 和 secret 是随机的：换成座位名，fixture 才稳定
  let text = JSON.stringify(recorded);
  for (const [seat, p] of seats) text = text.replaceAll(p.secret, `secret-${seat}`).replaceAll(p.id, seat);
  return JSON.parse(text) as Step[];
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('录下的消息序列与服务端当前的推送一致', async () => {
  const flows = {
    // 两人局：a 征税被质疑属实，b 失去影响力；b 虚张征税被质疑，出局。赛后 a 断线两次，期间 b 再来一局并开局，a 再征税
    duel: record([['duke', 'captain'], ['contessa', 'assassin']], [
      ['a 建房', (t) => t.join('a')],
      ['b 加入', (t) => t.join('b')],
      ['a 开局', (t) => t.start('a')],
      ['a 征税', (t) => t.act('a', { type: 'chooseAction', action: 'tax' })],
      ['b 质疑', (t) => t.act('b', { type: 'challenge' })],
      ['a 翻开公爵', (t) => t.act('a', { type: 'revealShowdownCard', cardId: t.card('a', 'duke') })],
      ['b 失去刺客', (t) => t.act('b', { type: 'resolveLoss', cardId: t.card('b', 'assassin') })],
      ['b 征税', (t) => t.act('b', { type: 'chooseAction', action: 'tax' })],
      ['a 质疑', (t) => t.act('a', { type: 'challenge' })],
      ['b 翻开女伯爵，出局', (t) => t.act('b', { type: 'revealShowdownCard', cardId: t.card('b', 'contessa') })],
      ['a 赛后断线', (t) => t.drop('a')],
      ['a 赛后重连', (t) => t.join('a')],
      ['a 再次断线', (t) => t.drop('a')],
      ['b 再来一局', (t) => t.rematch('b')],
      ['b 开局', (t) => t.start('b')],
      ['a 在新一局重连', (t) => t.join('a')],
      ['a 收入', (t) => t.act('a', { type: 'chooseAction', action: 'income' })],
      ['b 收入', (t) => t.act('b', { type: 'chooseAction', action: 'income' })],
      ['a 新一局征税', (t) => t.act('a', { type: 'chooseAction', action: 'tax' })],
    ]),
    // 两人局里的断线重连：b 在 a 的回合断线又回来；a 超时默认收入；a 在自己的回合、在对质中各重连一次，最后在对质中离开
    turns: record([['duke', 'captain'], ['contessa', 'assassin']], [
      ['a 建房', (t) => t.join('a')],
      ['b 加入', (t) => t.join('b')],
      ['a 开局', (t) => t.start('a')],
      ['b 断线', (t) => t.drop('b')],
      ['b 重连', (t) => t.join('b')],
      ['a 超时，默认收入', (t) => t.wait(ACTION_TIMEOUT_MS)],
      ['b 收入', (t) => t.act('b', { type: 'chooseAction', action: 'income' })],
      ['a 断线', (t) => t.drop('a')],
      ['a 重连', (t) => t.join('a')],
      ['a 征税', (t) => t.act('a', { type: 'chooseAction', action: 'tax' })],
      ['b 质疑', (t) => t.act('b', { type: 'challenge' })],
      ['a 对质中断线', (t) => t.drop('a')],
      ['a 对质中重连', (t) => t.join('a')],
      ['a 对质中离开', (t) => t.leave('a')],
    ]),
    // 三人局：a 旁观 b 被 c 质疑时断线，离线期间换成 c 被 b 质疑，a 重连；b 随后两次失去影响力出局，牌局继续
    trio: record([['captain', 'contessa'], ['duke', 'assassin'], ['duke', 'ambassador']], [
      ['a 建房', (t) => t.join('a')],
      ['b 加入', (t) => t.join('b')],
      ['c 加入', (t) => t.join('c')],
      ['a 开局', (t) => t.start('a')],
      ['a 收入', (t) => t.act('a', { type: 'chooseAction', action: 'income' })],
      ['b 征税', (t) => t.act('b', { type: 'chooseAction', action: 'tax' })],
      ['c 质疑', (t) => t.act('c', { type: 'challenge' })],
      ['a 断线', (t) => t.drop('a')],
      ['b 翻开公爵', (t) => t.act('b', { type: 'revealShowdownCard', cardId: t.card('b', 'duke') })],
      ['c 失去大使', (t) => t.act('c', { type: 'resolveLoss', cardId: t.card('c', 'ambassador') })],
      ['c 征税', (t) => t.act('c', { type: 'chooseAction', action: 'tax' })],
      ['b 质疑', (t) => t.act('b', { type: 'challenge' })],
      ['a 重连', (t) => t.join('a')],
      ['c 翻开公爵', (t) => t.act('c', { type: 'revealShowdownCard', cardId: t.card('c', 'duke') })],
      ['b 失去刺客', (t) => t.act('b', { type: 'resolveLoss', cardId: t.card('b', 'assassin') })],
      ['a 再收入', (t) => t.act('a', { type: 'chooseAction', action: 'income' })],
      ['b 偷 c', (t) => t.act('b', { type: 'chooseAction', action: 'steal', targetId: t.id('c') })],
      ['c 质疑偷钱', (t) => t.act('c', { type: 'challenge' })],
      ['b 翻开最后一张，出局', (t) => t.act('b', { type: 'revealShowdownCard', cardId: t.card('b') })],
    ]),
    // 两人局里的座位动效：偷钱、交换、虚张刺杀被质疑、从没钱的人那里偷、阻挡外援
    seats: record([['contessa', 'duke'], ['captain', 'ambassador']], [
      ['a 建房', (t) => t.join('a')],
      ['b 加入', (t) => t.join('b')],
      ['a 开局', (t) => t.start('a')],
      ['a 收入', (t) => t.act('a', { type: 'chooseAction', action: 'income' })],
      ['b 偷 a', (t) => t.act('b', { type: 'chooseAction', action: 'steal', targetId: t.id('a') })],
      ['a 不质疑偷钱', (t) => t.act('a', { type: 'passChallenge' })],
      ['a 不阻挡偷钱', (t) => t.act('a', { type: 'passBlock' })],
      ['a 交换', (t) => t.act('a', { type: 'chooseAction', action: 'exchange' })],
      ['b 不质疑交换', (t) => t.act('b', { type: 'passChallenge' })],
      ['a 留下原来的牌', (t) => t.act('a', { type: 'resolveExchange', keepIds: [t.card('a', 'contessa'), t.card('a', 'duke')] })],
      ['b 刺杀 a', (t) => t.act('b', { type: 'chooseAction', action: 'assassinate', targetId: t.id('a') })],
      ['a 质疑刺杀', (t) => t.act('a', { type: 'challenge' })],
      ['b 翻开船长', (t) => t.act('b', { type: 'revealShowdownCard', cardId: t.card('b', 'captain') })],
      ['a 偷 b', (t) => t.act('a', { type: 'chooseAction', action: 'steal', targetId: t.id('b') })],
      ['b 不质疑偷钱', (t) => t.act('b', { type: 'passChallenge' })],
      ['b 不阻挡偷钱', (t) => t.act('b', { type: 'passBlock' })],
      ['b 再偷 a', (t) => t.act('b', { type: 'chooseAction', action: 'steal', targetId: t.id('a') })],
      ['a 不质疑再偷', (t) => t.act('a', { type: 'passChallenge' })],
      ['a 不阻挡再偷', (t) => t.act('a', { type: 'passBlock' })],
      ['a 再交换', (t) => t.act('a', { type: 'chooseAction', action: 'exchange' })],
      ['b 不质疑再交换', (t) => t.act('b', { type: 'passChallenge' })],
      ['a 再留下原来的牌', (t) => t.act('a', { type: 'resolveExchange', keepIds: [t.card('a', 'contessa'), t.card('a', 'duke')] })],
      ['b 偷没钱的 a', (t) => t.act('b', { type: 'chooseAction', action: 'steal', targetId: t.id('a') })],
      ['a 不质疑偷空', (t) => t.act('a', { type: 'passChallenge' })],
      ['a 不阻挡偷空', (t) => t.act('a', { type: 'passBlock' })],
      ['a 再收入', (t) => t.act('a', { type: 'chooseAction', action: 'income' })],
      ['b 外援', (t) => t.act('b', { type: 'chooseAction', action: 'foreignAid' })],
      ['a 以公爵阻挡', (t) => t.act('a', { type: 'block', role: 'duke' })],
      ['b 不质疑阻挡', (t) => t.act('b', { type: 'passChallenge' })],
    ]),
  };
  const text = `{\n${Object.entries(flows)
    .map(([name, steps]) => `  ${JSON.stringify(name)}: [\n${steps.map((s) => `    ${JSON.stringify(s)}`).join(',\n')}\n  ]`)
    .join(',\n')}\n}\n`;
  await expect(text).toMatchFileSnapshot('../../shared/fixtures/message-flows.json');
});
