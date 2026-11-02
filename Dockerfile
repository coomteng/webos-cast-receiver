# webos-cast-receiver — zero-dependency Node DLNA MediaRenderer.
# SSDP needs LAN multicast (UDP 1900): run with --network host.
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY app ./app
COPY sim ./sim
# data/ holds the persistent device UUID (phones key their device cache on it).
VOLUME ["/app/data"]
EXPOSE 8790
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://${BIND_ADDR:-127.0.0.1}:${PORT:-8790}/healthz || exit 1
CMD ["node", "server/server.js"]
