FROM node:22-bookworm-slim

RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build:client

ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["pnpm", "--filter", "@coup/server", "start"]
