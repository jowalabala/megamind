# Build from the repo root: docker build -f apps/web/Dockerfile .
FROM node:26-alpine AS build
RUN corepack enable 2>/dev/null || npm install -g pnpm@10.34.9
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @mm/web...
ARG NEXT_PUBLIC_WORKOS_REDIRECT_URI
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @mm/web build

FROM node:26-alpine AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
USER app
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
