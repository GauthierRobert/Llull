# 06 E2E — Validation plan

What is validated: the harness itself (it launches, drives and observes the real desktop app, deterministically, without
weakening the release), the migration of every legacy browser suite onto it, and its contract with the central readiness
gate ([`../../VALIDATION.md`](../../VALIDATION.md)), for which it is the executor of every case with driver `electron`.

Machines: CI profiles `ci-ubuntu-swiftshader`, `ci-windows-swiftshader` (and `ci-macos-swiftshader` when the owner lifts the
macOS deferral); the owner's Windows 11 workstation `ref-win11` (hardware GPU) for local runs. Grades follow
[`../../../plant/TEMPLATE.md`](../../../plant/TEMPLATE.md): **A** read in a primary source or counted / measured in llull,
**B** one secondary extract, **C** located, not confirmed; **target** = a budget set by this spec (gating, revisited after
measurement). No timing below is a measurement unless its source says so; unmeasured values are `TBD — measure with <VC>`.

Readiness level (track-wide): **PRL1** installable + observable (INS, E2E) · **PRL2** trustworthy (DSF, PRF) · **PRL3**
daily-capable (UXD, XCH, VNV) · **PRL4** adoptable (COM) · **PRL5** field-proven (PIL). This pack's default is PRL1; the
perf / fault / accessibility hooks are required at the level of the pack that consumes them.

## Use cases

1. **UC-1 Launch and drive the real app.** Dev and packaged twin on each OS; shipped smoke after install (VC-01…05, 14).
2. **UC-2 Trust the harness.** Deterministic shots, dialogs, menus, action-to-command mapping, crash / hang detection,
   isolation (VC-06…13, 21, 23, 25, 26, 28, 31).
3. **UC-3 Retire the browser path.** Legacy e2e, production UI driver and quality gate 2 ported with parity, then deleted
   (VC-15…19).
4. **UC-4 Serve the other packs.** VC runner contract, perf / fault APIs, accessibility, flake budget, local run
   (VC-20, 22, 24, 27, 29, 30).

## Validation cases

