# Coup Online

[中文](#中文) · [English](#english)

<a id="中文"></a>

## 中文

### 项目简介

Coup Online 是可在浏览器中游玩的线上版政变（Coup）桌游。服务器权威执行规则，客户端只发送玩家意图；房主可通过临时的 Cloudflare Quick Tunnel 加入链接，邀请不同网络的朋友进入同一房间。每位玩家可在自己的浏览器中独立选择简体中文或 English，语言切换不会改变房间或其他玩家的设置。

### 游戏规则概览

每位玩家以两张暗牌（两点影响力）和两枚金币开始，轮流选择收入、外援、政变或声称角色来执行征税、暗杀、偷窃、交换。角色声称可以被质疑，部分行动可以被阻挡；失去全部影响力即被淘汰，最后仍有影响力的玩家获胜。

标准版 Indie Boards & Cards《Coup》基础规则是游戏行为的权威来源。本项目另行标注倒计时、自动行动、重连和弃权等线上对局规则。完整玩法请打开游戏页眉中的「规则」，并在「简要规则」与「详细规则」之间切换；README 不重复整份规则。

### 架构

项目采用 pnpm monorepo：

| 包 | 职责 |
| --- | --- |
| `packages/engine` | 纯函数游戏引擎：规则、状态机与卡牌；零 I/O |
| `packages/shared` | 客户端与服务器共享的协议和类型 |
| `packages/server` | Node.js + Socket.IO：房间、计时器、意图裁决与静态文件服务 |
| `packages/client` | Vite + React 浏览器客户端 |

详细设计见 [`CONTEXT.md`](CONTEXT.md) 与 [`docs/adr/`](docs/adr/)。

### 快速开始

需要 Node.js 20+、pnpm 9，以及可选的 `cloudflared`（仅公网隧道需要）。

```bash
pnpm install
pnpm build:client
pnpm dev:server
```

打开 `http://localhost:8787`。服务器会在同一端口提供前端静态文件与 Socket.IO 连接。

### 公网临时链接

房主创建房间后，可在本机打开的房间中选择「生成加入链接」。服务器会启动 Cloudflare Quick Tunnel，并生成带 `?room=` 房间号的可复制链接。Quick Tunnel 免费、临时且无需 Cloudflare 账号；主机需要已安装 `cloudflared`。

也可手动启动隧道：

```bash
cloudflared tunnel --url http://localhost:8787
```

### 云服务器部署

仓库提供 Docker Compose 配置。默认只在服务器的 `127.0.0.1:8787` 监听，可通过 SSH 端口转发私有验证；取得域名并完成公开发布所需手续后，才启用 Caddy 的 `public` 配置。操作步骤见 [`docs/deployment.md`](docs/deployment.md)。房间和对局只保存在内存中，服务器或容器重启后会消失。

### 开发

```bash
pnpm dev:server  # 后端热更新，默认端口 8787
pnpm dev:client  # 前端热更新，默认端口 5173；代理 /socket.io 到 8787
```

### 测试

```bash
pnpm test          # engine、shared、server、client 全部测试
pnpm typecheck     # 全包 TypeScript 检查
pnpm build:client  # 客户端生产构建
pnpm smoke         # socket 冒烟流程；需先运行 pnpm dev:server
```

<a id="english"></a>

## English

### Project overview

Coup Online is a browser-based version of the Coup card game. The server authoritatively enforces the rules while clients send player intents only. A host can invite friends on other networks with a temporary Cloudflare Quick Tunnel link. Each player independently selects Simplified Chinese or English in their own browser; changing language never changes the room or another player's preference.

### Game rules overview

Each player starts with two Hidden Cards (two Influence) and two coins. On a turn, a player takes Income, Foreign Aid, a Coup, or Claims a Role to Tax, Assassinate, Steal, or Exchange. Role Claims can be Challenged and some Actions can be Blocked. A Player with no Influence is eliminated; the last Player with Influence wins.

The standard Indie Boards & Cards Coup base rules are authoritative for game behavior. This project labels timers, automatic actions, reconnection, and forfeits separately as online-play rules. For complete play guidance, open **Rules** in the game header and switch between **Quick Rules** and **Full Rules**; the README does not duplicate the full rules.

### Architecture

The project is a pnpm monorepo:

| Package | Responsibility |
| --- | --- |
| `packages/engine` | Pure game engine: rules, state machine, and cards; zero I/O |
| `packages/shared` | Protocol and types shared by client and server |
| `packages/server` | Node.js + Socket.IO rooms, timers, intent adjudication, and static-file serving |
| `packages/client` | Vite + React browser client |

See [`CONTEXT.md`](CONTEXT.md) and [`docs/adr/`](docs/adr/) for the detailed design.

### Quick start

You need Node.js 20+, pnpm 9, and optionally `cloudflared` for a public tunnel.

```bash
pnpm install
pnpm build:client
pnpm dev:server
```

Open `http://localhost:8787`. The server provides both the client build and Socket.IO connection on that port.

### Temporary public link

After creating a room, the host can select **Generate invite link** from the locally opened room. The server starts a Cloudflare Quick Tunnel and returns a copyable link with the room code in `?room=`. Quick Tunnel is free, temporary, and requires no Cloudflare account; `cloudflared` must be installed on the host machine.

You can also start the tunnel manually:

```bash
cloudflared tunnel --url http://localhost:8787
```

### Cloud deployment

The Docker Compose configuration initially binds the app to `127.0.0.1:8787` on the server for private verification over SSH forwarding. Enable the Caddy `public` profile only after a domain and public-release requirements are ready. See [`docs/deployment.md`](docs/deployment.md). Rooms and games are kept in memory and disappear on server or container restart.

### Development

```bash
pnpm dev:server  # backend watch mode on port 8787 by default
pnpm dev:client  # frontend HMR on port 5173; proxies /socket.io to 8787
```

### Testing

```bash
pnpm test          # all engine, shared, server, and client tests
pnpm typecheck     # TypeScript checks for every package
pnpm build:client  # production client build
pnpm smoke         # socket smoke flow; run pnpm dev:server first
```
