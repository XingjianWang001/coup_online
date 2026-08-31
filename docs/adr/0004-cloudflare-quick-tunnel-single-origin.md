# Cloudflare Quick Tunnel 单 origin 部署

需要零成本、零注册、临时网址的方式让不同网络的玩家加入，且无需自购域名。我们采用 `cloudflared tunnel --url http://localhost:8787`（quick tunnel），它输出一个随机的 `trycloudflare.com` 临时域名。quick tunnel 只能暴露一个本地端口，因此后端在同一端口上同时服务前端静态文件与 Socket.IO 连接，玩家打开同一网址即完成页面加载与实时通道建立，无需记忆两个地址。

**Considered Options**: 曾考虑固定域名（Cloudflare 账户 + 绑定域名）。弃用原因：需要注册账户与域名，违背零注册、临时网址的约束，属后续可选升级。
