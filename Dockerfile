# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY extension/package.json extension/package.json
COPY shared/package.json shared/package.json
COPY designer-ui/package.json designer-ui/package.json
COPY runtime-next/package.json runtime-next/package.json
RUN npm ci --workspaces --include-workspace-root

FROM deps AS build
COPY extension extension
RUN npm run build:headless-bridge -w extension

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV BRIDGE_PORT=8080
WORKDIR /app

COPY --from=build /app/extension/dist/headlessBridge.js ./extension/dist/headlessBridge.js

RUN mkdir -p /run/secrets
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.BRIDGE_PORT || '8080') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "extension/dist/headlessBridge.js"]
