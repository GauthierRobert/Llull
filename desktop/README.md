# llull desktop

The llull web app, the local backend (`server/`), the `llull` CLI and Python + CadQuery in one
installable offline app. Rationale: [`docs/decisions/KI6-desktop-app-cli-first.md`](../docs/decisions/KI6-desktop-app-cli-first.md).

```
Electron main (src/main.ts: wiring only)
  ├─ utilityProcess: server/dist/index.js on 127.0.0.1:<stable port>, per-launch token
  │     serves the web app (built with VITE_LLULL_SERVER_URL=same-origin), /command, /live, /export
  │     LLULL_PYTHON = resources/python (CadQuery: import_step / export_step;
  │     import_code runs arbitrary Python: only when the app is launched with LLULL_ALLOW_CODE_EXECUTION=1)
  │     LLULL_NATIVE_DIR = resources/native, only when bundled (llull-compute jobs; llull-kernel)
  │     LLULL_KERNEL = occt-native when the bundle holds llull-kernel (native OCCT 7.9.2, KI7), else occt (WASM OCC);
  │       an inherited LLULL_KERNEL=manifold or occt is kept as a diagnostic override
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
npm --prefix desktop run dist     # build → stage:server → prepare:python → prepare:native → electron-builder
```

- Run it on each target OS: the server's native modules and the Python wheels are per platform.
- `prepare:python` downloads python-build-standalone (pinned in the script; override with
  `LLULL_PYTHON_STANDALONE_URL`, verify with `LLULL_PYTHON_STANDALONE_SHA256`, or point
  `LLULL_PYTHON_STANDALONE_DIR` at an extracted tree), runs `pip install -r
  server/python/requirements.txt`, and fails unless the bridge probe reports CadQuery.
- `prepare:native` (needs Rust; RS1) builds `llull-compute` (with the `gpu` feature: wgpu raster, CPU-twin fallback) and
  `llull-kernel` into `build/cargo-target`, builds or reuses the shared OCCT 7.9.2 (`solver/scripts/build-occt.mjs`, about an
  hour the first time; or `LLULL_OCCT_DIR`), and stages `build/native/{llull-compute,llull-kernel,occt/lib/*,licenses/}`
  (Windows: the OCCT DLLs next to the executables). `LLULL_NATIVE_PREBUILT_DIR` takes prebuilt binaries, `LLULL_NATIVE_GPU=0`
  drops wgpu, `LLULL_NATIVE_KERNEL=0` ships `llull-compute` only. With `llull-kernel` in the bundle the app runs the native kernel
  (`LLULL_KERNEL=occt-native`, [KI7](../docs/decisions/KI7-native-kernel-default.md): it passed the VC-KRN-25 reference suite);
  without it (`LLULL_NATIVE_KERNEL=0`) the WASM OCC kernel (`LLULL_KERNEL=occt`). Launch with
  `LLULL_KERNEL=occt` to compare against the WASM kernel.
  Only the Linux path is exercised so far; macOS (`@loader_path` rpath, dylib install names) and Windows (DLL staging) are untested.
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
