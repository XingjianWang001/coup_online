# 调研：文字聊天与语音聊天的代码库现状与约束

- 调研基线：分支 `feat/chat` @ `75d9d31`（与 `dev` 相同），2026-10-22
- 范围：只读调研，不含实现与选型。仓库内出处写作 `path:line`，外部出处写 URL（见文末）。标「推断」的内容由代码推出、未实测；标「未确认」的内容没有找到可靠出处。
- `DESIGN.md` 与 `PRODUCT.md` 被 `.gitignore` 忽略（`.gitignore:447`、`.gitignore:455`），只存在于本机工作区；引用它们时，其他机器上的 agent 看不到。

## 摘要

- **传输层**：单端口 Node `http` + Socket.IO 4（`packages/server/src/index.ts:43`、`index.ts:81`）。客户端到服务器只有一个业务事件 `intent`（外加 `timeSync`），服务器到客户端每种消息用一个独立的 Socket.IO 事件名。入站只校验了外形（`index.ts:151-154`），没有 schema 库。限流只有两处：按 IP 的建房限流（`room-limits.ts:17-27`），以及对质悬停按房间 50ms 节流（`room.ts:31`、`room.ts:358-361`）。`maxHttpBufferSize` 用的是默认值 1 MB。
- **现成模板**：ADR 0011 的 `focusShowdownCard` → `showdownFocus` 是一条「不进牌局状态、经服务器校验和节流后转发给房间」的通道（`index.ts:225-231`、`room.ts:348-362`），形状与聊天消息、WebRTC 信令最接近。
- **谁在房间里**：Socket.IO room 里是房间全部玩家的当前连接，被淘汰的玩家也在其中，照常收全部广播。没有观战者：开局后新玩家无法加入（`room.ts:111`）。牌局中**不广播在线状态**：`PublicPlayerView` 没有 `connected`，而 `lobby` 消息只在大厅阶段发送（`types.ts:98-105`、`index.ts:108-109`）。
- **历史与持久化**：引擎纯函数，不保存日志。「记录」是客户端用收到的 `events` 拼出来的：开局和回到大厅时清空，重连时也不补发（`session.ts:83-100`、`session.ts:122-131`、`index.ts:125`）。`GameRepository` 只有 `save`/`delete`，类型限定为 `GameState`，从不被读取（`repository.ts:4-7`）。聊天历史放在哪里，要和 ADR 0003 的措辞一起决定。
- **客户端**：React 18 + Vite。没有状态库，只用 `useReducer(reduceSession)`。所有 UI 集中在 `App.tsx`（1880 行）。双语文案放在类型化字典里（`localization.ts`），中英两份都必须补全，否则编译不过（`localization.ts:247`）。
- **语音的硬约束**：`navigator.mediaDevices` 只在安全上下文中存在。localhost、127.0.0.1（SSH 转发）、Quick Tunnel 的 https 和 Caddy 的 https 都满足；**局域网 IP 的 http 不满足**。现有 WebSocket 可以承载信令。但 Quick Tunnel、Caddy 和当前的 compose 都**不转发 UDP**，媒体需要 P2P 直连或借助外部或自建的 TURN。
- **历史**：`feat/voice-chat` 上没有任何语音相关提交（它是 `feat/chat` 的祖先，见第 7 节）。prototype 分支只有 `origin/prototype/role-icons`，与聊天无关。GitHub 上也没有相关 issue。另外，`main` 只有 Initial commit，真正的集成分支是 `dev`。
- **术语**：`CONTEXT.md` 里没有聊天和语音的术语，需要交给 domain-modeling 补录（第 8 节）。

## 架构现状

```mermaid
flowchart LR
  subgraph Browser["浏览器 packages/client"]
    UI["App.tsx 组件"] -->|send()| SK["socket.ts<br/>socket.emit('intent')"]
    SK2["socket.ts onMessage<br/>固定事件名列表"] --> RS["session.ts reduceSession"] --> UI
  end
  subgraph Server["Node 单端口 :8787 packages/server"]
    H["index.ts handleIntent switch"] --> RM["room.ts Room<br/>校验/计时/房主/断线"]
    RM -->|apply(fn)| EN["engine game.ts<br/>纯函数 → GameEvent[]"]
    RM -->|onBroadcast| PUB["index.ts publish()/broadcast()"]
    RM --> REPO["repository.ts<br/>InMemoryGameRepository.save()"]
  end
  SK -->|WebSocket / Socket.IO| H
  PUB -->|"io.to(room): gameStarted|events → publicState<br/>io.to(socketId): privateState"| SK2
```

一次状态变化的推送顺序：`gameStarted` 或 `events` → `publicState` → 每人各自的 `privateState`（`index.ts:83-110`，客户端侧注释见 `session.ts:69`）。

## 1. 传输层

**库与端点**
- 服务器用 `socket.io` ^4.8.1（`packages/server/package.json:15`），客户端用 `socket.io-client` ^4.8.1（`packages/client/package.json:16`）。
- 服务器是 `node:http` 的 `createServer`，上面挂 `new Server(httpServer)`，未传任何选项（`index.ts:43`、`index.ts:81`）。
- HTTP 端点只有 `/healthz`（`index.ts:45-48`）和 `client/dist` 下的静态文件（`index.ts:50-78`），没有 REST API。
- 客户端用 `io({ autoConnect: true })` 连接同源（`socket.ts:6-8`）。开发模式下由 Vite 把 `/socket.io` 代理到 8787，并开启 `ws: true`（`vite.config.ts:8-13`）。

**协议类型**（`packages/shared/src/protocol.ts`）
- `ClientIntent` 是判别联合（`protocol.ts:4-20`），其中 `focusShowdownCard` 注明「只转发给房间，不进牌局状态」（`protocol.ts:16-17`）。
- `ServerMessage` 定义在 `protocol.ts:73-83`。
- 错误码白名单在 `protocol.ts:30-50`，解析函数是 `parseServerError`（`protocol.ts:58-70`）。
- 出口文件是 `packages/shared/src/index.ts:1-14`。

