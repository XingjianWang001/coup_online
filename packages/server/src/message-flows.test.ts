import { afterEach, expect, it, vi } from 'vitest';
import { ACTION_TIMEOUT_MS, type MessageFlows, type Role, type ServerMessage } from '@coup/shared';
import type { GameRepository } from './repository.ts';
import { Room, type GameIntent, type RoomPlayer } from './room.ts';
import { publish, pushJoined, type Pusher } from './push.ts';

// 用真实的 Room 和 push.ts 跑几条流程，录下每位玩家的连接实际收到的消息，写进 packages/shared/fixtures/message-flows.json。
// 客户端 session.test.ts 只重放这些录下的序列。推送顺序一变，这里的比对就失败：
// 确认新顺序没错后用 `pnpm fixtures` 重新生成，再跑客户端测试看会话是否还对。

type Step = MessageFlows[keyof MessageFlows][number];
type Who = 'a' | 'b' | 'c'; // 玩家代号，fixture 里的玩家 id 也换成它

interface Driver {
  join(who: Who): void; // 首次加入，或凭 id + secret 换一条新连接重连
  drop(who: Who): void; // 连接断开（还在宽限期内）
  leave(who: Who): void;
  start(who: Who): void;
  rematch(who: Who): void;
  act(who: Who, intent: GameIntent): void;
  card(who: Who, role?: Role): string; // 手里这个角色（不给时第一张）的牌 id
  id(who: Who): string; // 玩家 id，用作行动目标
  wait(ms: number): void;
}

const NAMES: Record<Who, string> = { a: '张三', b: '李四', c: '王五' };

