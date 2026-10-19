# KI6 — Desktop app (Electron); local agents use the CLI, MCP is for the cloud

Status: accepted (2026-10). Amended by [LC1](LC1-local-only.md) (2026-10-19): the cloud / on-prem host and MCP were
removed; the CLI is the only agent path. The "MCP is the cloud surface" bullet below is historical.

## Problem

Engineering offices expect an installed, offline CAD application that works on files. The web app
already works offline, but the useful parts sit in `server/` (OpenCascade worker, STEP and CadQuery
exchange through Python, PNG rendering, large documents), and somebody had to start that server by
hand. Browser autosave lives in `localStorage` (about 5 MB). Local AI agents reached llull over
MCP, which needs a running server and a configured client. A terminal agent (Claude Code) is
faster with the `llull` CLI: it writes a plan file, runs one command, and reads compact output.

## Decision

- **Electron shell in `desktop/`** (own `package.json`, not a workspace, like `server/`). The
  main process holds wiring only. It starts the **unchanged server bundle** in an Electron
  `utilityProcess` on loopback, and the window loads the **unchanged web app**. The web app is
  built with `VITE_LLULL_SERVER_URL=same-origin` and served by that backend. No business logic is
  added. L1 and L6 hold: File > Open/New go through `load_document` / `clear_document`, and Save
  serializes `GET /live/snapshot`.
- **Python is bundled, not an add-on.** A relocatable CPython (python-build-standalone) with
  CadQuery ships in `resources/python`, so `import_step` / `export_step` / CadQuery exchange work
  offline with nothing else installed (`desktop/scripts/prepare-python.mjs`). build123d is not
  bundled because it pins a different OCP version. DWG import still needs an external converter.
  `import_code` (arbitrary Python) stays off unless the app is launched with
  `LLULL_ALLOW_CODE_EXECUTION=1`.
- **The local agent path is Claude Code + the CLI.** The app writes `~/.llull/desktop.json`
  (owner-only: URL, per-launch token, pid, open document). `llull --app …` drives the window's
  document, and the user sees every change live and can undo it. The exchange tools (STEP,
  DWG, CadQuery code) are reachable from the CLI too: in-process for `--doc`, or through
  `POST /exchange` (the MCP handlers, with document changes on the command bus) for
  `--app` / `--server`. Help > Install Command Line Tool
  puts a `llull` launcher in `~/.llull/bin`; it runs the CLI with the app's own runtime
  (`ELECTRON_RUN_AS_NODE`). The `llull-cli` skill is the procedure.
- **MCP is the cloud surface.** `/mcp` stays in the server (on-prem and cloud deployments, Claude
  Desktop and claude.ai connectors). The desktop app does not advertise it; it remains reachable
  on loopback with the launch token.
- **Desktop hardening.** The backend binds 127.0.0.1 only, and a per-launch random token is
  required on every REST call (`LLULL_REQUIRE_TOKEN_FOR_REST`). The only allowed browser origin is
  the app's own, which blocks other local processes and websites. The window runs with
  `contextIsolation` and `sandbox`, `nodeIntegration` is off, and navigation is pinned to the
  backend origin. The port is stable across launches (remembered in `desktop-settings.json`), so
  the page origin, and its UI preferences, do not change.

## Consequences

- The installer is large (Chromium plus CPython plus CadQuery/OCP, several hundred MB). That is
  accepted in exchange for zero setup.
- Each OS is packaged on that OS (`npm run dist`: native wheels and the Python runtime are per
  platform). Signing and notarization use the usual electron-builder environment.
- The desktop logic is tested without Electron (`npm --prefix desktop test`): the real server
  bundle starts the way the app starts it, File operations go through `DocumentSession`, and the
  CLI uses `--app` through the discovery file. The Electron glue (`desktop/src/main.ts`) is
  type-checked; driving the window itself needs a desktop session.
- The stack table in `CLAUDE.md` gains Electron (desktop shell) and bundled CPython + CadQuery.