**通道约定**
- 客户端到服务器：业务消息全部走单一事件 `socket.emit('intent', ClientIntent)`（`socket.ts:10-12`、`index.ts:133-139`）。唯一的例外是 `timeSync` 带 ack 的对时（`index.ts:129-131`、`App.tsx:277-304`）。
- 服务器到客户端：每个 `ServerMessage.type` 是一个独立的 Socket.IO 事件名。客户端 `onMessage` 只订阅一份**写死的事件名列表**，再包装回 `{ type, ...payload }`（`socket.ts:15-25`）。**新事件名如果不加进这份列表，消息会被静默丢弃。**

**入站解析与校验**（信任边界）
- `handleIntent` 只检查「是对象，且 `type` 是字符串」（`index.ts:151-154`）。参数上的 `raw: ClientIntent` 只是编译期标注（`index.ts:133`）。
- 逐类型的检查：
  - 已在房间内时不能再建房或加入（`index.ts:157`、`index.ts:171`）。
  - 房间码必须是 6 位十六进制（`index.ts:172-174`）。
  - 昵称要求去掉首尾空白后非空、长度 ≤ 32、不含控制字符（`room.ts:34`、`room.ts:95-97`）。这是聊天文本校验可以参照的现成规则。
- 牌局类意图的字段直接用 `as` 断言，再由引擎规则把关（`room.ts:317-346`）：`GameRuleError` 映射为 `invalidGameAction`，未知类型映射为 `illegalIntent`（`room.ts:336-344`）。
- 在 `index.ts` 的 switch 里没有单独 case 的类型都会落进 `default`，即 `Room.dispatch`（`index.ts:232-236`）。所以聊天消息必须单独加一个 case，否则只会收到 `illegalIntent`。
- 抛出的错误经 `toServerError` 变成结构化错误码，`socket.emit('error', …)` 发回（`index.ts:136-138`、`errors.ts:1-17`），客户端再本地化（`localization.ts:343-361`）。

**按房间广播与私有视图**
- 入房时调用 `socket.join(room.code)`，并把 `socket.data.roomCode` 和 `socket.data.playerId` 绑定到这条连接（`index.ts:112-115`）。
- 房间广播用 `io.to(room.code).emit(...)`（`index.ts:86`、`index.ts:100`、`index.ts:106-107`）。
- 定向发送用 `io.to(p.socketId)`，而且只发给当前连接（`index.ts:92-95`）。这是 WebRTC 信令「按 playerId 定向转发」可以复用的写法。
- 私有视图由引擎生成：`publicState` 只暴露 `handCount` 和已翻开的角色（`game.ts:533-562`），`privateState` 只含本人手牌（`game.ts:564-567`）。
- Room 通过 `onBroadcast` 回调把推送交给传输层（`room.ts:52-56`）。
- Socket.IO 文档说明：`socket.to(room)` 发给房间内除发送者以外的所有连接；连接断开时会自动离开所有 room（https://socket.io/docs/v4/rooms/）。

**大小限制与限流**
- `maxHttpBufferSize` 没有设置，默认 `1e6` 字节，单条消息超过即断开连接（https://socket.io/docs/v4/server-options/）。
- `connectionStateRecovery` 默认未启用（同一页面），断线期间错过的消息不会补发。
- 限流只有两处：
  - 建房按 IP 限制：60 秒内最多 5 次，全服最多 100 个房间（`room-limits.ts:3-5`、`room-limits.ts:17-27`）。
  - 对质悬停按**房间**节流：50ms 内的重复消息直接丢弃（`room.ts:31`、`room.ts:68`、`room.ts:358-361`）。
- 没有通用的按连接或按玩家的限流。
- 取客户端 IP 时，只有 `TRUST_PROXY=1` 才读 `X-Forwarded-For`（`index.ts:22-28`）。compose 默认值是 0（`compose.yaml:6`），公网部署脚本会写成 1（`scripts/deploy-private-remote.sh:43`）。
- **推断**：Quick Tunnel 模式下，cloudflared 连接的是 `http://localhost:PORT`（`tunnel.ts:28`），所有经隧道进来的玩家对服务器来说都是回环地址。后果有二：按 IP 的限流把所有人算作一个来源；`canStartTunnel` 和 `startTunnel` 的回环校验（`index.ts:123`、`index.ts:192`，ADR 0006）对隧道用户也会放行（隧道 URL 是单例，见 `tunnel.ts:25-26`）。cloudflared 是否带上 `X-Forwarded-For`：**未确认**。对聊天的含义：在这种部署下按 IP 限流不可靠，只有按 playerId 或连接限流才能由代码保证。

**加一种 chat 消息需要动的地方**：见下文「加入文字聊天需要碰的接触点清单」。

## 2. 房间与身份

**房间生命周期**
- `createRoom` 生成 6 位十六进制房间码，存进模块级 `rooms` Map（`index.ts:20`、`index.ts:30-36`、`index.ts:156-169`）。
- 阶段流转：
  - 大厅阶段：`game = null`。
  - 房主开局：至少 2 人（`room.ts:191-211`）。
  - 牌局进行，直到 `gameOver`。
  - 房主发起再来一局，回到大厅阶段（`room.ts:177-189`）。
- 空房 5 分钟后回收（`room.ts:375-384`），`onEmpty` 回调把它从 Map 中删除（`index.ts:161`）。
- 每房最多 6 人（`room.ts:33`、`room.ts:112-114`）。

**身份**
- `RoomPlayer` 包含 `id`（8 字节 hex）、`secret`（16 字节 hex，只发给本人）、`name`、`socketId`、`connected`（`room.ts:36-50`）。
- `joined` 消息只发给本人，里面带 `secret`（`index.ts:116-124`）。
- 客户端把身份存在 localStorage：`coup_identity` 存身份，`coup_room` 存房间码（`socket.ts:27-63`、`App.tsx:215-219`）。
- 没有账号（`CONTEXT.md:9-11`、`PRODUCT.md:11`）。昵称不唯一。重连时 `Room.players` 里的昵称可以改（`room.ts:104`），但牌局内的名字在开局时已经固定（`room.ts:203`）。

