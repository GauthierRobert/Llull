# llull server

Optional Express backend. Provides:

1. **MCP host** (`/mcp`) — exposes the llull command registry to external agents (Claude or any MCP client) over the MCP Streamable HTTP transport. This is the only path for AI control of llull (architecture L6). Sessions start with the `core` toolset plus tool discovery (see below).
2. **Shared live document** — one document for every MCP session and browser tab, with autosave, broadcast to the web app as a command log over `/live`.

The server is not an npm workspace: it has its own `package.json` and imports the workspace packages through the same path aliases (`@core`, `@mcp`, `@aec`, `@kernel-*`, `@app`). `src/plugins.ts` installs the default domain plugins before anything else loads.

## Run

```bash
# From the repo root:
npm --prefix server install

# Start the MCP host (dev, auto-reload):
MCP_AUTH_TOKEN=changeme npm --prefix server run dev

# Production: bundle once, then run the bundle
npm --prefix server run build
MCP_AUTH_TOKEN=changeme npm --prefix server start
```

Variables are also read from `<repo>/.env` and `server/.env` (see `.env.example`); real
environment variables take precedence.

The server binds to `127.0.0.1:3001` by default (local tool; not reachable from the network). Override with `PORT=<n>` and `HOST=<addr>` (`HOST=0.0.0.0` to expose it; set `MCP_AUTH_TOKEN` when you do). SIGTERM/SIGINT shut down gracefully (autosave switches to synchronous writes, SSE/MCP streams closed with a 3 s time-box, connections drained, autosave flushed again); a second signal forces exit after a sync flush, and `uncaughtException` flushes before exiting. Requires Node >= 20.12.

## Routes

| Method | Path       | Description                                          |
|--------|------------|------------------------------------------------------|
| GET    | /health    | Liveness probe — returns `{ status: "ok", kernel }` (`manifold`, `occt` or `null`) |
| POST   | /mcp       | MCP Streamable HTTP — initialize + tools/list + tools/call |
| GET    | /mcp       | MCP SSE stream for server-initiated notifications (`mcp-session-id` required) |
| DELETE | /mcp       | Close the MCP session (`mcp-session-id` required); the shared document is untouched |
| GET    | /live      | SSE command log of the shared document: `snapshot` `{ epoch, seq, stateHash, document }` on connect / undo / redo, `command` `{ epoch, seq, name, params, stateHash }` per mutation; `epoch` is a random id per server process (`seq` restarts at 0 on restart, so clients compare `(epoch, seq)`: same epoch and `seq <=` known = already applied; different epoch = resync) |
| GET    | /live/snapshot | Current `{ epoch, seq, stateHash, document }` — resync after a seq gap or hash mismatch |
| POST   | /command   | Run `{ name, params, commandId? }` on the shared document (the web app's `dispatch`). A repeated `commandId` returns the first result without re-applying (bounded LRU of 1000), so network retries are safe |
| POST   | /undo, /redo | Undo / redo on the shared document (the step counter `nextStepNumber` never rewinds, so undone ids are not re-minted) |
| GET    | /export/stl | Download the live model as STL |
| GET    | /export/code | Download the model as parametric code (`?language=cadquery\|build123d\|openscad\|freecad`) |
| GET    | /export/step | Download an exact B-rep STEP file (needs the Python bridge; 503 otherwise) |

---

### POST /mcp — MCP Streamable HTTP

The MCP endpoint exposes registered llull commands as MCP tools, filtered by the session's enabled toolsets. Tool schemas are generated from `buildMcpTools()` (`packages/mcp/src/tools.ts`), which delegates to `toToolSchemas()` from the command registry — they are always in sync.

**Authentication**

If `MCP_AUTH_TOKEN` is set, every request must carry:

```
Authorization: Bearer <MCP_AUTH_TOKEN>
```

A missing or wrong token returns `401 Unauthorized`. If the env var is not set the endpoint is unprotected (local dev only — set it in production).

**MCP initialization (example with curl)**

```bash
# 1. Initialize the session
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer changeme" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "my-agent", "version": "0.1.0" }
    }
  }'

# 2. List available tools (send the `mcp-session-id` header returned by step 1 on every later request)
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer changeme" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'

# 3. Call a tool (add a box at origin)
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer changeme" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "add_box",
      "arguments": {
        "size": [10, 5, 3],
        "position": [0, 0, 0]
      }
    }
  }'
```

**tools/call response shape**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      { "type": "text", "text": "Added box <id> ..." },
      { "type": "text", "text": "Affected entity ids: <id>" }
    ],
    "isError": false
  }
}
```

`isError` is `true` for unknown tool names and for tools of a disabled toolset. A registered command that gracefully no-ops on bad params (e.g. missing entity id, or params rejected by its schema with `<name> rejected: invalid params — <path>: …`) is NOT an error — its summary is normal feedback.

**Working document (shared live document)**

Each `initialize` creates a session (UUID `mcp-session-id`, idle sessions evicted after `MCP_SESSION_TTL_MS`). All sessions read and write the SINGLE shared `CadDocument` in `src/liveDocument.ts` (restored from the autosave file on start). Every mutating `tools/call` is broadcast on `/live`, so other sessions and the web app see it immediately.

---

---

## Tool discovery (`search_tools`, `enable_toolset`)

By default a session lists only the `core` toolset plus two discovery tools (defined in `packages/mcp/src/discovery.ts`; MCP-layer tools, not registry commands):

- `search_tools { query, limit? }` — keyword search over every tool (enabled or not); returns `data.results: [{ name, toolset, enabled, description }]`.
- `enable_toolset { toolset }` — enables a toolset for the calling session only; the server then sends `notifications/tools/list_changed` (`capabilities.tools.listChanged: true`). An unknown name is an `isError` result listing the valid toolsets.

Calling a tool of a disabled toolset returns an error that names `enable_toolset`. `build_project` steps can use any command regardless.

---

## Example MCP agent

`server/examples/mcp-agent.ts` is a standalone script that connects to the llull MCP server as an external MCP client and drives the document end-to-end over the Streamable HTTP transport. It demonstrates the full round-trip: tool discovery → command execution → id chaining.

### What the demo proves

1. `tools/list` returns the `core` toolset plus the `search_tools` / `enable_toolset` discovery tools by default (`LLULL_TOOLSETS=all` lists every registry command, matching `listCommands()` — no duplication, one source of truth); the demo then calls `enable_toolset` for `3d` and `2d`.
2. `add_box` creates a 2×2×2 box and returns its entity id in `affected`.
3. `draw_circle` creates a circle and returns its entity id.
4. `extrude_sketch` receives the circle's id (parsed from step 3's result) and extrudes it into a 3-unit solid — proving that id chaining between sequential tool calls works correctly.
5. The client closes cleanly; the shared live document now holds all three entities (and the web app shows them).

### How to run

```bash
# 1. Start the server (in one terminal):
npm --prefix server run dev

