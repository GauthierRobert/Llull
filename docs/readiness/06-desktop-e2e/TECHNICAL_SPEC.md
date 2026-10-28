# 06 E2E — The shipped desktop app under automated test — Technical specification

Status: specification only (2026-10-28). Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md). Laws: [`.claude/rules/architecture.md`](../../../.claude/rules/architecture.md).

## 1. Current state in llull (read on main f1351cff, 2026-10-28)

| Area | Where | Behaviour today | Limit |
| ---- | ----- | --------------- | ----- |
| Browser e2e | `playwright.config.ts:7-22`; `tests/e2e/*.spec.ts` (7 specs, 30 tests: construction 12, industrial 13, coreFlows, civil, civilStarter, sheets, viewportIdle) | `webServer: npm run dev` on `:5173`, Chromium project, viewport 1600×1000, `workers: 1`, `retries: CI ? 1 : 0`, `trace: retain-on-failure`; offline mode (no backend) | not the product; renderer runs commands in-process on Manifold |
| Production UI driver | `playwright.production.config.ts` (extends base); `tests/production/ui.gate.ts` (4 tests); `tests/production/ui/session.ts:8-56` | `page.goto('/')`, `localStorage.clear()`, "Open project" via `setInputFiles`, downloads via `waitForEvent('download')`; ignores console errors from `http://localhost:3001` (offline probe) | same browser path; download pacing workaround (400 ms) is Chromium-anchor specific |
| Quality gate 2 | `playwright.quality.config.ts`; `tests/quality/display.gate.ts:14-26`, `silhouette.ts` | silhouette = screenshot minus the same camera with every layer hidden; checks errors / stretch / visible / framed / aspect / fit-all / top-view; 52 documents rendered without error (`docs/QUALITY_GATES.md`) | browser; `OPTIONAL_SERVER` exemption |
| Desktop tests | `desktop/tests/*.test.ts` (7 files), `desktop/vitest.config.mts` | real server bundle forked with `child_process.fork` (not `utilityProcess`), File ops via `DocumentSession`, `llull --app` via discovery file | no Electron, no window, no menu, no dialog |
| Main process | `desktop/src/main.ts` (396 lines) | one `BrowserWindow` 1440×900, `contextIsolation`, `sandbox`, no preload; `dialog.showOpenDialog` / `showSaveDialog` / `showMessageBox` / `showErrorBox`; `requestSingleInstanceLock`; quit confirmation (`interceptQuit`); `process.on('uncaughtException')` → `writeDesktopCrashReport`; backend via `utilityProcess.fork(..., { stdio: 'inherit' })`; app quits when the backend exits (LC1 step 6) | no `crashReporter.start`, no `render-process-gone` / `child-process-gone` handling |
| Menu | `desktop/src/menu.ts:25-63` | items by label only, no `id` | not addressable by a test except by label path |
| Fuses | `desktop/electron-builder.yml:51-60` | `runAsNode: true`, `enableCookieEncryption: true`, `enableNodeOptionsEnvironmentVariable: false`, `enableNodeCliInspectArguments: false`, `enableEmbeddedAsarIntegrityValidation: true`, `onlyLoadAppFromAsar: true` | blocks `--inspect` → Playwright / WDIO main access [R1][R5] |
| Packaged layout | `desktop/src/layout.ts:37-57` | packaged: `resources/{web,server,python,native}`; dev: repo `dist/`, `server/dist`, `desktop/build/{python,native}` | — |
| Backend observation | `server/src/liveRoutes.ts:43-114`, `server/src/liveDocument.ts:74-157`, `server/src/liveCommandLog.ts` | `/live` SSE (ticket via `POST /live/ticket`) carries every `command` event with `name`, `params`, `seq`, `stateHash`; `GET /live/snapshot` → `{ epoch, seq, stateHash, document }`; command log kept for crash reports (≤ 2,000 commands, rebased on undo / snapshot) | no read route for the command log |
| Discovery | `server/src/cli/desktopDiscovery` (used by `main.ts:56`) | `~/.llull/desktop.json` = `{ url, token, pid, documentPath, version }` (`LLULL_HOME` overrides) | — |
| Renderer canvas | `src/ui/viewport/3d/Viewport3D.tsx:189`, `2d/Viewport2D.tsx:160` | `dpr={[1, 2]}`, `antialias: true`, `frameloop="demand"` (2D), ACES tone mapping | DPR follows the display → screenshots differ per screen |
| Fonts | `src/main.tsx:5-9`, `src/ui/styles/tokens.css:76-77` | Hanken Grotesk and DM Mono latin subsets bundled (`@fontsource`); other scripts fall back to system fonts | unicode names (e.g. `syn-unicode-names`) render with OS fonts |
| CI | `.github/workflows/check.yml` | `e2e` job (browser, ubuntu); `native-bundle` on `windows-latest` only ("macOS deferred, owner 2026-10-19"); desktop deps installed without the Electron binary | no Electron launched in CI |
| Docs | W3 table (`.claude/rules/workflow.md`), `docs/PRODUCTION_GATE.md`, `docs/QUALITY_GATES.md`, `.claude/skills/verify-llull/SKILL.md:54` | all say "legacy browser Playwright, being retargeted to Electron (LC1)" | — |

