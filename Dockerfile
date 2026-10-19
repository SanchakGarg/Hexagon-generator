FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web /usr/share/nginx/html/web
COPY hexagon /usr/share/nginx/html/hexagon
COPY Node /usr/share/nginx/html/Node
COPY Edge /usr/share/nginx/html/Edge

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/web/ >/dev/null || exit 1