# 2. (Optional) start the server with auth enabled — the script reads the same env var:
MCP_AUTH_TOKEN=changeme npm --prefix server run dev

# 3. In another terminal, run the agent:
npm --prefix server run agent:example

# 4. With auth enabled — pass the same token:
MCP_AUTH_TOKEN=changeme npm --prefix server run agent:example

# 5. Override the server URL (e.g. staging):
MCP_URL=https://my-llull-server.example.com/mcp MCP_AUTH_TOKEN=... npm --prefix server run agent:example
```

Expected output (tool names and ids will vary):

```
Connecting to llull MCP server at http://localhost:3001/mcp ...
Connected.

tools/list → <n> tool(s) registered:
  - search_tools
  - enable_toolset
  - describe_scene
  - ...

Step 1: add_box
  summary  : Added box box-<step>.1 of size 2×2×2; ...
  affected : box-<step>.1

Step 2: draw_circle
  summary  : Drew circle ... with radius 1.
  affected : <circle id>

Step 3: extrude_sketch (source: <circle id>)
  summary  : Extruded <circle id> into extrusion ... with depth 3.
  affected : <extrusion id>

Done. Client closed cleanly.
```

### Troubleshooting

- **"Failed to connect"** — the server is not running. Start it with `npm --prefix server run dev`.
- **401 Unauthorized** — the server was started with `MCP_AUTH_TOKEN` but the script was not given a matching token. Pass `MCP_AUTH_TOKEN=<token>` before the run command.
- **extrude_sketch no-op** — the circle `id` was not found in the server's working document. This can happen if the document was cleared or replaced (e.g. `clear_document`, `load_document`, or a restart with autosave disabled) between step 2 and step 3.

---

## Environment variables

| Variable                   | Required | Default           | Description                                              |
|----------------------------|----------|-------------------|----------------------------------------------------------|
| `PORT`                     | no       | `3001`            | Listening port                                           |
| `MCP_AUTH_TOKEN`           | recommended | —             | Bearer token guarding `/mcp`. Unset = unprotected (warn) |
| `MCP_RATE_LIMIT_MAX`       | no       | `600`             | Max requests per window per IP on `/mcp` (0 or invalid = default) |
| `MCP_RATE_LIMIT_WINDOW_MS` | no       | `60000`           | Rate limit window in milliseconds (default: 1 minute)    |
| `HOST`                     | no       | `127.0.0.1`       | Bind address. Use `0.0.0.0` only with `MCP_AUTH_TOKEN` set |
| `LLULL_ALLOWED_ORIGINS`    | no       | `http://localhost:5173,http://localhost:5174,http://localhost:3000` | Comma-separated browser origins for CORS and the REST mutation guard. Disallowed origins get no CORS headers |
| `LLULL_REQUIRE_TOKEN_FOR_REST` | no   | unset             | `true` + `MCP_AUTH_TOKEN`: `/command`, `/undo`, `/redo` mutations always need the bearer token. Build the web app with `VITE_LLULL_API_TOKEN` set to the same token so the UI sends it |
| `LLULL_ALLOWED_HOSTS`      | no       | unset             | Comma-separated extra `Host` header values (`name` = any port, `name:port` = exact). `localhost`, `127.0.0.1`, `[::1]` are always allowed (DNS-rebinding defence). If `HOST` is non-loopback and this is unset, any Host is accepted |
| `LLULL_ALLOW_UNAUTHENTICATED` | no    | unset             | `true` lets the server start on a non-loopback `HOST` without `MCP_AUTH_TOKEN`. Default: it refuses to start |
| `LLULL_REST_RATE_LIMIT_MAX` | no      | `600`             | Max requests per window per IP on `/command`, `/undo`, `/redo`, `/export/stl` |
| `LLULL_REST_RATE_LIMIT_WINDOW_MS` | no | `60000`          | REST rate limit window |
| `LLULL_BODY_LIMIT`         | no       | `2mb`             | JSON body size limit (413 beyond it) |
| `LLULL_AUTOSAVE_PATH`      | no       | `server/.autosave.json` | Autosave file (written atomically via temp file + rename) |
| `LLULL_AUTOSAVE_DEBOUNCE_MS` | no     | `300`             | Autosave write coalescing delay; flushed on shutdown |
| `LLULL_AUTOSAVE_DISABLED`  | no       | unset             | `true` disables autosave |
| `MCP_SESSION_TTL_MS` / `MCP_SESSION_SWEEP_MS` | no | `1800000` / `60000` | Idle MCP session eviction |
| `LLULL_KERNEL`             | no       | `manifold`        | Geometry kernel: `manifold` or `occt` (OpenCascade WASM, ~63 MB, ~1.5 s cold start; needed for `fillet_edge`). Same setting as the browser's `?kernel=occt`. Falls back to Manifold with a warning if OCC fails to load. `GET /health` reports the active `kernel` |
| `LLULL_PYTHON`             | no       | `python3`         | Python with CadQuery for `export_step` / `import_step` / `import_code`; `off` disables the bridge. See [docs/CAD_EXCHANGE.md](../docs/CAD_EXCHANGE.md) |
| `LLULL_PYTHON_BUILD123D`   | no       | `LLULL_PYTHON`    | Python with build123d (keep it in its own virtualenv) |
| `LLULL_PYTHON_TIMEOUT_MS`  | no       | `120000`          | Per-request Python timeout |
| `LLULL_EXCHANGE_DIR`       | no       | unset             | Directory for the exchange tools' `path` arguments; `export_step` also saves there |
| `LLULL_ALLOW_CODE_EXECUTION` | no     | unset             | `1` enables `import_code`, which **runs arbitrary Python** with server privileges |
| `LLULL_TOOLSETS`           | no       | `core`            | Comma-separated MCP toolsets a session starts with: `core` (always on: core commands + the `search_tools` / `enable_toolset` discovery tools), `2d`, `3d`, `measure`, `parametric`, `assembly`, `exchange`, `building`, or `all` (every tool, the pre-MG6.3 behavior). Unset = `core` only, so clients do not load ~230 schemas; an agent calls `search_tools` to find a tool and `enable_toolset` to load its toolset for that session (the server then sends `notifications/tools/list_changed`). Unknown names are ignored with a warning. Prompts that need a hidden toolset are hidden until it is enabled. Hidden tools stay usable as `build_project` steps and in the UI. See `packages/mcp/src/toolsets.ts`, `packages/mcp/src/discovery.ts` |