## 2. Target architecture

### 2.1 Placement

| Part | Path | Layer / law |
| ---- | ---- | ----------- |
| Harness library | `tests/desktop/harness/` (`launch.ts`, `modes.ts`, `actions.ts`, `observe.ts`, `dialogs.ts`, `menus.ts`, `watchdog.ts`, `environment.ts`, `faults.ts`, `perf.ts`, `a11y.ts`, `visual.ts`) | test code; imports `@protocol/*` types and `@server/cli/desktopDiscovery` like `desktop/tests` do (tests are exempt from the host-index rule, L10) |
| Playwright config | `playwright.desktop.config.ts` (projects `dev-swiftshader`, `dev-gpu`, `twin`, `shipped-smoke`) | replaces the three browser configs |
| Suites | `tests/desktop/selftest/` (VC-E2E), `tests/desktop/flows/` (ported `tests/e2e`), `tests/desktop/production/` (UI driver), `tests/desktop/display/` (gate 2), `tests/desktop/packs/<pack>/` (readiness `electron` cases of packs 02–05, 07–09) | W3 gets a row `tests/desktop/` |
| Twin builder | `scripts/e2eTwin.mjs` | copies the unpacked build, flips one fuse with `@electron/fuses` [R8] |
| VC runner | `scripts/e2eVc.mjs` + reporter `tests/desktop/harness/vcReporter.ts` | §9 |
| Product changes (not test hooks) | `desktop/src/menu.ts` (ids), `desktop/src/main.ts` (crash reporter, process-gone reports, profile directory, diagnostics IPC-free read-out), `src/ui/diagnostics/` | L2, L6: host / UI only, no `packages/*` change |

`desktop/tests/` stays as it is (fast, Electron-free unit / backend tests).

### 2.2 Launch modes and what each may touch

| Capability | dev | twin | shipped |
| ---------- | --- | ---- | ------- |
| Binary | `desktop/node_modules/electron` + `desktop/dist/main.js` (`app.isPackaged = false`, repo layout) | copy of `release/<os>-unpacked` (or `mac/llull.app`), `app.isPackaged = true`, real `resources/` | the release artefact as installed, untouched |
| Launch | Playwright `_electron.launch({ args: ['desktop'] })` [R1] | `_electron.launch({ executablePath })` | spawn by the harness with a document argument; renderer attach via `--remote-debugging-port` + `chromium.connectOverCDP` **if Q1 accepts it**, else CLI only |
| Main-process `evaluate` (dialog stubs, menus, will-download, app events, faults) | yes | yes | **no** |
| Renderer page (DOM, screenshots, keyboard, mouse) | yes | yes | yes if Q1, else no |
| CLI `llull --app` (status, `render_view`, commands) | yes | yes | yes |
| Native kernel / bundled Python | if built locally (`desktop/build/native`) | bundled | bundled |

### 2.3 Keeping the production fuses safe (TR-E2E-02)

1. `electron-builder.yml` is not changed. The release keeps `enableNodeCliInspectArguments: false`.
2. `scripts/e2eTwin.mjs <unpacked dir> <out dir>` copies the build, then `flipFuses(<copied executable>, {
   version: FuseVersion.V1, [EnableNodeCliInspectArguments]: true, resetAdHocDarwinSignature: <darwin-arm64> })` [R8].
   Only the executable changes; `resources/app.asar` and every other file are byte-identical. The asar integrity hash
   lives in the executable's resource (Windows) or `Info.plist` (macOS) [R9] and is not touched, so integrity validation
   still runs and still passes: a twin that launches proves the shipped asar is intact. Linux has no asar integrity
   validation [R9]; there the harness compares the asar sha256 itself.
3. `@electron/fuses read --app` [R8] on both the release and the twin; the harness asserts release = builder config (6
   fuses) and twin = release except one fuse (`E2E_FUSE_MISMATCH` otherwise). The twin is never uploaded as a release
   artefact (CI artefact name `twin-*`, retention ≤ 7 days).