**断线与重连**
- socket 重连后，客户端自动用 id 和 secret 重新发送 `joinRoom`。从 `?room=` 链接进入时例外（`App.tsx:258-272`、`App.tsx:78-88`）。
- secret 匹配就复用原座位，否则当作新玩家（`room.ts:99-109`）。
- 同一身份在新标签页接管时，旧连接收到 `left: replaced`（`index.ts:179-187`）。
- 所有写操作都要求「当前连接」（`room.ts:120-127`）。每次重连后 socket.id 都会变，所以信令和定向消息应当按 playerId 寻址（推断）。
- 断线后标记离线并广播，宽限期 90 秒（`room.ts:32`、`room.ts:129-149`）。宽限期过后：牌局中视为弃权，座位保留且玩家判为淘汰；大厅阶段或牌局结束后直接移除。

**房主**
- 移除房主时，由最早加入的在场玩家继承（`room.ts:159-168`）。
- 牌局结束时房主若离线，权利立即交给在线玩家（`room.ts:170-175`、`CONTEXT.md:21-25`）。
- 没有踢人、禁言之类的房主管理能力（全仓库无相关意图，见 `protocol.ts:4-20`）。

**离开与弃权**
- `leaveRoom`：牌局中先弃权再移除，其他阶段直接移除（`index.ts:213-224`、`room.ts:213-220`、`CONTEXT.md:117-123`）。

**被淘汰的玩家**
- 引擎只把 `alive` 置为 false，玩家仍留在 `room.players` 和 Socket.IO room 里，照常收 `publicState` 和 `events`（`index.ts:86-95`）。
- 宽限期到期而弃权的离线座位，会保留到再来一局时才清掉（`room.ts:181-184`）。

**观战者**
- 不存在观战者角色：开局后新玩家一律被拒（`room.ts:110-111`，错误码 `gameAlreadyStarted`）。
- ADR 0011 和代码注释里的「旁观者 / Spectators」指对质时被质疑者以外的玩家（`docs/adr/0011-…md:5`、`App.tsx:1139`），不是一种参与方。

**在线状态**
- `LobbyPlayer.connected` 只随 `joined` 和 `lobby` 下发（`protocol.ts:23-28`、`index.ts:99-101`）。
- 牌局中不发 `lobby`（`index.ts:108-109`），`PublicPlayerView` 也没有 `connected` 字段（`types.ts:98-105`），所以**牌局进行中客户端不知道谁在线**。语音的「在场 / 正在说话」和聊天的「对方离线」提示都需要新数据。

**「谁能发言 / 谁能听到」的现状边界**：`io.to(room.code)` 天然覆盖房间内当前在线的全部玩家，包括被淘汰的和牌局结束后留下的。要排除某些人，必须在服务器上按 `room.players` 或 `game.players[].alive` 显式过滤。

## 3. 状态与持久化

- **引擎纯度（ADR 0001）**：引擎零 I/O（`docs/adr/0001-…md:3`）。`GameEvent` 联合只包含规则事件（`types.ts:83-95`）。引擎不保存事件历史，各函数返回 `GameEvent[]`，由 Room 转交传输层（`room.ts:222-228`）。聊天不属于规则，放进引擎或 `GameEvent` 都会污染规则核心，而且日志分组 `groupLog` 会把它当作规则事件处理（`narration.ts:153-179`）。
- **仓储（ADR 0003）**：
  - 接口只有 `save(roomCode, GameState)` 和 `delete(roomCode)`，没有读取方法（`repository.ts:4-7`），实现是一个 Map（`repository.ts:9-19`）。
  - 权威状态其实由 `Room.game` 持有（`room.ts:66`），仓储只在变更后被写入，作为镜像（`room.ts:206`、`room.ts:225`、`room.ts:186`、`room.ts:379`）。
  - ADR 0003 写的是「读写状态一律经过 `GameRepository` 接口」（`docs/adr/0003-…md:3`）。
- **事件日志（「记录」）**：
  - 纯客户端：`reduceSession` 的 `events` 分支把事件追加到 `log`，最多保留 500 条（`session.ts:122-131`）。
  - `gameStarted` 和 `lobby` 都会清空 log（`session.ts:83-100`）。
  - 渲染时 `groupLog` 按行动分组（`narration.ts:141-179`），面板在 `App.tsx:1624`、`App.tsx:1726-1756`。
  - 服务器不保存历史，重连只推当前状态：`emitJoined` 调用的是 `publish(room, [])`（`index.ts:125`）。所以刷新后记录是空的或残缺的（推断）。
  - `LogEntry.event` 的类型被固定为 `GameEvent`（`narration.ts:141-144`），要直接复用就得放宽这个类型。
- **通知（notice）**：
  - 纯客户端、单槽位：新通知直接覆盖旧的，4 秒后自动消失（`transient.ts:1-9`、`App.tsx:182-183`、`App.tsx:205-208`、`App.tsx:274-275`）。
  - 由事件触发（`App.tsx:221-232`）。可选 key 是一个封闭集合 `NoticeDescriptor`（`localization.ts:363-365`）。
  - 组件是 `TransientMessage`（`App.tsx:1469-1518`）。
- **不违反现有 ADR 的落点**（只列事实，不做决定）：
  - 不能放进引擎（ADR 0001）。ADR 0011 已有先例：服务器在牌局状态之外转发数据并限流。
  - 放在服务器内存里（例如 Room 上）符合 ADR 0003 的「内存、重启丢失」和 `MISSION.md:13-14` 的「不引入数据库」。但它不会经过只接受 `GameState` 的 `GameRepository`，和 ADR 0003 的字面措辞有张力（见文末冲突一节）。
  - 只放在客户端（像现在的 log 一样）则刷新即丢。

