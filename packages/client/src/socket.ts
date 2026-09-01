import { io, type Socket } from 'socket.io-client';
import type { ClientIntent, ServerMessage } from '@coup/shared';

export type { ClientIntent, ServerMessage };

export function connect(): Socket {
  return io({ autoConnect: true });
}

export function send(socket: Socket, intent: ClientIntent): void {
  socket.emit('intent', intent);
}

// 注册消息监听，返回清理函数（移除全部监听）
export function onMessage(socket: Socket, handler: (msg: ServerMessage) => void): () => void {
  const events = ['joined', 'lobby', 'gameStarted', 'publicState', 'privateState', 'events', 'error', 'left'] as const;
  const listeners = events.map((event) => {
    const listener = (payload: Record<string, unknown>) => handler({ type: event, ...payload } as ServerMessage);
    socket.on(event, listener);
    return [event, listener] as const;
  });
  return () => {
    for (const [event, listener] of listeners) socket.off(event, listener);
  };
}

const STORAGE_KEY = 'coup_identity';
const ROOM_KEY = 'coup_room';

export interface Identity {
  playerId: string;
  name: string;
  secret: string;
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

export function loadRoomCode(): string | null {
  return localStorage.getItem(ROOM_KEY);
}

export function saveRoomCode(code: string): void {
  localStorage.setItem(ROOM_KEY, code);
}

export function clearRoomCode(): void {
  localStorage.removeItem(ROOM_KEY);
}

export function clearIdentity(): void {
  localStorage.removeItem(STORAGE_KEY);
}