4. **No test-only code.** The shipped main and renderer contain no `if (process.env.TEST…)` branch. Everything the harness
   needs that is not reachable through `evaluate` is a product feature with its own user value:
   - menu items get stable `id`s (`file.open`, `file.saveAs`, `help.crashReports`, …) — needed by `Menu.getMenuItemById`;
   - `crashReporter.start({ uploadToServer: false })` early in `main.ts` [R22] and `render-process-gone` /
     `child-process-gone` [R23] written as crash reports (SC-D3 completeness: today only main-process JS errors are);
   - `--profile <dir>` / `LLULL_PROFILE_DIR`: run with a separate user-data folder (portable / second profile), applied with
     `app.setPath('userData', dir)` before the single-instance lock — spike S5 confirms the lock follows it;
   - a read-only diagnostics snapshot in the renderer (`src/ui/diagnostics/`) that feeds a Help > Diagnostics view and crash
     reports: frame count, last frame time, `renderer.info` (calls, triangles, geometries, textures), device pixel ratio,
     WebGL renderer string, renderer state hash, kernel, document `seq`. The harness reads it with `page.evaluate` of the
     same frozen snapshot function the view uses (exposed as `globalThis.llullDiagnostics()` — owner question Q2).

### Technical requirements

| Id | Requirement | Proves FR |
| -- | ----------- | --------- |
| TR-E2E-01 | `launchApp({ mode, profile?, env?, args?, window? })` returns an `AppHandle` within 30 s (Playwright default launch timeout [R1]) or fails `E2E_LAUNCH_TIMEOUT` with the captured stdout / stderr | FR-E2E-01 |
| TR-E2E-02 | Twin builder and fuse / asar verifier as §2.3 | FR-E2E-02, 15 |
| TR-E2E-03 | Action DSL (§4) with declared commands; command stream from `/live` SSE opened before the first action | FR-E2E-03, 04 |
| TR-E2E-04 | Dialog stubs installed by `evaluate` on the `dialog` module object before the first window loads; any unstubbed call resolves as cancelled **and** fails the test (`E2E_UNSTUBBED_DIALOG`) | FR-E2E-03 |
| TR-E2E-05 | Download capture: `session.defaultSession.on('will-download')` → `item.setSavePath(<artefacts>/downloads/<name>)` [R21] | FR-E2E-03 |
| TR-E2E-06 | Watchdog (§5.3): app events, page events, backend liveness, console | FR-E2E-06 |
| TR-E2E-07 | Environment pinning and record (§6) | FR-E2E-07 |
| TR-E2E-08 | Visual comparator and policy (§7) | FR-E2E-08 |
| TR-E2E-09 | Legacy parity ledger `tests/desktop/legacyParity.json` (legacy test id → ported test id → status) checked by a self-test | FR-E2E-09 |
| TR-E2E-10 | CI workflow `desktop-e2e` and local scripts (§10) | FR-E2E-10 |
| TR-E2E-11 | Flake ledger `.cache/e2e/flake-ledger.json` + quarantine file `tests/desktop/quarantine.json` (§11) | FR-E2E-11 |
| TR-E2E-12 | VC runner + reporter + result schema `validation/data/vc-result.schema.json` (§9) | FR-E2E-12 |
| TR-E2E-13 | `perf` API (§5.4) | FR-E2E-13 |
| TR-E2E-14 | `faults` API (§5.5) | FR-E2E-14 |
| TR-E2E-15 | `a11y.scan(scope)` with `@axe-core/playwright`, tags `wcag2a wcag2aa wcag21a wcag21aa` [R20]; ratchet file `tests/desktop/a11yKnown.json` | FR-E2E-16 |
| TR-E2E-16 | Process ownership: the harness records every pid it starts (Electron main from `electronApp.process()`, backend pid from `utilityProcess` via `evaluate` or the discovery file) and only signals those; per-instance temp root holds profile, `LLULL_HOME`, `LLULL_DATA_DIR`, `LLULL_VAULT`, autosave; whole runs take `scripts/heavyLock.mjs` | FR-E2E-17 |
| TR-E2E-17 | Failure artefacts: Playwright trace (`retain-on-failure`), video (`recordVideo` [R1]) on failure, Chromium trace when the test enabled it, logs, crash folder | FR-E2E-18 |

## 3. Data model (test side)

```ts
type LaunchMode = 'dev' | 'twin' | 'shipped';
interface MachineProfile { id: string; os: string; osVersion: string; cpu: string; ramGB: number; gpuRenderer: string;
  deviceScaleFactor: number; windowContent: [number, number]; fonts: string[]; electron: string; chromium: string;
  kernel: 'occt-native' | 'manifold'; mode: LaunchMode; commit: string }
interface LoggedCommand { seq: number; name: string; params: unknown; stateHash: string; source: 'rest' | 'cli' }
interface ActionResult { commands: LoggedCommand[]; summary: string; stateHashBefore: string; stateHashAfter: string; durationMs: number }
interface E2eFailure { code: E2eCode; message: string; artefacts: string[] }       // §8 codes
```

`machineProfile` ids match `docs/readiness/readiness_gate.json` `machineProfiles` (default `ref-win11`); CI profiles are
`ci-ubuntu-swiftshader`, `ci-windows-swiftshader`, `ci-macos-swiftshader`.

