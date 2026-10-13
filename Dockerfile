# llull on-prem image: web app (Vite) + Node server (MCP host, live document, audit, licensing).
#   docker build --build-arg LLULL_PUBLIC_URL=https://cad.example.com -t llull .
# LLULL_PUBLIC_URL is baked into the web bundle (where the browser reaches the server).

# ---- build ---------------------------------------------------------------------------------
# Base images are pinned by digest (Dependabot bumps them, .github/dependabot.yml).
FROM node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS build
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

# ---- DWG converter -------------------------------------------------------------------------
# LibreDWG's dwg2dxf gives DWG import. Debian stable does not package it (and Debian lists CVEs
# up to 0.13.4), so a pinned release is built from source. The tarball must match
# LIBREDWG_SHA256 (verified against the maintainer's signature, key 38A4167B0DB69E49C5F7216CB8C28866AB27A7A2);
# LIBREDWG_URL may point at a mirror, the checksum keeps it honest. WITH_DWG=0 skips the stage.
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS dwg
ARG WITH_DWG=1
ARG LIBREDWG_VERSION=0.14
ARG LIBREDWG_SHA256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275
ARG LIBREDWG_URL=https://ftp.gnu.org/gnu/libredwg/libredwg-${LIBREDWG_VERSION}.tar.xz
RUN mkdir -p /out/bin /out/lib && if [ "$WITH_DWG" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends build-essential ca-certificates curl xz-utils pkg-config \
      && curl -fsSL -o /tmp/libredwg.tar.xz "$LIBREDWG_URL" \
      && echo "$LIBREDWG_SHA256  /tmp/libredwg.tar.xz" | sha256sum -c - \
      && mkdir /tmp/src && tar -xJf /tmp/libredwg.tar.xz -C /tmp/src --strip-components=1 \
      && cd /tmp/src && ./configure --prefix=/usr/local --disable-bindings --disable-python --disable-docs --disable-static \
      && make -j"$(nproc)" && make install \
      && cp /usr/local/bin/dwg2dxf /out/bin/ && cp -P /usr/local/lib/libredwg.so* /out/lib/; \
    fi

# ---- runtime -------------------------------------------------------------------------------
FROM node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567
COPY --from=dwg /out/bin/ /usr/local/bin/
COPY --from=dwg /out/lib/ /usr/local/lib/
RUN ldconfig
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
    LLULL_LICENSE_FILE=/data/license/license.key \
    LLULL_PYTHON=off
# The image ships no Python/CadQuery: the STEP import / CadQuery bridge is off (clear "disabled"
# errors instead of spawn failures). STEP export still works with LLULL_KERNEL=occt.
VOLUME ["/data/autosave", "/data/audit", "/data/users", "/data/license"]
RUN mkdir -p /data/autosave /data/audit /data/users /data/license && chown -R node:node /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "server/dist/index.js"]
