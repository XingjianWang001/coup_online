import { io, type Socket } from 'socket.io-client';
import type { ClientIntent, ServerMessage } from '@coup/shared';

export type { ClientIntent, ServerMessage };

export function connect(): Socket {
  return io({ autoConnect: true });
}

export function send(socket: Socket, intent: ClientIntent): void {
  // 断线时 socket.io 会缓存 emit，重连后先于自动重新加入补发：服务器把它当成不在房间的连接（roomNotFound 清掉会话）。只有进房意图可以等重连；
  // 离开房间也等重连：服务器对不在房间的连接照样回 left，客户端借此退回入口（房间号已先清掉，不会自动重新加入）
  if (socket.connected || intent.type === 'createRoom' || intent.type === 'joinRoom' || intent.type === 'leaveRoom') socket.emit('intent', intent);
}

// 注册消息监听，返回清理函数（移除全部监听）
export function onMessage(socket: Socket, handler: (msg: ServerMessage) => void): () => void {
  const events = ['joined', 'lobby', 'gameStarted', 'publicState', 'privateState', 'events', 'showdownFocus', 'reaction', 'error', 'tunnelUrl', 'left'] as const;
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

// 浏览器可能禁用存储（隐私设置、内嵌页面），连访问 localStorage 都会抛错：读不到按没有处理，写不进就只是这次不记住，页面照常可用
function storage<T>(use: (store: Storage) => T): T | null {
  try {
    return use(localStorage);
  } catch {
    return null;
  }
}

export function loadIdentity(): Identity | null {
  return storage((store) => {
    const raw = store.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Identity) : null;
  });
}

export function saveIdentity(id: Identity): void {
  storage((store) => store.setItem(STORAGE_KEY, JSON.stringify(id)));
}

export function loadRoomCode(): string | null {
  return storage((store) => store.getItem(ROOM_KEY));
}

export function saveRoomCode(code: string): void {
  storage((store) => store.setItem(ROOM_KEY, code));
}

export function clearRoomCode(): void {
  storage((store) => store.removeItem(ROOM_KEY));
}

export function clearIdentity(): void {
  storage((store) => store.removeItem(STORAGE_KEY));
}