## 4. The user-action DSL (`tests/desktop/harness/actions.ts`)

Every action resolves its target by accessible role and name (the locators axe also sees), never by CSS class, and
declares the commands it must produce:

```ts
interface Expect { expect: readonly (string | { name: string; params?: Partial<Record<string, unknown>> })[] }
interface Actions {
  click(target: Target, o: Expect): Promise<ActionResult>;
  type(target: Target, text: string, o: Expect): Promise<ActionResult>;
  press(chord: string, o: Expect): Promise<ActionResult>;                 // 'Control+Z', 'Escape'
  drag(from: Point | Target, to: Point | Target, o: Expect & { steps?: number }): Promise<ActionResult>;
  wheel(at: Point, deltaY: number, o: Expect): Promise<ActionResult>;
  orbit(dx: number, dy: number): Promise<ActionResult>;                  // expect: [] (view state only)
  palette(command: string, fields: Record<string, string>, o: Expect): Promise<ActionResult>;
  panel(panel: string, form: string, fields: Record<string, string>, submit: string, o: Expect): Promise<ActionResult>;
  menu(id: MenuId, o: Expect & { dialog?: DialogScript }): Promise<ActionResult>;
  openDocument(file: string): Promise<ActionResult>;                      // menu('file.open') + open stub; expect load
  saveAs(file: string): Promise<ActionResult>;                            // menu('file.saveAs') + save stub
  launchSecondInstance(args: string[]): Promise<void>;                     // single-instance hand-off
}
type DialogScript = { open?: string[] | 'cancel'; save?: string | 'cancel'; message?: number /* button index */ };
```

Semantics of one action:

1. Read `stateHashBefore` and the stream position.
2. Perform the gesture through Playwright (`page.mouse`, `page.keyboard`, locators) or, for menus, `evaluate(({ Menu },
   id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click())`.
3. Wait until the stream is quiet (no new event for one debounce period and the renderer's `seq` equals the backend's)
   or until the declared commands arrived; time-out → `E2E_ACTION_TIMEOUT`.
4. Compare received commands with `expect` (names in order; listed params deep-equal, numbers within 1e-9 relative).
   Differences → `E2E_COMMAND_MISMATCH` with both lists.
5. Compare the backend `stateHash` (`/live/snapshot`) with the renderer's (`llullDiagnostics().stateHash`); different →
   `E2E_STATE_HASH_DIVERGED`. Status-bar summaries matching the existing `REFUSED` pattern
   (`tests/production/ui/session.ts:12`) → `E2E_COMMAND_REFUSED` unless the test expects a refusal.

Native menus cannot be clicked through the DOM; menu actions use ids. Accelerators are tested separately: spike S3
decides whether CDP key events reach Electron's menu accelerators; if not, accelerators are proved by
`webContents.sendInputEvent` in twin / dev plus a unit test that every menu item with an accelerator has a unique one.

## 5. Observation, watchdog, perf and fault APIs

### 5.1 `observe` (`tests/desktop/harness/observe.ts`)

| Call | Implementation | Modes |
| ---- | -------------- | ----- |
| `page()`, `windows()`, `on('window')` | `electronApp.firstWindow()`, `windows()`, `'window'` event [R1] | dev, twin (shipped if Q1) |
| `screenshot({ region?, mask? })`, `viewport()` | `page.screenshot`, canvas locator screenshot | dev, twin |
| `renderView(params)` | `llull render_view … --save <png> --app` with `LLULL_HOME` of the instance | all |
| `snapshot()` / `stateHash()` / `document()` | `GET /live/snapshot` with the token from the instance's discovery file | all |
| `commands(since?)` | SSE `/live` (ticket from `POST /live/ticket`), recorded from launch | all |
| `rendererStateHash()`, `diagnostics()` | `page.evaluate(() => llullDiagnostics())` | dev, twin |
| `logs()` | Electron stdout / stderr (backend inherits them, `main.ts:329`), renderer console, `--enable-logging` file [R10] | all |
| `crashes()` | the instance's `LLULL_DATA_DIR` crash reports (`server/src/crashReports.ts`) + `app.getPath('crashDumps')` minidumps [R22] | all |
| `environment()` | §6 record | all |
| `a11y(scope)` | axe scan [R20] | dev, twin |

### 5.2 Readiness packs call this API

| Pack | Calls |
| ---- | ----- |
| 02 UXD (tasks) | `launchApp`, `act.*` (each task step declares commands), `observe.commands` for keystroke / click counts, `perf.measure` for time on task |
| 03 PRF | `perf.*`, `observe.diagnostics` (draw calls, frame times), `act.openDocument`, `faults.none`; GPU project on the reference machine |
| 04 DSF | `faults.*`, `observe.crashes`, `observe.snapshot` before / after, `act.menu('file.save…')`, relaunch with the same profile |
| 05 INS | `launchApp({ mode: 'shipped', executablePath })`, `verifyFuses`, `verifyAsar`, shipped smoke |
| 07 VNV, 08 XCH, 09 COM | `act.openDocument`, downloads, `observe.renderView`, `a11y` (09: help / localisation screens) |

