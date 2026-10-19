# LC1 — CLI + local only (no browser, no cloud)

Status: decided 2026-10-19 by the owner: "remove the browser part entirely; it will work on CLI and local only; optimize for that".
**Done 2026-10-19**: steps 1–6 below are complete (the step-5 "one release on the native default" wait was waived by the owner's goal to finish LC1).
Binding text: `CLAUDE.md` § PRODUCT DIRECTIVE. Related: RS1 (native compute), KI6 (desktop + CLI first), the 12 CFD directives
(CLI only, local only, MCP being removed).

## What changes

| Before | After |
| ------ | ----- |
| Web app usable in a browser (Vite site, PWA + service worker, `?kernel=` URL choice) | The React UI runs only inside Electron (`desktop/`); no web build is published |
| Cloud / on-prem server (Docker image, multi-user auth, licence, tickets, admin) and MCP `/mcp` for cloud agents | One local backend per machine, started by the desktop app or the CLI; agents use the `llull` CLI |
| WASM kernels (OpenCascade.js 7.4, Manifold) as the default and the browser path | Native `llull-kernel` (OCCT 7.9.2) is the target default; WASM kernels are legacy, kept only until the native default is proven |
| Offline outbox for a browser losing its server | The backend is local and always present: no outbox (step 6); the renderer runs commands locally only while `/live` is down |

## Order of work (each step keeps `npm run check` green)

1. **Native kernel default on desktop + CLI** — VC-KRN-25 vs OCP 7.9.3 (passed), then flip.
   - [x] Done 2026-10-19. Desktop: KI7 (`backendEnv.ts`). Server + CLI: `LLULL_KERNEL` unset installs the native `llull-kernel` when
     found (`LLULL_KERNEL_BIN`, `LLULL_NATIVE_DIR`, `solver/target/release`), else Manifold with a warning and
     `kernel_info.fallbackReason`; `LLULL_KERNEL=manifold` is a diagnostic override. `llull run --validate` now warns from the installed
     kernel (`supports('fillet')`), not from `$LLULL_KERNEL`.
2. **Stop shipping the browser build**: drop the PWA (`serviceWorker/`, `viteServiceWorker.ts`, `playwright.pwa.config.ts`, `test:pwa`,
   `tests/pwa/`), the public web deployment docs, and the `?kernel=` URL switch in `src/main.tsx`; Vite stays as the Electron renderer's
   dev server and bundler.
   - [x] Done 2026-10-19. Removed: `serviceWorker/`, `viteServiceWorker.ts` (+ its Vite plugin), `playwright.pwa.config.ts`,
     `test:pwa`, `tests/pwa/`, `tests/unit/{viteServiceWorker,serviceWorkerRuntime}.test.ts`, the update banner
     (`src/ui/services/appUpdates.ts`, `src/ui/components/UpdateBanner.tsx` + test + CSS), the `?kernel=` switch and
     `src/ui/geometry/occtKernelBrowser.ts`. README / `docs/ARCHITECTURE.md` / `docs/DEPLOYMENT.md` / rules / skills describe
     desktop + CLI. `parseKernelChoice` stayed until step 5.
   - Kept for step 5: the renderer still installs Manifold (WASM) in-process (`src/main.tsx`) — it runs the commands the
     renderer executes itself (local mode while the backend restarts, read-only queries, panel analyses) and re-runs live
     events to check the state hash. The desktop backend defaults to the native OCC kernel (KI7), so replay of kernel commands falls back to a
     snapshot fetch; moving those to the backend removes the renderer kernel.
   - Items kept for step 6 (serverConfig, IndexedDB libraries, outbox, COOP/COEP, `node:module` stub, demo files): see step 6.
   - Follow-up done: the OCC kernel hint in `packages/core` command descriptions / summaries no longer mentions the browser.
3. **Remove the cloud host** — done 2026-10-19. Removed: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, the CI `image` job;
   named users / roles (`server/src/users.ts`, `scripts/add-user.mjs`), the offline licence (`license.ts`, `scripts/license.mjs`,
   `GET /license`), the audit trail (`audit.ts`), `/admin/*` (`adminRoutes.ts`), the deprecated `?access_token=` query token,
   `LLULL_TRUST_PROXY`, `LLULL_ALLOWED_HOSTS`, `LLULL_ALLOW_UNAUTHENTICATED` and non-loopback binding (a non-loopback `HOST` now
   refuses to start). Kept, because the desktop app uses them: `security.ts` (per-launch bearer token, env `LLULL_AUTH_TOKEN` since step 6, +
   `LLULL_REQUIRE_TOKEN_FOR_REST`, origin / Host allowlists, CSRF guard, rate limits) and `tickets.ts` (single-use `?ticket=` for
   the UI's `/live` EventSource, now without user identity). Live `command` events keep their `source` (rest / cli) for the UI's
   labels. `docs/DEPLOYMENT.md` rewritten for the desktop app + CLI; `PILOT.md`, `README.md`, `server/README.md` updated.
   UI follow-up done in step 6: the status bar no longer asks `GET /license` (the `LicenseResponseBody` type is gone too).
4. **Remove MCP** — done 2026-10-19. Removed: the `/mcp` endpoint (`server/src/mcp.ts`, `server/src/mcp/{server,middleware,sessions}.ts`),
   the `@modelcontextprotocol/sdk` dependency, MCP resources (`cad://…`), prompts, server instructions, the `search_tools` /
   `enable_toolset` meta-tools and per-session toolset gating (`LLULL_TOOLSETS`, `MCP_RATE_LIMIT_*`, `MCP_MAX_SESSIONS`,
   `MCP_SESSION_*`), `server/examples/{mcp-agent.ts,factory-demo.mts}`, the MCP-only tests, `.mcp.json`'s `llull` entry, the
   `mcp-server` skill; the `mcp-engineer` agent became `cli-engineer`. Moved: `packages/mcp` → `packages/protocol` (`@protocol`,
   `@llull/protocol`), which keeps what the UI, the backend, the desktop shell and the CLI share — live sync (`liveSync.ts`), REST
   bodies (`restProtocol.ts`), command outcomes, document file names, the exchange / FE / library tool definitions and their ports
   (`FeaToolsPort`, `CadExchangePort`, …), toolsets (CLI listings, UI palette), tool search (`llull search`) and result shaping
   (`toolResult.ts`, was `dispatch.ts`). They stay in a workspace package rather than `server/` because root unit tests and the UI
   import them (`server/` is not a workspace). `toToolSchemas()` is unchanged (`llull describe`, plan validation; the contract
   snapshot stays). The production gates now drive the backend the way the CLI does (`server/tests/production/cliHarness.ts`).
   UI follow-up done in step 6: the MCP connect panel (`McpConnect`, its tests and CSS), the `mcp` live-event source and tone
   (sources are now `rest` | `cli`; the dead `userId` / `userName` fields of the live event went with them), the agent pill
   (now "Live sync: <status>") and the `useMcpLiveDocument` hook (now `useLiveDocument`). The bearer-token env var is
   `LLULL_AUTH_TOKEN` (was `MCP_AUTH_TOKEN`; renamed cleanly, no fallback: only the desktop app sets it, per launch, and it
   strips the name from the backend's inherited env). Aerospace / physics / plant feature specs still mention MCP as written at
   the time.
5. **Retire the WASM kernels** once the native kernel has been the desktop default for a release: `packages/kernel-occt` (opencascade.js),
   then decide on Manifold (still useful as an in-process mesh kernel for tests and for commands that need no exact B-rep).
   Decision: keep `packages/kernel-manifold` (in-process mesh kernel for tests, the renderer and the fallback when `llull-kernel` is missing).
   - [x] Done 2026-10-19. Unblocked by porting the pocket floor fillet to the sidecar: the host sends the floor-selection inputs of the
     lowered pocket (`floorFillet` on the `featureCut` node: radius, floor depth, frame, outline / island curves in frame-local
     coordinates), and `llull-kernel-occt` `recipe/floor.rs` picks the unique edges of the cut's topology in explorer order with the rules of
     `floorEdgeIndices` (not seam / degenerate; start, mid and end on the floor plane within 1e-5 (1 + depth); within that tolerance of an outline
     or island curve), then fillets them (no edge = refused). The gate in `server/src/native/kernelFeatures.ts` is gone.
     Removed: `packages/kernel-occt` (opencascade.js, `@kernel-occt/*` alias, tsconfig / knip / package.json entries, the `opencascade.js`
     dependency), `server/src/{occtNode,occtWorker}.ts`, the WASM fallback of `nativeKernelWorker.ts` / `native/kernelRouter.ts` (the router
     now only translates and forwards; a refused or unsupported recipe is a null result, a dead sidecar is respawned on the next call),
     `recycle` / `recycleCount` of `isolatedKernel.ts`, `kernelChoice.ts` / `parseKernelChoice` (nothing read it) and the `occt` value of
     `LLULL_KERNEL` (only `manifold` is special; `occt` is now just "not manifold", i.e. the native kernel), the desktop's WASM fallback
     (`desktopKernel(inherited)` returns `occt-native` unless `manifold`; a bundle without `llull-kernel` falls through to Manifold plus the
     server's warning; `hasNativeKernel` is gone), the WASM-only tests (`tests/unit/occtKernel.test.ts`, `server/tests/occtRepeatedMeshing`,
     `workerEntry`, the recycle cases of `isolatedKernel`). Moved to `packages/core/src/geometry`: `tangentGuard`, `meshClosure` (with their tests).
     Parity suites that used WASM as the oracle assert closed forms and run against the real binary (see KI7 amendment); the other
     `server/tests/occt*` suites run on the native kernel and skip with a logged reason when the binary is missing
     (`LLULL_REQUIRE_NATIVE_KERNEL=1`, set in CI, fails instead).
   - Kept: `packages/kernel-manifold` (mesh kernel for tests, the renderer, the fallback) and the hint texts `--kernel occt` / `LLULL_KERNEL=occt`
     in command descriptions, which still work (the value selects the native kernel like any value but `manifold`).
6. **Simplify for one local backend** — done 2026-10-19.
   - Removed: the offline outbox and its replay (`src/ui/store/outbox.ts`: queued commands, id remapping, poisoned ids, retry
     backoff, `syncState`, `hasUnsyncedLocalEdits`, `localOutbox`, `localRedoOutbox`, `localOnly`), the connect-grace timers
     (`graceRuns.ts`, `CONNECT_GRACE_MS`), the 4xx / 401-403-404 refusal classification that only the flush used, and the
     autosave "outbox acknowledged, drop the copy" rule; tests `outboxPermanentError`, `connectGrace` and the outbox / flush
     cases of `store`, `dispatchOnResult`, `Autosave`. The desktop shell does not restart the backend (it quits when the backend
     exits), so there is nothing to replay to.
     `VITE_LLULL_SERVER_URL` and `VITE_LLULL_API_TOKEN` (build vars): `serverConfig.ts` now uses the page origin in a production
     build (the backend serves the renderer) and `http://localhost:3001` under `npm run dev`; `desktop`'s `build:web` no longer sets
     the var (and drops `cross-env`). The IndexedDB material-library provider (`browserLibraries.ts` + test): nothing in the
     renderer ever registered a library, so it was always empty; renderer-side `execute` has no library provider and library
     lookups answer "not found" there (the backend uses its own `~/.llull/libraries/` provider). COOP / COEP headers of the Vite
     dev server (nothing uses `SharedArrayBuffer` in the renderer; only `server/` workers do, and Node needs no isolation). The
     unreferenced `public/bike-*.svg` and `public/bike-views.html`. The never-built "bundle budget" quality gate (gzip size
     per chunk, "first load on the web") in `docs/QUALITY_GATES.md`. There is no other size budget in `scripts/`, `package.json`
     or CI.
   - Kept, and why: local `execute` in the renderer while `/live` is down (`localMode.ts`: bounded undo snapshots, status
     "ran locally — backend offline"; read-only queries and panel analyses also need it) — on reconnect the backend snapshot is
     adopted and the status bar says that local edits were replaced; `#token=` fragment (+ `localStorage['llull.apiToken']` so a
     reload keeps the token): it is how `desktop/src/main.ts` hands the per-launch token to the renderer; the `/live/ticket`
     single-use ticket for the `EventSource`; autosave + restored-copy banner (they keep local work recoverable, and
     are outside this step); the `node:module` alias in `vite.config.ts`, because the renderer still bundles Manifold
     (`manifold-3d` imports `node:module`; without the alias the build externalizes it and the WASM loader breaks) — Manifold stays
     (step 5 decision), so the alias stays; `chunkSizeWarningLimit: 900` (a console warning threshold for three.js, not a budget).

Every removal is its own PR with the tests that covered the removed surface deleted or moved, never skipped.

## Not changed

- The command layer, the registry, purity, plugins, document format: unchanged.
- The UI is still React + three.js, rendered by Electron's Chromium (that is a local renderer, not a browser deployment).
- Offline-first stays (AF-41): nothing needs the network.
