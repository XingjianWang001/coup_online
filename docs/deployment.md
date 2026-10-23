# 云服务器部署

本配置适用于一台 Ubuntu 24.04 云服务器。Node 服务同时提供网页和 Socket.IO；Docker Compose 默认仅将端口绑定到服务器的 `127.0.0.1:8787`。不需要数据库，房间及对局在服务重启后清空。

## 一键私有部署（Windows / Mac）

在仓库根目录运行：Windows PowerShell 中为 `.\deploy.cmd`，Mac 上为 `./deploy.sh`（需要 PowerShell 7：`brew install powershell`）。两者运行同一个 `scripts/deploy-private.ps1`，下文的 `-Revision`、`-AccessOnly` 等参数用法相同。首次运行输入服务器 IPv4 地址或域名、SSH 用户名（默认 `ubuntu`）和本机 PEM 文件完整路径；设置保存在 Git 忽略的 `.deploy-private.local.json`，其中只记录 PEM 的路径，PEM 文件始终留在本机。每次连接时脚本使用一份收紧权限的临时副本，结束后删除。之后每次运行相同命令即可更新。

命令从 `origin/dev` 取得最新提交，只打包该提交中的文件，不包含未提交改动；通过 SSH 上传、在 Ubuntu 24.04 上检查或安装 Docker、构建并启动应用，然后检查服务器和本机隧道两端的 `/healthz`。成功后打开 `http://127.0.0.1:18887`，保持命令窗口运行；按 `Ctrl+C` 关闭隧道；若 Windows 继续询问 `Terminate batch job (Y/N)?`，输入 `Y`。之后只想重新打开私有访问而不更新服务器时，运行 `.\deploy.cmd -AccessOnly`（Mac 为 `./deploy.sh -AccessOnly`）。SSH 密钥口令或远端 `sudo` 密码如有要求，会在运行时提示，不会保存。

更新前请确认无人正在对局。构建失败不会替换正在运行的容器；如果启动或健康检查失败，命令会报错并显示日志，不会自动回滚。需要恢复时可运行 `.\deploy.cmd -Revision <上次成功的完整提交 SHA>`，上次成功的 SHA 记录在服务器的 `~/.coup-online/current`。服务器上的旧版本目录会保留；磁盘空间不足时需人工清理。本机需要 Git 和 OpenSSH 客户端，服务器需要能访问软件源和 Docker 镜像仓库。

## 私有部署与验证

