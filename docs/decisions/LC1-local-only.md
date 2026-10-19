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
3. **Remove the cloud host**: Docker image + CI `image` job, `docker-compose.yml`, multi-user auth / licence / tickets / admin routes
   (`server/src/{users,security,license,tickets,adminRoutes}.ts`), `docs/DEPLOYMENT.md` / `PILOT.md` cloud parts — after checking that
   the desktop and the CLI use none of it.
4. **Remove MCP**: `packages/mcp` exposure and `/mcp`; move what the CLI still needs (`FeaToolsPort`, exchange tools, discovery used by
   `llull search`) to `server/` (12 CFD open question 2). Tool schemas stay (`toToolSchemas()` feeds the CLI's `describe`).
5. **Retire the WASM kernels** once the native kernel has been the desktop default for a release: `packages/kernel-occt` (opencascade.js),
   then decide on Manifold (still useful as an in-process mesh kernel for tests and for commands that need no exact B-rep).
6. **Simplify for one local backend**: outbox / live-sync paths that only existed for remote or flaky connections; bundle size budgets
   that only mattered for web download.

Every removal is its own PR with the tests that covered the removed surface deleted or moved, never skipped.

## Not changed

- The command layer, the registry, purity, plugins, document format: unchanged.
- The UI is still React + three.js, rendered by Electron's Chromium (that is a local renderer, not a browser deployment).
- Offline-first stays (AF-41): nothing needs the network.