## 4. 客户端

**框架与状态管理**
- 技术栈：React 18、Vite 6、Vitest（`packages/client/package.json`）。没有路由，也没有状态库。
- `useReducer(sessionReducer)` 包装纯函数 `reduceSession`（`App.tsx:70-75`、`App.tsx:161`，`session.ts:70-141`）。界面的局部状态用 `useState`（`App.tsx:180-193`）。
- `Session` 的形状在 `session.ts:27-46`，初值在 `session.ts:48-66`。
- 构建开启了 `strict`（`tsconfig.base.json:7`），`reduceSession` 的 switch 没有 default 分支。所以新增 `ServerMessage` 成员而没有补 case 时，TypeScript 会报「缺少返回」（推断）。

**服务端消息进入 UI 的路径**
- `onMessage` → `dispatchSession({ msg, now })` → `reduceSession`。
- 同一个 effect 里还处理副作用：持久化身份、显示错误和通知、清理房间码（`App.tsx:210-256`）。

**页面结构**
- `App`：
  - 页眉：标题，以及规则、设置、离开房间三个 ghost 按钮（`App.tsx:375-390`）。
  - 浮层：规则、设置、离开确认、发牌展示、对质舞台、失去影响力（`App.tsx:392-433`）。
  - 错误条（`App.tsx:435-442`）。
  - `EntryForm` 或 `RoomView`（`App.tsx:444-484`）。
- `RoomView`：
  - 大厅阶段：房间码、加入链接、玩家列表（带「房主」「离线」后缀）、开始按钮（`App.tsx:796-835`）。
  - 牌局阶段：渲染 `GameBoard`（`App.tsx:837-856`）。
- `GameBoard` 依次是：通知、获胜横幅、牌桌（左/上/右三条座位栏加中央叙述）、自己的座位、行动区、记录（`App.tsx:1636-1759`）。

**布局规范**
- DESIGN.md 规定整体是单列、最大宽度 920px，顺序为 header → notice → table → your seat → controls → log（`DESIGN.md:131-133`）。
- 768px 以下：
  - 座位改为左右两栏加顶部（`DESIGN.md:135`）。
  - 行动区变成 sticky 底栏，并排在记录之后（`DESIGN.md:139`、`style.css:1716`、`style.css:1901-1914`）。
- 记录面板最大高度 260px，可滚动（`DESIGN.md:180-181`、`style.css:830-838`）。
- 聊天面板目前没有预留位置。可选位置包括：记录区旁边或下方、页眉按钮打开的面板或对话框、大厅阶段的玩家列表旁。这里只列出可能性。PRODUCT 原则「One glance per turn」（`PRODUCT.md:59`）以及移动端底栏和记录区的关系（`style.css:1901-1914` 的注释）会约束聊天面板的选位。

**可复用组件与模式**
- `TransientMessage`：带进入/退出动画的单条提示，`role` 和 `aria-live` 可配（`App.tsx:1469-1518`）。
- `useDialogFocus`：焦点约束、Escape 关闭、焦点归还（`App.tsx:98-139`）。ADR 0008 要求设置和规则这类面板具备这些行为（`docs/adr/0008-…md:7`）。
- 记录面板：可折叠分组（`App.tsx:1726-1756`）。
- 玩家可写的内容都以 JSX 文本节点渲染（昵称见 `App.tsx:822`、`App.tsx:1598`）。`packages/client/src` 中没有 `dangerouslySetInnerHTML` 或 `innerHTML`（grep 结果）。

**双语（ADR 0008）**
- 语言是浏览器本地状态，不进协议（`docs/adr/0008-…md:3`）。
- 玩家自己写的内容永不翻译（`docs/adr/0008-…md:5`）。
- 服务器只发错误码和原始事件，客户端在渲染时本地化（`docs/adr/0008-…md:5`）。
- 字典：
  - 英文字典在 `localization.ts:19-131`，`MessageKey` 由它推导（`localization.ts:133`）。
  - 中文字典 `satisfies Record<MessageKey, string>`，少一个 key 就编译失败（`localization.ts:135-247`）。
  - 带参数的文案在 `MessageValues` 里声明参数类型（`localization.ts:254-292`）。
  - `translate` 在 `localization.ts:331-341`。

**设计 token**
- CSS 变量定义在 `style.css:19-64`，与 `DESIGN.md:4-58` 的 frontmatter 对应。
- 需要遵守的规则：
  - 金色只用于主操作、金币、当前玩家环和焦点（One Flame，`DESIGN.md:110`、`DESIGN.md:191-195`）。未读提示用什么颜色需要设计决定。
  - 角色色只出现在牌上（`DESIGN.md:112`）。
  - 平面无阴影，唯一例外是移动端底栏（`DESIGN.md:143-149`）。
  - 次要文字用 sage 色，不用中性灰（`DESIGN.md:93-94`）。
  - 间距用 `gap`（`DESIGN.md:137`）。
  - 触控目标 ≥ 44px（`DESIGN.md:158`、`PRODUCT.md:38`）。
  - 输入框规范见 `DESIGN.md:174-175`。

## 5. 语音相关约束（只列约束与选项）

**5.1 安全上下文与 getUserMedia**
- W3C Media Capture 规范把 `Navigator.mediaDevices` 标为 `[SecureContext]`，`MediaDevices` 接口本身也是（https://www.w3.org/TR/mediacapture-streams/ §9.1、§9.2）。
- MDN 的说法是：在不安全的上下文中 `navigator.mediaDevices` 为 `undefined`，调用会抛 `TypeError`。用户拒绝时抛 `NotAllowedError`，没有设备时抛 `NotFoundError`。用户也可能一直不理会授权提示，promise 永不 settle（https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia）。
- 「潜在可信源」包括：`https`/`wss`、`127.0.0.0/8`、`::1`、`localhost` 和 `*.localhost`、`file`（https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy、https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts）。局域网 IP 不在列表中。
- `microphone` 是受 Permissions Policy 控制的功能，默认 allowlist 是 `self`（规范 §14）。本应用是顶层页面，服务器也不设 `Permissions-Policy` 头（`index.ts:77`），所以默认允许本源使用；只有嵌入 iframe 时才需要 `allow="microphone"`。

