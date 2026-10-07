import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, type Socket } from 'socket.io';
import { InMemoryGameRepository } from './repository.ts';
import { Room } from './room.ts';
import { getTunnelUrl, startTunnel, stopTunnel } from './tunnel.ts';
import { forfeit } from '@coup/engine';
import type { ClientIntent } from '@coup/shared';
import { ClientError, toServerError } from './errors.ts';
import { reserveRoomCreation } from './room-limits.ts';

const PORT = Number(process.env.PORT ?? 8787);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
// 前端构建产物路径（相对 packages/server）
const CLIENT_DIST = join(__dirname, '../../client/dist');

const repo = new InMemoryGameRepository();
const rooms = new Map<string, Room>();

function clientAddress(socket: Socket): string {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  }
  return socket.handshake.address;
}

function genCode(): string {
  let code: string;
  do {
    code = randomBytes(3).toString('hex').toUpperCase(); // 6 位房间码
  } while (rooms.has(code));
  return code;
}

// 仅允许回环来源启动隧道：防止公网（经隧道）可达的客户端在主机上 spawn cloudflared。
function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
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
    '.json': 'application/json',
  };
  res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(filePath));
});

const io = new Server(httpServer);

function broadcast(room: Room): void {
  const pub = room.getPublicState();
  if (pub) {
    io.to(room.code).emit('publicState', {
      state: pub,
      remainingMs: room.getDeadlineMs(),
      deadlineAt: room.getDeadlineAt(),
    });
    for (const p of room.players.values()) {
      const priv = room.getPrivateState(p.id);
      if (priv) io.to(p.socketId).emit('privateState', { hand: priv.hand });
    }
  }
}

function broadcastLobby(room: Room): void {
  io.to(room.code).emit('lobby', { players: room.playerList, hostId: room.hostId });
}

io.on('connection', (socket) => {
  socket.on('timeSync', (ack: (serverNow: number) => void) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('intent', (raw: ClientIntent) => {
    try {
      handleIntent(socket, raw);
    } catch (e) {
      socket.emit('error', toServerError(e));
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode as string | undefined;
    const playerId = socket.data.playerId as string | undefined;
    if (roomCode && playerId) {
      const room = rooms.get(roomCode);
      if (room) {
        room.markDisconnected(playerId);
        if (room.game) broadcast(room);
        else broadcastLobby(room);
      }
    }
  });
});

function handleIntent(socket: Socket, raw: ClientIntent): void {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') {
    throw new ClientError({ code: 'illegalIntent' });
  }
  switch (raw.type) {
    case 'createRoom': {
      if (socket.data.roomCode) throw new ClientError({ code: 'illegalIntent' });
      const code = genCode();
      const room = new Room(code, '', repo, {
        onBroadcast: (room, events) => {
          io.to(room.code).emit('events', { events });
          broadcast(room);
        },
        onEmpty: (r) => rooms.delete(r.code),
      });
      const p = room.addPlayer(raw.name, socket.id);
      reserveRoomCreation(clientAddress(socket), rooms.size);
      room.hostId = p.id;
      rooms.set(code, room);
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerId = p.id;
      socket.emit('joined', {
        roomCode: code,
        playerId: p.id,
        secret: p.secret,
        players: room.playerList,
        hostId: room.hostId,
        tunnelUrl: getTunnelUrl() ?? undefined,
        canStartTunnel: isLoopback(socket.handshake.address),
      });
      broadcastLobby(room);
      break;
    }
    case 'joinRoom': {
      if (socket.data.roomCode) throw new ClientError({ code: 'illegalIntent' });
      if (typeof raw.roomCode !== 'string' || !/^[0-9a-f]{6}$/i.test(raw.roomCode)) {
        throw new ClientError({ code: 'roomNotFound' });
      }
      const room = rooms.get(raw.roomCode.toUpperCase());
      if (!room) throw new ClientError({ code: 'roomNotFound' });
      const reconnect = raw.playerId && raw.secret ? { id: raw.playerId, secret: raw.secret } : undefined;
      const p = room.addPlayer(raw.name, socket.id, reconnect);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.playerId = p.id;
      socket.emit('joined', {
        roomCode: room.code,
        playerId: p.id,
        secret: p.secret,
        players: room.playerList,
        hostId: room.hostId,
        tunnelUrl: getTunnelUrl() ?? undefined,
        canStartTunnel: isLoopback(socket.handshake.address),
      });
      if (room.game) broadcast(room);
      else broadcastLobby(room);
      break;
    }
    case 'startTunnel': {
      if (!isLoopback(socket.handshake.address)) throw new ClientError({ code: 'tunnelUnauthorized' });
      startTunnel(PORT)
        .then((url) => socket.emit('tunnelUrl', { url }))
        .catch((error) => {
          console.error('tunnel startup error', error);
          socket.emit('error', { code: 'tunnelStartup' });
        });
      break;
    }
    case 'startGame': {
      const room = rooms.get(socket.data.roomCode);
      if (!room) throw new ClientError({ code: 'roomNotFound' });
      if (socket.data.playerId !== room.hostId) throw new ClientError({ code: 'hostOnly' });
      const events = room.startGame();
      io.to(room.code).emit('gameStarted', { turnOrder: events[0].type === 'started' ? (events[0] as { turnOrder: string[] }).turnOrder : [] });
      broadcast(room);
      break;
    }
    case 'leaveRoom': {
      const room = rooms.get(socket.data.roomCode);
      if (room) {
        if (room.game) {
          // 对局中主动离开 = 立即弃权：翻开暗牌、淘汰、推进回合，避免幽灵玩家卡死
          const events = room.apply((g) => forfeit(g, socket.data.playerId));
          io.to(room.code).emit('events', { events });
          room.removePlayer(socket.data.playerId);
          broadcast(room);
        } else {
          room.removePlayer(socket.data.playerId);
          broadcastLobby(room);
        }
        socket.leave(room.code);
      }
      socket.data.roomCode = undefined;
      socket.data.playerId = undefined;
      socket.emit('left', { reason: 'left' });
      break;
    }
    default: {
      const room = rooms.get(socket.data.roomCode);
      if (!room) throw new ClientError({ code: 'roomNotFound' });
      const events = room.dispatch(socket.data.playerId, raw);
      io.to(room.code).emit('events', { events });
      broadcast(room);
    }
  }
}

httpServer.listen(PORT, () => {
  console.log(`Coup server listening on http://localhost:${PORT}`);
  console.log('暴露到公网: cloudflared tunnel --url http://localhost:' + PORT);
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
