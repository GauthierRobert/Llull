---
name: verify-llull
description: Run llull's full verification loop and confirm a change actually works. Use before declaring any non-trivial change done, when npm run check fails, or to validate viewport/UI behavior in the running app. Covers typecheck + lint + format + test + coverage gate + golden corpus, the server suite, and (for UI) checking the change in the desktop app through `llull --app` + `render_view`.
---

# Skill: verify-llull

Verify honestly. Report exactly what passed/failed with real output — never claim
green without running it. For deep coverage work, delegate to `test-verifier`.

## 1. Static + tests (always)
```bash
npm run check          # typecheck + arch + deadcode + lint (max-lines 500) + format:check + native:check (skipped without cargo) + test
npm run test:coverage  # gate 90 stmts / 85 branch / 90 fn / 90 lines on
                       # packages/core/src/{commands,geometry,dynamics}/** and
                       # packages/{domain-aec,domain-cae,domain-aero,domain-dynamics,design-lang,plm}/src/** (vite.config.ts)
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

## 3. Server + CLI (when `server/`, `packages/protocol` or command schemas changed)
```bash
npm --prefix server run typecheck && npm --prefix server test && npm --prefix server run build
npm --prefix desktop test     # the desktop backend + CLI --app
node server/bin/llull.cjs help && node server/bin/llull.cjs search box
```

## 4. Desktop app (for UI / viewport / interaction changes)
The UI ships only in the Electron app (no browser target). Run it, then drive and look at it from the shell:
```bash
npm --prefix desktop run build && npm --prefix desktop start   # background; after renderer edits: run build:web, restart
node server/bin/llull.cjs status                                # finds the open app (~/.llull/desktop.json)
node server/bin/llull.cjs --app exec <command> key=value …      # the window follows over /live
node server/bin/llull.cjs --app exec render_view view=iso --save shot.png   # PNG of the live document; Read it
```
- `render_view` is the deterministic reference raster of the document (views, `isolate`, `cut`, `showLabels`, `turntable`;
  `llull describe render_view`), not a screenshot of the viewport. Viewport-only behaviour (gizmos, hover, selection
  highlight, panels) is covered by `tests/component/` and by asking the user to look at the window; say which you did.
- `llull crashes list` / `show latest` must show no new report from the run.
- `npm run test:e2e` (browser Playwright on the Vite dev server) is LEGACY, being retargeted to Electron (LC1): run it if
  it covers the change, never extend it.

## 5. AI / CLI changes
Run the change through the CLI (`llull-cli` skill): `llull exec <tool> …` or `llull run plan.json` on a `--doc` file
(the native `llull-kernel` is the default; `LLULL_KERNEL=manifold` for the mesh kernel), or `--app` against the open desktop app, and confirm it mutates the document, returns a
sensible `summary`, and (with `--app`) the UI follows over `/live`.

## Report
State pass/fail per stage with the command output. List anything skipped. Only call
the change done when stages 1–2 (and 3/4/5 if relevant) are green.
