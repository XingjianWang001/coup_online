# 腾讯云长期部署 Resources

## Knowledge

- [腾讯云：轻量应用服务器购买方式](https://cloud.tencent.com/document/product/1207/44580)
  官方选购说明。用于选择地域、操作系统镜像与续费方式。
- [腾讯云：轻量应用服务器使用限制](https://cloud.tencent.com/document/product/1207/44376)
  官方限制与备案说明。用于判断中国内地和境外地域的差别。
- [腾讯云：ICP 备案新手指引](https://cloud.tencent.com/document/product/243/45097)
  中国内地服务器绑定网站域名时的官方备案入口与流程。
- [腾讯云：配置安全组](https://cloud.tencent.com/document/product/213/15377)
  官方端口规则说明。用于只开放 SSH、HTTP 与 HTTPS。
- [腾讯云 DNSPod：云解析 DNS 产品介绍](https://cloud.tencent.com/document/product/302/2589)
  官方 A 记录和域名解析说明。用于把子域名指向服务器公网 IP。
- [Docker：在 Ubuntu 安装 Docker Engine](https://docs.docker.com/engine/install/ubuntu/)
  Docker 官方生产安装方法。用于安装 Docker Engine 与 Compose 插件。
- [Docker Compose：服务与 restart 策略](https://docs.docker.com/reference/compose-file/services/)
  Compose 官方参考。用于理解 `restart: unless-stopped` 的恢复行为。
- [Caddy：Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
  Caddy 官方证书签发、续期及 HTTP 自动跳转 HTTPS 的说明。
- [Caddy：Reverse proxy quick-start](https://caddyserver.com/docs/quick-starts/reverse-proxy)
  Caddy 官方反向代理教程。用于把 80/443 流量转发到应用的 8787 端口。

## Wisdom (Communities)

- [腾讯云开发者社区](https://cloud.tencent.com/developer)
  遇到账号、备案或地域特有问题时检索经验；最终仍以腾讯云官方文档和工单答复为准。
- [Caddy Community](https://caddy.community/)
  用于排查 ACME 证书签发、DNS 与反向代理问题。
