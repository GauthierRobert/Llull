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
- Host-only ports: the renderer's `applyLiveCommand` runs `execute` WITHOUT `meshAssets` (the content-addressed mesh store, native mesh engine and kernel
  sidecar live in the backend process). A command that needs the store (`attach_mesh_asset`, `import_mesh_file fileKey`, asset-backed reads) is refused
  or differs there, the `stateHash` mismatches and the client resyncs from `/live/snapshot`; correctness never depends on the renderer re-running it
  (test: `liveSync.test.ts`). Asset-backed entities keep their display level of detail in the document, so the snapshot renders without the store.
- While the backend is unreachable the UI runs `execute` locally (undo snapshots, no outbox, no replay); the next
  snapshot replaces the local document (LC1 step 6). `POST /command` is idempotent per `commandId`; events carry
  a server `epoch` so `(epoch, seq)` orders resyncs across restarts. `source` is `rest` | `cli`.
- Agents use the `llull` CLI (no MCP server): `--doc` runs `execute` in-process on a file, `--app` / `--server` send
  `POST /command` / `POST /exchange` to the local backend. Toolsets (`@protocol/toolsets`) are a listing view
  (`llull list <toolset>`, UI palette); every tool stays callable. Tool schemas come only from `toToolSchemas()`.
- The backend is local-only (LC1): loopback bind, the desktop app's per-launch bearer token, no users / licence / admin.
- No business logic in `server/`; it forwards to the registry. Verify server changes with
  `npm --prefix server run typecheck && npm --prefix server test`.
