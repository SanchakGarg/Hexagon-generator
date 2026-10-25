FROM node:22-alpine

WORKDIR /app
COPY server /app/server
COPY web /app/public
COPY hexagon /app/public/hexagon
COPY Node /app/public/Node
COPY Edge /app/public/Edge
# the parts list; hexwall.sh mounts the repo's copy over this one, so editing it needs only a restart
COPY parts.xlsx /app/parts.xlsx

# shared build guides live here; mount a volume so they outlive the container
ENV DATA_DIR=/data PORT=80
VOLUME /data

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
CMD ["node", "server/server.js"]
