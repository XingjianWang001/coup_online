import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, type Socket } from 'socket.io';
import { InMemoryGameRepository } from './repository.ts';
import { Room } from './room.ts';
import type { ClientIntent } from '@coup/shared';

const PORT = Number(process.env.PORT ?? 8787);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
// 前端构建产物路径（相对 packages/server）
const CLIENT_DIST = join(__dirname, '../../client/dist');

const repo = new InMemoryGameRepository();
const rooms = new Map<string, Room>();

function genCode(): string {
  let code: string;
  do {
    code = randomBytes(3).toString('hex').toUpperCase(); // 6 位房间码
  } while (rooms.has(code));
  return code;
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  path = normalize(path);

  const filePath = join(CLIENT_DIST, path);
  if (!filePath.startsWith(CLIENT_DIST) || !existsSync(filePath) || !statSync(filePath).isFile()) {
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
    io.to(room.code).emit('publicState', { state: pub });
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
  socket.on('intent', (raw: ClientIntent) => {
    try {
      handleIntent(socket, raw);
    } catch (e) {
      socket.emit('error', { message: e instanceof Error ? e.message : 'unknown error' });
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
  switch (raw.type) {
    case 'createRoom': {
      const code = genCode();
      const room = new Room(code, '', repo, {
        onBroadcast: broadcast,
        onEmpty: (r) => rooms.delete(r.code),
      });
      const p = room.addPlayer(raw.name, socket.id);
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
      });
      broadcastLobby(room);
      break;
    }
    case 'joinRoom': {
      const room = rooms.get(raw.roomCode.toUpperCase());
      if (!room) throw new Error('房间不存在');
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
      });
      if (room.game) broadcast(room);
      else broadcastLobby(room);
      break;
    }
    case 'startGame': {
      const room = rooms.get(socket.data.roomCode);
      if (!room) throw new Error('房间不存在');
      if (socket.data.playerId !== room.hostId) throw new Error('只有房主能开始游戏');
      const events = room.startGame();
      io.to(room.code).emit('gameStarted', { turnOrder: events[0].type === 'started' ? (events[0] as { turnOrder: string[] }).turnOrder : [] });
      broadcast(room);
      break;
    }
    case 'leaveRoom': {
      const room = rooms.get(socket.data.roomCode);
      if (room) {
        room.removePlayer(socket.data.playerId);
        socket.leave(room.code);
        if (room.game) broadcast(room);
        else broadcastLobby(room);
      }
      socket.emit('left', { reason: 'left' });
      break;
    }
    default: {
      const room = rooms.get(socket.data.roomCode);
      if (!room) throw new Error('房间不存在');
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
