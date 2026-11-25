import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, type Socket } from 'socket.io';
import { InMemoryGameRepository } from './repository.ts';
import { Room, type RoomOptions, type RoomPlayer } from './room.ts';
import { canStartTunnel, startTunnel, stopTunnel } from './tunnel.ts';
import { parseClientIntent, type ClientIntent, type ServerError } from '@coup/shared';
import { ClientError, toServerError } from './errors.ts';
import { reserveRoomCreation } from './room-limits.ts';
import { publish, pushJoined } from './push.ts';
import { creditsFor, readRoster, readSites, siteFor } from './credits.ts';
import { appendRecord } from './data-file.ts';
import { pruneVisits, recordVisit } from './visits.ts';
import { readStats } from './stats.ts';

const PORT = Number(process.env.PORT ?? 8787);
// 控制台单开一个端口、默认只听本机：能连上就是运营者，不做认证（ADR 0015）。容器里改听 0.0.0.0，由 compose 只映射到宿主的 127.0.0.1
const CONSOLE_PORT = Number(process.env.CONSOLE_PORT ?? 8788);
const CONSOLE_HOST = process.env.CONSOLE_HOST ?? '127.0.0.1';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
// 前端构建产物路径（相对 packages/server）
const CLIENT_DIST = join(__dirname, '../../client/dist');

// 以下环境变量只供测试：由 scripts/ui-check.mjs 按场景的 serverEnv 设置，生产环境从不设置。
// SPEECH_RANDOM=0 让电脑表态的随机源恒为这个数，每个能开口的时刻都开口、按最短延迟说
const SPEECH_RANDOM = process.env.SPEECH_RANDOM === undefined ? undefined : Number(process.env.SPEECH_RANDOM);
// COMPUTER_DELAY_MS=300 让电脑每一步都只等这么久（替换默认区间和旁观加速），要打完一整局的场景放得进 ui-check 的时限
const COMPUTER_DELAY_MS = process.env.COMPUTER_DELAY_MS === undefined ? undefined : Number(process.env.COMPUTER_DELAY_MS);
// STARTING_PLAYER_RANDOM=0 让最先入座的人先手；HANDS 按入座顺序发牌（JSON，如 [["duke","duke"],["contessa","captain"]]）
const STARTING_PLAYER_RANDOM = process.env.STARTING_PLAYER_RANDOM === undefined ? undefined : Number(process.env.STARTING_PLAYER_RANDOM);
const HANDS = process.env.HANDS === undefined ? undefined : (JSON.parse(process.env.HANDS) as RoomOptions['hands']);
// COMPUTER_RANDOM=0.999 让电脑行动的随机源恒为这个数：几乎从不质疑，有真牌就阻挡
const COMPUTER_RANDOM = process.env.COMPUTER_RANDOM === undefined ? undefined : Number(process.env.COMPUTER_RANDOM);
const roomOptions: RoomOptions = {
  ...(SPEECH_RANDOM !== undefined && { speechRandom: () => SPEECH_RANDOM }),
  ...(COMPUTER_DELAY_MS !== undefined && { computerDelayMs: () => COMPUTER_DELAY_MS }),
  ...(STARTING_PLAYER_RANDOM !== undefined && { startingPlayerRandom: () => STARTING_PLAYER_RANDOM }),
  ...(HANDS && { hands: HANDS }),
  ...(COMPUTER_RANDOM !== undefined && { computerRandom: () => COMPUTER_RANDOM }),
};

const repo = new InMemoryGameRepository();
const rooms = new Map<string, Room>();

// socket 传 socket.handshake，HTTP 请求传 { headers, address: remoteAddress }
function clientAddress({ headers, address }: { headers: IncomingMessage['headers']; address?: string }): string {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  }
  return address ?? '';
}

function genCode(): string {
  let code: string;
  do {
    code = randomBytes(3).toString('hex').toUpperCase(); // 6 位房间码
  } while (rooms.has(code));
  return code;
}

