import { io, type Socket } from 'socket.io-client';
import type { ClientIntent, ServerMessage } from '@coup/shared';

export type { ClientIntent, ServerMessage };

export function connect(): Socket {
  return io({ autoConnect: true });
}

export function send(socket: Socket, intent: ClientIntent): void {
  socket.emit('intent', intent);
}

export function onMessage(socket: Socket, handler: (msg: ServerMessage) => void): void {
  // ServerMessage 是联合类型，按 type 分发的消息各自携带不同事件名
  (['joined', 'lobby', 'gameStarted', 'publicState', 'privateState', 'events', 'error', 'left'] as const).forEach(
    (event) => {
      socket.on(event, (payload: Record<string, unknown>) => {
        handler({ type: event, ...payload } as ServerMessage);
      });
    },
  );
}

const STORAGE_KEY = 'coup_identity';

export interface Identity {
  playerId: string;
  name: string;
}

export function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Identity) : null;
  } catch {
    return null;
  }
}

export function saveIdentity(id: Identity): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(id));
}
