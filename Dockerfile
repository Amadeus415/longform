FROM node:24-slim

# yt-dlp powers Listen mode (audio that keeps playing with the screen locked).
# Node 24 ships built-in node:sqlite for zero-dependency multi-user persistence.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates curl \
  && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && mkdir -p /data

ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/data/longform.db

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["npx", "tsx", "server/index.ts"]
