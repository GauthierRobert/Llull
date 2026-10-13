export const USAGE = `llull — the CAD command registry from a shell (same commands as the UI and MCP).

Usage: llull <subcommand> [args] [flags]

Discover
  list [toolset]              every command, one line each (toolsets: llull toolsets)
  search <words…>             rank commands by keywords        [--limit N]
  describe <command…>         full description + params schema
  toolsets                    toolset names and command counts
  guide                       CAD modeling conventions (units, axes, ids, plans)
  status                      is the desktop app running? which document would --doc use?

Act (on --doc FILE, default $LLULL_DOC or model.llull.json; created on first change)
  exec <command> [params]     run one command; params are key=value pairs (values parsed as
                              JSON unless the param is a string: size=[1,2,3] name=123),
                              one JSON object,
                              @params.json or - (stdin); a value @img:scan.png is
                              read as an image data URL (add_image_underlay dataUrl=…)
  <command> [params]          shorthand for exec
                              exchange tools too (export_step, import_step, import_dwg,
                              import_code): file=PATH reads a local file into their content
  run <plan.json | ->         build_project: an actions array or { actions, onError }
                              [--validate] dry-run check  [--continue] onError=continue
  new [--force]               write an empty document
  undo | redo                 local: swap with FILE.bak (one level); server: shared history

Flags
  --app                       act on the running llull desktop app (what the user sees;
                              found via ~/.llull/desktop.json, token included)
  --doc FILE                  local document file
  --server URL                act on a running llull server's live document instead
                              ($LLULL_SERVER; --token T or $LLULL_TOKEN for Bearer auth)
  --dry-run                   run against the local file but never write it
  --save PATH                 write the file a command returns (export_stl, export_code,
                              export_step_exact, sheets, export_nc_files → a directory);
                              PATH.png rasterizes an svg (render_view)
  --json                      print one JSON object instead of text
  --quiet                     print nothing on success
  --progress                  stream one stderr line per plan step ([12/189] boolean … 3.2s);
                              automatic when stderr is a terminal. Steps over 10 s always warn, and
                              every step's durationMs is in the --json report (local runs only)
  --timeout SEC               stop a whole run after SEC seconds: exit 1 with a clear message, nothing
                              saved. Local: checked between plan steps, a hard kill 5 s later for a
                              step that never ends; --server: per-request limit (default 120 s)
  --kernel manifold|occt      geometry kernel for local runs (default manifold; $LLULL_KERNEL)

Exit codes: 0 ok · 1 the command failed, a plan step failed, or a change command changed
nothing · 2 bad usage or unreadable input`;
