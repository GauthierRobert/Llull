# llull server

The local backend (one per machine, loopback only — decision LC1) and the `llull` CLI. Provides:

1. **Shared live document** — the document the desktop window and `llull --app` edit together, with autosave, broadcast to the UI as a command log over `/live`.
2. **Exchange and native I/O** — STEP / DWG / CadQuery exchange, FE meshing and solving, native compute, exports (Python, DWG converters and native binaries sit behind ports here).
3. **The `llull` CLI** (`src/cli/`) — the agent path (Claude Code, scripts, CI): see [CLI](#cli-llull) below. There is no MCP server (removed, LC1 step 4).

The server is not an npm workspace: it has its own `package.json` and imports the workspace packages through the same path aliases (`@core`, `@protocol`, `@aec`, `@kernel-*`, `@app`). `src/plugins.ts` installs the default domain plugins before anything else loads.

## Run

```bash
# From the repo root:
npm --prefix server install

# Start the backend (dev, auto-reload):
npm --prefix server run dev

# Production: bundle once, then run the bundle
npm --prefix server run build
npm --prefix server start
```

Variables are also read from `<repo>/.env` and `server/.env` (see `.env.example`); real
environment variables take precedence.

The server binds to `127.0.0.1:3001` by default (local tool; not reachable from the network). Override the port with `PORT=<n>`; `HOST` must stay a loopback address (the backend is local-only, LC1: a non-loopback `HOST` refuses to start). SIGTERM/SIGINT shut down gracefully (autosave switches to synchronous writes, SSE streams closed with a 3 s time-box, connections drained, autosave flushed again); a second signal forces exit after a sync flush, and `uncaughtException` flushes before exiting. Requires Node >= 22.12.

## Routes

| Method | Path           | Description                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /health        | Liveness probe — returns `{ status: "ok", kernel }` (`manifold`, `occt` or `null`)                                                                                                                                                                                                                                                                                            |
| GET    | /live          | SSE command log of the shared document: `snapshot` `{ epoch, seq, stateHash, document }` on connect / undo / redo, `command` `{ epoch, seq, name, params, stateHash }` per mutation; `epoch` is a random id per server process (`seq` restarts at 0 on restart, so clients compare `(epoch, seq)`: same epoch and `seq <=` known = already applied; different epoch = resync) |
| POST   | /live/ticket   | `{ ticket, expiresInMs }`: single-use 30 s ticket for `GET /live?ticket=` (header auth only; see Read routes)                                                                                                                                                                                                                                                                 |
| GET    | /live/snapshot | Current `{ epoch, seq, stateHash, document }` — resync after a seq gap or hash mismatch                                                                                                                                                                                                                                                                                       |
| POST   | /command       | Run `{ name, params, commandId? }` on the shared document (the web app's `dispatch`). A repeated `commandId` returns the first result without re-applying (bounded LRU of 1000), so network retries are safe                                                                                                                                                                  |
| POST   | /undo, /redo   | Undo / redo on the shared document (the step counter `nextStepNumber` never rewinds, so undone ids are not re-minted)                                                                                                                                                                                                                                                         |
| GET    | /export/stl    | Download the live model as STL                                                                                                                                                                                                                                                                                                                                                |
| GET    | /export/code   | Download the model as parametric code (`?language=cadquery\|build123d\|openscad\|freecad`)                                                                                                                                                                                                                                                                                    |
| GET    | /export/step   | Download an exact B-rep STEP file (needs the Python bridge; 503 otherwise)                                                                                                                                                                                                                                                                                                    |
| POST   | /exchange      | Run an exchange tool `{ name, params }` (`export_step`, `import_step`, `import_dwg`, `import_code`) on the shared document: the `@protocol` exchange handlers for REST callers (the CLI with `--app` / `--server`). Answers `{ summary, affected, isError, data?, changed }`                                                                                                  |

## CLI (`llull`)

The registry from a shell — for terminal agents (Claude Code), scripts and CI. Same commands as
the UI, no server needed: it runs them on a local document file, or forwards them to a
running server's live document with `--server`.

```bash
node server/bin/llull.cjs help                       # or: npm run -s llull -- help (repo root)
node server/bin/llull.cjs search fillet edge         # discover; describe <cmd> for the params
node server/bin/llull.cjs add_box size=[10,10,10] --doc part.llull.json
node server/bin/llull.cjs run plan.json --validate   # build_project plan file (then without --validate)
node server/bin/llull.cjs export_stl format=binary --save out/part.stl
node server/bin/llull.cjs render_view --save view.png
node server/bin/llull.cjs import_step file=part.step --doc part.llull   # exchange tools too (Python bridge)
node server/bin/llull.cjs add_box size=[1,1,1] --server http://localhost:3001 --token $LLULL_TOKEN
node server/bin/llull.cjs add_box size=[1,1,1] --app                    # the running desktop app
```

`server/bin/llull.cjs` bundles `src/cli/bin.ts` with esbuild into `dist/llull-cli.cjs` when a source
changed, then runs the bundle. Exit codes: 0 ok, 1 the command failed or changed nothing, 2 usage.
Agent procedure: `.claude/skills/llull-cli/SKILL.md`.

## Environment variables

| Variable                          | Required    | Default                                                             | Description                                                                                                                                                                                                                                                        |
| --------------------------------- | ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                            | no          | `3001`                                                              | Listening port                                                                                                                                                                                                                                                     |
| `LLULL_AUTH_TOKEN`                  | recommended | —                                                                   | Bearer token guarding the REST routes (the desktop app sets a per-launch one; legacy name, kept for `desktop/`)                                                                                                                                                    |
| `HOST`                            | no          | `127.0.0.1`                                                         | Bind address; loopback only (anything else refuses to start)                                                                                                                                                                                                       |
| `LLULL_ALLOWED_ORIGINS`           | no          | `http://localhost:5173,http://localhost:5174,http://localhost:3000` | Comma-separated browser origins for CORS and the REST mutation guard. Disallowed origins get no CORS headers                                                                                                                                                       |
| `LLULL_REQUIRE_TOKEN_FOR_REST`    | no          | unset                                                               | `true` + `LLULL_AUTH_TOKEN`: `/command`, `/undo`, `/redo` mutations always need the bearer token. Build the web app with `VITE_LLULL_API_TOKEN` set to the same token so the UI sends it                                                                             |
| `LLULL_REST_RATE_LIMIT_MAX`       | no          | `600`                                                               | Max requests per window per IP on `/command`, `/undo`, `/redo`, `/export/stl`                                                                                                                                                                                      |
| `LLULL_REST_RATE_LIMIT_WINDOW_MS` | no          | `60000`                                                             | REST rate limit window                                                                                                                                                                                                                                             |
| `LLULL_LIVE_MAX_PER_CLIENT`       | no          | `8`                                                                 | Max concurrent `GET /live` SSE streams per client IP (429 beyond; 64 global cap stays). Not applied to proxied requests (every client would share the proxy IP)                                                                                                    |
| `LLULL_BODY_LIMIT`                | no          | `2mb`                                                               | JSON body size limit (413 beyond it)                                                                                                                                                                                                                               |
| `LLULL_AUTOSAVE_PATH`             | no          | `server/.autosave.json`                                             | Autosave file (written atomically via temp file + rename)                                                                                                                                                                                                          |
| `LLULL_AUTOSAVE_DEBOUNCE_MS`      | no          | `300`                                                               | Autosave write coalescing delay; flushed on shutdown                                                                                                                                                                                                               |
| `LLULL_AUTOSAVE_DISABLED`         | no          | unset                                                               | `true` disables autosave                                                                                                                                                                                                                                           |
| `LLULL_KERNEL`                    | no          | unset                                                               | Geometry kernel. Unset: the native OCCT `llull-kernel` sidecar when found (`LLULL_KERNEL_BIN`, `LLULL_NATIVE_DIR`, `solver/target/release`), else Manifold with a warning (`kernel_info.fallbackReason`). `manifold` is a diagnostic override; `occt-native` requires the sidecar; `occt` is the legacy OpenCascade WASM. `GET /health` reports the active `kernel` |
| `LLULL_PYTHON`                    | no          | `python3`                                                           | Python with CadQuery for `export_step` / `import_step` / `import_code`; `off` disables the bridge. See [docs/CAD_EXCHANGE.md](../docs/CAD_EXCHANGE.md)                                                                                                             |
| `LLULL_PYTHON_BUILD123D`          | no          | `LLULL_PYTHON`                                                      | Python with build123d (keep it in its own virtualenv)                                                                                                                                                                                                              |
| `LLULL_PYTHON_TIMEOUT_MS`         | no          | `120000`                                                            | Per-request Python timeout                                                                                                                                                                                                                                         |
| `LLULL_PYTHON_QUEUE_MAX`          | no          | `16`                                                                | Python bridge requests allowed to wait for a free slot (2 run at once); more get a "busy, retry later" error (REST 503)                                                                                                                                            |
| `LLULL_EXCHANGE_DIR`              | no          | unset                                                               | Directory for the exchange tools' `path` arguments; `export_step` also saves there                                                                                                                                                                                 |
| `LLULL_FEA_CACHE`                 | no          | `~/.llull/cache/fea`                                                | Content-addressed FE mesh / results artifacts (`<sha256>.json.gz`) written by `fea_mesh` / `fea_solve`                                                                                                                                                             |
| `LLULL_GMSH_PYTHON`               | no          | `LLULL_PYTHON`                                                      | Python with the `gmsh` module for `fea_mesh` (no CadQuery needed)                                                                                                                                                                                                  |
| `LLULL_CCX`                       | no          | `ccx`                                                               | CalculiX executable for `fea_solve`                                                                                                                                                                                                                                |
| `LLULL_FEA_MESH_TIMEOUT_MS`       | no          | `600000`                                                            | `fea_mesh` bridge timeout                                                                                                                                                                                                                                          |
| `LLULL_FEA_KEEP`                  | no          | unset                                                               | `1` keeps the `fea_solve` job directory and reports it in `data.jobDirectory`                                                                                                                                                                                      |
| `LLULL_ALLOW_CODE_EXECUTION`      | no          | unset                                                               | `1` enables `import_code`, which **runs arbitrary Python** with server privileges                                                                                                                                                                                  |

### REST mutation policy (`/command`, `/undo`, `/redo`)

The browser UI cannot attach a token to these, so they are guarded by origin instead of being open:

1. Valid `Authorization: Bearer <LLULL_AUTH_TOKEN>` -> allowed.
2. `Origin` header present and not in `LLULL_ALLOWED_ORIGINS` -> `403` (blocks cross-site requests).
3. `LLULL_AUTH_TOKEN` set and no `Origin` and no bearer (curl, scripts) -> `401`.
4. Allowed browser origin, or no token configured -> allowed.

The `Origin` allowlist is CSRF protection only: `Origin` is forged trivially by curl. Therefore when `LLULL_AUTH_TOKEN` is set, REST mutations from a non-loopback peer socket always require the bearer, regardless of `Origin`. A non-loopback `HOST` refuses to start. `LLULL_REQUIRE_TOKEN_FOR_REST=true` additionally demands the bearer from loopback clients (build the web app with `VITE_LLULL_API_TOKEN`; point it at a non-default server with `VITE_LLULL_SERVER_URL`). Bearer comparison is constant-time and the `Bearer` scheme is case-insensitive. Malformed JSON returns `400`, oversize bodies `413`, throwing commands return `isError` results.

### Read routes (`/live`, `/live/snapshot`, `/export/*`)

With `LLULL_AUTH_TOKEN` set these follow the same policy as the mutation routes (anything that lets the local UI mutate lets it read), and additionally accept a single-use `?ticket=<ticket>` because `EventSource` cannot send headers: `POST /live/ticket` (bearer token in the `Authorization` header only) returns `{ ticket, expiresInMs }` (32 random bytes base64url, valid once for 30 s; at most 1024 outstanding, else `503`). The web app mints a fresh ticket per (re)connect. A token in the URL (`?access_token=`) is not accepted: it would land in logs and history. Without a token they stay open. `/live` is rate limited, capped at 64 subscribers (`503`), and a subscriber with more than 8 MB unsent is dropped (it resyncs via `/live/snapshot`).

Behind a local reverse proxy every client looks like loopback: when a token is set, a request carrying `X-Forwarded-For` or `Forwarded` is treated as a non-loopback peer and needs the bearer. An unknown `?language=` on `/export/code` returns `400`.

## Local-only (LC1)

There are no named users, roles, licence seats, audit trail or admin routes: the backend serves one person on one machine, binds
loopback only, and the desktop app guards it with a per-launch `LLULL_AUTH_TOKEN` (`LLULL_REQUIRE_TOKEN_FOR_REST=true`).
`LLULL_STATIC_DIR` serves the built renderer from the same origin (the desktop app sets it).
