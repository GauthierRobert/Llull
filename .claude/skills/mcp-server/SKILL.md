---
name: mcp-server
description: Build or extend llull's MCP host — the transport that exposes the command registry to external MCP agents (Claude or any MCP client). Use for the Express /mcp endpoint, toolsets and tool discovery, live sync, auth/rate-limiting, or an example agent script. Not for adding tools (those are commands — use add-command).
---

# Skill: mcp-server

MCP usability is llull's defining feature. This skill wires the transport; the tools
themselves are commands. Delegate to the `mcp-engineer` agent.

## The cardinal rule
Tools are generated from `toToolSchemas()`. NEVER hand-write a tool schema — that
duplicates the registry. A new tool = a new command (`add-command` skill). The only MCP-layer
tools are the discovery meta-tools and the exchange tools (`packages/mcp/src/exchangeTools.ts`,
backed by the server's Python bridge).

## References
- `.claude/context/command-layer.md` (registry API), `.claude/rules/architecture.md` (L1, L5, L6)
- Env + routes: `server/README.md`

## Layout
- `packages/mcp/src` (`@mcp/*`, pure, no transport): `tools.ts` (`buildMcpTools` from
  `toToolSchemas`), `dispatch.ts` (`applyMcpToolCall`, result shaping), `toolsets.ts`
  (`TOOLSETS`, `parseToolsets`, `isToolEnabled`), `discovery.ts` (`search_tools`,
  `enable_toolset`), `resources.ts`, `prompts.ts`, `conventions.ts`, `liveSync.ts`.
- `server/src` (transport only): `mcp.ts` (Streamable HTTP router, per-session `Server`),
  `mcp/sessions.ts`, `liveDocument.ts` (the shared document + command log), `index.ts` (REST +
  `/live`), `geometryKernel.ts` (`LLULL_KERNEL`), `plugins.ts` (installs default plugins first).

## Tool exposure
1. Default session = `core` toolset + `search_tools` / `enable_toolset`. `search_tools { query,
   limit? }` searches every tool; `enable_toolset { toolset }` enables one for THAT session and
   the host sends `notifications/tools/list_changed` (`capabilities.tools.listChanged: true`).
2. `LLULL_TOOLSETS=core,2d,…|all` sets a session's starting toolsets. Disabled tools return an
   error naming `enable_toolset`; they stay callable as `build_project` steps and from the UI.
3. Every tool belongs to exactly one toolset (test-guarded). Plugin commands join their plugin's
   `toolset` via `pluginToolNames`; core commands are listed in `toolsets.ts`.

## Live document & sync
- All MCP sessions and the browser share ONE document (`liveDocument.ts`). A tool call runs
  `execute` on it and appends to the command log.
- `/live` SSE: `command` `{ seq, name, params, stateHash }` per mutation, `snapshot`
  `{ seq, stateHash, document }` on connect / undo / redo / bulk replace; `GET /live/snapshot`
  for resync. Clients apply with `applyLiveCommand` (`@mcp/liveSync`). There is no UI bridge and
  no document-diff channel — don't add one.

## Rules
- Transport/`fetch`/network lives in `server/` only — `packages/*` stay fetch-free (L2).
- Auth + rate limiting at the transport (`MCP_AUTH_TOKEN`, `MCP_RATE_LIMIT_*`, REST mutation
  guard). No business logic in the server — it forwards to the registry.
- Maintain `server/examples/mcp-agent.ts` (connects, enables toolsets, drives the document).

## Verify
- `npm run check` and `npm --prefix server run typecheck && npm --prefix server test` green.
- `LLULL_TOOLSETS=all` tool list == `listCommands()` + MCP-layer tools.
- Manual: `npm --prefix server run dev`, then `npm --prefix server run agent:example`; confirm a
  tool call mutates the live document, returns a useful summary, and the UI follows over `/live`.

## Done checklist
- [ ] No hand-written tool schemas (registry is the source)
- [ ] `packages/*` fetch-free; transport in `server/`
- [ ] Tool call → `execute` → live document mutation + `command` broadcast, summary returned
- [ ] Toolset membership + discovery consistent; auth + rate limiting on `/mcp`; checks green
