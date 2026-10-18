# coup 的 Caddy 兼做整台服务器的入口

[ADR 0009](0009-private-cloud-staging-and-fixed-domain.md) 让 Caddy 以固定域名发布 coup，并独占服务器的 80/443。现在同一台服务器还要托管 `www.davidxjwang.com` 个人主页（独立仓库、纯静态），两者不能各自运行一个 Caddy。

## 决策

- Caddy 仍属于本仓库的 `coup-online` compose 项目。`Caddyfile` 末尾 `import /etc/caddy/sites/*.caddy`，compose 把服务器的 `~/.edge/sites` 与 `~/.edge/www` 只读挂载进 Caddy 容器。
- 其他站点由各自的仓库把 Caddy 片段放进 `~/.edge/sites/`，把静态文件放进 `~/.edge/www/`。本仓库的路由配置不写这些站点的域名，文档示例除外。目录为空时 Caddy 只给出警告，coup 照常运行。
- 已知的联动：80/443 随 `coup-online` 项目启停。去掉 coup 的 `Domain` 重新部署，或执行 `docker compose down`，会让所有站点一起下线；需要摆脱这个联动时即触发下面的条件 (b)。

## 升级条件

满足任一条件时，按 [#26](https://github.com/XingjianWang001/coup_online/issues/26) 把 Caddy 拆成独立的 edge 仓库／compose 项目，本仓库只保留 `app`：

- (a) 服务器上出现第三个站点；
- (b) 需要单独停掉 coup 或去掉它的 `Domain`，同时其他站点不能停；
- (c) 某个站点不再是纯静态，需要自己的后端容器。

在这些条件出现之前不要拆分，也不要把 `import` 当作多余配置删掉。
