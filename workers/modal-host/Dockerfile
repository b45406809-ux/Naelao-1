FROM node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c AS build

WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY workers/modal-host/package.json workers/modal-host/README.md workers/modal-host/tsconfig.json workers/modal-host/tsconfig.build.json ./workers/modal-host/
COPY workers/modal-host/src/ ./workers/modal-host/src/
RUN pnpm install --frozen-lockfile --filter @naelao/modal-host...
RUN pnpm --filter @naelao/modal-host build
RUN pnpm --filter @naelao/modal-host deploy --prod /out

FROM node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/server.js"]
