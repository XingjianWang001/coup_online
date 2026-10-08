# 云服务器部署

本配置适用于一台 Ubuntu 24.04 云服务器。Node 服务同时提供网页和 Socket.IO；Docker Compose 默认仅将端口绑定到服务器的 `127.0.0.1:8787`。不需要数据库，房间及对局在服务重启后清空。

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
