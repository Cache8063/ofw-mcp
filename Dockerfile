# Build the esbuild bundle, then ship only the bundled HTTP entry on a minimal
# runtime. The bundle inlines every dependency except `dotenv` (which is
# optional — loadDotenvSafely swallows its absence and real env vars are used),
# so the runtime image needs no node_modules.
#
# node:22 (>=22.5) is required for the node:sqlite cache backend.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOME=/home/ofw \
    OFW_HTTP_PORT=7330 \
    OFW_CACHE_DIR=/data
WORKDIR /app
# Non-root; /data is the cache volume (message cache lives here — mount a volume
# and, if OFW_CACHE_KEY is set, it's encrypted at rest).
RUN useradd -r -u 10001 -m -d /home/ofw ofw \
    && mkdir -p /data && chown -R ofw:ofw /data
COPY --from=build --chown=ofw:ofw /app/dist/http.js ./dist/http.js
USER ofw
EXPOSE 7330
# Liveness via the built-in /healthz (node 22 has global fetch; image has no curl).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OFW_HTTP_PORT||7330)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/http.js"]
