# LC1 — CLI + local only (no browser, no cloud)

Status: decided 2026-10-19 by the owner: "remove the browser part entirely; it will work on CLI and local only; optimize for that".
Binding text: `CLAUDE.md` § PRODUCT DIRECTIVE. Related: RS1 (native compute), KI6 (desktop + CLI first), the 12 CFD directives
(CLI only, local only, MCP being removed).

## What changes

| Before | After |
| ------ | ----- |
| Web app usable in a browser (Vite site, PWA + service worker, `?kernel=` URL choice) | The React UI runs only inside Electron (`desktop/`); no web build is published |
| Cloud / on-prem server (Docker image, multi-user auth, licence, tickets, admin) and MCP `/mcp` for cloud agents | One local backend per machine, started by the desktop app or the CLI; agents use the `llull` CLI |
| WASM kernels (OpenCascade.js 7.4, Manifold) as the default and the browser path | Native `llull-kernel` (OCCT 7.9.2) is the target default; WASM kernels are legacy, kept only until the native default is proven |
| Offline outbox for a browser losing its server | The backend is local and always present; the outbox only has to cover a backend restart |

## Order of work (each step keeps `npm run check` green)

1. **Native kernel default on desktop + CLI** — VC-KRN-25 vs OCP 7.9.3, then flip (in progress, PR #89 follow-up).
2. **Stop shipping the browser build**: drop the PWA (`serviceWorker/`, `viteServiceWorker.ts`, `playwright.pwa.config.ts`, `test:pwa`,
   `tests/pwa/`), the public web deployment docs, and the `?kernel=` URL switch in `src/main.tsx`; Vite stays as the Electron renderer's
   dev server and bundler.
3. **Remove the cloud host** — done 2026-10-19. Removed: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, the CI `image` job;
   named users / roles (`server/src/users.ts`, `scripts/add-user.mjs`), the offline licence (`license.ts`, `scripts/license.mjs`,
   `GET /license`), the audit trail (`audit.ts`), `/admin/*` (`adminRoutes.ts`), the deprecated `?access_token=` query token,
   `LLULL_TRUST_PROXY`, `LLULL_ALLOWED_HOSTS`, `LLULL_ALLOW_UNAUTHENTICATED` and non-loopback binding (a non-loopback `HOST` now
   refuses to start). Kept, because the desktop app uses them: `security.ts` (per-launch bearer token `MCP_AUTH_TOKEN` +
   `LLULL_REQUIRE_TOKEN_FOR_REST`, origin / Host allowlists, CSRF guard, rate limits) and `tickets.ts` (single-use `?ticket=` for
   the UI's `/live` EventSource, now without user identity). Live `command` events keep their `source` (rest / cli) for the UI's
   labels. `docs/DEPLOYMENT.md` rewritten for the desktop app + CLI; `PILOT.md`, `README.md`, `server/README.md` updated.
   Deferred: the UI status bar still asks `GET /license` (now 404, it renders nothing) — remove with the UI clean-up.
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
   Deferred: the token keeps its env name `MCP_AUTH_TOKEN` (set by `desktop/src/backendEnv.ts`); the UI still has an MCP connect
   panel (`McpConnect`), the `mcp` live-event source label and the `useMcpLiveDocument` hook name — UI clean-up; aerospace / physics /
   plant feature specs still mention MCP as written at the time.
5. **Retire the WASM kernels** once the native kernel has been the desktop default for a release: `packages/kernel-occt` (opencascade.js),
   then decide on Manifold (still useful as an in-process mesh kernel for tests and for commands that need no exact B-rep).
6. **Simplify for one local backend**: outbox / live-sync paths that only existed for remote or flaky connections; bundle size budgets
   that only mattered for web download.

Every removal is its own PR with the tests that covered the removed surface deleted or moved, never skipped.

## Not changed

- The command layer, the registry, purity, plugins, document format: unchanged.
- The UI is still React + three.js, rendered by Electron's Chromium (that is a local renderer, not a browser deployment).
- Offline-first stays (AF-41): nothing needs the network.
