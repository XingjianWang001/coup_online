# 云服务器部署

本配置适用于一台 Ubuntu 24.04 云服务器。Node 服务同时提供网页和 Socket.IO；Docker Compose 默认仅将端口绑定到服务器的 `127.0.0.1:8787`。不需要数据库，房间及对局在服务重启后清空。

## 从 Windows 一键私有部署

在仓库根目录的 Windows PowerShell 中运行 `.\deploy.cmd`。首次运行输入服务器 IPv4 地址或域名、SSH 用户名（默认 `ubuntu`）和本机 PEM 文件完整路径；设置保存在 Git 忽略的 `.deploy-private.local.json`，PEM 文件始终留在 Windows。之后每次运行相同命令即可更新。

命令从 `origin/dev` 取得最新提交，只打包该提交中的文件，不包含未提交改动；通过 SSH 上传、在 Ubuntu 24.04 上检查或安装 Docker、构建并启动应用，然后检查服务器和 Windows 隧道两端的 `/healthz`。成功后打开 `http://127.0.0.1:18887`，保持命令窗口运行；按 `Ctrl+C` 关闭隧道；若 Windows 继续询问 `Terminate batch job (Y/N)?`，输入 `Y`。之后只想重新打开私有访问而不更新服务器时，运行 `.\deploy.cmd -AccessOnly`。SSH 密钥口令或远端 `sudo` 密码如有要求，会在运行时提示，不会保存。

更新前请确认无人正在对局。构建失败不会替换正在运行的容器；如果启动或健康检查失败，命令会报错并显示日志，不会自动回滚。需要恢复时可运行 `.\deploy.cmd -Revision <上次成功的完整提交 SHA>`，上次成功的 SHA 记录在服务器的 `~/.coup-online/current`。服务器上的旧版本目录会保留；磁盘空间不足时需人工清理。Windows 需要 Git 和 OpenSSH 客户端，服务器需要能访问软件源和 Docker 镜像仓库。

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

## 将来启用固定网址

取得域名并完成公开发布所需手续后，将域名的 A 记录指向服务器公网 IP，在项目目录的 `.env` 写入 `SITE_DOMAIN=实际域名` 与 `TRUST_PROXY=1`，然后执行：

```bash
sudo docker compose --profile public up -d --build
```

在腾讯云轻量应用服务器的防火墙开放 TCP 80 和 443。Caddy 会为该域名申请 HTTPS 证书，并代理网页与 Socket.IO；`https://实际域名/healthz` 应返回 `ok`。应用自身的 8787 端口仍只绑定服务器本机。域名应先正确解析到此服务器，否则证书申请不会成功。不要在没有域名时把服务器 IP 填入 `SITE_DOMAIN` 来期待浏览器信任的 HTTPS。

当前项目借用了《Coup》的名称和规则相关表达；公开发布前，应根据取得的授权回复和主管部门要求确认知识产权与备案／游戏审批条件。私有验证不等于已经满足公开发布条件。