| 部署方式 | 玩家打开的 origin | 安全上下文 | 仓库出处 |
| --- | --- | --- | --- |
| 本机 `pnpm dev:server` | `http://localhost:8787` | 是（localhost） | `README.md:42` |
| 本机 `pnpm dev:client` | `http://localhost:5173` | 是 | `README.md:62`、`vite.config.ts:7` |
| 局域网设备访问开发机 | `http://<局域网 IP>:…` | **否** | 推断（不在可信列表） |
| Quick Tunnel（ADR 0004/0006） | `https://*.trycloudflare.com`；房主本机仍是 localhost | 是 | `tunnel.ts:5`、`App.tsx:798`、`App.tsx:812` |
| 云服务器私有验证（SSH 转发） | `http://127.0.0.1:18887` | 是（127.0.0.0/8） | `docs/deployment.md:9`、`docs/deployment.md:50` |
| 云服务器固定域名（Caddy） | `https://<域名>` | 是 | `Caddyfile:1-4`、`docs/deployment.md:56-68` |
| 用服务器 IP 直连 | 不可用：8787 只绑定服务器本机 | — | `compose.yaml:7-8`、`docs/deployment.md:68` |

**5.2 自动播放**
- MDN：标签页还没有任何用户交互时，程序发起的带声音的播放通常会被拦截（https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay）。
- 首次建房或加入时有点击。但刷新后客户端会自动重新加入（`App.tsx:258-272`），这时页面还没有用户手势，远端音频可能被拦，直到用户与页面交互（推断）。

**5.3 现有 WebSocket 作为信令通道**
- WebRTC 不规定信令怎么传输，WebSocket 是常见做法。需要交换的是 SDP 的 offer/answer 和 ICE candidate（https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling）。
- 现有 Socket.IO 通道在所有部署方式下都能工作：
  - Caddy `reverse_proxy` 支持 WebSocket（https://caddyserver.com/docs/caddyfile/directives/reverse_proxy）。
  - Cloudflare Tunnel 完整支持 WebSocket（https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/）。
  - Vite 代理开了 `ws: true`。
- 可以复用的写法：定向发送 `io.to(p.socketId)`（`index.ts:94`），以及「校验后转发」的 `focusShowdownCard` 模式。SDP 是文本，大小应远低于默认的 1 MB 上限（未实测）。
- Caddy 重载配置时默认会强制关闭 WebSocket 连接（上面的 Caddy 文档）。ADR 0010 的流程里，为其他站点执行 `caddy reload`（`docs/deployment.md:86`）会让所有玩家的 Socket.IO 断开重连，信令随之中断。已建立的 P2P 媒体是否受影响：**未确认**。

**5.4 UDP、STUN 与 TURN**
- 媒体走 ICE 选出的路径：能直连就 P2P，否则走 TURN 中继。
  - 不配 `iceServers` 时只能连本地对端（https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection）。
  - STUN 用来发现公网地址；遇到对称 NAT 需要 TURN，而 TURN 会中继全部流量（https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols）。
  - 本产品的场景是「不同网络的朋友」（`PRODUCT.md:11`、`CONTEXT.md:3`），所以至少需要 STUN。需要 TURN 的玩家占多大比例：**未确认**。
- **Quick Tunnel 和 Cloudflare Tunnel**：
  - 公开主机名的服务类型是 HTTP/HTTPS/UNIX，以及经 WebSocket 承载的 TCP/SSH/RDP/SMB，没有 UDP；非 HTTP 服务要求客户端也装 cloudflared（https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/）。
  - Tunnel「off-ramp only and does not support server-initiated protocols (VoIP, SIP)」（https://developers.cloudflare.com/cloudflare-one/networks/connectivity-options/）。
  - Quick Tunnel 仅用于测试和开发：无可用性保证，最多 200 个并发请求，不支持 SSE（https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/）。
  - 结论：TURN 和 SFU 无法放在隧道后面。
- **Caddy 和当前的 compose**：
  - 四层（TCP/UDP）代理模块「does not come with Caddy」（https://caddyserver.com/docs/json//apps/layer4/servers/routes/handle/proxy/upstreams），官方镜像 `caddy:2`（`compose.yaml:12`）只做 HTTP 代理。
  - compose 端口的协议默认是 TCP（https://docs.docker.com/reference/compose-file/services/），所以 `"443:443"`、`"80:80"`、`127.0.0.1:8787:8787` 都只映射 TCP（`compose.yaml:7-8`、`compose.yaml:18-20`）。
  - 附带一点：Caddy 默认启用 h3（https://caddyserver.com/docs/caddyfile/options），但 UDP 443 没有映射。
- **腾讯云**：
  - 轻量应用服务器防火墙支持 TCP、UDP、ICMP、ICMPv6，端口可以写成范围。Linux 镜像默认只放通 22、80 和 ICMP，每个实例最多 100 条规则（https://cloud.tencent.com/document/product/1207/44577）。
  - 部署文档只要求开放 TCP 80/443（`docs/deployment.md:58`、`reference/tencent-cloud-deployment-runbook.html:34`）。
  - 流量包只统计出流量，超出部分按小时计费（https://cloud.tencent.com/document/product/1207/44368）。TURN 中继的流量全部经过服务器，会计入流量包（推断）。