### 5.3 Watchdog (`watchdog.ts`)

Installed at launch (dev, twin) via `evaluate`: `app.on('render-process-gone' | 'child-process-gone')` [R23],
`webContents.on('unresponsive')`, `process.on('uncaughtException')` already in `main.ts` (observed through the crash
folder), page `pageerror` / `console` errors / `crash`, Electron process `exit`, backend `/health` poll. Each event becomes
an `E2eFailure` that fails the running test at its next await, with artefacts. Shipped mode: process exit, crash folder,
CLI health only.

### 5.4 `perf` (pack 03)

`perf.mark(name)` / `perf.measure(name, from, to)` read the renderer's User Timing entries; product marks
`llull:document-open`, `llull:first-frame`, `llull:command:<name>` are added in `src/ui` (product instrumentation, also shown
in Help > Diagnostics). `perf.trace(categories, fn)` wraps `contentTracing.startRecording` / `stopRecording` → Perfetto
file [R19]. `perf.cdpMetrics()` opens a CDP session on the page (`Performance.getMetrics`). `perf.memory()` →
`app.getAppMetrics()`. Budgets belong to pack 03.

### 5.5 `faults` (pack 04)

`killBackend()` (SIGKILL of the recorded utility pid), `crashRenderer()` (`webContents.forcefullyCrashRenderer()`),
`hangRenderer(ms)` (busy loop through `page.evaluate`), `crashGpu()` (navigate a hidden webContents to `chrome://gpucrash`,
spike S6), `killApp()`, `corruptProfile(kind)` (before launch: truncated autosave, invalid `desktop.json`, read-only profile).
A fault test declares the failure it expects; the watchdog then records instead of failing.

## 6. Determinism (TR-E2E-07)

