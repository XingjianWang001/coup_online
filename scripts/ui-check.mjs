// 浏览器实跑验证：构建前端 → 空闲端口起一个服务端（不带 watch）→ headless Chrome 扮演真人玩家 → 跑场景 → 无论成败都整组结束子进程。
// 不占用 8787 / 5173，不按进程名杀进程，所以不会挡住手动开发服务器。
//
// 用法：node scripts/ui-check.mjs [场景.mjs] [截图目录]
//   场景默认导出 async (ui) => {}，ui 见 main() 里的 context；不传场景时跑内置场景（真人玩家加入机器人房间并开局）。
//   环境变量：W/H 视口，MOBILE=1 手机触屏，REDUCED=1 减少动态效果，LOCALE=zh-CN|en，NO_BUILD=1 跳过构建，CHROME 浏览器路径。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const { io } = createRequire(join(ROOT, 'packages/client/package.json'))('socket.io-client');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TOTAL_TIMEOUT_MS = 100_000; // 低于代理工具 120s 的命令上限，超时也能走到清理
const STEP_TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, what) =>
  Promise.race([promise, sleep(ms).then(() => { throw new Error(`超时：${what}`); })]);

const children = [];
const sockets = [];
let profileDir = null;

// 子进程以独立进程组启动，结束时整组 kill，连同 tsx/Chrome 派生的孙进程
function launch(cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return child;
}

async function cleanup() {
  for (const s of sockets) s.close();
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  }
  await sleep(500);
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
}

const freePort = () => new Promise((r) => {
  const srv = createServer().listen(0, () => { const { port } = srv.address(); srv.close(() => r(port)); });
});

async function startServer() {
  if (!process.env.NO_BUILD) {
    const build = spawnSync('pnpm', ['build:client'], { cwd: ROOT, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('前端构建失败');
  }
  const port = await freePort();
  const server = launch(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(ROOT, 'packages/server'),
    env: { ...process.env, PORT: String(port) },
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const url = `http://localhost:${port}`;
  await withTimeout((async () => { for (;;) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(200); } })(), 20_000, `服务端启动\n${log}`);
  return url;
}

async function startChrome() {
  profileDir = mkdtempSync(join(tmpdir(), 'coup-ui-check-'));
  launch(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--no-first-run', 'about:blank'], {});
  // 端口 0 让 Chrome 自选端口，写在配置目录的 DevToolsActivePort 里
  const port = await withTimeout((async () => {
    for (;;) { try { return readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {} await sleep(100); }
  })(), STEP_TIMEOUT_MS, 'Chrome 启动');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await withTimeout(new Promise((r) => ws.addEventListener('open', r)), STEP_TIMEOUT_MS, 'CDP 连接');
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  return (method, params = {}) => withTimeout(new Promise((r, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : r(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  }), STEP_TIMEOUT_MS, method);
}

// 内置场景：机器人建房，真人玩家凭加入链接进房，机器人开局，截下开局画面
async function defaultScenario(ui) {
  const host = ui.bot();
  host.intent({ type: 'createRoom', name: 'Bot' });
  const { roomCode } = await host.next('joined');
  await ui.joinAs('Me', roomCode);
  await host.next('lobby');
  host.intent({ type: 'startGame' });
  await ui.waitFor('.showcase');
  await ui.frames('deal', [0, 300, 700, 1400]);
}

async function main() {
  const [scenarioPath, outArg] = process.argv.slice(2);
  const out = resolve(outArg ?? join(tmpdir(), 'coup-ui-check-shots'));
  mkdirSync(out, { recursive: true });
  const scenario = scenarioPath ? (await import(pathToFileURL(resolve(scenarioPath)))).default : defaultScenario;

  const url = await startServer();
  const cdp = await startChrome();
  const [W, H] = [Number(process.env.W ?? 1280), Number(process.env.H ?? 800)];
  const mobile = !!process.env.MOBILE;
  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, mobile });
  if (mobile) await cdp('Emulation.setTouchEmulationEnabled', { enabled: true });
  if (process.env.REDUCED) await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  // headless Chrome 不认 --lang：语言只能经界面自己的持久化键注入
  if (process.env.LOCALE) await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('coup.locale', ${JSON.stringify(process.env.LOCALE)})` });

  // CDP 的 Runtime.evaluate 不支持顶层 await：表达式统一包进 async 函数
  const evaluate = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`页面脚本出错：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };

  const ui = {
    url,
    out,
    cdp,
    evaluate,
    goto: (path = '/') => cdp('Page.navigate', { url: new URL(path, url).href }),
    // 等元素出现：比固定 sleep 稳，页面加载慢时不会偶发失败
    waitFor: (selector, ms = STEP_TIMEOUT_MS) => withTimeout((async () => {
      while (!(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`))) await sleep(100);
    })(), ms, `等待 ${selector}`),
    click: (textPattern, scope = 'body') => evaluate(`(() => {
      const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => new RegExp(${JSON.stringify(textPattern)}).test(b.textContent.trim()));
      if (!b) throw new Error('找不到按钮 ' + ${JSON.stringify(textPattern)});
      b.click();
    })()`),
    // 走 React 认得的原生 setter，受控输入框才会更新
    type: (selector, value) => evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`),
    key: async (key) => {
      for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key, code: key });
    },
    shot: async (name) => {
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
      const file = join(out, `${name}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log('📸', file);
      return file;
    },
    // 截图本身要几百毫秒，实时截不到动画中间帧：先暂停全部动画并定位到各时间点再截
    frames: async (prefix, times) => {
      for (const t of times) {
        await evaluate(`document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${t}; })`);
        await sleep(50);
        await ui.shot(`${prefix}-${t}`);
      }
      await evaluate(`document.getAnimations().forEach((a) => a.finish())`);
    },
    // 真人玩家凭加入链接进房
    joinAs: async (name, roomCode) => {
      await ui.goto(`/?room=${roomCode}`);
      await ui.waitFor('input');
      await ui.type('input', name);
      await ui.click('Join|加入');
    },
    // socket.io 机器人：intent 发意图，next 等下一条某类消息，state 存最新公开状态与手牌
    bot: () => {
      const socket = io(url, { forceNew: true });
      sockets.push(socket);
      const state = { pub: null, hand: [], playerId: null };
      socket.on('joined', (m) => (state.playerId = m.playerId));
      socket.on('publicState', (m) => (state.pub = m.state));
      socket.on('privateState', (m) => (state.hand = m.hand));
      return {
        socket,
        state,
        intent: (intent) => socket.emit('intent', intent),
        next: (event, ms = STEP_TIMEOUT_MS) => withTimeout(new Promise((r) => socket.once(event, r)), ms, `机器人等待 ${event}`),
      };
    },
  };

  await scenario(ui);
}

let failed = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await cleanup(); process.exit(130); });
try {
  await withTimeout(main(), TOTAL_TIMEOUT_MS, '整个验证');
  console.log('✅ ui-check 完成');
} catch (error) {
  failed = true;
  console.error('❌', error.message);
} finally {
  await cleanup();
}
process.exit(failed ? 1 : 0);