function record(hands: Role[][], steps: [string, (t: Driver) => void][]): Step[] {
  vi.useFakeTimers({ now: 0 });
  vi.spyOn(Math, 'random').mockReturnValue(0); // 洗牌、换牌固定下来
  const inbox = new Map<Who, ServerMessage[]>();
  // 连接 id → 玩家代号和它所在的 socket.io 房间。断开的连接不在表里，收不到任何消息
  const connections = new Map<string, { who: Who; rooms: Set<string> }>();
  const io: Pusher = {
    to: (target) => ({
      emit: (event, payload) => {
        // 按线上的样子序列化：undefined 字段丢掉，之后牌局状态再变也不影响已录下的消息
        const msg = JSON.parse(JSON.stringify({ type: event, ...payload })) as ServerMessage;
        for (const [id, c] of connections) if (id === target || c.rooms.has(target)) inbox.get(c.who)?.push(msg);
      },
    }),
  };
  const repo = { save: () => {}, delete: () => {} } as unknown as GameRepository;
  const room = new Room('ABC123', '', repo, { onBroadcast: (r, events) => publish(io, r, events), onEmpty: () => {}, onReaction: () => {}, onShowdownFocus: () => {} }, {
    hands,
    startingPlayerRandom: () => 0,
  });
  const players = new Map<Who, RoomPlayer>();
  let connectionCount = 0;
  const player = (who: Who) => players.get(who)!;
  const driver: Driver = {
    join(who) {
      const socketId = `${who}${++connectionCount}`;
      const known = players.get(who);
      const p = room.addPlayer(NAMES[who], socketId, known && { id: known.id, secret: known.secret });
      players.set(who, p);
      connections.set(socketId, { who, rooms: new Set([room.code]) });
      pushJoined(io, room, p, false);
    },
    drop(who) {
      const { socketId, id } = player(who);
      connections.delete(socketId);
      room.markDisconnected(id, socketId);
    },
    leave(who) {
      const { socketId, id } = player(who);
      room.leavePlayer(id, socketId);
      connections.delete(socketId);
    },
    start: (who) => void room.startGame(player(who).id, player(who).socketId),
    rematch: (who) => room.rematch(player(who).id, player(who).socketId),
    act: (who, intent) => void room.dispatch(player(who).id, player(who).socketId, intent),
    card: (who, role) => room.getPrivateState(player(who).id)!.hand.find((c) => !role || c.role === role)!.id,
    id: (who) => player(who).id,
    wait: (ms) => vi.advanceTimersByTime(ms),
  };
  const recorded: Step[] = [];
  for (const [step, run] of steps) {
    if (recorded.some((s) => s.step === step)) throw new Error(`duplicate step ${step}`);
    for (const who of Object.keys(NAMES) as Who[]) inbox.set(who, []);
    run(driver);
    const to = Object.fromEntries([...inbox].filter(([, msgs]) => msgs.length));
    recorded.push({ step, to });
  }
  // 服务器生成的 id 和 secret 是随机的：换成玩家代号，fixture 才稳定
  let text = JSON.stringify(recorded);
  for (const [who, p] of players) text = text.replaceAll(p.secret, `secret-${who}`).replaceAll(p.id, who);
  return JSON.parse(text) as Step[];
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('录下的消息序列与服务端当前的推送一致', async () => {
  const flows: MessageFlows = {
    // 两人局：a 征税被质疑属实，b 失去影响力；b 诈唬征税被质疑，出局。赛后 a 断线两次，期间 b 再来一局并开局，a 再征税
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
      ['b 偷窃 c', (t) => t.act('b', { type: 'chooseAction', action: 'steal', targetId: t.id('c') })],
      ['c 质疑偷窃', (t) => t.act('c', { type: 'challenge' })],
      ['b 翻开最后一张，出局', (t) => t.act('b', { type: 'revealShowdownCard', cardId: t.card('b') })],
    ]),
    // 两人局里的座位动效：偷窃、交换、诈唬暗杀被质疑、偷窃没钱的人、阻挡外援
    seats: record([['contessa', 'duke'], ['captain', 'ambassador']], [
      ['a 建房', (t) => t.join('a')],
      ['b 加入', (t) => t.join('b')],
      ['a 开局', (t) => t.start('a')],
      ['a 收入', (t) => t.act('a', { type: 'chooseAction', action: 'income' })],
      ['b 偷窃 a', (t) => t.act('b', { type: 'chooseAction', action: 'steal', targetId: t.id('a') })],
      ['a 不质疑偷窃', (t) => t.act('a', { type: 'passChallenge' })],
      ['a 不阻挡偷窃', (t) => t.act('a', { type: 'passBlock' })],
      ['a 交换', (t) => t.act('a', { type: 'chooseAction', action: 'exchange' })],
      ['b 不质疑交换', (t) => t.act('b', { type: 'passChallenge' })],
      ['a 留下原来的牌', (t) => t.act('a', { type: 'resolveExchange', keepIds: [t.card('a', 'contessa'), t.card('a', 'duke')] })],
      ['b 暗杀 a', (t) => t.act('b', { type: 'chooseAction', action: 'assassinate', targetId: t.id('a') })],
      ['a 质疑暗杀', (t) => t.act('a', { type: 'challenge' })],
      ['b 翻开队长', (t) => t.act('b', { type: 'revealShowdownCard', cardId: t.card('b', 'captain') })],
      ['a 偷窃 b', (t) => t.act('a', { type: 'chooseAction', action: 'steal', targetId: t.id('b') })],
      ['b 不质疑偷窃', (t) => t.act('b', { type: 'passChallenge' })],
      ['b 不阻挡偷窃', (t) => t.act('b', { type: 'passBlock' })],
      ['b 再偷窃 a', (t) => t.act('b', { type: 'chooseAction', action: 'steal', targetId: t.id('a') })],
      ['a 不质疑再偷窃', (t) => t.act('a', { type: 'passChallenge' })],
      ['a 不阻挡再偷窃', (t) => t.act('a', { type: 'passBlock' })],
      ['a 再交换', (t) => t.act('a', { type: 'chooseAction', action: 'exchange' })],
      ['b 不质疑再交换', (t) => t.act('b', { type: 'passChallenge' })],
      ['a 再留下原来的牌', (t) => t.act('a', { type: 'resolveExchange', keepIds: [t.card('a', 'contessa'), t.card('a', 'duke')] })],
      ['b 偷窃没钱的 a', (t) => t.act('b', { type: 'chooseAction', action: 'steal', targetId: t.id('a') })],
      ['a 不质疑落空的偷窃', (t) => t.act('a', { type: 'passChallenge' })],
      ['a 不阻挡落空的偷窃', (t) => t.act('a', { type: 'passBlock' })],
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
