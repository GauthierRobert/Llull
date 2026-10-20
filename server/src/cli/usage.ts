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
  fea_export analysisId=ID [format=calculix_inp|nastran_bdf|vtu]   the solver deck (CalculiX .inp, Nastran .bdf) or a VTU of mesh + results (text + sha256)  [--save deck.inp]
  fea_import_results analysisId=ID format=frd|op2 file=R.op2   external results of the current mesh -> record_fea_results
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
  mtest_run mtest=SCRIPT      OPTIONAL MFront / MTest (user-installed, never bundled: $LLULL_MTEST, $LLULL_MFRONT; needs LLULL_ALLOW_CODE_EXECUTION=1):
                              run an MTest script [mfront={name,source} timeoutS=120 probe=true]; absent tools -> MFRONT_TOOL_MISSING with the reason
  register_material_library file=LIB.llull-matlib.json   copy a material library into $LLULL_LIBRARIES_DIR (~/.llull/libraries); then
                              import_material_library libraryId=ID version=V sha256=H, and resolve_material_libraries after a load
  run <plan.json | ->         build_project: an actions array or { actions, onError }
                              [--validate] dry-run check  [--continue] onError=continue
  new [--force]               write an empty document
  undo | redo                 local: swap with FILE.bak (one level); server: shared history
  run_benchmarks [packs=a,b]  judge every docs/physics/*/validation/expected_results.json case
                              (harness recipes + unit-test measurements); exit 1 on an A-grade
                              fail/error  [grades=A,B caseIds=… measurements=FILE root=DIR]

Flags
  --app                       act on the running llull desktop app (what the user sees;
                              found via ~/.llull/desktop.json, token included)
  --doc FILE                  local document file
  --server URL                act on a running llull server's live document instead
                              ($LLULL_SERVER; --token T or $LLULL_TOKEN for Bearer auth)
  --dry-run                   run against the local file but never write it
  --no-fit                    run: keep the camera as it is (by default a plan that never sets it is framed with fit_view)
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
  --kernel manifold|occt-native  geometry kernel for local runs (default: the native llull-kernel when found, else
                              Manifold with a warning; $LLULL_KERNEL; manifold is a diagnostic override)

Exit codes: 0 ok · 1 the command failed, a plan step failed, or a change command changed
nothing · 2 bad usage or unreadable input`;
