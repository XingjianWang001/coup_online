// packages/server/src/tunnel.test.ts
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { spawn } from 'node:child_process';
import { canStartTunnel, getTunnelUrl, parseTunnelUrl, startTunnel, stopTunnel } from './tunnel.ts';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

describe('parseTunnelUrl', () => {
  it('从 cloudflared 输出中解析 trycloudflare 域名', () => {
    const output = `
Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):
https://random-words-1234.trycloudflare.com
`;
    expect(parseTunnelUrl(output)).toBe('https://random-words-1234.trycloudflare.com');
  });

  it('输出中无域名时返回 null', () => {
    expect(parseTunnelUrl('tunnel failed to start')).toBeNull();
  });
});

function fakeCloudflared() {
  const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValueOnce(proc as never);
  return proc;
}

describe('startTunnel', () => {
  afterEach(() => {
    stopTunnel();
    vi.mocked(spawn).mockReset();
  });

  it('启动中的重复请求共用同一个 cloudflared 进程', async () => {
    const proc = fakeCloudflared();
    const first = startTunnel(8787);
    const second = startTunnel(8787);
    proc.stderr.emit('data', 'https://a-b.trycloudflare.com');

    expect(await first).toBe('https://a-b.trycloudflare.com');
    expect(await second).toBe('https://a-b.trycloudflare.com');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('隧道进程退出后不再复用失效的域名，下次重新启动', async () => {
    const proc = fakeCloudflared();
    const started = startTunnel(8787);
    proc.stderr.emit('data', 'https://dead-1.trycloudflare.com');
    await started;

    proc.emit('exit', 1);

    expect(getTunnelUrl()).toBeNull();
    const next = fakeCloudflared();
    const restarted = startTunnel(8787);
    next.stderr.emit('data', 'https://alive-2.trycloudflare.com');
    expect(await restarted).toBe('https://alive-2.trycloudflare.com');
  });

  it('已给出域名的隧道退出时通知持有链接的页面；启动失败不通知', async () => {
    const onClosed = vi.fn();
    const failed = fakeCloudflared();
    const failing = startTunnel(8787, onClosed).catch(() => null);
    failed.emit('exit', 1);
    await failing;
    expect(onClosed).not.toHaveBeenCalled();

    const proc = fakeCloudflared();
    const started = startTunnel(8787, onClosed);
    proc.stderr.emit('data', 'https://dead-4.trycloudflare.com');
    await started;
    proc.emit('exit', 1);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('stopTunnel 之后进程再输出的域名不会被缓存', async () => {
    const proc = fakeCloudflared();
    const started = startTunnel(8787).catch(() => null);
    stopTunnel();
    proc.stderr.emit('data', 'https://dead-3.trycloudflare.com');
    proc.emit('exit', null);

    expect(await started).toBeNull();
    expect(getTunnelUrl()).toBeNull();
  });
});

// 信任靠网络位置推断，每种入口都要列在这里：只给某一种补一个特例的修法已经漏过两次（#41、#43）
describe('canStartTunnel', () => {
  it.each([
    ['本机直连（非浏览器，无 Origin）', '127.0.0.1', {}, true],
    ['Vite 开发代理', '::1', { origin: 'http://localhost:5173' }, true],
    ['生产同源 localhost', '127.0.0.1', { origin: 'http://localhost:8787' }, true],
    ['生产同源 127.0.0.1', '127.0.0.1', { origin: 'http://127.0.0.1:8787' }, true],
    ['本机 IPv6', '::1', { origin: 'http://[::1]:8787' }, true],
    ['ssh -L 转发到本机', '127.0.0.1', { origin: 'http://localhost:9000' }, true],
    ['经 cloudflared 进来的访客', '127.0.0.1', { origin: 'https://a-b.trycloudflare.com', 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' }, false],
    ['经反向代理（Caddy）进来的访客', '::ffff:127.0.0.1', { origin: 'https://coup.example', 'x-forwarded-for': '203.0.113.9' }, false],
    ['本机浏览器里打开的其他网站', '127.0.0.1', { origin: 'https://evil.example' }, false],
    ['本机页面同源 polling 握手（无 Origin）', '127.0.0.1', { host: 'localhost:8787' }, true],
    ['DNS 重绑定：别的域名同源 polling 握手（无 Origin）', '127.0.0.1', { host: 'evil.test:8787' }, false],
    ['局域网访客', '192.168.1.20', { origin: 'http://192.168.1.10:8787' }, false],
  ])('%s', (_name, address, headers, expected) => {
    expect(canStartTunnel({ address, headers })).toBe(expected);
  });
});
