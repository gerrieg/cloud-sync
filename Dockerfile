# syntax=docker/dockerfile:1

# ---- Build: Vite frontend + TypeScript backend ----
FROM node:26-alpine AS build
WORKDIR /app
# Toolchain for better-sqlite3 in case no prebuilt binary matches
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json tsconfig.client.json vite.config.ts ./
COPY src ./src
RUN npm run build

# ---- Production dependencies only ----
FROM node:26-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Runtime ----
FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/cloud-sync.db
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY package.json ./
# The volume at /app/data inherits this ownership when it is first created
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Run node directly (not via npm) so it is PID 1 and receives SIGTERM
CMD ["node", "dist/server/index.js"]
