# On-prem deployment

llull runs fully offline in the browser. For a team, deploy the optional server: one shared live
document, MCP host for agents, named users with roles, a per-user audit trail and an offline license.

## 1. Install

```bash
docker compose up -d --build        # builds web app + server, binds 127.0.0.1:3001
curl http://127.0.0.1:3001/health
```

Set in a `.env` next to `docker-compose.yml`:

| Variable                   | Meaning                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `LLULL_PUBLIC_URL`         | URL browsers use (baked into the web bundle, also the allowed origin)    |
| `LLULL_ALLOWED_HOSTS`      | Host header(s) accepted behind the proxy (e.g. `cad.example.com`)        |
| `LLULL_BIND`               | Host interface to publish (`127.0.0.1` default; use the proxy to expose) |
| `LLULL_TOOLSETS`           | MCP toolsets per session (`core` default, `all`)                         |
| `LLULL_LICENSE_PUBLIC_KEY` | Vendor public key PEM (see section 3)                                    |

Without Docker: `npm ci && npm --prefix server ci && npm run build && npm --prefix server run build`,
then `LLULL_STATIC_DIR=$PWD/dist HOST=0.0.0.0 LLULL_USERS_FILE=... node server/dist/index.js`.

The container refuses to be reachable without auth: `LLULL_USERS_FILE` is always set, so until the
first user exists every request is 401.

## 2. Users and roles

```bash
docker compose exec llull node server/scripts/add-user.mjs ada "Ada Admin" admin
docker compose exec llull node server/scripts/add-user.mjs ed  "Ed Editor" editor
docker compose exec llull node server/scripts/add-user.mjs vera "Vera Viewer" viewer
```

Each call prints a fresh token once and appends only its SHA-256 to `users.json` (no restart needed;
the file is re-read on change). To revoke or rotate, delete the entry and add the user again.

| Role     | May                                                                                   |
| -------- | ------------------------------------------------------------------------------------- |
| `viewer` | `GET /live`, `/live/snapshot`, `/export/*`, read-only MCP tools (measure, query, ...) |
| `editor` | + `/command`, `/undo`, `/redo`, `/import/*`, every MCP tool                           |
| `admin`  | + `/admin/users`, `/admin/audit`, `/admin/license`                                    |

Tokens are sent as `Authorization: Bearer <token>` (MCP agents, scripts) or `?access_token=` (SSE).
Browser users open the app once at `https://cad.example.com/#token=<their token>`; it is kept in
`localStorage` and the fragment is removed. Unknown token: 401. Role too low: 403.
Named-user mode supersedes `MCP_AUTH_TOKEN`.

Audit (admin): `curl -H "Authorization: Bearer $ADMIN" "$URL/admin/audit?user=ed&since=2026-01-01T00:00:00Z&limit=200"`.
Each line of `audit.jsonl`: `{ ts, userId, userName, source: rest|mcp, command, paramsSha256, summary,
affectedCount, epoch, seq }`. Only applied (document-changing) commands, undo and redo are logged;
parameters are hashed, not stored. It rotates at `LLULL_AUDIT_MAX_BYTES` keeping `LLULL_AUDIT_KEEP` files.

## 3. License

Without a license the server runs in **evaluation** mode: at most 3 named users, and the status bar
shows "Evaluation - 3 users". A license is verified offline (Ed25519) and raises the seat count
(distinct named users in `users.json`; admins first, then file order). Users beyond the seats get
HTTP 402 with an explanatory message. Expired or tampered licenses fall back to evaluation with a
warning in the logs and in `GET /license`.

Vendor side (keep the private key off customer machines and out of git):

```bash
node server/scripts/license.mjs keygen --out license-private.pem     # prints the public key PEM
echo '{"customer":"ACME","seats":10,"expires":"2027-12-31","features":[]}' > acme.json
node server/scripts/license.mjs sign acme.json --key license-private.pem > license.key
```

Customer side: put `license.key` in the license volume (`/data/license/license.key`) and set
`LLULL_LICENSE_PUBLIC_KEY` (single line with `\n` escapes, or a file path). It is re-read on change.
Check: `curl $URL/license`.

## 4. TLS

The server speaks plain HTTP; terminate TLS in a reverse proxy and keep the container on loopback.
Caddy:

```
cad.example.com {
    reverse_proxy 127.0.0.1:3001 {
        flush_interval -1      # SSE (/live, /mcp) must not be buffered
    }
}
```

nginx: `proxy_buffering off; proxy_read_timeout 1h; proxy_http_version 1.1;` on `/live` and `/mcp`.
Set `LLULL_PUBLIC_URL=https://cad.example.com` and `LLULL_ALLOWED_HOSTS=cad.example.com`.

## 5. DWG converter

The image builds LibreDWG's `dwg2dxf` from a pinned GNU release (`LIBREDWG_VERSION`, default
0.14 — Debian stable does not package LibreDWG, and Debian's tracker lists CVEs up to 0.13.4).
Verify the download by passing the published checksum:
`docker build --build-arg LIBREDWG_SHA256=<sha256 from ftp.gnu.org/gnu/libredwg> …`. Build without
DWG support with `--build-arg WITH_DWG=0`. Check with `docker compose exec llull dwg2dxf --version`.
Alternatives: mount the ODA File Converter and set `LLULL_ODA_CONVERTER=<executable>`, or set
`LLULL_DWG2DXF=off`. Without a converter `POST /import/dwg` answers 503; DXF import is unaffected.

LibreDWG is GPL-3.0: it runs as a separate program, never linked into llull. Keep it that way
(do not bundle a LibreDWG WebAssembly/library build into the app) unless llull's licence allows it.

## 6. Backup

State lives in four volumes: `llull-autosave` (the document), `llull-audit`, `llull-users`,
`llull-license`. Back them up while running:

```bash
docker run --rm -v llull_llull-autosave:/d -v "$PWD":/b busybox tar czf /b/llull-autosave.tgz -C /d .
```

(repeat per volume; prefix is your compose project name). Restore by extracting into an empty
volume before starting. Treat `users.json` as sensitive (token hashes).

## 7. Upgrade

```bash
git pull && docker compose up -d --build
```

Volumes are kept. The autosave is versioned and migrated on load; an unreadable one is moved aside
as `autosave.json.unreadable-<ts>` and the server starts empty (restore from backup). Roll back by
checking out the previous tag and rebuilding.