| VC | Proves | Level | Input | Expected | Tolerance | Source / grade |
| -- | ------ | ----- | ----- | -------- | --------- | -------------- |
| VC-E2E-01 | FR-E2E-01, TR-E2E-01 | PRL1 | `selftest/launch.spec.ts`, dev mode, fresh profile | first window shown, `/health` ok, `stateHash` readable, clean quit (exit 0, no crash report) within the launch limit | launch ≤ 30 s; typical `TBD — measure` | [R1] default timeout; target |
| VC-E2E-02 | FR-E2E-02, TR-E2E-02 | PRL1 | `scripts/e2eTwin.mjs` on the unpacked release (Windows; Linux; macOS when shipped) | `@electron/fuses read`: twin = release except `EnableNodeCliInspectArguments` (1 fuse); `app.asar` sha256 equal; twin launches (integrity check passed, Win / mac) | exact | [R7][R8][R9]; target |
| VC-E2E-03 | FR-E2E-02 | PRL1 | shipped release artefact | its 6 fuses equal `desktop/electron-builder.yml` (`runAsNode` on, cookie encryption on, NODE_OPTIONS off, CLI inspect off, asar integrity on, only-asar on); no `twin-*` file in release outputs | exact | S2 (A, config read) |
| VC-E2E-04 | FR-E2E-01 | PRL1 | the self-test suite in twin mode on `windows-latest` after `native-bundle` | all self-tests pass as in dev; `kernel_info` = `occt-native` (no fallback reason); bundled Python probe ok | exact | target |
| VC-E2E-05 | FR-E2E-01, FR-E2E-15 | PRL1 | installed app (pack 05 VM), shipped mode, a fixture document as argument | window up; `llull status --app` reports it with the document path; `llull render_view --save v.png --app` writes a non-empty PNG; quit leaves no process of the run | exact | target |
| VC-E2E-06 | FR-E2E-07, TR-E2E-07 | PRL1 | `3d_box_cylinder_sphere` golden plan, project `dev-swiftshader`, 20 fresh launches | the 20 viewport shots are pixel-identical | 0 px | target |
| VC-E2E-07 | FR-E2E-03, TR-E2E-04 | PRL1 | (a) open stub → fixture, `act.menu('file.open')`; (b) save stub, `file.saveAs`; (c) no stub, `file.open` | (a) document loaded, `load_document` in the stream; (b) file written and reloads to the same `stateHash`; (c) test fails with `E2E_UNSTUBBED_DIALOG`, no OS dialog window left | exact | [R1] (dialogs not intercepted); target |
| VC-E2E-08 | FR-E2E-03 | PRL1 | every `menuTemplate` item; accelerators `CmdOrCtrl+N/O/S`, `Shift+CmdOrCtrl+S` | each id resolves with `getMenuItemById` and its handler runs (observed effect); accelerators trigger the same handlers through the path chosen in spike S3 | exact | S3 (A); target |
| VC-E2E-09 | FR-E2E-04, TR-E2E-03 | PRL1 | `act.palette('add_box', …, {expect:['add_box']})`; orbit with `expect: []`; a deliberately wrong declaration | stream = exactly the declared commands; hashes equal; wrong declaration fails `E2E_COMMAND_MISMATCH` listing both | exact | S7 (A, liveSync contract); target |
| VC-E2E-10 | FR-E2E-06, TR-E2E-06 | PRL1 | `faults.crashRenderer()` in an unexpected position | test fails `E2E_RENDERER_GONE` with reason `crashed` / `killed`; artefacts: logs, last screenshot, stream; a crash report written by the app (product change §2.3) | exact | [R23]; target |
| VC-E2E-11 | FR-E2E-06, TR-E2E-06 | PRL1 | `faults.killBackend()` unexpected | `E2E_BACKEND_EXIT` (and `E2E_APP_EXIT`, the shell quits when the backend exits) detected | ≤ 5 s after the kill | S4 (A, LC1 step 6 behaviour); target |
| VC-E2E-12 | FR-E2E-06, TR-E2E-06 | PRL1 | `evaluate(() => setTimeout(() => { throw new Error('e2e-main') }))` with the error box stubbed | `E2E_MAIN_ERROR`; a crash report folder with `source: desktop-main` exists in the instance's crash dir | exact | S5 (A, `crashes.ts`); target |
| VC-E2E-13 | FR-E2E-06, TR-E2E-06 | PRL1 | `faults.hangRenderer(60000)` | `E2E_RENDERER_HUNG` from `unresponsive` | detection ≤ 30 s `TBD — measure` | target |
| VC-E2E-14 | FR-E2E-03 | PRL1 | instance A running; launch again with a document, same profile | one process tree, one window, the document opened in A (`second-instance` path) | exact | S1 (A, `main.ts:367-375`); target |
| VC-E2E-15 | FR-E2E-09, TR-E2E-09 | PRL1 | `tests/desktop/flows/` vs `tests/e2e/` | parity ledger 30 / 30 ported; all green in twin and dev, twice in a row | exact | baseline A: 30 browser tests counted 2026-10-28 (S6) |
| VC-E2E-16 | FR-E2E-09 | PRL1 | production UI driver on Electron, 4 scenarios | extraction 27 / 27, revision B 30 / 30, pipe rack 28 / 28, civil 11 / 11; `knownIssues.ui` empty; no `OPTIONAL_SERVER` exemption | exact | baseline A: `docs/PRODUCTION_GATE.md` Results (S8) |
| VC-E2E-17 | FR-E2E-09 | PRL1 | quality gate 2 on Electron, smoke + full tiers (same commit as a browser run) | same pass / known set per case as the browser run; 0 console / page / WebGL errors on every native and complex document | exact | baseline A: 52 documents without error (`docs/QUALITY_GATES.md`, S9) |
| VC-E2E-18 | FR-E2E-09 | PRL1 | repository scan (contract test in `npm run check`) | no `webServer` in Playwright configs, no `tests/e2e/`, no `playwright.production.config.ts` / `playwright.quality.config.ts`, no CI job running `npx playwright install … chromium` for the renderer; W3 / PRODUCTION_GATE / QUALITY_GATES / verify-llull mention the desktop harness | exact | target |
| VC-E2E-19 | FR-E2E-10, TR-E2E-10 | PRL1 | `.github/workflows/*.yml` | lanes `desktop-e2e` (ubuntu + windows, PR), `desktop-e2e-twin` (nightly / release), `desktop-quarantine`; failure artefacts uploaded | exact | target; [R13][R17] |
| VC-E2E-20 | FR-E2E-11, TR-E2E-11 | PRL1 | flake ledger, last 50 runs per lane | suite flake rate ≤ 1 %; quarantine ≤ 5 % of tests, none > 14 days; no MUST VC quarantined without a recorded owner decision | as stated | [R16]; target |
| VC-E2E-21 | FR-E2E-08, TR-E2E-08 | PRL1 | baseline scene; (a) a 1-px overlay; (b) `filter: brightness(1.2)` on the canvas through `page.addStyleTag` (no product change) | (a) passes; (b) fails `E2E_VISUAL_DIFF`; SSIM reported for both, not gating | `threshold 0.2`, `maxDiffPixelRatio 0.005` | [R15]; QUALITY_GATES proposed gate 4 (S9); target |
| VC-E2E-22 | FR-E2E-12, TR-E2E-12 | PRL1 | `npm run e2e:vc -- --pack docs/readiness/06-desktop-e2e --all`, plus a pack index with a non-electron case and an unimplemented id | one file per VC valid against `data/vc-result.schema.json`; non-electron → `skipped` with reason; unimplemented → `skipped` `E2E_VC_NOT_IMPLEMENTED`; a known issue that passes → `fail` | exact | target |
| VC-E2E-23 | FR-E2E-05 | PRL1 | one session: `renderView`, `snapshot`, `commands`, `logs`, `crashes`, `diagnostics`; a renderer `fetch('https://example.com')` | PNG non-empty; CLI `stateHash` = harness `stateHash`; logs hold main, backend and renderer lines; the fetch fails `E2E_NETWORK_REQUEST` | exact | target |
| VC-E2E-24 | FR-E2E-14, TR-E2E-14 | PRL2 | each `faults.*` with the failure declared as expected | each fault happens on the harness's own pids, is recorded, and the test passes; relaunch with the same profile succeeds | exact | target |
| VC-E2E-25 | FR-E2E-07, FR-E2E-05, TR-E2E-07 | PRL1 | `dev-swiftshader` launch; then a launch without the SwiftShader switches in that project | record: `devicePixelRatio` 1, content 1600×1000, renderer string contains `SwiftShader`, fonts Hanken Grotesk + DM Mono loaded; second launch fails `E2E_ENV_MISMATCH` | exact | [R11]; S10 (fonts); target |
| VC-E2E-26 | FR-E2E-17, TR-E2E-16 | PRL1 | two harness runs in parallel on one machine (different lanes), plus an unrelated Electron process started outside the harness | no port / discovery / autosave collision (each `desktop.json` under its own `LLULL_HOME`); both pass; the outside process is still alive at the end | exact | memory rule (no global kill); target |
| VC-E2E-27 | FR-E2E-13, TR-E2E-13 | PRL2 | `perf.trace(['electron','blink'], openDocument)`; `perf.measure('llull:document-open')` | Perfetto file non-empty and parseable; the measure exists with duration > 0; CDP metrics readable | exact | [R19]; target |
| VC-E2E-28 | FR-E2E-03, TR-E2E-05 | PRL1 | 78 exports triggered back to back from the renderer | 78 files in the artefact folder, no OS save dialog | 0 dropped | baseline A: browser Chromium dropped 6 / 78 back to back (`tests/production/ui/session.ts:50-53`, S8) |
| VC-E2E-29 | FR-E2E-16, TR-E2E-15 | PRL3 | axe scan of the shell and each panel, tags `wcag2a wcag2aa wcag21a wcag21aa` | serious + critical violations not in `a11yKnown.json` = 0; ratchet | exact | [R20]; baseline `TBD — measure with the first scan` |
| VC-E2E-30 | FR-E2E-10, FR-E2E-17 | PRL1 | `ref-win11`, clean lane worktree, `npm run e2e` | builds what is stale, waits for / takes the heavy slot, passes; `~/.llull` of the user untouched (mtime unchanged) | exact | target |
| VC-E2E-31 | FR-E2E-18, TR-E2E-17 | PRL1 | a test forced to fail | report holds Playwright trace, video, logs, crash folder listing | exact | [R1]; target |

Every FR is covered: FR-01 (01, 04, 05), FR-02 (02, 03), FR-03 (07, 08, 14, 28), FR-04 (09), FR-05 (23, 25), FR-06 (10–13),
FR-07 (06, 25), FR-08 (21), FR-09 (15–18), FR-10 (19, 30), FR-11 (20), FR-12 (22), FR-13 (27), FR-14 (24), FR-15 (05),
FR-16 (29), FR-17 (26, 30), FR-18 (31).

## How to run

```text
npm run e2e -- --grep @selftest                    # VC-E2E-01, 06…14, 21, 23…28, 31 (dev)
npm run e2e -- --mode twin --grep @selftest        # VC-E2E-02, 04
npm run e2e:vc -- --pack docs/readiness/06-desktop-e2e --all --out .cache/readiness/results
```

Machine index: [`expected_results.json`](expected_results.json) (schema [`../../vc.schema.json`](../../vc.schema.json)).
Per-VC result schema: [`data/vc-result.schema.json`](data/vc-result.schema.json). Sources: [`sources.md`](sources.md).