- **TURN 的来源选项**（只列选项，不做选择）：
  1. **自建 coturn**：默认在 3478 端口监听 UDP/TCP，5349 端口监听 TLS/DTLS，中继端口范围 49152–65535；用 `static-auth-secret` 支持 TURN REST 限时凭证（https://github.com/coturn/coturn/blob/master/README.turnserver）。需要做的：在防火墙放通 UDP 端口和中继端口范围；在 compose 里加 `/udp` 映射或改用 host 网络（host 网络模式下不能再做端口映射，见上面的 Docker 文档）；由服务器签发凭证。
  2. **托管 TURN**，以 Cloudflare Realtime 为例：
     - 端口：STUN 3478/udp；TURN 3478/udp（备用 443/udp）、3478/tcp（备用 80/tcp）、5349/tcp（备用 443/tcp）（https://developers.cloudflare.com/realtime/turn/）。
     - 凭证由后端用 TURN key 生成，可设置 TTL，key 不能交给浏览器（https://developers.cloudflare.com/realtime/turn/generate-credentials/）。
     - 价格：每 GB 出流量 $0.05，每月前 1000 GB 免费，与 SFU 共用这份额度（https://developers.cloudflare.com/realtime/sfu/pricing/）。
     - 该服务运行在 Cloudflare 全球网络上，但不包括 China Network，**中国大陆的可达性未确认**。另外，它需要 Cloudflare 账号。
  3. **只用 STUN**：接受对称 NAT 下连不上。MDN 提醒应使用自有或获得授权的 STUN/TURN 服务器（见 5.3 的信令页面）。公共 STUN 在中国大陆的可达性：**未确认**。
- **拓扑**：每房最多 6 人（`room.ts:33`）。全 mesh 时最多 15 条 PeerConnection，每个客户端最多向 5 个对端各发一路上行。替代方案是 SFU（自建，或 Cloudflare Realtime SFU）。只列出，不做选择。
- **隐私**：ICE 可能让对端得知用户的 IP 地址，包括私网地址（https://www.rfc-editor.org/rfc/rfc8828.html §3）。设置 `iceTransportPolicy: 'relay'` 后只使用中继候选（MDN RTCPeerConnection 页面），代价是全部流量都经过 TURN。目前所有通信都经服务器中转，玩家之间互相看不到 IP。

## 6. 测试与验证

**测试框架与写法**
- 四个包都用 Vitest ^3，`pnpm test` 递归运行（`package.json:6`）。
- CI 依次执行 test、typecheck、build:client，再在 Windows 上检查部署脚本（`.github/workflows/ci.yml:35-60`）。**smoke 和 ui-check 不在 CI 里。**
- 现有写法：
  - 引擎：`game.test.ts`，纯函数测试。
  - 服务器：`room.test.ts` 用 `makeRoom` 注入 mock 的 repo 和 `onBroadcast`（`room.test.ts:7-12`），配合 fake timers。对质悬停的转发与节流测试（`room.test.ts:460-482`）可以直接作为「聊天校验和限流」测试的模板。
  - 协议：`protocol.test.ts` 测 `parseServerError`（`protocol.test.ts:1-24`）。
  - 客户端：纯模块测试，`session.test.ts` 用 `run()` 依次喂 `ServerMessage`（`session.test.ts:8-18`）。`CODING_STANDARDS.md:5-9` 要求喂入的消息序列必须是服务器真能发出的顺序。
- `index.ts` 传输层没有单元测试，由 `packages/client/smoke-test.mjs` 覆盖：4 个 socket.io-client 机器人，地址取 `COUP_URL`，需要先运行 `pnpm dev:server`（`smoke-test.mjs:1-40`、`README.md:71`）。

**ui-check**（`scripts/ui-check.mjs`）
- 流程（`ui-check.mjs:1-6`）：构建前端，在空闲端口启动服务端，再起 headless Chrome（CDP）跑场景，结束时整组清理进程。
- 用法：`node scripts/ui-check.mjs [场景.mjs] [截图目录]`，也可以用 `pnpm ui-check`（`package.json:13`）。
- 环境变量：`W`/`H` 视口尺寸，`MOBILE=1`，`REDUCED=1`，`LOCALE`（通过 localStorage 注入，`ui-check.mjs:119`），`NO_BUILD=1`，`CHROME`。
- 场景通过 `ui` 对象操作：`bot()`（Node 端的 socket.io 机器人，可 `intent` 也可 `next`）、`joinAs`、`goto`、`waitFor`、`click`（只匹配 button 文本）、`type`、`key`、`shot`、`frames`（`ui-check.mjs:128-190`）。默认场景见 `ui-check.mjs:94-103`。
- 对聊天的影响：
  - `ui.type` 用的是 `HTMLInputElement` 的 value setter（`ui-check.mjs:144-148`），如果聊天输入框是 `<textarea>`，这个 helper 用不了。
  - `ui.click` 只找 button（`ui-check.mjs:138-142`）。
- 对语音的影响：
  - 页面跑在 `http://localhost:<port>` 上，属于安全上下文。
  - 但 Chrome 启动参数（`ui-check.mjs:72`）里没有 `--use-fake-ui-for-media-stream`、`--use-file-for-fake-audio-capture` 这类免设备、免授权的测试参数（https://webrtc.org/getting-started/testing）。
  - 机器人是 Node 进程，不具备 WebRTC 能力，端到端语音验证需要第二个浏览器页面（推断）。
- Windows 上需要注意：
  - `CHROME` 的默认值是 macOS 路径（`ui-check.mjs:17`），在 Windows 上必须手动设置。
  - 清理时用 `process.kill(-pid)` 杀进程组（`ui-check.mjs:36-46`），构建时调用 `spawnSync('pnpm', …)`（`ui-check.mjs:54`）。这两处在 Windows 上的行为：**未确认**，本次没有运行。

## 7. 历史与追踪

