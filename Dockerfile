# llull on-prem image: web app (Vite) + Node server (MCP host, live document, audit, licensing).
#   docker build --build-arg LLULL_PUBLIC_URL=https://cad.example.com -t llull .
# LLULL_PUBLIC_URL is baked into the web bundle (where the browser reaches the server).

# ---- build ---------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
COPY server/package.json server/package-lock.json ./server/
RUN npm ci && npm --prefix server ci
COPY . .
ARG LLULL_PUBLIC_URL=http://localhost:3001
ENV VITE_LLULL_SERVER_URL=${LLULL_PUBLIC_URL}
RUN npm run build && npm --prefix server run build
RUN npm --prefix server prune --omit=dev

# ---- runtime -------------------------------------------------------------------------------
FROM node:22-bookworm-slim
# LibreDWG gives DWG import (dwg2dxf). Debian ships it as libredwg-tools; if your base image's
# distro does not, the build continues without it (see docs/DEPLOYMENT.md, "DWG converter").
RUN apt-get update \
    && (apt-get install -y --no-install-recommends libredwg-tools \
        || echo "WARNING: libredwg-tools not available - DWG import disabled") \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/server/dist ./server/dist
COPY --from=build /src/server/node_modules ./server/node_modules
COPY --from=build /src/server/package.json ./server/package.json
COPY --from=build /src/server/scripts ./server/scripts
COPY --from=build /src/dist ./web

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    LLULL_STATIC_DIR=/app/web \
    LLULL_AUTOSAVE_PATH=/data/autosave/autosave.json \
    LLULL_AUDIT_FILE=/data/audit/audit.jsonl \
    LLULL_USERS_FILE=/data/users/users.json \
    LLULL_LICENSE_FILE=/data/license/license.key
VOLUME ["/data/autosave", "/data/audit", "/data/users", "/data/license"]
RUN mkdir -p /data/autosave /data/audit /data/users /data/license && chown -R node:node /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "server/dist/index.js"]
