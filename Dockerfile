# syntax=docker/dockerfile:1.7
# POS API image for Coolify (Build Pack: Dockerfile).
# Fast rebuilds: the npm install layer is reused until package.json /
# package-lock.json change, and npm's download cache survives between builds.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 4000
CMD ["node", "index.js"]
