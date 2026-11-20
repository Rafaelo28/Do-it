# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- Bauen ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/parser/package.json packages/parser/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @do-it/web build \
 && pnpm --filter @do-it/server build \
 && pnpm --filter @do-it/server deploy --prod --legacy /out

# ---------- Laufzeit ----------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST=/app/web
WORKDIR /app/server
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/web/dist /app/web
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
