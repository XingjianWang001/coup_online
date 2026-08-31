# 政变 Coup Online

线上版政变桌游。后端权威运行游戏规则，前端为纯客户端，通过 Cloudflare Tunnel 暴露临时网址供不同网络的玩家加入。

## 架构

pnpm monorepo，四个包：

| 包 | 职责 |
|---|---|
| `packages/engine` | 纯函数游戏引擎（规则、状态机、卡牌），零 I/O，Vitest 全覆盖 |
| `packages/shared` | 前后端共享的协议与类型定义 |
| `packages/server` | Node.js + Socket.IO：房间、计时器、意图裁决、静态文件服务 |
| `packages/client` | Vite + React 前端 |

详细设计见 [`CONTEXT.md`](CONTEXT.md) 与 [`docs/adr/`](docs/adr/)。

## 快速开始

```bash
pnpm install

# 构建前端（server 会服务 dist）
pnpm build:client

# 启动后端（默认 8787 端口）
pnpm dev:server
```

打开 `http://localhost:8787` 即可游玩（server 同时服务前端静态文件与 Socket.IO）。

## 暴露到公网（无需注册、免费、临时网址）

```bash
cloudflared tunnel --url http://localhost:8787
```

会输出一个 `https://xxx.trycloudflare.com` 临时域名，发给朋友即可加入。

## 开发

```bash
# 前端热更新（5173，代理 /socket.io 到 8787）
pnpm dev:client
# 后端热更新
pnpm dev:server
```

## 测试

```bash
pnpm test            # 引擎单元测试
pnpm typecheck       # 全包类型检查
pnpm smoke           # 端到端冒烟测试（需先启动 server）
```
