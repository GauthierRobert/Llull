export const USAGE = `llull — the CAD command registry from a shell (same commands as the desktop app).

Usage: llull <subcommand> [args] [flags]

Discover
  list [toolset]              every command, one line each (toolsets: llull toolsets)
  search <words…>             rank commands by keywords        [--limit N]
  describe <command…>         full description + params schema
  toolsets                    toolset names and command counts
  guide                       CAD modeling conventions (units, axes, ids, plans)
  status                      is the desktop app running? which document would --doc use?
  crashes list|show ID|dir    local crash reports (document, command log, error; show latest = newest,
                              with an issue draft link; nothing is sent)  [$LLULL_DATA_DIR/llull/crashes]

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
  stackup_monte_carlo contributors=[..] [expression=.. samples=1e7 seed=N lowerSpecLimit=.. upperSpecLimit=..]
                              analyze_stackup with the Monte Carlo native (llull-compute stats, Philox4x32-10, up to 1e10 samples,
                              bit-identical on any thread count); without llull-compute: NATIVE_TOOL_MISSING
  fea_render analysisId=ID [render_fea_results params] raster=auto|ts|cpu|gpu --save plot.png
                              the same plot with the pixel raster in llull-compute (cpu = bit-identical twin, gpu = picture)
  topology_solve studyId=ID   native llull-compute topology optimization of a study (create_topology_study), recorded with
                              record_topology_result  [timeoutS=1800 resumeFromLast=true device=cpu|gpu|auto]; --progress prints one
                              line per iteration; without llull-compute only 2D studies up to 2000 voxels (TypeScript), else
                              TOP_TOOL_MISSING; then: topology_report studyId=ID, check_topology studyId=ID
  mtest_run mtest=SCRIPT      OPTIONAL MFront / MTest (user-installed, never bundled: $LLULL_MTEST, $LLULL_MFRONT; needs LLULL_ALLOW_CODE_EXECUTION=1):
                              run an MTest script [mfront={name,source} timeoutS=120 probe=true]; absent tools -> MFRONT_TOOL_MISSING with the reason
  auto_route lineId=ID from='{"portId":"tie-1.1"}' to='{"portId":"tie-2.1"}' [route_problem params]
                              native llull-compute pipe auto-routing (plant 02 RTE V2), committed by auto_route_pipe after
                              validation  [timeoutS=60 maxExpansions=2000000]; without llull-compute: NATIVE_TOOL_MISSING
                              (auto_route_pipe alone runs the TypeScript search up to 200000 expansions)
  stackup_monte_carlo [analyze_stackup params] samples=N   native llull-compute: stack-up Monte Carlo above the 2e6 TS cap
                              (same Philox samples as analyze_stackup)  [timeoutS=600 verify=true]
  vortex_lattice_solve [analyze_vortex_lattice params]   native llull-compute: vortex lattice above the 1000-panel TS cap
                              (influence + dense LU, faer; up to 20000 panels)  [timeoutS=600 verify=true]
  scan import FILE [sourceUnit=mm columns=xyzi …]   point cloud (E57 / LAS / LAZ / XYZ / PTS / CSV) -> native llull-compute octree
                              asset in $LLULL_SCAN_CACHE (~/.llull/cache/pointcloud); prints assetKey; then attach_point_cloud
                              assetKey=KEY. scan list = the stored assets. Toolset scan (llull list scan)
  register_material_library file=LIB.llull-matlib.json   copy a material library into $LLULL_LIBRARIES_DIR (~/.llull/libraries); then
                              import_material_library libraryId=ID version=V sha256=H, and resolve_material_libraries after a load
  run <plan.json | ->         build_project: an actions array or { actions, onError }
                              [--validate] dry-run check  [--continue] onError=continue
  new [--force]               write an empty document
  undo | redo                 local: swap with FILE.bak (one level); server: shared history
  keys list | create --user ID --name NAME | revoke KEYID   enroll a local signing key (09 PLM; $LLULL_KEYS_DIR, default ~/.llull/keys;
                              private key encrypted with the passphrase in $LLULL_KEY_PASSPHRASE or --passphrase-env VAR, >= 12 characters). An enrolled key is NOT trusted:
                              only the llull desktop app can trust it (Keys); revoke withdraws trust
  release pack --revision R --out DIR [--attach --confirm-key KEYID]   write the signed, read-only release package of a
                              frozen revision (--doc; --attach records its hash with attach_release_package, a human-only act)
  release verify DIR          re-verify a package: member hashes, manifest hash, Ed25519 signatures, key trust (works without a document)
  release sign --revision R --key KEYID [--kind release|iteration] [--apply]   sign release_manifest with a local key; --apply records it
                              with record_signature (the key must be trusted), else prints the params
  lotar pack --revision R --out DIR [--organization-id ID --organization-name NAME] [--export-confirmation FILE] [--attach --confirm-key KEYID]
                              EN 9300 archive package of a frozen revision (--doc): the release package plus the AP242 PDM file, validation properties,
                              PLM records (baselines, as-built, MBOM, FAI results) and VERIFY.txt
  lotar verify DIR [--manifest-sha256 HASH | --doc FILE]   everything release verify checks, plus the validation properties re-derived from the
                              archived definition, the PDM read-back and the sealed records
  (import a QIF 3.0 results file as FAI results: llull exec import_qif_results xml=@text:results.qif revision=A --confirm-key KEYID)
  vault init | status [PN] | checkout PN | checkin | renew PN | break-lock PN | verify   the local vault (09 PLM; --vault DIR or $LLULL_VAULT, --doc FILE):
                              checkout takes the exclusive lock and writes the head document, checkin checkpoints, stores frozen snapshots as
                              content-addressed objects, updates refs and frees the lock; PLM_VAULT_LOCKED names the holder; break-lock only a stale lock
  audit verify [DIR]          recompute the hash-chained audit log ($LLULL_AUDIT_DIR, default ~/.llull/audit); exit 1 on a broken chain
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
  --confirm-key KEYID         human-only plm acts (record_approval, release_item, classify_change_order, set_change_state, set_item_marking,
                              set_lifecycle_state obsolete, set_item_identity policy, attach_release_package) need a signature by a TRUSTED
                              key over the act: this flag signs it, the passphrase typed at an interactive terminal (never read from the environment). Without it
                              they are refused with PLM_HUMAN_GATE; there is no caller label to claim
  --doc FILE                  local document file
  --server URL                act on a running llull server's live document instead
                              ($LLULL_SERVER; --token T or $LLULL_TOKEN for Bearer auth)
  --dry-run                   run against the local file but never write it
  --no-fit                    run: keep the camera as it is (by default a plan that never sets it is framed with fit_view)
  --save PATH                 write the file a command returns (export_stl, export_3mf, export_code,
                              export_step_exact, export_step_ap242, export_iges, sheets, export_urdf, export_nc_files → a directory);
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
