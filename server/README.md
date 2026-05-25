# llull server

Optional Express backend. Provides:

1. **MCP host** (`/mcp`) — exposes the full llull command registry to external agents (Claude or any MCP client) over the MCP Streamable HTTP transport. This is the only path for AI control of llull (architecture L6).

## Run

```bash
# From the repo root:
npm --prefix server install

# Start the MCP host:
MCP_AUTH_TOKEN=changeme npm --prefix server run dev
```

The server starts on `http://localhost:3001` by default. Override with `PORT=<n>`.

## Routes

| Method | Path       | Description                                          |
|--------|------------|------------------------------------------------------|
| GET    | /health    | Liveness probe — returns `{ status: "ok" }`          |
| POST   | /mcp       | MCP Streamable HTTP — initialize + tools/list + tools/call |
| GET    | /mcp       | MCP SSE stream for server-initiated notifications    |
| DELETE | /mcp       | MCP session close (stateless v1: no-op, returns 200) |

---

### POST /mcp — MCP Streamable HTTP

The MCP endpoint exposes every registered llull command as an MCP tool. Tool schemas are generated from `buildMcpTools()` (`core/mcp`), which delegates to `toToolSchemas()` from the command registry — they are always in sync.

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

# 2. List available tools
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
        "width": 10,
        "height": 5,
        "depth": 3,
        "x": 0,
        "y": 0,
        "z": 0
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

`isError` is `true` only for unknown tool names. A registered command that gracefully no-ops on bad params (e.g. missing entity id) is NOT an error — its summary is normal feedback.

**Working document (v1 session model)**

The server holds one module-level `CadDocument` initialized from `createEmptyDocument()`. Each successful `tools/call` threads the result document forward. This is a shared, single-session store — sufficient for v1 single-agent use. A future v2 can switch to `sessionIdGenerator` mode (stateful transport) to give each client its own document.

---

---

## Example MCP agent

`server/examples/mcp-agent.ts` is a standalone script that connects to the llull MCP server as an external MCP client and drives the document end-to-end over the Streamable HTTP transport. It demonstrates the full round-trip: tool discovery → command execution → id chaining.

### What the demo proves

1. `tools/list` returns every command registered in the llull registry (the tool count matches `listCommands()` exactly — no duplication, one source of truth).
2. `add_box` creates a 2×2×2 box and returns its entity id in `affected`.
3. `draw_circle` creates a circle and returns its entity id.
4. `extrude_sketch` receives the circle's id (parsed from step 3's result) and extrudes it into a 3-unit solid — proving that id chaining between sequential tool calls works correctly.
5. The client closes cleanly; the server's working document now holds all three entities.

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

tools/list → 18 tool(s) registered:
  - add_box
  - extrude_profile
  - move_entity
  - ...

Step 1: add_box
  summary  : Added box box-<id> of size 2×2×2.
  affected : box-<id>

Step 2: draw_circle
  summary  : Drew circle circ-<id> at center (0, 0) with radius 1.
  affected : circ-<id>

Step 3: extrude_sketch (source: circ-<id>)
  summary  : Extruded circ-<id> into extrusion ext-<id> with depth 3.
  affected : ext-<id>

Done. Client closed cleanly.
```

### Troubleshooting

- **"Failed to connect"** — the server is not running. Start it with `npm --prefix server run dev`.
- **401 Unauthorized** — the server was started with `MCP_AUTH_TOKEN` but the script was not given a matching token. Pass `MCP_AUTH_TOKEN=<token>` before the run command.
- **extrude_sketch no-op** — the circle `id` was not found in the server's working document. This can happen if the server was restarted between step 2 and step 3 (the working document resets on restart).

---

## Environment variables

| Variable                   | Required | Default           | Description                                              |
|----------------------------|----------|-------------------|----------------------------------------------------------|
| `PORT`                     | no       | `3001`            | Listening port                                           |
| `MCP_AUTH_TOKEN`           | recommended | —             | Bearer token guarding `/mcp`. Unset = unprotected (warn) |
| `MCP_RATE_LIMIT_MAX`       | no       | `60`              | Max requests per window per IP on `/mcp`                 |
| `MCP_RATE_LIMIT_WINDOW_MS` | no       | `60000`           | Rate limit window in milliseconds (default: 1 minute)    |
