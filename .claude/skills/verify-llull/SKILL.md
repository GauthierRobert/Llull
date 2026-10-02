---
name: verify-llull
description: Run llull's full verification loop and confirm a change actually works. Use before declaring any non-trivial change done, when npm run check fails, or to validate viewport/UI behavior in the running app. Covers typecheck + lint + format + test + coverage gate + golden corpus, the server suite, and (for UI) driving the dev server with Playwright.
---

# Skill: verify-llull

Verify honestly. Report exactly what passed/failed with real output — never claim
green without running it. For deep coverage work, delegate to `test-verifier`.

## 1. Static + tests (always)
```bash
npm run check          # typecheck + lint (max-lines 500, no allowlist) + format:check + test
npm run test:coverage  # gate 90 stmts / 85 branch / 90 fn / 90 lines on
                       # packages/core/src/commands/** and packages/domain-aec/src/**
```
On a constrained machine (few cores / low memory) cap vitest workers:
`npx vitest run --maxWorkers=2 --minWorkers=1` (also works with `--coverage`).
Target a slice while iterating: `npx vitest run tests/unit/<file>.test.ts`.
If it fails: read the actual output, diagnose, fix (or hand to `test-verifier`). A
coverage gap is a missing branch test, not a reason to lower the threshold.

## 2. Contracts + golden corpus
- `tests/unit/contract/` — `toToolSchemas()` length == `listCommands()` length, tool-schema
  snapshot, schema conformance, plugins, ExecutionContext. A schema snapshot diff must be
  intended (agents read those texts); update with `npx vitest run tests/unit/contract -u`.
- `tests/golden/` — id-normalized document snapshots of `build_project` plans + replay equality.
  A golden diff means behaviour changed: update (`npx vitest run tests/golden -u`) ONLY when the
  change is intended, and say so in the report.

## 3. Server (when `server/`, `packages/mcp` or command schemas changed)
```bash
npm --prefix server run typecheck && npm --prefix server test && npm --prefix server run build
```

## 4. Live app (for UI / viewport / interaction changes)
Start the dev server and drive it with Playwright (MCP browser tools):
```bash
npm run dev            # http://localhost:5173 (run in background); ?kernel=occt for OpenCascade
```
- `browser_navigate` to the URL.
- `browser_snapshot` + `browser_take_screenshot` to confirm render.
- Exercise the actual interaction (click toolbar, drag gizmo, select) via
  `browser_click` / `browser_drag`.
- `browser_console_messages` — must be free of errors.
- `npm run test:e2e` runs the Playwright suite (starts the dev server).

## 5. AI/MCP changes
Start the backend (`npm --prefix server run dev`; `LLULL_TOOLSETS=all` to list every tool,
`LLULL_KERNEL=occt` for B-rep), connect Claude or `npm --prefix server run agent:example`, issue a
tool call, and confirm it mutates the live document, returns a sensible `summary`, and the UI
follows over `/live`.

## Report
State pass/fail per stage with the command output. List anything skipped. Only call
the change done when stages 1–2 (and 3/4/5 if relevant) are green.
