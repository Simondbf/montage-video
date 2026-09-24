# Image du site de montage : Node 22 et ffmpeg.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3013 \
    HOTE=0.0.0.0

RUN mkdir -p /data && chown node:node /data
# Pas de droits root dans le conteneur : le dossier data monté doit
# appartenir à l'utilisateur 1000 (voir README).
USER node
EXPOSE 3013
CMD ["node", "server/index.js"]
