# syntax=docker/dockerfile:1
# Aurora Support — production image (blueprint §11.1).
#
# Multi-stage:
#   deps    — production npm install (native build tools for fallback builds;
#             dev tooling excluded via --omit=dev)
#   builder — Next.js production build (output: "standalone") + esbuild bundle
#             of the deploy migration CLI
#   runner  — minimal, non-root runtime: standalone server + static assets +
#             versioned migrations
#
# Production is Postgres-gated (§11.2/§11.3): the boot gate refuses to start
# without a valid DATABASE_URL + SESSION_SECRET, and the entrypoint applies
# schema migrations BEFORE the server accepts traffic.

FROM node:24-alpine AS deps
WORKDIR /app
# better-sqlite3 ships prebuilds; the toolchain covers the no-prebuild fallback.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
# Deploy migration gate (§11.3): self-contained ESM entrypoint script.
# --packages=external keeps the app's own traced postgres driver (already in
# .next/standalone/node_modules) instead of vendoring a second copy.
RUN ./node_modules/.bin/esbuild scripts/migrate-cli.ts \
      --bundle --platform=node --format=esm --packages=external \
      --outfile=.next/standalone/migrate.mjs

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Non-root runtime user.
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
# standalone/ carries server.js + the minimal traced node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Static assets, public files, and the versioned migrations (read by the
# entrypoint migration gate and by first-use fallback).
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/migrations ./migrations
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh
USER nextjs
EXPOSE 3000
# Liveness for the platform; /health/ready (readiness + db) is the probe a
# load balancer should use. The metrics port is 127.0.0.1-bound and
# intentionally NOT exposed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
