// packages/server/src/tunnel.ts
import { spawn, type ChildProcess } from 'node:child_process';
import type { IncomingHttpHeaders } from 'node:http';

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
let starting: Promise<string> | null = null;

export function getTunnelUrl(): string | null {
  return currentUrl;
}

// 只允许本机直连启动隧道。经 cloudflared 或反向代理进来的访客在服务器看来也来自本机，靠转发头区分。
// shortcut: 纯 TCP 转发（ssh -R、socat、frp tcp）不加转发头，仍会被当作本机；要支持这类暴露方式时改用登录口令等凭据。
export function canStartTunnel(handshake: { address: string; headers: IncomingHttpHeaders }): boolean {
  const { address, headers } = handshake;
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  // WebSocket 不受 CORS 限制，本机浏览器里任何网页都能连上来：浏览器发起的握手还得来自本机页面
  const localPage = headers.origin === undefined || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(headers.origin);
  // 同源的 polling 握手不带 Origin：DNS 重绑定后别的域名的网页与本服务同源，只能靠 Host 认出它
  const localHost = headers.host === undefined || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(headers.host);
  return loopback && localPage && localHost && !headers['cf-connecting-ip'] && !headers['x-forwarded-for'];
}

// 启动（或复用）quick tunnel，resolve 临时域名。约 20 秒超时则终止子进程并 reject。
// onClosed：已给出的域名随进程退出而失效时调用，页面据此收起失效的加入链接。
export function startTunnel(port: number, onClosed?: () => void): Promise<string> {
  if (currentUrl) return Promise.resolve(currentUrl);
  // 启动中再次请求时共用同一个子进程，不再每次 spawn 一个。
  starting ??= launchTunnel(port, onClosed).finally(() => {
    starting = null;
  });
  return starting;
}

function launchTunnel(port: number, onClosed?: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`]);
    child = proc;
    let buf = '';
    let settled = false;

    const settleUrl = (chunk: string) => {
      if (settled || child !== proc) return; // 已被 stopTunnel 终止的进程不再提供域名
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
      // 已给出域名的隧道退出后域名也失效：清掉它，下次重新启动。
      if (child === proc) {
        child = null;
        if (currentUrl) {
          currentUrl = null;
          onClosed?.();
        }
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
