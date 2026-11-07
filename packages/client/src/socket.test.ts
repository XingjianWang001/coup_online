import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { send } from './socket.ts';

describe('send', () => {
  const fakeSocket = (connected: boolean) => ({ connected, emit: vi.fn() }) as unknown as Socket & { emit: ReturnType<typeof vi.fn> };

  it('断线时丢弃牌局意图和离开房间，免得重连后先于重新加入补发到不在房间的连接', () => {
    const socket = fakeSocket(false);
    send(socket, { type: 'chooseAction', action: 'income' });
    send(socket, { type: 'leaveRoom' });
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('创建或加入房间在断线时照常发出，等连上后补发', () => {
    const socket = fakeSocket(false);
    send(socket, { type: 'createRoom', name: '张三' });
    send(socket, { type: 'joinRoom', roomCode: 'ABC123', name: '张三' });
    expect(socket.emit).toHaveBeenCalledTimes(2);
  });

  it('在线时直接发出', () => {
    const socket = fakeSocket(true);
    send(socket, { type: 'passChallenge' });
    expect(socket.emit).toHaveBeenCalledWith('intent', { type: 'passChallenge' });
  });
});