// 和 socket 意图一样，一个请求出错只影响这个请求：漏出去的异常会让进程退出，内存里的所有房间随之丢失
const httpServer = createServer((req, res) => {
  serveHttp(req, res).catch((error) => {
    console.error('http request error', error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

async function serveHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost'); // 请求目标来自网络，/\[ 这类目标会让它抛错
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  if (url.pathname === '/api/credits') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(creditsFor(await readRoster(), req.headers.host ?? '', url.searchParams.get('locale'))));
    return;
  }
  if (url.pathname === '/api/site') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(siteFor(await readSites(), req.headers.host ?? '')));
    return;
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  // 打开首页记一次访问；静态资源、/healthz、/api/credits 都不记
  const home = path === '/' && req.method === 'GET';
  if (path === '/') path = '/index.html';
  path = normalize(path);

  const filePath = join(CLIENT_DIST, path);
  const relativePath = relative(CLIENT_DIST, filePath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = extname(filePath);
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
  };
  const headers: Record<string, string> = { 'Content-Type': types[ext] ?? 'application/octet-stream' };
  // Vite 给 assets/ 下的文件名带内容哈希：内容变了文件名就变，浏览器可以一直缓存，不必每次打开或刷新都重新下载
  if (relativePath.startsWith(`assets${sep}`)) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  res.writeHead(200, headers);
  res.end(readFileSync(filePath));
  if (home) recordVisit(clientAddress({ headers: req.headers, address: req.socket.remoteAddress }), { event: 'home' });
}

// 控制台：只读，页面、所有房间的完整状态和统计。游戏端口上没有这些路由
const CONSOLE_PAGE = readFileSync(join(__dirname, 'console.html'));
const consoleServer = createServer((req, res) => {
  const [path, query = ''] = (req.url ?? '').split('?');
  const json = (body: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(CONSOLE_PAGE);
  } else if (req.method === 'GET' && path === '/api/state') {
    json({ rooms: [...rooms.values()].map((room) => room.consoleSnapshot()) });
  } else if (req.method === 'GET' && path === '/api/stats') {
    readStats(new URLSearchParams(query).get('games') === 'all').then(json, (error) => {
      console.error('console stats error', error);
      res.writeHead(500);
      res.end();
    });
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

const io = new Server(httpServer);

// 所有错误都从这里发：带上这条连接是否还在房间里，客户端据此决定会话是否结束
function emitError(socket: Socket, error: ServerError): void {
  socket.emit('error', { ...error, inRoom: rooms.has(socket.data.roomCode) });
}

function emitJoined(socket: Socket, room: Room, player: RoomPlayer): void {
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  pushJoined(io, room, player, canStartTunnel(socket.handshake));
}

io.on('connection', (socket) => {
  socket.on('timeSync', (ack: (serverNow: number) => void) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('intent', (raw: unknown) => {
    try {
      const intent = parseClientIntent(raw);
      if (!intent) throw new ClientError({ code: 'illegalIntent' });
      handleIntent(socket, intent);
    } catch (e) {
      emitError(socket, toServerError(e));
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode as string | undefined;
    const playerId = socket.data.playerId as string | undefined;
    if (roomCode && playerId) {
      const room = rooms.get(roomCode);
      room?.markDisconnected(playerId, socket.id);
    }
  });
});

function handleIntent(socket: Socket, raw: ClientIntent): void {
  switch (raw.type) {
    case 'createRoom': {
      if (socket.data.roomCode) throw new ClientError({ code: 'illegalIntent' });
      const code = genCode();
      const room = new Room(code, '', repo, {
        onBroadcast: (r, events) => publish(io, r, events),
        onEmpty: (r) => rooms.delete(r.code),
        // 发给整个房间（含发送者）：自己的座位也要亮起，且只在服务器接受后才亮
        onReaction: (r, reaction) => io.to(r.code).emit('reaction', reaction),
        onShowdownFocus: (r, focus) => io.to(r.code).emit('showdownFocus', focus),
        // 写失败只打日志，不影响牌局
        onGameSummary: (summary) => appendRecord('games.jsonl', summary).catch((error) => console.error('game summary write error', error)),
      }, roomOptions);
      const p = room.addPlayer(raw.name, socket.id);
      reserveRoomCreation(clientAddress(socket.handshake), rooms.size);
      rooms.set(code, room);
      emitJoined(socket, room, p);
      recordVisit(clientAddress(socket.handshake), { event: 'createRoom' });
      break;
    }
    case 'joinRoom': {
      if (socket.data.roomCode) throw new ClientError({ code: 'illegalIntent' });
      if (!/^[0-9a-f]{6}$/i.test(raw.roomCode)) {
        throw new ClientError({ code: 'roomNotFound' });
      }
      const room = rooms.get(raw.roomCode.toUpperCase());
      if (!room) throw new ClientError({ code: 'roomNotFound' });
      const reconnect = raw.playerId && raw.secret ? { id: raw.playerId, secret: raw.secret } : undefined;
      const p = room.addPlayer(raw.name, socket.id, reconnect);
      for (const previousId of io.sockets.adapter.rooms.get(room.code) ?? []) {
        const previous = io.sockets.sockets.get(previousId);
        if (previous && previous.data.playerId === p.id && previous.id !== socket.id) {
          previous.leave(room.code);
          previous.data.roomCode = undefined;
          previous.data.playerId = undefined;
          previous.emit('left', { reason: 'replaced' });
        }
      }
      emitJoined(socket, room, p);
      // 回到自己原来的座位（断线重连、刷新）不算又进了一次房
      if (p.id !== raw.playerId) recordVisit(clientAddress(socket.handshake), { event: 'joinRoom', via: raw.via ?? 'code' });
      break;
    }
    case 'startTunnel': {
      if (!canStartTunnel(socket.handshake)) throw new ClientError({ code: 'tunnelUnauthorized' });
      // 隧道断了：所有页面收起失效的加入链接，房主可以重新生成
      startTunnel(PORT, () => io.emit('tunnelUrl', { url: null }))
        .then((url) => socket.emit('tunnelUrl', { url }))
        .catch((error) => {
          console.error('tunnel startup error', error);
          emitError(socket, { code: 'tunnelStartup' });
        });
      break;
    }
    case 'startGame': {
      const room = rooms.get(socket.data.roomCode);
      if (!room) throw new ClientError({ code: 'roomNotFound' });
      room.startGame(socket.data.playerId, socket.id);
      recordVisit(clientAddress(socket.handshake), { event: 'startGame' });
      break;
    }
    case 'rematch': {
      const room = rooms.get(socket.data.roomCode);
      if (!room) throw new ClientError({ code: 'roomNotFound' });
      room.rematch(socket.data.playerId, socket.id);
      break;
    }
    case 'addComputer': {
      const room = rooms.get(socket.data.roomCode);
      if (!room) throw new ClientError({ code: 'roomNotFound' });
      room.addComputer(socket.data.playerId, socket.id);
      break;
    }
    case 'removeComputer': {
      const room = rooms.get(socket.data.roomCode);
      if (!room) throw new ClientError({ code: 'roomNotFound' });
      room.removeComputer(socket.data.playerId, socket.id, raw.playerId);
      break;
    }
    case 'setComputerStrength': {
      const room = rooms.get(socket.data.roomCode);
      if (!room) throw new ClientError({ code: 'roomNotFound' });
      room.setComputerStrength(socket.data.playerId, socket.id, raw.playerId, raw.strength);
      break;
    }
    case 'leaveRoom': {
      // 房间已被超时回收（或服务器重启）时，离开视为已完成，让客户端能清掉残留的房间状态。
      const room = rooms.get(socket.data.roomCode);
      if (room) {
        room.leavePlayer(socket.data.playerId, socket.id);
        socket.leave(room.code);
      }
      socket.data.roomCode = undefined;
      socket.data.playerId = undefined;
      socket.emit('left', { reason: 'left' });
      break;
    }
    case 'focusShowdownCard': {
      const room = rooms.get(socket.data.roomCode);
      if (!room) throw new ClientError({ code: 'roomNotFound' });
      const focus = room.focusShowdownCard(socket.data.playerId, socket.id, raw.slot);
      if (focus) socket.to(room.code).emit('showdownFocus', focus);
      break;
    }
    case 'react': {
      const room = rooms.get(socket.data.roomCode);
      if (!room) throw new ClientError({ code: 'roomNotFound' });
      room.react(socket.data.playerId, socket.id, raw.reaction);
      break;
    }
    default: {
      const room = rooms.get(socket.data.roomCode);
      if (!room) throw new ClientError({ code: 'roomNotFound' });
      room.dispatch(socket.data.playerId, socket.id, raw);
    }
  }
}

httpServer.listen(PORT, () => {
  console.log(`Coup server listening on http://localhost:${PORT}`);
  console.log('暴露到公网: cloudflared tunnel --url http://localhost:' + PORT);
});
// 超过 90 天的访问文件：启动时删一次，之后每天检查一次
const prune = () => pruneVisits().catch((error) => console.error('visit prune error', error));
prune();
setInterval(prune, 86_400_000).unref();

consoleServer.listen(CONSOLE_PORT, CONSOLE_HOST, () => {
  console.log(`Console listening on http://${CONSOLE_HOST}:${CONSOLE_PORT}/`);
});

// 服务器退出时终止 cloudflared 子进程
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopTunnel();
    process.exit(0);
  });
}
// 兜底：普通退出 / 未捕获异常退出时也清理子进程（SIGKILL、段错误等无法拦截）。
process.on('exit', () => stopTunnel());
