# llull desktop

The llull web app, the local backend (`server/`), the `llull` CLI and Python + CadQuery in one
installable offline app. Rationale: [`docs/decisions/KI6-desktop-app-cli-first.md`](../docs/decisions/KI6-desktop-app-cli-first.md).

```
Electron main (src/main.ts: wiring only)
  ├─ utilityProcess: server/dist/index.js on 127.0.0.1:<stable port>, per-launch token
  │     serves the web app (built with VITE_LLULL_SERVER_URL=same-origin), /command, /live, /export
  │     LLULL_PYTHON = resources/python (CadQuery: import_step / export_step;
  │     import_code runs arbitrary Python: only when the app is launched with LLULL_ALLOW_CODE_EXECUTION=1)
  ├─ BrowserWindow → http://127.0.0.1:<port>/#token=…   (sandboxed, navigation pinned)
  ├─ File menu → DocumentSession (load_document / clear_document / snapshot → .llull file)
  └─ ~/.llull/desktop.json → `llull --app …` (Claude Code drives the open document)
```

## Develop

```bash
npm install && npm --prefix server install && npm --prefix desktop install
npm --prefix desktop run build    # web (same-origin) + server bundle + main process
npm --prefix desktop start        # Electron; LLULL_PYTHON=python3 to use a system CadQuery
npm --prefix desktop test         # Electron-free: real backend + File ops + CLI --app
npm --prefix desktop run typecheck
```

Without `npm run prepare:python`, development uses `desktop/build/python` if present, else set
`LLULL_PYTHON` (STEP/CadQuery tools report the bridge as unavailable otherwise).

## Package

```bash
npm --prefix desktop run dist     # build → stage:server → prepare:python → electron-builder
```

- Run it on each target OS: the server's native modules and the Python wheels are per platform.
- `prepare:python` downloads python-build-standalone (pinned in the script; override with
  `LLULL_PYTHON_STANDALONE_URL`, verify with `LLULL_PYTHON_STANDALONE_SHA256`, or point
  `LLULL_PYTHON_STANDALONE_DIR` at an extracted tree), runs `pip install -r
  server/python/requirements.txt`, and fails unless the bridge probe reports CadQuery.
- Output in `desktop/release/`: dmg/zip (macOS), nsis (Windows), AppImage/deb (Linux). `.llull`
  files open in the app.
- Signing: `CSC_LINK` / `CSC_KEY_PASSWORD`; macOS notarization: `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`.

## Claude Code

Help › Install Command Line Tool writes `~/.llull/bin/llull` (or `llull.cmd`), which runs the
bundled CLI with the app runtime. With the app open:

```bash
llull status                              # app running? which document?
llull add_box size=[40,30,10] --app       # change the open document (undo: Ctrl+Z / llull undo --app)
llull run plan.json --validate --app      # then without --validate
llull render_view --save view.png --app   # look at it
```

Without `--app` the CLI works on files (`--doc part.llull`). Procedure: `.claude/skills/llull-cli/SKILL.md`.
