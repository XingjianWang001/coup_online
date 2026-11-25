import type { GameEvent } from '@coup/shared';
import type { Room, RoomPlayer } from './room.ts';
import { getTunnelUrl } from './tunnel.ts';

// 推送用到的 socket.io Server 的那一小块：to(房间码或连接 id).emit(...)。message-flows.test.ts 用录制器替换它
export interface Pusher {
  to(target: string): { emit(event: string, payload: object): unknown };
}

function broadcast(io: Pusher, room: Room): void {
  const pub = room.getPublicState();
  if (pub) {
    io.to(room.code).emit('publicState', {
      state: pub,
      remainingMs: room.getDeadlineMs(),
      deadlineAt: room.getDeadlineAt(),
      hostId: room.hostId,
    });
    for (const p of room.players.values()) {
      const priv = room.getPrivateState(p.id);
      if (priv && room.isCurrentConnection(p.id, p.socketId)) io.to(p.socketId).emit('privateState', { hand: priv.hand });
    }
  }
}

function broadcastLobby(io: Pusher, room: Room): void {
  io.to(room.code).emit('lobby', { players: room.playerList, hostId: room.hostId });
}

// 房间状态变化后的唯一推送：先推事件（开局单独推 gameStarted），再按阶段推大厅或牌局状态。
export function publish(io: Pusher, room: Room, events: GameEvent[]): void {
  const started = events.find((e) => e.type === 'started');
  if (started) io.to(room.code).emit('gameStarted', { turnOrder: started.turnOrder, gameNumber: room.gameNumber });
  else if (events.length) io.to(room.code).emit('events', { events });
  if (room.game) broadcast(io, room);
  else broadcastLobby(io, room);
}

// 连接已入房（socket.join）后：先给这条连接 joined，再把房间当前状态推一遍
export function pushJoined(io: Pusher, room: Room, player: RoomPlayer, canStartTunnel: boolean): void {
  io.to(player.socketId).emit('joined', {
    roomCode: room.code,
    playerId: player.id,
    secret: player.secret,
    players: room.playerList,
    hostId: room.hostId,
    tunnelUrl: getTunnelUrl() ?? undefined,
    canStartTunnel,
    gameNumber: room.gameNumber,
  });
  publish(io, room, []);
}
