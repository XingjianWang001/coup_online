import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 起真的服务器进程：要验证的正是「一个坏请求不会让进程退出」
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
let server: ChildProcess;
let port: number;
let consolePort: number;
const dataDir = mkdtempSync(join(tmpdir(), 'coup-http-'));

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

// fetch 会先规范化 URL，坏的请求目标只能按原样写进 socket
const rawGet = (target: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.end(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    let response = '';
    socket.on('data', (chunk) => (response += chunk));
    socket.on('end', () => resolve(response.split('\r\n')[0]));
    socket.on('error', reject);
  });

beforeAll(async () => {
  port = await freePort();
  consolePort = await freePort();
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(port), CONSOLE_PORT: String(consolePort), DATA_DIR: dataDir } });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    server.stdout!.on('data', (chunk) => {
      out += chunk;
      if (out.includes('Coup server listening') && out.includes('Console listening')) resolve();
    });
    server.on('exit', (code) => reject(new Error(`server exited (${code}) before listening`)));
  });
}, 20_000);

afterAll(() => {
  server?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('http server', () => {
  it('answers a malformed request target with 400 and keeps serving', async () => {
    expect(await rawGet('/\\[')).toBe('HTTP/1.1 400 Bad Request');
    expect(await rawGet('/healthz')).toBe('HTTP/1.1 200 OK');
    expect(server.exitCode).toBeNull();
  });

  it('serves the console state only on the console port', async () => {
    const state = await fetch(`http://127.0.0.1:${consolePort}/api/state`);
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ rooms: [] });
    expect((await fetch(`http://127.0.0.1:${port}/api/state`)).status).toBe(404);
  });

  it('serves the console page and stats only on the console port', async () => {
    const page = await fetch(`http://127.0.0.1:${consolePort}/`);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('/api/stats');
    const stats = await fetch(`http://127.0.0.1:${consolePort}/api/stats?games=all`);
    expect(((await stats.json()) as { since: unknown }).since).toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/api/stats`)).status).toBe(404);
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).not.toContain('/api/stats');
  });
});
