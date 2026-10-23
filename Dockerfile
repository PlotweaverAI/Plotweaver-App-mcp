# Public MCP gateway for STORM TTS. Serves MCP over HTTP on port 8787.
# Build:  docker build -t storm-tts-gateway .
# Run:    docker run -p 8787:8787 -e STORM_API_KEY=... -e STORM_TTS_API_KEY=... \
#           -v "$PWD/gateway-data:/data" -e STORM_GATEWAY_KEYS=/data/keys.json storm-tts-gateway

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production \
    STORM_GATEWAY_HOST=0.0.0.0 \
    STORM_GATEWAY_PORT=8787 \
    STORM_GATEWAY_KEYS=/data/keys.json
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/index.js", "http"]
