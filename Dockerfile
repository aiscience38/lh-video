FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV OPEN_HIGGSFIELD_STORAGE_DIR=/app/data

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs \
    && mkdir -p /app/data \
    && chown nextjs:nodejs /app/data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Next 16's standalone output omits the app-route runtimes that route handlers
# require at runtime; without these every API route returns 500.
COPY --from=builder --chown=nextjs:nodejs \
    /app/node_modules/next/dist/compiled/next-server/app-route.runtime.prod.js \
    /app/node_modules/next/dist/compiled/next-server/app-route-experimental.runtime.prod.js \
    /app/node_modules/next/dist/compiled/next-server/app-route-turbo.runtime.prod.js \
    /app/node_modules/next/dist/compiled/next-server/app-route-turbo-experimental.runtime.prod.js \
    ./node_modules/next/dist/compiled/next-server/

USER nextjs
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