- `main` 和 `origin/main` 都停在 `bc3834d Initial commit`（2026-08-31）。实际的集成分支是 `dev`，部署也从 `origin/dev` 取代码（`docs/deployment.md:9`）。`feat/chat` 与 `dev` 同在 `75d9d31`。
- `feat/voice-chat` 停在 `5803727`（2026-09-01，Merge PR #1）：
  - 相对 `main` 多出的 9 个提交都是 MVP 历史（`b3988fb`…`450b2d6`）。
  - 它是 `feat/chat` 的祖先，`git rev-list feat/chat..feat/voice-chat` 为 0。
  - 提交信息和文件名里都没有 chat、voice、RTC、audio 相关内容。全仓库 `--grep` 只命中 `72498e0`，那里的 "voice" 指界面语气，是误报。
- prototype 分支只有 `origin/prototype/role-icons`，内容是角色图标、金币和王冠图标、悬停方案（`git log dev..origin/prototype/role-icons`），与聊天无关。注意：`AGENTS.md` 建议用 `git log main..prototype/<name>` 查看，但 `main` 只有初始提交，这个范围会把全部历史都列出来，实际应该用 `dev..`。
- GitHub（`gh`，仓库 XingjianWang001/coup_online）：搜索 chat、voice、聊天、语音、webrtc、microphone、麦克风、talk，全部为空。全部 issue（#6–#26）里也没有相关条目。

## 8. 术语

- `CONTEXT.md` 中**没有**聊天或语音相关的术语。会受约束的现有术语：
  - 玩家 Player：避免说「用户、账号」（`CONTEXT.md:9-11`）。
  - 房间 Room：等同 Socket.IO room，避免说「大厅、牌桌」（`CONTEXT.md:13-15`）。
  - 大厅阶段 Lobby Phase：不能用「大厅」指代房间（`CONTEXT.md:17-19`）。所以「大厅聊天」这种说法会违反术语表。
  - 意图 Intent：「客户端发送的动作请求，不含结果，由服务器裁决」（`CONTEXT.md:102-104`）。
  - 房主、离开房间、弃权（`CONTEXT.md:21-25`、`CONTEXT.md:117-123`）。
- **缺失项**，按 `docs/agents/domain.md:25` 的要求记为 gap，交给 domain-modeling，本文不自创替代用语：
  - 聊天 / Chat，以及聊天消息
  - 语音 / Voice，以及静音、发言状态
  - 在线 / 离线：界面已经用了「(离线)」后缀（`localization.ts:168`），但没有定义
  - 旁观者 / Spectator：ADR 0011 和代码注释里在用，没有定义
  - 通知 Notice、记录 Log：代码和 DESIGN.md 里在用，没有定义
  - 聊天消息算不算 Intent：现有定义没有覆盖这种情况

## 加入文字聊天需要碰的接触点清单

- **shared**
  - `ClientIntent` 加成员（`protocol.ts:4-20`），`ServerMessage` 加成员（`protocol.ts:73-83`）。
  - 如果要新的错误码，改白名单和 `ServerError`（`protocol.ts:30-50`），再补 `protocol.test.ts`。
  - 有新的导出类型时更新 `shared/src/index.ts:1-14`。
- **server**
  - `index.ts` 的 `handleIntent` 在 `default` 之前加 case（`index.ts:151-238`），用 `io.to(room.code)` 或 `socket.to(room.code)` 广播。
  - `room.ts` 新增校验和限流方法，仿照 `focusShowdownCard`（`room.ts:348-362`），并用 `requireCurrentConnection` 做身份把关（`room.ts:125-127`）。如果服务器要保存历史，也放在这里或传输层。
  - 如果新加入的人要看到历史，需要改 `emitJoined`（`index.ts:112-126`）。
  - 测试写在 `room.test.ts`。
- **engine**：不改（ADR 0001）。
- **client**
  - `socket.ts:16` 的事件名列表必须加上新事件名。
  - `session.ts` 的 `Session`、`initialSession` 和 `reduceSession`（`session.ts:27-141`）；还要决定聊天在 `lobby`、`gameStarted`、`left` 这几个重置点上怎么处理（`session.ts:83-100`、`session.ts:134-140`）。
  - `App.tsx`：大厅视图（`App.tsx:796-835`）、`GameBoard`（`App.tsx:1520-1759`），也可能要加页眉入口（`App.tsx:375-390`）；副作用 effect（`App.tsx:210-256`）。
  - `localization.ts` 的两份字典和 `MessageValues`，可能还有 `NoticeDescriptor` 和 `localizeServerError`。
  - `style.css` 用现有 token，补移动端规则（`style.css:1716` 起）。
  - 测试写在 `session.test.ts`。
- **验证**：`smoke-test.mjs` 加一步，再写一个 ui-check 场景。注意 `ui.type` 对 textarea 的限制，以及 Windows 上要设置 `CHROME`。
- **文档**：在 `CONTEXT.md` 补术语（经 domain-modeling）；如果涉及 ADR 0003 或 0002 的取舍，补写 ADR；README 的功能说明。

## 加入语音聊天的约束与可选路线（不做决定）

- **信令**：可以走现有 Socket.IO。需要新增若干按 playerId 定向转发的意图和消息，由服务器校验目标在同一房间且是当前连接，并做限流。连接重建后 socket.id 会变（第 2 节）。
- **媒体路径**有三类：P2P mesh、自建 SFU、托管 SFU。
- **NAT 穿透**有三类：只用 STUN、自建 TURN（腾讯云上开 UDP 端口和中继范围、改 compose、由服务器签发凭证）、托管 TURN（需要账号和费用，大陆可达性未确认）。
- **各部署方式的可行性**：
  - Quick Tunnel 模式只能转发信令；TURN 只能放在隧道之外，例如托管服务，或在房主家的路由器上开 UDP 端口（推断）。
  - 云固定域名模式：HTTPS 已经具备，UDP 和 TURN 需要额外开放端口或接入外部服务。
  - 局域网 http 访问时，麦克风不可用。
- **客户端需要处理**：麦克风授权失败的界面、自动播放被拦后的恢复、静音和发言状态、离开房间或被接管时释放媒体轨道。牌局中没有在线状态数据（第 2 节）。
- **测试**：Chrome 加假设备参数，并用双页面；`ui-check.mjs` 目前不支持这两点。

