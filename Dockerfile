FROM node:22-bookworm-slim

RUN corepack enable
WORKDIR /app
# 依赖缓存层：只要锁文件不变，改源码后重建不会重新下载依赖
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --frozen-lockfile --offline && pnpm build:client

ENV NODE_ENV=production PORT=8787 CONSOLE_HOST=0.0.0.0
EXPOSE 8787 8788
CMD ["pnpm", "--filter", "@coup/server", "start"]
