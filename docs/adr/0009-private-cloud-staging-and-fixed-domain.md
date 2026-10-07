# 云服务器私有验证与固定域名入口

早期的 [ADR 0004](0004-cloudflare-quick-tunnel-single-origin.md) 和 [ADR 0006](0006-server-managed-tunnel-and-invite-link.md) 为「本机启动、临时分享」选择 Cloudflare Quick Tunnel。现在游戏后端需要在云服务器持续运行，房主的电脑不再承担服务端角色。

## 决策

- Node 服务继续在同一个端口提供网页与 Socket.IO；房间和牌局仍在内存中，重启丢局符合当前需求。
- 先在腾讯云 Ubuntu 服务器上用 Docker Compose 启动应用，仅绑定服务器的 `127.0.0.1:8787`，通过 SSH 端口转发私有验证。此阶段不开放网页公网端口。
- 取得域名并确认公开发布所需条件后，启用 Caddy 的 `public` 配置，以固定域名提供 HTTPS，并代理到同一个 Node 服务。房主的加入链接使用当前网页 origin 和 `?room=` 房间码。
- Quick Tunnel 保留为本机开发时的临时分享方式。云服务器私有验证时，不向无法启动隧道的连接显示该操作。

这项决策扩展了 0004 和 0006 的适用场景，并未改变其本机临时分享流程。若未来需要多副本或重启后续局，再单独决策共享限流与状态持久化。
