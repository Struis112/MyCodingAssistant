# MyCodingAssistant container
# Multi-stage build that produces a slim runtime image with both the
# Express + Socket.IO API server and the Next.js production web app.
#
# Volumes:
#   /data/pi  -> mount your host's ~/.pi/agent so sessions + auth persist
#
# Ports:
#   3000  Next.js web UI
#   3001  API + WebSocket

# ----- 1. deps: install workspace dependencies -----
FROM node:22-slim AS deps
WORKDIR /app

# Native deps for better-sqlite3 and friends
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

# --ignore-scripts skips husky's prepare hook in the container
RUN npm ci --ignore-scripts

# ----- 2. build: compile server (tsc) + web (next build) -----
FROM node:22-slim AS build
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

# npm workspaces hoist most deps into the root node_modules; per-workspace
# node_modules are only created for conflicts. Copy what exists at deps stage.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ----- 3. run: minimal runtime image -----
FROM node:22-slim AS run
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOST=0.0.0.0 \
    PI_CODING_AGENT_DIR=/data/pi

# Copy what we actually need to run, dropping build tooling
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/packages/shared ./packages/shared

# Mountpoint for pi sessions + auth
# apps/web/public may not exist (Next.js skips it if no static assets); the
# `|| true` keeps the build green when it doesn't.
RUN if [ -d /app/apps/web/public ]; then echo "public copied"; fi

RUN mkdir -p /data/pi && chown -R node:node /data
USER node

EXPOSE 3000 3001

# Start both services and exit if either dies
CMD ["sh", "-c", "node apps/server/dist/index.js & SERVER_PID=$!; (cd apps/web && node node_modules/next/dist/bin/next start --port 3000) & WEB_PID=$!; trap 'kill $SERVER_PID $WEB_PID 2>/dev/null' INT TERM; wait -n $SERVER_PID $WEB_PID"]
