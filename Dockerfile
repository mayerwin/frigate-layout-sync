FROM node:22-alpine
WORKDIR /app

# docker-cli: the companion talks to the Docker socket to keep Frigate's nginx
# injection in place (and to reload nginx) — see src/nginx.js.
RUN apk add --no-cache docker-cli

# install only runtime deps (js-yaml)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV PORT=3000 \
    DATA_DIR=/app/data \
    FRIGATE_CONTAINER=frigate \
    LAYOUTSYNC_UPSTREAM=frigate-layout-sync:3000
EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
