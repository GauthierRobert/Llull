---
paths:
  - 'packages/protocol/**'
  - 'server/**'
  - 'src/ui/store/**'
  - 'src/app/**'
---

# RULE: sync (live document + local backend + CLI detail, L6 as built)

- Live sync = the command log (`@protocol/liveSync`): `/live` SSE broadcasts `command`
  `{ seq, name, params, stateHash, source?, commandId? }` and `snapshot` `{ seq, stateHash, document }` events. Clients
  re-run each command with `execute` and check `stateHash`; a seq gap or hash mismatch ⇒
  `GET /live/snapshot`. No document-diff channel, no UI bridge.
- Offline: the UI queues commands in an outbox (client `commandId` per entry, acked by id) and
  replays them on reconnect, remapping ids the server minted differently. `POST /command` is
  idempotent per `commandId`; events carry a server `epoch` so `(epoch, seq)` orders resyncs
  across restarts.
- Agents use the `llull` CLI (no MCP server): `--doc` runs `execute` in-process on a file, `--app` / `--server` send
  `POST /command` / `POST /exchange` to the local backend. Toolsets (`@protocol/toolsets`) are a listing view
  (`llull list <toolset>`, UI palette); every tool stays callable. Tool schemas come only from `toToolSchemas()`.
- The backend is local-only (LC1): loopback bind, the desktop app's per-launch bearer token, no users / licence / admin.
- No business logic in `server/`; it forwards to the registry. Verify server changes with
  `npm --prefix server run typecheck && npm --prefix server test`.
