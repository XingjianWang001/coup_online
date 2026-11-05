// packages/server/src/tunnel.test.ts
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const { spawn } = await import('node:child_process');
const { canStartTunnel, getTunnelUrl, parseTunnelUrl, startTunnel, stopTunnel } = await import('./tunnel.ts');

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
});

describe('canStartTunnel', () => {
  it.each([
    ['本机直连', '127.0.0.1', {}, true],
    ['本机 IPv6', '::1', {}, true],
    ['经 cloudflared 进来的访客', '127.0.0.1', { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' }, false],
    ['经反向代理进来的访客', '::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }, false],
    ['局域网访客', '192.168.1.20', {}, false],
  ])('%s', (_name, address, headers, expected) => {
    expect(canStartTunnel({ address, headers })).toBe(expected);
  });
});
