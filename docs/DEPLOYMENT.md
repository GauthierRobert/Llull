# Deployment — desktop app + CLI (local only)

llull is installed on the engineer's machine and runs offline (decision
[LC1](decisions/LC1-local-only.md)). There is no shared server, no Docker image, no named users, licence
seats, audit trail or admin routes: one local backend per machine, started by the desktop app or the CLI.

| Piece           | What it is                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------- |
| Desktop app     | Electron shell (`desktop/`): starts the local backend on loopback and shows the React UI in it |
| Local backend   | `server/` bundle: the live document, autosave, exchange (STEP / DWG / CadQuery), exports        |
| `llull` CLI     | `server/src/cli`: the agent path (Claude Code, scripts, CI), on a file or on the open app       |
| Native binaries | `solver/` (`llull-compute`, `llull-kernel`), bundled with the app when built                   |

## 1. Install

Build the installer on each target OS (native wheels, the Python runtime and the native binaries are per
platform); details in [desktop/README.md](../desktop/README.md):

```bash
npm ci && npm --prefix server ci && npm --prefix desktop ci
npm --prefix desktop run dist        # installer in desktop/release/
```

The installer bundles a relocatable CPython with CadQuery, so STEP import / export and CadQuery code exchange
work offline with nothing else installed. `import_code` (arbitrary Python) stays off unless the app is launched
with `LLULL_ALLOW_CODE_EXECUTION=1`.

## 2. Agents: the CLI

Help › Install Command Line Tool puts a `llull` launcher in `~/.llull/bin`. `llull --app …` drives the open
window's document (the user sees every change and can undo it); `llull --doc part.llull …` works headless on a
file. Procedure: the `llull-cli` skill; reference: `node server/bin/llull.cjs help`.

## 3. Security of the local backend

- The backend binds `127.0.0.1` only; a non-loopback `HOST` refuses to start.
- The desktop app mints a random per-launch token (`LLULL_AUTH_TOKEN`, `LLULL_REQUIRE_TOKEN_FOR_REST=true`) and
  writes it, owner-only, to `~/.llull/desktop.json` for the CLI. Every REST call needs it as
  `Authorization: Bearer <token>`; the SSE stream takes a single-use 30 s `?ticket=` minted by
  `POST /live/ticket`. Other local processes and websites cannot reach the document.
- The only allowed browser origin is the app's own; Host headers other than loopback names are refused
  (DNS rebinding).

Every server variable (rate limits, timeouts, Python bridge, kernel) is listed in
[server/README.md](../server/README.md#environment-variables).

## 4. DWG converter

DWG import runs an external converter, never linked into llull: LibreDWG's `dwg2dxf` (0.14 or later, on the
`PATH`; Debian stable does not package it and older releases have known CVEs) or the ODA File Converter.
Without a converter `POST /import/dwg` answers 503; DXF import is unaffected. When running the backend or the
CLI directly, `LLULL_DWG2DXF=<path|off>` and `LLULL_ODA_CONVERTER=<executable>` choose the converter.

LibreDWG is GPL-3.0: it runs as a separate program. Keep it that way (do not bundle a LibreDWG
WebAssembly/library build into the app) unless llull's licence allows it.

## 5. Backup and upgrade

The open document is autosaved to `autosave.json` in the app's user-data directory; File › Save writes
`.llull` files wherever the user chooses. Back up those files like any other engineering data. The autosave is
versioned and migrated on load; an unreadable one is moved aside as `autosave.json.unreadable-<ts>` and the
app starts empty. Upgrading is installing the new build over the old one.
