---
paths:
  - 'packages/mcp/**'
  - 'server/**'
  - 'src/ui/store/**'
  - 'src/app/**'
---

# RULE: sync (live document + MCP host detail, L6 as built)

- Live sync = the command log (`@mcp/liveSync`): `/live` SSE broadcasts `command`
  `{ seq, name, params, stateHash }` and `snapshot` `{ seq, stateHash, document }` events. Clients
  re-run each command with `execute` and check `stateHash`; a seq gap or hash mismatch ⇒
  `GET /live/snapshot`. No document-diff channel, no UI bridge.
- Offline: the UI queues commands in an outbox (client `commandId` per entry, acked by id) and
  replays them on reconnect, remapping ids the server minted differently. `POST /command` is
  idempotent per `commandId`; events carry a server `epoch` so `(epoch, seq)` orders resyncs
  across restarts.
- MCP exposure is a view (`@mcp/toolsets`): default = `core` toolset + `search_tools` /
  `enable_toolset`; hidden tools stay callable via `execute` (UI, `build_project` steps). Tool
  schemas come only from `toToolSchemas()`.
- No business logic in `server/`; it forwards to the registry. Verify server changes with
  `npm --prefix server run typecheck && npm --prefix server test`.