| Factor | Pin | How |
| ------ | --- | --- |
| Window | content 1600 × 1000 CSS px (same as the legacy suites) | `BrowserWindow.setContentSize` via `evaluate` after `firstWindow` (dev, twin) |
| Device scale | 1 | Chromium switch `--force-device-scale-factor=1` (not in Electron's switch list [R10]; spike S4 verifies `devicePixelRatio === 1`) |
| GPU backend | visual projects: SwiftShader `--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader` [R11]; `dev-gpu` project: hardware, no pixel baselines | switches on the launch args; the record's WebGL renderer string must contain `SwiftShader` in visual projects, else `E2E_ENV_MISMATCH` |
| Display (Linux) | Xvfb screen 1920×1080×24 | `xvfb-run` in CI [R13] |
| Fonts | bundled latin fonts loaded | wait for `document.fonts.ready`; visual fixtures avoid non-latin text (unicode names are checked as DOM text, not pixels) |
| Animations / caret | disabled / hidden | `toHaveScreenshot` defaults [R15] |
| Render loop | idle before a shot | wait until `llullDiagnostics().frames` is stable over two windows (the `viewportIdle` rule) |
| Profile | fresh temp profile, `LLULL_HOME`, `LLULL_DATA_DIR`, autosave per instance | `--profile` (§2.3) |
| Network | none | the backend is loopback; tests fail on any non-loopback request (`session.webRequest` filter in dev / twin) |
| Locale / time zone | `en-US`, `UTC` | `--lang=en-US`, `TZ=UTC` env |
| Kernel | recorded; `@native` tests require `occt-native` (`LLULL_REQUIRE_NATIVE_KERNEL=1` as in `check.yml`) | `kernel_info` via CLI |

## 7. Visual-diff policy (TR-E2E-08)

1. **Gating pixel baselines** exist only for the `dev-swiftshader` project, one set per OS (Playwright names baselines per
   platform [R14]). Comparator: `toHaveScreenshot` with `threshold: 0.2` (Playwright default, YIQ per-pixel [R15]) and
   `maxDiffPixelRatio: 0.005` (the 0.5 % budget proposed in `docs/QUALITY_GATES.md` "Proposed next gates" #4), masks on the
   status-bar timestamps.
2. **Geometric checks gate everywhere** (all projects, all OS): gate 2's silhouette, `visible`, `framed`, `aspect`,
   `stretch` (`tests/quality/silhouette.ts`), on `observe.viewport()` shots.
3. **SSIM** [R25] is computed and reported for every compared pair (triage), never gating.
4. **Updating baselines**: only `npm run e2e -- --update-visual` (wraps `--update-snapshots` [R14]); the PR must carry the
   old / new / diff images (CI uploads them) and a one-line reason; a reviewer approves. CI never updates baselines.
5. A hardware-GPU difference is not a regression by itself: `dev-gpu` and twin projects assert geometry and errors only.

## 8. Stable codes (AF-11)

| Code | Meaning |
| ---- | ------- |
| `E2E_LAUNCH_TIMEOUT` | no first window / backend health within the launch limit |
| `E2E_FUSE_MISMATCH` / `E2E_ASAR_MISMATCH` | release fuses ≠ builder config, twin ≠ release + one fuse / asar hash differs |
| `E2E_UNSTUBBED_DIALOG` | a native dialog was called without a scripted answer |
| `E2E_ACTION_TIMEOUT` | an action's declared commands never arrived |
| `E2E_COMMAND_MISMATCH` | received commands ≠ declared |
| `E2E_COMMAND_REFUSED` | the command summary is a refusal and the test did not expect one |
| `E2E_STATE_HASH_DIVERGED` | renderer and backend state hashes differ after an action |
| `E2E_RENDERER_GONE` / `E2E_CHILD_GONE` / `E2E_RENDERER_HUNG` / `E2E_MAIN_ERROR` / `E2E_APP_EXIT` / `E2E_BACKEND_EXIT` | crash / hang classes (§5.3), with Electron's `reason` |
| `E2E_CONSOLE_ERROR` | renderer console error or page error (no exemptions; the offline probe exemption goes away with the browser path) |
| `E2E_NETWORK_REQUEST` | a non-loopback request |
| `E2E_ENV_MISMATCH` | environment record ≠ the project's pins |
| `E2E_VISUAL_DIFF` | pixel baseline exceeded |
| `E2E_A11Y_VIOLATION` | a serious / critical axe violation not in the ratchet |
| `E2E_VC_NOT_IMPLEMENTED` | a requested VC has no test (result `skipped`) |
| `E2E_FLAKE_BUDGET` | flake ledger over budget (§11) |

## 9. VC runner contract for the central readiness gate (TR-E2E-12)

```text
npm run e2e:vc -- --pack <pack dir> [--vc VC-UXD-03,VC-UXD-04 | --all] [--mode dev|twin|shipped]
                  [--profile ref-win11] [--out .cache/readiness/results] [--executable <path>]
```

1. Read `<pack dir>/validation/expected_results.json`; validate it against `docs/readiness/vc.schema.json`.
2. Select the cases whose `driver` is `electron` (and, when given, whose `id` is listed). A listed id with another driver
   is written `skipped` with `reason: "driver <x> is not electron"`.
3. Map each id to tests by tag: a desktop test carries `{ tag: '@VC-UXD-03' }` in its title options; the runner runs
   Playwright with `--grep` of the selected tags. No test for an id → `skipped`, `reason: E2E_VC_NOT_IMPLEMENTED`.
4. Tests report measurements with `testInfo.annotations.push({ type: 'vc-measured', description: JSON.stringify({ id,
   value, unit }) })` and artefacts with `testInfo.attach`.
5. The reporter compares `measured` with the case's `target` (`{op, value}`) or `expected` ± `tolerance` when the test did
   not assert itself; assertion failures are `fail`. A case listed in `tests/desktop/knownIssues.json` (ratchet: must fail)
   that fails is `known`; one that passes is `fail` with `reason: "known issue now passes: remove it"`.
6. One file per VC: `<out>/<pack>/<VC id>.json`, schema [`validation/data/vc-result.schema.json`](validation/data/vc-result.schema.json):

```json
{ "id": "VC-UXD-03", "pack": "02-drafting-interaction", "status": "pass", "measured": 41.2, "unit": "s",
  "target": { "op": "<=", "value": 60 }, "artefacts": [".cache/readiness/results/02-drafting-interaction/VC-UXD-03/trace.zip"],
  "durationMs": 58231, "machineProfile": "ref-win11", "commit": "f1351cff", "mode": "twin", "attempts": 1, "flaky": false,
  "reason": null }
```

Exit code 0 when every selected MUST case is `pass` or `known`; the central gate reads the files, not the exit code.
(Values in the example are illustrative.)

## 10. Migration, CI matrix and local run

### 10.1 Migration (FR-E2E-09)

| Step | Change | Done when |
| ---- | ------ | --------- |
| G1 | Harness + self-tests (VC-E2E-01…14, 21…30) in dev mode | self-tests green on Linux + Windows CI |
| G2 | Port `tests/e2e/*.spec.ts` → `tests/desktop/flows/` (helpers `buildingHelpers.ts` → harness actions). Browser-only idioms change: `localStorage.clear()` → fresh profile; `page.goto('/')` → launch; anchor downloads → `will-download` capture (the 400 ms pacing in `session.ts:16` is dropped if VC-E2E-28 shows no drop); `setInputFiles` on the "Project file" input is kept for the in-renderer control and joined by a File > Open variant; `addInitScript` frame counter (`viewportIdle.spec.ts:32-40`) → `llullDiagnostics().frames` | ledger 30 / 30 ported, green twice in a row; old and new run side by side in CI for 10 consecutive green runs |
| G3 | Production UI driver: `UiSession` takes an `AppHandle`; `OPTIONAL_SERVER` exemption removed; flows unchanged; `npm run production:ui` → desktop config | 4 / 4 scenarios with the criteria counts of `PRODUCTION_GATE.md` Results (27 / 30 / 28 / 11), `knownIssues.ui` empty |
| G4 | Quality gate 2: "Open project" → `act.openDocument`; silhouette code reused; `npm run quality:display` → desktop config | every case of the tier passes or is in its ratchet exactly as in the browser run of the same commit |
| G5 | Delete: `playwright.config.ts` browser project + `webServer`, `playwright.production.config.ts`, `playwright.quality.config.ts`, `tests/e2e/`, CI job `e2e`, `test:e2e` repointed to `playwright.desktop.config.ts`; update W3 table, `PRODUCTION_GATE.md`, `QUALITY_GATES.md`, `verify-llull` skill, LC1 (new "step 7 done") | VC-E2E-18 scan clean |

Semantic change, stated: the browser suites exercised the renderer's offline `execute` on Manifold. On Electron, commands
go to the backend (native kernel when bundled). Local mode (`localMode.ts`, backend unreachable) becomes a pack 04 fault
case instead of the default path of every UI test.

### 10.2 CI matrix (FR-E2E-10)

| Lane | Trigger | Runners | Mode / project | Suites |
| ---- | ------- | ------- | -------------- | ------ |
| `desktop-e2e` | every PR | `ubuntu-latest` (Xvfb [R13]), `windows-latest` | dev / `dev-swiftshader` | self-tests, flows, display smoke tier; visual baselines gate on both |
| `desktop-e2e-twin` | nightly, release branch | `windows-latest` (after `native-bundle`), `ubuntu-latest`, `macos-latest` when the owner lifts the macOS deferral | twin | everything + production UI + display full tier + readiness `electron` cases |
| `desktop-shipped` | release | pack 05 install VMs | shipped | smoke + fuse / asar verification |
| `desktop-quarantine` | nightly | `ubuntu-latest` | dev | quarantined tests only, non-gating |
| reference machine | owner / agent on demand | owner's Windows 11 workstation (hardware GPU) | `dev-gpu`, twin | pack 03 perf, gate 2 on hardware |

Standard hosted runners have no GPU; GPU runners are larger runners on paid plans [R17][R18], so CI renders with
SwiftShader everywhere and hardware-GPU evidence comes from the reference machine (owner question Q3).
Electron's binary must now be downloaded in CI for these lanes (`check` keeps `ELECTRON_SKIP_BINARY_DOWNLOAD=1`).
Artefacts on failure: Playwright report, traces, videos, logs, crash folders, visual diffs.

### 10.3 Local run

`npm run e2e` builds what is stale (`npm --prefix desktop run build`), takes the heavy slot, launches in dev mode with a
temp profile and its own port (the backend port is chosen per user-data folder, `desktop/src/backend.ts`
`chooseBackendPort`). It never touches the developer's `~/.llull`, never kills a process it did not start, and can run in a
lane worktree (`npm run lane`). `npm run e2e -- --headed-slow` shows the actions with a delay for debugging.

## 11. Flake budget (TR-E2E-11)

- CI `retries: 1` (unchanged from today); Playwright classifies passed / flaky / failed [R16]. Local `retries: 0`.
- Ledger: every CI run appends per-test outcomes; rolling window = last 50 runs of the lane.
- Quarantine rule: a test flaky in ≥ 3 of the last 50 runs is moved to `tests/desktop/quarantine.json` (tag `@quarantine`,
  runs only in `desktop-quarantine`) with an owner-visible issue; it expires after 14 days → fixed or deleted. Size cap 5 %
  of desktop tests; above it the lane fails `E2E_FLAKE_BUDGET`. A MUST readiness VC is never quarantined without an owner
  decision recorded in the pack.
- Suite flake rate (flaky executions / executions over the window) ≤ 1 %.
- Retry hygiene: a retry gets a fresh app instance and profile; `testInfo.retry` is recorded in the result (`attempts`).

All numbers in this section are budgets of this spec (grade `target`), to revisit after 50 measured CI runs.

## 12. Performance and robustness budgets of the harness itself

| Item | Budget | Basis |
| ---- | ------ | ----- |
| Launch to first window + backend healthy (dev, twin) | hard limit 30 s; typical `TBD — measure with VC-E2E-01` | Playwright default [R1] |
| Twin build from an unpacked release | `TBD — measure with VC-E2E-02` | — |
| Per-action overhead (stream quiet wait) | `TBD — measure with VC-E2E-09`; ≤ 10 % of the ported suite's wall time vs the browser run | spec budget |
| PR lane wall time | ≤ 30 min per OS (the current `e2e` and `check` jobs' `timeout-minutes: 30`) | `check.yml` |
| Memory | one app instance per worker; workers = 1 unless `--workers` given (as today) | `playwright.config.ts` |

## 13. Test strategy

| Level | What | VC |
| ----- | ---- | -- |
| unit (`desktop/tests`) | menu ids unique, every accelerator unique, `--profile` parsing, crash-report writer for process-gone | VC-E2E-08, 10, 11 |
| harness self-tests (`tests/desktop/selftest`) | launch, twin, fuses, dialogs, menus, DSL, watchdog, determinism, isolation, runner | VC-E2E-01…14, 21…30 |
| ported suites | flows, production UI, display | VC-E2E-15…17 |
| repository scans | legacy path deleted, CI lanes present | VC-E2E-18, 19 |
| ledger | flake budget | VC-E2E-20 |

## 14. Delivery plan

| Milestone | Content | Depends on | Effort (agent-days, estimate) |
| --------- | ------- | ---------- | ----------------------------- |
| S0 spike | S1 Playwright launch of dev app; S2 twin flip + launch on Windows; S3 accelerators via CDP vs `sendInputEvent`; S4 `--force-device-scale-factor`; S5 `--profile` + single-instance lock; S6 `chrome://gpucrash`; S7 shipped attach via `--remote-debugging-port` | — | 2 |
| M1 | harness core, product changes (menu ids, crash reporter, process-gone reports, `--profile`, diagnostics), self-tests | S0 | 5 |
| M2 | port `tests/e2e` + parity ledger; CI `desktop-e2e` | M1 | 3 |
| M3 | production UI driver + gate 2 on Electron | M2 | 3 |
| M4 | visual policy, flake ledger, quarantine lane, twin lane | M2; pack 05 M0 for release builds | 3 |
| M5 | VC runner + reporter + schema; perf / fault / install APIs | M1 | 3 |
| M6 | delete the browser path, docs | M3 green 10 runs | 1 |

Total ≈ 20 agent-days. Cross-pack: 05 INS (builds the release artefacts the twin and shipped modes need; the native bundle on
each OS), 02 / 03 / 04 consume §5.2. Each milestone is reviewed by `cad-reviewer` (it touches `desktop/`, `src/ui`) and
gated by `npm run check` plus the desktop lanes.

## 15. Open questions and proposed decisions

| # | Question | Proposed |
| - | -------- | -------- |
| Q1 | May the shipped binary be attached through `--remote-debugging-port` for the smoke? It is a documented Electron switch [R10] that no fuse disables; anyone able to launch the app as the user can already run code as that user | yes for the install-VM smoke only; if refused, shipped smoke = CLI `--app` + `render_view` + process / crash checks |
| Q2 | Is a read-only `globalThis.llullDiagnostics()` in the shipped renderer acceptable (it backs Help > Diagnostics; no write path) | yes; alternative: expose it only through the backend (`GET /diagnostics` fed by the renderer), slower |
| Q3 | Which platforms gate a release: Windows only (today's native bundle), + Linux, + macOS? Pay for GPU runners [R18] or keep hardware-GPU evidence on the reference machine? | Windows + Linux gate now, macOS when the owner lifts the deferral; no paid GPU runners, reference machine for GPU |
| Q4 | Playwright vs WebdriverIO | Playwright `_electron` (§16) |
| Q5 | Keep a second, fused-on "test release" artefact? | no: build the twin on demand from the release (one fuse), never distribute it |

## 16. Framework decision

| Option | Main-process access with the release fuses | Fit with llull | Verdict |
| ------ | ------------------------------------------ | -------------- | ------- |
| Playwright `_electron` [R1] | needs `nodeCliInspect` on → twin | same runner, `Page` API, `toHaveScreenshot`, traces, retries as the 30 + 4 + gate-2 legacy tests → port is mostly mechanical; `evaluate` in main for dialogs / menus / downloads; experimental | **chosen** |
| WebdriverIO `wdio-electron-service` [R4][R5][R6] | same fuse requirement for `execute` / `mock` [R5] | built-in `mock('dialog', …)`, auto-detects electron-builder output; second test runner, chromedriver; rewrites every test | fallback if Playwright drops Electron |
| Custom stdio test driver [R2] | none needed | requires an app-side listener gated by an env var = a test hook in the shipped app (violates §2.3.4) | rejected |
| Spectron | — | deprecated 2022-02-01 [R3] | rejected |

## 17. References

[R1]–[R27] and code-survey rows S1–S12: [`validation/sources.md`](validation/sources.md).