### REST mutation policy (`/command`, `/undo`, `/redo`)

The browser UI cannot attach a token to these, so they are guarded by origin instead of being open:

1. Valid `Authorization: Bearer <MCP_AUTH_TOKEN>` -> allowed.
2. `Origin` header present and not in `LLULL_ALLOWED_ORIGINS` -> `403` (blocks cross-site requests).
3. `MCP_AUTH_TOKEN` set and no `Origin` and no bearer (curl, scripts) -> `401`.
4. Allowed browser origin, or no token configured -> allowed.

The `Origin` allowlist is CSRF protection only: `Origin` is forged trivially by curl. Therefore when `MCP_AUTH_TOKEN` is set, REST mutations from a non-loopback peer socket always require the bearer, regardless of `Origin`. A non-loopback `HOST` without `MCP_AUTH_TOKEN` refuses to start (override: `LLULL_ALLOW_UNAUTHENTICATED=true`). `LLULL_REQUIRE_TOKEN_FOR_REST=true` additionally demands the bearer from loopback clients (build the web app with `VITE_LLULL_API_TOKEN`; point it at a non-default server with `VITE_LLULL_SERVER_URL`). Bearer comparison is constant-time and the `Bearer` scheme is case-insensitive. Malformed JSON returns `400`, oversize bodies `413`, throwing commands return `isError` results.
