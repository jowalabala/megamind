# One image for the Node services; ECS picks the entrypoint (api, gateway, worker or an ops job).
# Build from the repo root: docker build -f apps/api/Dockerfile .
FROM node:26-alpine AS build
RUN corepack enable 2>/dev/null || npm install -g pnpm@10.34.9
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @mm/api... --filter @mm/worker... --filter @mm/gateway... --filter @mm/ops... --filter master-mind
RUN pnpm --filter @mm/api build && pnpm --filter @mm/worker build && pnpm --filter @mm/gateway build && pnpm --filter @mm/ops build

FROM node:26-alpine AS run
ENV NODE_ENV=production PORT=4000
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /repo/apps/api/dist ./api
COPY --from=build --chown=app:app /repo/apps/worker/dist ./worker
COPY --from=build --chown=app:app /repo/apps/gateway/dist ./gateway
# Operator one-offs (tenant purge, restore drill), run by the ops task only.
COPY --from=build --chown=app:app /repo/packages/ops/dist ./ops
USER app
EXPOSE 4000
CMD ["node", "--enable-source-maps", "api/main.js"]