1. 在服务器安装 Docker Engine 和 Compose。Ubuntu 24.04 可使用系统软件源的 `docker.io` 与 `docker-compose-v2` 包：

   ```bash
   sudo apt-get update
   sudo apt-get install -y docker.io docker-compose-v2
   sudo systemctl enable --now docker
   ```

   上海服务器若拉取 Docker Hub 基础镜像超时，可按[腾讯云镜像源文档](https://cloud.tencent.com/document/product/213/8623)在 Docker 的 `/etc/docker/daemon.json` 中加入 `"registry-mirrors": ["https://mirror.ccs.tencentyun.com"]`，然后运行 `sudo systemctl restart docker`。如果该文件已有其他设置，应合并 JSON 内容，不要覆盖原配置。

2. 将仓库源码放到服务器，例如 `/home/ubuntu/coup-online`。至少需要 `packages/`、根目录的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`Dockerfile`、`.dockerignore`、`compose.yaml` 和 `Caddyfile`。不要上传 PEM 密钥或本地 `.env`。

3. 在该目录启动应用：

   ```bash
   sudo docker compose up -d --build app
   sudo docker compose ps
   curl -fsS http://127.0.0.1:8787/healthz
   ```

   健康检查应输出 `ok`。`sudo docker compose logs --tail=100 app` 可查看启动失败原因。

4. 在 Windows PowerShell 中运行 SSH 端口转发，并保持该终端打开。先将命令中的 PEM 路径和 `SERVER_IP` 换成自己的值。下面的命令只创建一个临时密钥副本，关闭 SSH 后会删除它；原 PEM 文件不会改变：

   ```powershell
   $keyCopy = Join-Path $env:TEMP ("coup-online-$([guid]::NewGuid()).pem")
   try {
     Copy-Item -LiteralPath 'C:\path\to\server.pem' -Destination $keyCopy
     icacls $keyCopy /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
     ssh -N -i $keyCopy -o ExitOnForwardFailure=yes -L 127.0.0.1:18887:127.0.0.1:8787 ubuntu@SERVER_IP
   } finally {
     if (Test-Path -LiteralPath $keyCopy) { Remove-Item -LiteralPath $keyCopy -Force }
   }
   ```

   然后在本机浏览器打开 `http://127.0.0.1:18887`。可以开多个无痕窗口，用不同昵称建房、输入房间码加入并完成一局。此时网页端口没有对公网开放。Mac 上的密钥副本可使用 `chmod 600 /path/to/server.pem` 限制读取权限，再以同样的 `-L 18887:127.0.0.1:8787` 连接。

## 更新与排查

更新源码后，在服务器目录执行 `sudo docker compose up -d --build app`。构建成功后 Compose 会替换容器；正在进行的房间和对局会丢失，宜先通知玩家。`sudo docker compose logs --tail=100 app` 查看日志，`sudo docker compose ps` 查看容器状态。云服务器防火墙无需为私有验证开放 8787 端口。

## 启用固定网址

取得域名并完成公开发布所需手续后，将域名的 A 记录指向服务器公网 IP，并在腾讯云轻量应用服务器的防火墙开放 TCP 80 和 443。

使用一键部署时，在 `.deploy-private.local.json` 中加入 `"Domain": "实际域名"`（例如 `"coup.davidxjwang.com"`），再运行部署命令。同一个应用可用多个域名访问，用逗号分隔，例如 `"coup.davidxjwang.com,coup.surwhy.com"`；各域名共用同一批房间。脚本每次发布都会在新版本目录写入 `SITE_DOMAIN` 与 `TRUST_PROXY=1`，以 `public` 配置同时启动应用和 Caddy，最后从本机逐个检查 `https://域名/healthz`，任一域名失败即报错并指出该域名；全部成功后直接退出，不再开 SSH 隧道。新增域名时先配置 A 记录，再部署。删去 `Domain` 后再次部署会移除 Caddy 容器、恢复私有部署行为；`.\deploy.cmd -AccessOnly` 仍可打开 SSH 隧道排查问题。首页底部的 ICP 与公安备案号按访问域名取自 `packages/client/src/App.tsx` 的 `FILINGS`；未登记的域名（含 localhost 和 SSH 隧道）不显示页脚。新增或更换域名、备案主体时需同步修改，并且要先合入 `dev` 再部署。

手动部署时，在项目目录的 `.env` 写入 `SITE_DOMAIN=实际域名` 与 `TRUST_PROXY=1`（多个域名写成 `SITE_DOMAIN=a.example.com, b.example.com`，逗号后须有空格），然后执行：

```bash
sudo docker compose --profile public up -d --build
```

Caddy 会为该域名申请 HTTPS 证书，并代理网页与 Socket.IO；`https://实际域名/healthz` 应返回 `ok`。应用自身的 8787 端口仍只绑定服务器本机。域名应先正确解析到此服务器，否则证书申请不会成功。不要在没有域名时把服务器 IP 填入 `SITE_DOMAIN` 来期待浏览器信任的 HTTPS。

## 同一服务器上的其他站点

这个 Caddy 也是整台服务器的入口（[ADR 0010](adr/0010-coup-caddy-as-shared-server-edge.md)）。公网发布时，部署脚本会创建 `~/.edge/sites` 与 `~/.edge/www`，并通过 `.env` 的 `EDGE_DIR` 将它们只读挂载到 Caddy 容器的 `/etc/caddy/sites` 与 `/srv/www`。个人主页等站点由各自的仓库上传文件，例如 `~/.edge/sites/www.caddy`：

```caddy
www.davidxjwang.com {
  encode zstd gzip
  root * /srv/www
  file_server
}

davidxjwang.com {
  redir https://www.davidxjwang.com{uri} permanent
}
```

只更新 `~/.edge/www` 里的静态文件时，不需要重启或重载 Caddy。新增或修改片段后，在服务器上运行 `sudo docker exec coup-online-caddy-1 caddy reload --config /etc/caddy/Caddyfile`。如果之后重新部署 coup，Caddy 启动时也会读入这些片段。新域名同样需要配置 A 记录，Caddy 会自动申请证书。去掉 coup 的 `Domain` 会同时停掉这些站点。

当前项目借用了《Coup》的名称和规则相关表达；公开发布前，应根据取得的授权回复和主管部门要求确认知识产权与备案／游戏审批条件。私有验证不等于已经满足公开发布条件。
