import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { clearIdentity, clearRoomCode, loadIdentity, loadRoomCode, saveIdentity, saveRoomCode, send } from './socket.ts';

describe('本机保存的身份与房间码', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('浏览器禁用存储时读不到按没有处理、写入和清除不抛错', () => {
    const denied = () => { throw new Error('SecurityError'); };
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied });
    expect(loadIdentity()).toBeNull();
    expect(loadRoomCode()).toBeNull();
    expect(() => {
      saveIdentity({ playerId: 'a', name: '张三', secret: 's' });
      saveRoomCode('ABC123');
      clearIdentity();
      clearRoomCode();
    }).not.toThrow();
  });
});

describe('send', () => {
  const fakeSocket = (connected: boolean) => ({ connected, emit: vi.fn() }) as unknown as Socket & { emit: ReturnType<typeof vi.fn> };

  it('断线时丢弃牌局意图，免得重连后先于重新加入补发到不在房间的连接', () => {
    const socket = fakeSocket(false);
    send(socket, { type: 'chooseAction', action: 'income' });
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('创建、加入或离开房间在断线时照常发出，等连上后补发', () => {
    const socket = fakeSocket(false);
    send(socket, { type: 'createRoom', name: '张三' });
    send(socket, { type: 'joinRoom', roomCode: 'ABC123', name: '张三' });
    send(socket, { type: 'leaveRoom' }); // 服务器对不在房间的连接也回 left，客户端退回入口
    expect(socket.emit).toHaveBeenCalledTimes(3);
  });

  it('在线时直接发出', () => {
    const socket = fakeSocket(true);
    send(socket, { type: 'passChallenge' });
    expect(socket.emit).toHaveBeenCalledWith('intent', { type: 'passChallenge' });
  });
});
