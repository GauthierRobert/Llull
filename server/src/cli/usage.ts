export const USAGE = `llull — the CAD command registry from a shell (same commands as the desktop app).

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
  fea_mesh analysisId=ID      mesh an FE analysis (Gmsh) and record it; needs python gmsh
  fea_solve analysisId=ID     solve it with CalculiX (ccx)  [timeoutS=600]; then: fea_report analysisId=ID
  fea_export analysisId=ID    the CalculiX .inp deck (text + sha256)  [--save deck.inp]
  fea_import_field analysisId=ID file=T.csv coordinatesUnit=mm temperatureUnit=degC   temperature table x,y,z,T -> thermo_static field
                              (works locally and with --app / --server; artifacts: $LLULL_FEA_CACHE)
  fatigue_field caseId=ID     native llull-compute: rainflow + Miner damage on every FE node, then compute_fatigue
                              [timeoutS=600 verify=true]  (--doc, --app, --server: runs where the document lives; $LLULL_COMPUTE)
  fea_map_field analysisId=ID native llull-compute: interpolate the thermal result onto the mechanical mesh
                              (fea_solve does it itself from $LLULL_NATIVE_MAP_MIN_NODES nodes)
  fea_render analysisId=ID [render_fea_results params] raster=auto|ts|cpu|gpu --save plot.png
                              the same plot with the pixel raster in llull-compute (cpu = bit-identical twin, gpu = picture)
  topology_solve studyId=ID   native llull-compute topology optimization of a study (create_topology_study), recorded with
                              record_topology_result  [timeoutS=1800 resumeFromLast=true device=cpu|gpu|auto]; --progress prints one
                              line per iteration; without llull-compute only 2D studies up to 2000 voxels (TypeScript), else
                              TOP_TOOL_MISSING; then: topology_report studyId=ID, check_topology studyId=ID
  register_material_library file=LIB.llull-matlib.json   copy a material library into $LLULL_LIBRARIES_DIR (~/.llull/libraries); then
                              import_material_library libraryId=ID version=V sha256=H, and resolve_material_libraries after a load
  run <plan.json | ->         build_project: an actions array or { actions, onError }
                              [--validate] dry-run check  [--continue] onError=continue
  new [--force]               write an empty document
  undo | redo                 local: swap with FILE.bak (one level); server: shared history
  run_benchmarks [packs=a,b]  judge every docs/physics/*/validation/expected_results.json case
                              (harness recipes + unit-test measurements); exit 1 on an A-grade
                              fail/error  [grades=A,B caseIds=… measurements=FILE root=DIR]

Robustness fuzz (local kernel; seeded designs on a 2.5 mm grid, checked after every step)
  fuzz [--from N] [--count K] [--jobs J] [--out DIR] [--report FILE] [--kinds join,cut,…] [--max-steps M]
                              run seeds N..N+K-1: base (box / extrusion / revolve) + up to 8 joins, cuts, fillets,
                              chamfers, shells, holes, patterns (fillet/chamfer/shell only on a kernel that has them);
                              every body a valid closed solid of positive volume, cuts never add and joins never
                              remove volume, plus V(A∪B)+V(A∩B)=V(A)+V(B) and V(A−B)=V(A)−V(A∩B) within 0.2 %.
                              --out writes each failing seed's plan, --report the JSON report; exit 1 on a failure
  fuzz-one <seed> [--minimise] [--out FILE]
                              one seed step by step; --minimise delta-debugs the steps to a minimal failing
                              build_project plan (printed, or written to FILE; replay with llull run FILE)

Agent skills (for your own agent driving this CLI)
  skills list | path          the shipped skills (llull-modeling, llull-editing, llull-checking, llull-mechanisms)
  skills install [--dir D] [--force]   copy them into ~/.claude/skills (or D); --force replaces changed copies

Flags
  --app                      act on the running llull desktop app (what the user sees;
                              found via ~/.llull/desktop.json, token included)
  --doc FILE                  local document file
  --server URL                act on a running llull server's live document instead
                              ($LLULL_SERVER; --token T or $LLULL_TOKEN for Bearer auth)
  --dry-run                   run against the local file but never write it
  --no-fit                    run: keep the camera as it is (by default a plan that never sets it is framed with fit_view)
  --save PATH                 write the file a command returns (export_stl, export_3mf, export_code,
                              export_step_exact, sheets, export_urdf, export_nc_files → a directory);
                              PATH.png rasterizes an svg (render_view)
  --json                      print one JSON object instead of text
  --quiet                     print nothing on success
  --progress                  stream one stderr line per plan step ([12/189] boolean … 3.2s);
                              automatic when stderr is a terminal. Steps over 10 s always warn, and
                              every step's durationMs is in the --json report (local runs only)
  --timeout SEC               stop a whole run after SEC seconds: exit 1 with a clear message, nothing
                              saved. Local: checked between plan steps, a hard kill 5 s later for a
                              step that never ends; --server: per-request limit (default 120 s)
  --kernel manifold|occt-native  geometry kernel for local runs (default: the native llull-kernel when found, else
                              Manifold with a warning; $LLULL_KERNEL; manifold is a diagnostic override)

Exit codes: 0 ok · 1 the command failed, a plan step failed, or a change command changed
nothing · 2 bad usage or unreadable input`;
