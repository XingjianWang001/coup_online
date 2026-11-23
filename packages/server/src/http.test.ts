import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 起真的服务器进程：要验证的正是「一个坏请求不会让进程退出」
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
let server: ChildProcess;
let port: number;

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
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(port) } });
  await new Promise<void>((resolve, reject) => {
    server.stdout!.on('data', (chunk) => String(chunk).includes('listening') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited (${code}) before listening`)));
  });
}, 20_000);

afterAll(() => {
  server?.kill();
});

describe('http server', () => {
  it('answers a malformed request target with 400 and keeps serving', async () => {
    expect(await rawGet('/\\[')).toBe('HTTP/1.1 400 Bad Request');
    expect(await rawGet('/healthz')).toBe('HTTP/1.1 200 OK');
    expect(server.exitCode).toBeNull();
  });
});
