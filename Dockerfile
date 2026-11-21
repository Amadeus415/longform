FROM node:22-slim

# yt-dlp powers Listen mode (audio that keeps playing with the screen locked).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["npx", "tsx", "server/index.ts"]
