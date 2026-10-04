# Quality gates

`npm run check` proves the code is internally consistent. The quality gates prove the **app** does
the right thing with **real CAD data it did not author**: third-party STEP files from OpenCascade,
CadQuery, build123d and pythonocc, imported through the same path an MCP agent uses, then opened
in the real browser app.

```bash
npm run quality:fetch     # download the pinned corpus → .cache/quality-corpus/ (sha256-verified)
npm run quality:step      # STEP import gate   (needs CadQuery: pip install -r server/python/requirements.txt)
npm run quality:display   # display gate       (Playwright + Chromium, runs after quality:step)
npm run quality           # all three
QUALITY_TIER=smoke|full|stress npm run quality:step   # default: full
```

Reports (JSON metrics per file) and screenshots land in `.cache/quality-corpus/reports/`.

## Corpus — `quality/corpus.json`

Every file is pinned to a commit URL + sha256 and is **downloaded, never committed** (licences
range from MIT to LGPL). Tiers are cumulative: `smoke` ⊂ `full` ⊂ `stress`.

| id | tier | what it stresses |
| -- | ---- | ---------------- |
| red-cube-blue-cylinder | smoke | 2-part AP214 assembly, per-part colours + names |
| screw | smoke | B-spline faces |
| face-recognition-part | smoke | prismatic machined part, coloured faces |
| splinecage | smoke | surface-only model (no solid) |
| as1-oc-214 | smoke | classic nested assembly: 18 placed parts, colours, product names |
| as1-pe-203 | smoke | same assembly in AP203, large coordinates |
| m6-countersunk-screw | smoke | fine helical thread on a small part |
| linkrods | full | 1.8 MB single solid, many small fillets |
| ventilator | full | free-form twisted blades |
| part-11752 | full | ~125k-triangle single solid |
| kuka-kr600 | stress | robot, 61 solids, ~860k triangles |
| rc-buggy-suspension | stress | 211-part assembly, ~1.2M triangles |

Eight DXF files (gear, V-slot profile, splines, hatches, nested-block dimensions…) are also pinned
and downloaded, but **llull has no DXF/SVG importer yet**, so no gate consumes them. They are the
ready-made corpus for an `import_dxf` gate.

## Gate 1 — STEP import fidelity (`server/tests/quality/stepImport.gate.ts`)

Each STEP file goes through the Python bridge (`import_step` port) → `import_mesh` → the measure
and check commands → save/load. Ground truth comes from `quality/step_reference.py`, which reads the
file with **plain OpenCascade** (exact B-rep volumes, optimal bounding boxes, the XDE colour/name
table), independently of the bridge's code path.

| check | passes when |
| ----- | ----------- |
| `imports` | one mesh per reference solid |
| `mesh-integrity` | finite coordinates, < 1 % degenerate triangles; solids: < 0.1 % open/non-manifold edges and every body outward-wound (positive signed volume) |
| `volume` | `measure_volume` total within 1.5 % of the exact B-rep volume |
| `bounding-box` | `measure_bounding_box` within 0.5 % of the diagonal (+ 2× chord tolerance) of the face bbox. Catches scale, unit and axis-swap errors |
| `part-placement` | every body's bbox matches a distinct reference solid. Catches assembly-transform errors that keep total volume |
| `colors` | the file defines colours ⇒ at least one body is not the default grey |
| `part-names` | assemblies keep at least one product name |
| `check-model` | `check_model` reports no errors |
| `save-load` | `serializeDocument` → `load_document` round-trips; writes the document for gate 2 |

## Gate 2 — display (`tests/quality/display.gate.ts`)

Every imported STEP document, plus native 2D and 3D documents built from golden plans, is opened
through **Open project** in the real app (offline mode). The model silhouette is the pixel diff
between a screenshot and the same camera with every layer hidden (a local view toggle), so the
grid, lighting and DOM overlays cancel out.

| check | passes when |
| ----- | ----------- |
| `errors` | no console error, page error or `webglcontextlost` (the refused probe of the optional server at `localhost:3001` is expected offline) |
| `stretch` | canvas drawing-buffer aspect equals its CSS box aspect |
| `visible` | the model covers ≥ 0.05 % of the canvas |
| `framed` | after `fit_view` (3D, top) / zoom-extents (2D) the model is whole (not touching the border) and fills ≥ 2 % |
| `aspect` | on-screen width/height equals the world X/Y bounding-box ratio. 2D (orthographic): within 3 %; 3D (perspective): within 15 %. **This is the deformation check.** |
| `fit-all-button` / `top-view-button` | the UI buttons leave the model whole and visible |

## The ratchet: `knownIssues`

A check that fails today is listed in the file's `knownIssues` (`displayKnownIssues` for gate 2,
`NATIVE_KNOWN_ISSUES` for native documents). The gate is green when **exactly** the known checks
fail. It goes red on a new failure, and also when a known issue starts passing, which forces whoever
fixed it to delete the entry. Quality can only move forward.

## What the gates found (first run, 2026-10)

Geometry import is solid: on every file that imports, volume is within 0.9 % of the exact B-rep,
bboxes and per-part placement match, meshes are watertight and outward-wound, and save/load
round-trips. Every document renders with no console, page or WebGL error, and on-screen proportions
match the bounding box (2D within 0.2 %, most 3D within 0.5 %). The open defects, all recorded as
`knownIssues`:

| # | defect | evidence | where |
| - | ------ | -------- | ----- |
| 1 | **Manifold kernel never loaded in the dev app**: pre-bundling moved `manifold-3d` away from its `.wasm`, which 404'd into `index.html`. Booleans and other kernel commands were unavailable in the browser. **Fixed** (`optimizeDeps.exclude`) | display `errors` | `vite.config.ts` |
| 2 | **Large STEP files cannot be imported**: the bridge's JSON reply exceeds the 128 MB cap at ~0.8M triangles (full-precision floats, triangle soup, fixed 0.05 mm chord tolerance whatever the model size) | `kuka-kr600`, `rc-buggy-suspension`: `imports` | `server/python/llull_bridge.py`, `server/src/pythonExchange.ts` |
| 3 | **STEP colours and part names are dropped**: `as1-oc-214` defines 5 colours and parts `bolt` / `nut` / `plate` / `rod`, and imports as grey `solid_1..18` (the tool description promises both) | `colors`, `part-names` | `llull_bridge.py` `_assembly_bodies` |
| 4 | **"Fit all" frames entity positions, not geometry** (+ a fixed 3-unit guess) and always switches to iso. Imported parts (all at the origin) are not framed | display `fit-all-button` | `src/ui/viewport/3d/ViewPresets.tsx` |
| 5 | **Front / Top / Right presets ignore the model**: they always target the origin at distance 10 | display `top-view-button` | `ViewPresets.tsx` `handlePreset` |
| 6 | **Open surfaces render single-sided**: faces of a surface-only import seen from behind disappear | `splinecage`: `aspect` | `MeshSolidMesh` / `SolidMeshShell` |
| 7 | **Arc bounds are the full circle**: `measure_bounding_box` (and so 2D zoom-extents and agents) over-reports a semicircle's height ×2 | `2d_arcs_circles`: `aspect` | `packages/core/src/commands/sceneBounds.ts` |
| 8 | **Text / dimension bounds disagree with what is drawn**, so zoom-extents is off-centre | `2d_text_dimensions`: `aspect` | `sceneBounds.ts` |
| 9 | A dark-grey half-plane (shadow-frustum edge) is visible on some 3D scenes | screenshot `native/3d_cone_torus_wedge_pyramid.png` | lighting / shadows |

`as1-oc-214`'s known `aspect` failure is **not** a defect. It renders correctly, but the 3D aspect
check runs in perspective, and its tall brackets near the camera read 15.5 % wide. An orthographic
measurement camera would remove this limit.

## Proposed next gates

Ordered by value per effort. Each one names a metric and a threshold, so it can ratchet like the
two gates above.

| # | gate | metric → threshold | why llull needs it |
| - | ---- | ------------------ | ------------------ |
| 1 | **Export round-trip** | corpus + golden docs → `export_stl` / `export_obj` / `export_gltf` (and STEP via the bridge) → re-parse → volume and bbox equal to the source within 0.5 % | exporters can deform geometry (units, axis convention, winding) and no test re-reads their output |
| 2 | **Performance budgets** | open-to-first-frame (gate 2 already records `loadMs`), median frame time while orbiting, JS heap after load, document bytes per triangle; fail on a +20 % regression against a stored baseline | a 125k-triangle STEP takes 12–21 s to open and its document is 44 MB (≈ 350 B/triangle) |
| 3 | **Leak check** | load → delete all → load ×5; GPU geometries / heap must return to baseline (`renderer.info.memory`) | R9 requires disposal, and nothing measures it |
| 4 | **Visual regression** | per-plan golden screenshot, pixel diff ≤ 0.5 % | catches lighting, shadow and material regressions that geometry checks miss |
| 5 | **DXF / SVG import** | same checks as gate 1 (bbox, entity counts, closed profiles extrude), then gate 2 in the 2D view | the 2D corpus is already pinned; the importer is the missing piece |
| 6 | **Kernel parity** | `kernelPlans` under Manifold and OCCT: volume and bbox agree within 0.5 % | L9 promises one kernel interface; nothing checks the two agree |
| 7 | **Malformed input** | truncated / corrupted STEP, JSON, oversized files → a graceful `summary`, unchanged document, no page error | import is an attack and crash surface |
| 8 | **Command fuzzing** | property-based (fast-check) params for every registered command: never throws, never mutates the input, `summary` non-empty | L3 purity and the graceful no-op contract, over all commands, not only the hand-written cases |
| 9 | **MCP task success** | scripted agent scenarios (bracket, enclosure, gearbox) through `/mcp`; `check_model` clean and measured dimensions match the brief | MCP is the product's defining surface |
| 10 | **Accessibility** | axe-core on every panel, 0 serious violations; keyboard-only open / fit / export flow | R10 |
| 11 | **Bundle budget** | `vite build` gzip size per chunk; fail on +10 % | first load on the web |

Gates 1–4 can reuse this corpus and the Playwright harness as they are. A nightly CI job running
`npm run quality` (the repo has no CI workflow yet) is what turns these from tools into gates.
