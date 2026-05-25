---
name: verify-llull
description: Run llull's full verification loop and confirm a change actually works. Use before declaring any non-trivial change done, when npm run check fails, or to validate viewport/UI behavior in the running app. Covers typecheck + lint + test + coverage gate, and (for UI) driving the dev server with Playwright.
---

# Skill: verify-llull

Verify honestly. Report exactly what passed/failed with real output — never claim
green without running it. For deep coverage work, delegate to `test-verifier`.

## 1. Static + tests (always)
```bash
npm run check          # typecheck + lint + test — must be green
npm run test:coverage  # core/commands/** gate: 90 stmts / 85 branch / 90 fn / 90 lines
```
If it fails: read the actual output, diagnose, fix (or hand to `test-verifier`). A
coverage gap is a missing branch test, not a reason to lower the threshold.

## 2. Registry invariant
Confirm `toToolSchemas()` length == `listCommands()` length (a unit test guards this;
it must pass). Every command is reachable by UI and MCP.

## 3. Live app (for UI / viewport / interaction changes)
Start the dev server and drive it with Playwright (MCP browser tools):
```bash
npm run dev            # http://localhost:5173 (run in background)
```
- `browser_navigate` to the URL.
- `browser_snapshot` + `browser_take_screenshot` to confirm render.
- Exercise the actual interaction (click toolbar, drag gizmo, select) via
  `browser_click` / `browser_drag`.
- `browser_console_messages` — must be free of errors.

## 4. AI/MCP changes
Start the backend (`npm --prefix server run dev`), connect Claude or an external MCP
agent, issue a tool call, and confirm it mutates the live document and returns a
sensible `summary`.

## Report
State pass/fail per stage with the command output. List anything skipped. Only call
the change done when stages 1–2 (and 3/4 if relevant) are green.
