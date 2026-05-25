---
name: mcp-server
description: Build or extend llull's MCP host — the transport that exposes the command registry to external MCP agents (Claude or any MCP client). Use for the Express /mcp endpoint, auth/rate-limiting, or an example agent script. Not for adding tools (those are commands — use add-command).
---

# Skill: mcp-server

MCP usability is llull's defining feature. This skill wires the transport; the tools
themselves are commands. Delegate to the `mcp-engineer` agent.

## The cardinal rule
Tools are generated from `toToolSchemas()`. NEVER hand-write a tool schema — that
duplicates the registry. A new tool = a new command (`add-command` skill).

## References
- `.claude/context/command-layer.md` (registry API), `.claude/rules/architecture.md` (L1, L6)

## MCP host — `src/core/mcp` + `server`
1. Serve `toToolSchemas()` over MCP (Streamable HTTP at `/mcp`). On a call, run
   `execute` against the shared document; return `summary` + `affected` as the result.
   This is how Claude or any MCP agent drives llull.
2. Transport/`fetch`/network lives in `server/` only — `core/` stays fetch-free (L2).
3. Add auth + rate limiting at the transport (`MCP_AUTH_TOKEN`, `MCP_RATE_LIMIT_*`).
   No business logic in the server — it forwards to the registry.
4. Maintain an example external-agent script that connects and drives the app.

## Verify
- Tools served == `listCommands()`. `npm run check` green.
- Manual: start `npm --prefix server run dev`, connect an MCP agent, confirm a tool
  call mutates the live document and returns a useful summary.

## Done checklist
- [ ] No hand-written tool schemas (registry is the source)
- [ ] `core/` fetch-free; transport in `server/`
- [ ] Tool call → `execute` → live document mutation, summary returned
- [ ] Auth + rate limiting on `/mcp`; checks green