## 需要用户决定的开放问题

1. 先做文字、语音，还是两者都做？语音必须覆盖哪些部署方式：本机 Quick Tunnel、云固定域名，还是两者？
2. 谁能发言、谁能收听：被淘汰的玩家？宽限期到期而弃权的离线座位？大厅阶段和牌局结束后可以吗？要不要「只有存活玩家能发言」这类规则？
3. 聊天历史：刷新或重连后是否保留？开局和再来一局时是否清空？保留多少条？存在服务器内存还是只在客户端？
4. 消息约束：长度上限、频率上限、是否允许换行和 emoji、是否要过滤敏感词。房主要不要禁言或踢人？目前没有任何房主管理能力。
5. 聊天和「记录」的关系：合成一条时间线，还是分开的面板？桌面和移动端分别放在哪里？未读提示用什么颜色？金色受 One Flame 规则限制。
6. 语音：只用 STUN 能接受吗？要 TURN 的话，自建还是托管，预算多少？自建 TURN 意味着放开「单端口」的约束。大陆玩家的可达性要先验证。
7. 拓扑选 mesh 还是 SFU？
8. 玩家之间互相暴露 IP 能否接受？是否强制只走中继？
9. 按键说话、自由麦，还是进房默认静音？
10. 牌局中是否要广播在线状态，例如在 `PublicState` 之外再补一种消息？
11. 合规：在中国大陆公开发布时，用户生成内容和语音是否带来额外的备案或审核要求？**未确认**。`docs/deployment.md:88` 已经提示过公开发布前的合规条件。
12. 术语：聊天和语音的正式名称（中英）；聊天消息是否算 Intent。

## 与现有 ADR 的潜在冲突

- **ADR 0001（纯引擎）**：把聊天做成 `GameEvent` 或放进引擎状态会违反这条决定。ADR 0011 已有先例：在牌局状态之外转发。
- **ADR 0002（服务器权威与私有状态）**：
  - 文字聊天经服务器转发，不碰隐藏信息的边界。
  - P2P 语音的媒体不经过服务器，服务器无法限流或审查，还会把玩家 IP 暴露给对端。这一条不属于「泄露暗牌」，但偏离了「一切经服务器」的现状，需要明确表态。
- **ADR 0003（内存加 repository 接口）**：
  - 聊天历史放在内存里符合「重启即丢」。
  - 但 `GameRepository` 只接受 `GameState`（`repository.ts:4-7`），而 ADR 写的是「读写状态一律经过 GameRepository」。所以要么扩展接口，要么明确「聊天不属于该 ADR 所说的状态」。
- **ADR 0004 / 0006（Quick Tunnel、单 origin、零注册）**：
  - 隧道不转发 UDP，TURN 和 SFU 都不能放在它后面。
  - 托管 TURN 需要注册账号，与「零注册」冲突。
  - 附带观察（推断）：隧道模式下，回环校验和按 IP 限流可能失效（见第 1 节）。
- **ADR 0008（客户端双语）**：聊天内容属于玩家自写，不翻译，这一点一致。如果要加「系统消息」（例如某人加入），必须由服务器发结构化事件、客户端本地化，不能在协议里放成句文本。
- **ADR 0009 / 0010 与 MISSION**：
  - MISSION 要求「保持当前单端口 Node.js + Socket.IO 架构」（`MISSION.md:13`）。自建 TURN 或 SFU 会增加服务和 UDP 端口。
  - Caddy 是全机共用的入口，不能代理 UDP，`caddy reload` 还会断开所有 WebSocket。
  - 如果在服务器上加 TURN 这类后端容器，可能触发 ADR 0010 的拆分条件 (c)（`docs/adr/0010-…md:17`）。这一条是推断，因为 (c) 原文说的是「某个站点需要自己的后端容器」。
- **ADR 0011（对质）**：没有冲突，反而提供了转发加限流的模式。但它用的「Spectators」一词没有进术语表。

## 外部来源

- W3C Media Capture and Streams：https://www.w3.org/TR/mediacapture-streams/
- W3C Secure Contexts：https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy
- MDN getUserMedia：https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- MDN Secure contexts：https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts
- MDN Autoplay guide：https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay
- MDN WebRTC protocols：https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols
- MDN Signaling and video calling：https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling
- MDN RTCPeerConnection()：https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection
- IETF RFC 8828（WebRTC IP Address Handling）：https://www.rfc-editor.org/rfc/rfc8828.html
- WebRTC 项目的测试参数：https://webrtc.org/getting-started/testing
- Socket.IO server options：https://socket.io/docs/v4/server-options/
- Socket.IO rooms：https://socket.io/docs/v4/rooms/
- Cloudflare Quick Tunnels：https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
- Cloudflare Tunnel protocols：https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/
- Cloudflare Tunnel FAQ：https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/
- Cloudflare connectivity options：https://developers.cloudflare.com/cloudflare-one/networks/connectivity-options/
- Cloudflare Realtime TURN：https://developers.cloudflare.com/realtime/turn/
- Cloudflare Realtime 凭证：https://developers.cloudflare.com/realtime/turn/generate-credentials/
- Cloudflare Realtime 价格：https://developers.cloudflare.com/realtime/sfu/pricing/
- Caddy reverse_proxy：https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- Caddy 全局选项：https://caddyserver.com/docs/caddyfile/options
- Caddy layer4（非标准模块）：https://caddyserver.com/docs/json//apps/layer4/servers/routes/handle/proxy/upstreams
- Docker Compose services：https://docs.docker.com/reference/compose-file/services/
- 腾讯云轻量防火墙：https://cloud.tencent.com/document/product/1207/44577
- 腾讯云轻量计费概述：https://cloud.tencent.com/document/product/1207/44368
- coturn 配置参考：https://github.com/coturn/coturn/blob/master/README.turnserver
