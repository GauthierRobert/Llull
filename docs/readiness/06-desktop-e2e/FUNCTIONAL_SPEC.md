# 06 E2E — The shipped desktop app under automated test — Functional specification

Status: specification only (2026-10-28). Nothing in this pack is built. Gap id `E2E`. Template:
[`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md), grades as in [`../../plant/TEMPLATE.md`](../../plant/TEMPLATE.md).
Track: [`../README.md`](../README.md). Technical view: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md). Readiness level: **PRL1 (installable + observable)**.

## 1. Summary

llull ships one product: the Electron desktop app (`desktop/`) that starts the local backend (`server/`) and shows the
React / three.js renderer, plus the `llull` CLI ([`../../decisions/LC1-local-only.md`](../../decisions/LC1-local-only.md)).
No automated test launches that app. Every UI-level test runs the renderer in **browser Chromium on the Vite dev server in
offline mode, without the backend**:

| Suite | Runner today | What it really exercises | Evidence |
| ----- | ------------ | ------------------------ | -------- |
| `tests/e2e/` (7 specs, 30 tests) | `playwright.config.ts` → `webServer: npm run dev`, project `chromium` | renderer + in-renderer Manifold `execute`; no backend, no native kernel, no menus, no native dialogs, no packaging | `playwright.config.ts:7-22`; CI job `e2e` on `ubuntu-latest` (`.github/workflows/check.yml:195-213`) |
| Production-gate UI driver (4 scenarios) | `playwright.production.config.ts` (extends the browser config) | the same browser renderer | `docs/PRODUCTION_GATE.md` ("browser Playwright: legacy, being retargeted to Electron, LC1") |
| Quality gate 2 — display | `playwright.quality.config.ts` (extends the browser config) | "Open project" through a `<input type=file>` in offline mode | `docs/QUALITY_GATES.md` gate 2; `tests/quality/display.gate.ts:14-18` |
| `desktop/tests/` (7 files) | Vitest, Node | backend lifecycle, File operations and `llull --app` **without Electron** | `desktop/tests/backend.e2e.test.ts:1-6`; CI installs desktop deps with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` |

So the main process (`desktop/src/main.ts`: window, menu, native dialogs, single-instance lock, quit confirmation,
crash reports, navigation and permission guards), the packaged resources (`app.asar`, bundled Python, native
`llull-kernel`), the Electron fuses (`desktop/electron-builder.yml`) and the renderer talking to the real backend have no
automated proof. Packs 02 (UX tasks), 03 (performance), 04 (fault injection) and 05 (install) all need to run on that
shipped app; without this pack their results would again describe a browser, not the product.

This pack specifies **one harness** that launches the real desktop app — from the checkout and from the packaged build —
on Windows, macOS and Linux, drives it like a user (mouse, keyboard, menus, native dialogs, files, several windows and
instances), observes it (DOM, screenshots, `render_view`, backend state hash, command log, logs, crash reports), and
becomes the executor of every readiness validation case whose driver is `electron`. It then moves the legacy browser
suites onto it and deletes the browser path, as LC1 requires.

## 2. Context and value

- **Who needs it.** The engineer at the desktop app is the operator of this track ([`../README.md`](../README.md)); the
  readiness question ("can a professional use llull daily?") can only be answered on the build they install.
- **How desktop apps are tested.** Electron maintains no test runner of its own and documents three paths: WebdriverIO,
  Selenium, Playwright, or a custom driver over a stdio IPC channel [R2]. Spectron, the former official tool, was
  deprecated on 2022-02-01 with Playwright and WebdriverIO named as successors [R3]. Playwright's Electron support is
  marked **experimental**, needs Electron ≥ 21, reaches the main process through `electronApp.evaluate()`, and does not
  intercept native dialogs: they must be stubbed in the main process [R1].
- **The packaging constraint.** llull's release disables the `EnableNodeCliInspectArguments` fuse and turns on
  integrity-checked asar (`desktop/electron-builder.yml:51-60`). Playwright's own docs say a launch time-out comes from that
  fuse being off [R1]; WebdriverIO's main-process API (`browser.electron.execute`, `mock`) also stops working without it,
  while renderer testing keeps working [R5]. Both tools recommend a test build with the fuse on [R5]. The harness must
  therefore test the packaged app **without** weakening the shipped binary — §5 FR-E2E-02.
- **Why visuals are hard.** Rendering varies with OS, version, settings and hardware; Playwright screenshot baselines are
  per platform [R14]. Chromium no longer falls back to SwiftShader WebGL automatically; a GPU-less run must opt in with
  `--enable-unsafe-swiftshader` [R11]. Standard GitHub-hosted runners have no GPU; GPU runners (T4, Windows and Linux) are
  "larger runners" on paid plans [R17][R18]. Linux CI needs a virtual display (Xvfb); Windows and macOS do not [R13].

## 3. Personas and user stories

- **Engineer (operator of the track).**
  - US-1: "The app I install is the app that was tested: menus, Open / Save dialogs, exports, quit-with-unsaved-changes."
  - US-2: "A crash in the app is caught by a test before release, with the report it would have written for me."
- **Agent (llull developer, CLI).**
  - US-3: "I write a UI test as a list of user actions; each action says which registered command it should produce,
    and the test fails if the app dispatched something else."
  - US-4: "I run the same desktop suite locally on Windows with one command, in parallel with other lanes, without
    killing anyone's processes."
  - US-5: "A pack's validation runner calls the harness with a list of VC ids and gets a result file per VC."
- **Owner.**
  - US-6: "The production gate's UI column and the display gate mean the desktop app, not a browser."
  - US-7: "The release binary keeps every security fuse; test tooling never ships."

## 4. Scope

| Phase | Content |
| ----- | ------- |
| **MVP** | Spike (fuse twin, shipped-binary attach, accelerators, DPR switch, profile isolation) · harness core (launch dev + packaged twin, actions mapped to commands, observation, dialog stubs, crash / hang detection) · self-tests VC-E2E-01…14 · port of `tests/e2e` |
| **V1** | Production-gate UI driver and quality gate 2 on Electron · visual-diff policy · CI matrix (Linux + Windows; macOS per owner) · flake budget and quarantine · VC runner contract for the central readiness gate · deletion of the browser path |
| **V2** | Shipped-binary smoke in the install VMs (pack 05) · perf / fault / UX-task APIs consumed by packs 03 / 04 / 02 · accessibility scans · hardware-GPU lane on the reference machine |
| Out of scope | Writing pack 02–05 test content (they own it); a cloud device farm; testing a browser build (none exists, LC1); signing / notarisation (pack 05) |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-E2E-01 | MUST | The harness launches the real desktop app in three modes: **dev** (Electron on the checkout's built `desktop/dist/main.js`), **twin** (the packaged build, copied, with exactly one fuse changed, §FR-E2E-02) and **shipped** (the release artefact, unmodified, smoke only); on Windows, macOS and Linux | today no test launches Electron | code survey; [R1][R2] |
| FR-E2E-02 | MUST | The release binary keeps every fuse of `electron-builder.yml`; the twin differs from it only by `EnableNodeCliInspectArguments = on`, keeps a byte-identical `app.asar` and keeps integrity validation on. No test-only code path exists in the shipped main process or renderer | the fuse blocks Playwright / WDIO main access; tests must not weaken the product | [R1][R5][R7][R9] |
| FR-E2E-03 | MUST | Tests drive the app the way a user does: pointer (move, click, drag, wheel), keyboard (text, shortcuts, menu accelerators), application menus by stable id, native Open / Save / message dialogs (stubbed in the main process, answers scripted per test), downloads, a document passed on the command line, a second launch (single-instance hand-off), and every window the app opens | user-level proof | [R1][R21][R23] |
| FR-E2E-04 | MUST | Every scripted user action declares the registered commands it must produce (possibly none). After the action the harness reads the backend command stream and fails with `E2E_COMMAND_MISMATCH` when names or params differ, and with `E2E_STATE_HASH_DIVERGED` when the renderer's and the backend's state hashes differ | PRIME DIRECTIVE: one UI action = one registered command (L1); AGENT_FIRST | `CLAUDE.md`; `packages/protocol/src/liveSync.ts` |
| FR-E2E-05 | MUST | Observation API: DOM / accessibility tree, window and canvas screenshots, `render_view` through `llull --app`, backend `/live/snapshot` (document, `stateHash`, `epoch`, `seq`), the command stream since launch, main / backend / renderer logs, crash reports and minidumps, and an environment record (OS, GPU renderer string, device scale, window size, loaded fonts, kernel) | assertions read outcomes, not internals (W3) | code survey |
| FR-E2E-06 | MUST | Crash and hang detection: renderer gone, child (GPU / utility / backend) gone, main-process uncaught error, unresponsive renderer, unexpected app exit, console error. Each fails the test with a stable code and attaches the artefacts (logs, crash report folder, last screenshot, command stream) | a crash must never pass silently | [R22][R23]; `desktop/src/crashes.ts` |
| FR-E2E-07 | MUST | Deterministic environment: fixed window content size, device scale factor 1, bundled fonts loaded before the first assertion, a pinned GPU backend per test project (SwiftShader for visual baselines), a fresh profile (user data, `LLULL_HOME`, autosave, port) per app instance, no network. The environment record is attached to every result; a mismatch fails with `E2E_ENV_MISMATCH` | screenshots and timings are only comparable in one environment | [R11][R14] |
| FR-E2E-08 | MUST | Visual-diff policy: gating pixel baselines only in the deterministic project; tolerances fixed in config; geometric checks (silhouette, aspect, framing, from gate 2) gate on every OS; baseline updates only by an explicit, reviewed update run | false positives kill trust in visual tests | [R14][R15]; `docs/QUALITY_GATES.md` |
| FR-E2E-09 | MUST | Migration with parity: every test of `tests/e2e/`, the four production-gate UI scenarios and every quality-gate-2 case runs on the harness with the same assertions (or stricter) and passes; then the browser path is deleted (configs, `webServer`, CI job, docs), with no compatibility shim | LC1; owner rule "no backward compatibility" | `../../decisions/LC1-local-only.md` |
| FR-E2E-10 | MUST | CI matrix and local run: Linux (Xvfb) and Windows on every PR in dev mode; packaged-twin runs nightly and before a release on every platform the release ships; one local command runs any subset on the developer's machine | [R13][R17] | code survey |
| FR-E2E-11 | MUST | Flake budget: one retry in CI; a test that passes only on retry is reported `flaky`; per-test and suite flake rates are tracked over a rolling window; over budget a test is quarantined (non-gating lane, owner-visible list, expiry); a MUST validation case cannot be quarantined silently | [R16] | spec budget |
| FR-E2E-12 | MUST | VC runner contract: given VC ids and a pack's `validation/expected_results.json`, the harness runs every case whose driver is `electron` and writes one result JSON per VC (`id`, `status` pass / fail / known / skipped, `measured`, `unit`, `artefacts[]`, `durationMs`, `machineProfile`, `commit`) for the central readiness gate ([`../VALIDATION.md`](../VALIDATION.md)) | one executor for every pack | coordinator request 2026-10-28 |
| FR-E2E-13 | SHOULD | Performance API for pack 03: named renderer marks / measures, Chromium trace capture (`contentTracing`), CDP performance metrics, frame statistics, process memory | perf must be measured on the shipped app | [R19] |
| FR-E2E-14 | SHOULD | Fault API for pack 04: kill the backend, crash or hang the renderer, crash the GPU process, kill the whole app, launch with a corrupted profile / autosave / document — each from the harness, on its own process tree | data-safety claims need injected faults | [R23] |
| FR-E2E-15 | SHOULD | Install API for pack 05: attach to an installed app (`shipped` mode, given its executable), verify its fuses and asar integrity, run the shipped smoke | install VMs run the real installer | [R7][R8][R9] |
| FR-E2E-16 | SHOULD | Accessibility: an axe-core scan of the shell and of each panel (WCAG 2.0 / 2.1 A and AA tags); serious and critical violations ratchet to zero | QUALITY_GATES proposed gate 10 | [R20] |
| FR-E2E-17 | MUST | Isolation and machine safety: the harness only signals process ids it started, never kills by name, uses its own profile / ports / `LLULL_HOME`, takes the heavy-run slot (`scripts/heavyLock.mjs`), and two harness runs on one machine never interfere | memory rule "parallel loops: no global kill"; DL1 | `docs/decisions/DL1-dev-loop.md` |
| FR-E2E-18 | COULD | On failure: Playwright trace, video of the window and the Chromium trace are kept as artefacts | triage | [R1] |

## 6. Workflows

**Developer / agent, local (Windows reference machine).**

```text
npm run e2e                                  # dev mode, every desktop test, takes the heavy slot
npm run e2e -- --grep @VC-E2E-07             # one case
npm run e2e -- --mode twin                   # packaged twin (builds release/ first: npm --prefix desktop run dist)
npm run e2e:vc -- --pack docs/readiness/02-drafting-interaction --vc VC-UXD-03,VC-UXD-04
npm run e2e -- --update-visual               # writes new baselines; the diff images go into the PR for review
```

**CI.** PR: `desktop-e2e` on `ubuntu-latest` (Xvfb, SwiftShader) and `windows-latest` (SwiftShader), dev mode, sharded.
Nightly + release: packaged twin on each shipped platform; the readiness `electron` cases; shipped-binary smoke after the
installer job (pack 05).

**A user action in a test** (sketch, §4 of the technical spec):

```ts
await app.act.palette('add_box', { size: '40,30,10' }, { expect: ['add_box'] });
await app.act.menu('file.saveAs', { dialog: { save: tmp('part.llull.json') }, expect: [] });
expect(await app.observe.stateHash()).toEqual(await app.observe.rendererStateHash());
```

## 7. Acceptance criteria

| Given | When | Then | VC |
| ----- | ---- | ---- | -- |
| a checkout with built renderer, server and main | `npm run e2e -- --grep @selftest` | the app launches in dev mode, backend healthy, state hash readable, quits cleanly | VC-E2E-01 |
| a packaged build | the harness makes the twin | exactly one fuse differs; `app.asar` hash equal; the twin launches (integrity passes) | VC-E2E-02, 03 |
| the release artefact | shipped smoke | fuses equal `electron-builder.yml`; window shown; `llull status --app` finds it; `render_view` writes a PNG; clean quit | VC-E2E-04, 05 |
| one scene, SwiftShader, DPR 1 | 20 fresh launches | identical viewport screenshots | VC-E2E-06 |
| a stubbed Open dialog | File > Open via menu id | the fixture opens; no OS dialog; an unstubbed dialog fails the test with `E2E_UNSTUBBED_DIALOG` | VC-E2E-07 |
| every menu item | clicked by id / accelerator | its handler runs | VC-E2E-08 |
| a scripted action that declares `add_box` | it runs | the command stream holds exactly `add_box`; renderer and backend hashes equal | VC-E2E-09 |
| a crashed renderer / killed backend / main error / hung renderer | the harness watches | the test fails with the named code and the artefacts | VC-E2E-10…13 |
| second launch with a document | same profile / different profile | hand-off to the first instance / two isolated instances | VC-E2E-14, 26 |
| the 30 legacy e2e tests, 4 UI scenarios, all gate-2 cases | run on the harness | all pass with the same criteria counts | VC-E2E-15…17 |
| migration complete | repository scan | no browser Playwright config, `webServer`, `tests/e2e/` or CI browser job | VC-E2E-18 |
| a pack's VC list | `npm run e2e:vc` | one schema-valid result JSON per VC | VC-E2E-22 |

## 8. Standards and alignment

No regulatory standard governs desktop UI test automation. Accessibility scans use axe-core rule tags for WCAG 2.0 / 2.1
levels A and AA [R20]; automated scans catch only part of the issues, so they are a floor, not a conformance claim [R20].
Architecture laws L1 (one command layer), L2 (no DOM in packages), L6 (thin hosts) hold: the harness is test code under
`tests/desktop/`; the only product changes are product features (menu ids, diagnostics read-out, crash reporter, profile
directory option), never test-only switches (TECHNICAL_SPEC §2).

## 9. KPIs

| KPI | Target | Source |
| --- | ------ | ------ |
| Legacy browser tests ported and green | 30 / 30 `tests/e2e` + 4 / 4 UI scenarios + every gate-2 case | counted 2026-10-28 |
| Shipped fuses equal the builder config | 6 / 6 on every release artefact | `desktop/electron-builder.yml` |
| Deterministic screenshot | 0 differing pixels across 20 launches (visual project) | spec budget |
| Suite flake rate (tests passing only on retry) | ≤ 1 % of test executions over the last 50 CI runs | spec budget |
| Quarantined tests | ≤ 5 % of desktop tests; none older than 14 days | spec budget |
| Launch to app ready (dev and twin) | ≤ 30 s hard limit (Playwright default launch timeout [R1]); measured value recorded, budget owned by pack 03 | [R1]; `TBD — measure with the harness` |
| Readiness VCs with driver `electron` executable by the harness | 100 % (missing test = `skipped`, counted as fail for MUST) | spec |

## 10. Risks and assumptions

| Risk | Mitigation |
| ---- | ---------- |
| Playwright Electron support is experimental [R1][R2]; an Electron upgrade may break it | pin `@playwright/test` and `electron`; the harness core is a thin adapter (`launch`, `evaluate`, `firstWindow`) so WebdriverIO could replace it; harness self-tests run on every Electron bump |
| The twin is not the shipped binary | twin = shipped asar + resources byte-identical, one fuse flipped and verified (VC-E2E-02); the shipped artefact still gets a smoke (VC-E2E-05) and the fuse check (VC-E2E-04) |
| Attaching to the shipped binary over `--remote-debugging-port` may be judged a security surface | owner question Q1; fallback: shipped smoke through the CLI only (`llull --app`, `render_view`) |
| Software rendering hides GPU-specific bugs | geometric checks on every OS; a hardware-GPU lane on the reference machine; GPU runners optional [R18] |
| Keyboard events sent through CDP may not trigger native menu accelerators | spike VC-E2E-08 decides: accelerator via `webContents.sendInputEvent` or menu-id click plus a separate accelerator-binding unit test |
| macOS: native bundle deferred by the owner (2026-10-19, `check.yml` `native-bundle`) | macOS twin runs without native kernel until pack 05 lands it; owner question Q3 |

## 11. References

[R1]–[R27] in [`validation/sources.md`](validation/sources.md) with URL, extract and grade; code-survey rows S1–S12 there too.
