// packages/server/src/tunnel.ts
import { spawn, type ChildProcess } from 'node:child_process';

// Cloudflare quick tunnel 的临时域名形如 https://xxxx-xxxx.trycloudflare.com
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// 启动超时：cloudflared 挂起（连不上 Cloudflare）时不再无限等待。
const START_TIMEOUT_MS = 20_000;

// 从 cloudflared 输出中解析临时域名，解析不到返回 null。
export function parseTunnelUrl(output: string): string | null {
  const m = output.match(URL_RE);
  return m ? m[0] : null;
}

// 模块级单例：一条 quick tunnel 服务整个服务器，所有房间共用同一域名。
let currentUrl: string | null = null;
let child: ChildProcess | null = null;

export function getTunnelUrl(): string | null {
  return currentUrl;
}

// 启动（或复用）quick tunnel，resolve 临时域名。约 20 秒超时则终止子进程并 reject。
export function startTunnel(port: number): Promise<string> {
  if (currentUrl) return Promise.resolve(currentUrl);
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`]);
    child = proc;
    let buf = '';
    let settled = false;

    const settleUrl = (chunk: string) => {
      if (settled) return;
      buf += chunk;
      const url = parseTunnelUrl(buf);
      if (url) {
        settled = true;
        clearTimeout(timer);
        currentUrl = url;
        resolve(url);
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      child = null;
      reject(new Error('隧道启动超时，请检查网络或手动运行 cloudflared'));
    }, START_TIMEOUT_MS);

    proc.stdout?.on('data', settleUrl);
    proc.stderr?.on('data', settleUrl);
    proc.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child = null;
      reject(new Error(`未检测到 cloudflared，请先安装或手动运行 cloudflared tunnel --url http://localhost:${port}`));
    });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child = null;
      reject(new Error(`隧道进程退出（code ${code}），请检查网络或手动运行 cloudflared`));
    });
  });
}

// 服务器退出时终止子进程（随进程生命周期结束）。
export function stopTunnel(): void {
  if (child) {
    child.kill();
    child = null;
    currentUrl = null;
  }
}
