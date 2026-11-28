# Quality gates

`npm run check` proves the code is internally consistent. The quality gates prove the **app** does
the right thing with **real CAD data it did not author**: third-party STEP files (OpenCascade,
CadQuery, build123d, pythonocc, the FreeCAD parts library), plus synthetic STEP files built to hit
known CAD failure modes, imported through the same path the `llull` CLI uses, then opened in the app renderer next to complex native
2D/3D documents (`quality:display` still drives it with browser Playwright: legacy, being retargeted to Electron, LC1).

```bash
npm run quality:fetch     # download the pinned corpus → .cache/quality-corpus/ (sha256-verified)
npm run quality:generate  # build the synthetic STEP cases + their analytic ground truth (CadQuery)
npm run quality:step      # STEP import gate   (needs CadQuery: pip install -r server/python/requirements.txt)
npm run quality:display   # display gate       (Playwright + Chromium, runs after quality:step)
npm run quality:drawings  # drawing gate: 21 parts rebuilt from 2D drawings (OCC only, no download, ≈ 1 min)
npm run quality           # all four
QUALITY_TIER=smoke|full|stress npm run quality   # default: full (≈ 15 min); stress adds the giants
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
| fc-bearing-608zz | smoke | ball bearing: toroidal races, balls, shields |
| fc-gearmotor-l | smoke | 6-part gearmotor, named materials, 6 colours |
| fc-glass-skin-doors | smoke | 28-part facade spanning 7.6 m |
| fc-steel-sheets | smoke | 3 m corrugated roof sheet: long, thin, repetitive |
| fc-hotend | full | 3D-printer hotend: threads and fins |
| fc-arduino-mega | full | PCB assembly, 108 parts |
| fc-nema17-connector | full | stepper motor, 1151 faces; its screws are shells, not solids |
| fc-raspberry-pi-4b | stress | 52 MB PCB assembly: 89 solids + 1978 surface patches |

### Synthetic cases — `quality/synthetic_step.py`

Generated with CadQuery, never downloaded. Each case writes `<id>.expected.json` with **analytic**
ground truth (plain maths, not OpenCascade) and is self-checked when it is generated: the written
file must read back as designed. The `intent-*` checks compare the import with that design, so they
catch errors the bridge and the OCCT reference would share.

| id | tier | failure mode it targets |
| -- | ---- | ----------------------- |
| syn-chiral-pair | smoke | mirrored geometry (reversed face orientation → winding and volume sign) |
| syn-inch-units | smoke | a file in INCH units must land in millimetres |
| syn-hollow-cavity | smoke | a sealed internal void: two shells, the inner one facing inward |
| syn-skew-nested | smoke | a leaf three assembly levels deep, skew-axis rotations at every level |
| syn-far-from-origin | smoke | parts 1 000 km from the origin (float precision, floating origin) |
| syn-micro-part | smoke | a 0.5 mm pin against a fixed 0.05 mm chord tolerance |
| syn-unicode-names | smoke | `Ø20 Welle`, `支架-01`, `pièce éàü`, correctly `\X2\`-encoded |
| syn-face-colors | smoke | six face colours on one solid, no part colour |
| syn-perforated-plate | full | 0.5 mm plate with 100 holes: thin walls, genus 100 |
| syn-helical-spring | full | a wire swept along a 10-turn helix |
| syn-bolt-grid | full | 400 instances of one bolt, each rotated and moved |
| syn-huge-sphere | stress | a 10 m radius sphere: triangle count explodes with a fixed chord tolerance |

A mirrored *instance* cannot be expressed in STEP (placements are right-handed axis systems, and
writers turn a mirror into a 180° rotation), so mirroring is tested in the geometry.

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
| `imports` | at least one mesh per reference solid and per closed free shell |
| `mesh-integrity` | finite coordinates, < 1 % degenerate triangles; solids: < 0.1 % open/non-manifold edges and every body outward-wound (positive signed volume) |
| `volume` | `mass_properties` total within 1.5 % of the exact B-rep volume |
| `bounding-box` | `measure_bounding_box` within 0.5 % of the diagonal (+ 2× chord tolerance) of the face bbox. Catches scale, unit and axis-swap errors |
| `part-placement` | every body's bbox matches a distinct reference solid. Catches assembly-transform errors that keep total volume |
| `surface-area` | imported triangle area within 2 % of the area of every face in the file. Catches **dropped geometry** whatever the grouping |
| `colors` | the file defines colours ⇒ at least one body is not the default grey |
| `part-names` | assemblies keep at least one product name |
| `check-model` | `check_model` reports no errors |
| `save-load` | `serializeDocument` → `load_document` round-trips every body; writes the document for gate 2 |
| `intent-geometry` | synthetic only: body count, volume and bbox match the **analytic** design |
| `intent-names` | synthetic only: every designed product name is kept exactly (unicode included) |

## Gate 2 — display (`tests/quality/display.gate.ts`)

Every imported STEP document, native 2D and 3D documents built from golden plans, and the complex
native documents of `tests/quality/complexPlans.ts` are opened
through **Open project** in the real app (offline mode). The model silhouette is the pixel diff
between a screenshot and the same camera with every layer hidden (a local view toggle), so the
grid, lighting and DOM overlays cancel out.

| check | passes when |
| ----- | ----------- |
| `errors` | no console error, page error or `webglcontextlost` (the refused probe of the optional server at `localhost:3001` is expected offline) |
| `stretch` | canvas drawing-buffer aspect equals its CSS box aspect |
| `visible` | the model covers ≥ 0.05 % of the canvas |
| `framed` | after the UI "Top" view (3D; opening a project re-frames it to iso) / zoom-extents (2D) the model is whole (not touching the border) and spans ≥ 30 % of the canvas along its major axis |
| `aspect` | on-screen width/height equals the world X/Y bounding-box ratio. 2D (orthographic): within 3 %; 3D (perspective): within 15 %; plus ±2 px of edge on the shorter side. **This is the deformation check.** |
| `fit-all-button` / `top-view-button` | the UI buttons leave the model whole and visible |

Complex native documents: a 1 100-entity drawing, 2D and 3D scenes 2 000 km from the origin,
10 µm parts, a 100 m site plan, a 20:1 drawing, 900 instanced boxes + 60 cones, and a beam rotated
45°.

## The ratchet: `knownIssues`

A check that fails today is listed in the file's `knownIssues` (`displayKnownIssues` for gate 2,
`NATIVE_KNOWN_ISSUES` / `COMPLEX_KNOWN_ISSUES` for native documents). The gate is green when **exactly** the known checks
fail. It goes red on a new failure, and also when a known issue starts passing, which forces whoever
fixed it to delete the entry. Quality can only move forward.

## What the gates found (2026-10)

Geometry import is solid: on every file that imports, volume is within 0.9 % of the exact B-rep,
bboxes and per-part placement match, meshes are watertight and outward-wound, and save/load
round-trips. Every document renders with no console, page or WebGL error, and on-screen proportions
match the bounding box (2D within 0.2 %, most 3D within 0.5 %). The open defects, all recorded as
`knownIssues`:

| # | defect | evidence | where |
| - | ------ | -------- | ----- |
| 1 | **Manifold kernel never loaded in the dev app**: pre-bundling moved `manifold-3d` away from its `.wasm`, which 404'd into `index.html`. Booleans and other kernel commands were unavailable in the renderer. **Fixed** (`optimizeDeps.exclude`) | display `errors` | `vite.config.ts` |
| 2 | **Large STEP files cannot be imported**: the bridge's JSON reply exceeds the 128 MB cap at ~0.8M triangles (full-precision floats, triangle soup, fixed 0.05 mm chord tolerance whatever the model size) | `kuka-kr600`, `rc-buggy-suspension`: `imports` | `server/python/llull_bridge.py`, `server/src/pythonExchange.ts` |
| 3 | **STEP colours and part names are dropped**: `as1-oc-214` defines 5 colours and parts `bolt` / `nut` / `plate` / `rod`, and imports as grey `solid_1..18` (the tool description promises both) | `colors`, `part-names` | `llull_bridge.py` `_assembly_bodies` |
| 4 | **"Fit all" frames entity positions, not geometry** (+ a fixed 3-unit guess) and always switches to iso. Imported parts (all at the origin) are not framed. **Fixed** — passes on the smoke tier | display `fit-all-button` | `src/ui/viewport/3d/ViewPresets.tsx` |
| 5 | **Front / Top / Right presets ignore the model**: they always target the origin at distance 10. **Fixed** — passes on the smoke tier | display `top-view-button` | `ViewPresets.tsx` `handlePreset` |
| 6 | **Open surfaces render single-sided**: faces of a surface-only import seen from behind disappear | `splinecage`: `aspect` | `MeshSolidMesh` / `SolidMeshShell` |
| 7 | **Arc bounds are the full circle**: `measure_bounding_box` (and so 2D zoom-extents and agents) over-reports a semicircle's height ×2 | `2d_arcs_circles`: `aspect` | `packages/core/src/geometry/bounds.ts` |
| 8 | **Text / dimension bounds disagree with what is drawn**, so zoom-extents is off-centre. **Fixed** — within tolerance on the smoke tier | `2d_text_dimensions`: `aspect` | `packages/core/src/geometry/bounds.ts` |
| 9 | A dark-grey half-plane / "wings" (shadow-frustum edge) is visible on some 3D scenes, and inflates `fc-gearmotor-l`'s silhouette | screenshots `native/3d_cone_torus_wedge_pyramid.png`, `step/fc-gearmotor-l.png` | lighting / shadows |
| 10 | **Surface geometry is dropped when an assembly also has solids**: the bridge keeps only solids per node, so 1 978 surface patches (13 % of the area) vanish from the Raspberry Pi | `fc-raspberry-pi-4b`: `imports`, `surface-area` | `llull_bridge.py` `_solids` |
| 11 | **`measure_bounding_box` ignores rotation**: a 40 × 4 beam rotated 45° reports 40 × 4 (it covers ≈ 31 × 31), and `fit_view` / zoom-extents / agents inherit it | `complex/3d_rotated_beam`: `aspect` | `packages/core/src/geometry/bounds.ts` |
| 12 | **Thin round features lose volume**: the bridge's 0.3 rad angular deflection makes a swept 1 mm wire 2.3 % too light (vs the exact B-rep and the design) | `syn-helical-spring`: `volume`, `intent-geometry` | `llull_bridge.py` `_triangles` |
| 13 | **No triangle budget**: a 10 m sphere tessellated at 0.05 mm kills the bridge process (no graceful error); a 9 cm stepper turns into a 114 MB document because each M2.5 screw thread becomes 79k triangles | `syn-huge-sphere`: all; `fc-nema17-connector` report | `llull_bridge.py`, `import_mesh` limits |
| 14 | Face-level STEP colours are ignored (only part colours are read) | `syn-face-colors`: `colors` | `llull_bridge.py` `_assembly_bodies` |

What the complex cases **confirmed works**: inch → mm conversion, skew-rotated three-level nested
assemblies (exact to the analytic corners), mirrored geometry, sealed cavities, 400 rotated
instances, 100-hole thin plates, 0.5 mm parts, parts 1 000 km away, correctly encoded unicode names,
and shell-only parts (the NEMA 17 screws). In the renderer: no error on any of the 52 documents,
including 900 instances, 1 100-entity drawings and documents 2 000 km from the origin.

CadQuery's own STEP writer double-encodes non-ASCII names (`Ã20 Welle`), and llull's
`export_step` goes through CadQuery. Fixed: `export_step` now sends ASCII placeholders as names to the CadQuery script and writes the real names back into the returned STEP as ISO 10303-21 strings (`@lib/stepNames`); the native `export_step_ap242` path already encoded them correctly. The proposed export round-trip gate should still cover names.

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
| 9 | **CLI task success** | scripted agent scenarios (bracket, enclosure, gearbox) through the `llull` CLI; `check_model` clean and measured dimensions match the brief | the CLI is the product's agent surface |
| 10 | **Accessibility** | axe-core on every panel, 0 serious violations; keyboard-only open / fit / export flow | R10 |

Gates 1–4 can reuse this corpus and the Playwright harness as they are. A nightly CI job running
`npm run quality` (the repo has no CI workflow yet) is what turns these from tools into gates.

## Render reference gate — `quality/render-reference.json` (RV1 §7 V3)

`render_realistic` (the native path tracer) against an independent renderer, Blender 4.0 Cycles (CPU).

```bash
pip install -r quality/render/requirements.txt   # numpy, OpenEXR, flip-evaluator, Pillow (compare.py)
npm run render:reference        # render each scene with llull (256 spp, seed 1) and compare with its pinned Cycles reference
npm run render:reference:bake   # first: render missing / stale references with Blender (LLULL_BLENDER, default `blender`)
RENDER_REFERENCE_SCENES=cal-sun,cornell-box npm run render:reference   # a subset
```

- **Scenes** are llull documents built with registry commands (`server/tests/quality/renderScenes.ts`); their textures (a checker
  PNG, a striped roughness PNG, a synthetic equirect `.hdr` with a sun blob, a sky gradient and an orange patch) are generated there,
  deterministically. The gate keeps each scene's job folder in `.cache/render-reference/jobs/<id>/`.
- **Converter** `quality/render/cycles_from_job.py` (run inside Blender: `blender -b -P cycles_from_job.py -- <job> <out.exr> <spp>`)
  reads a §5b job folder and builds the same Cycles scene: one mesh per job mesh with its normals and UVs, one linked duplicate per
  instance row, Principled BSDF ("GGX", not multiscatter) with every job channel and texture, the camera (vertical fov / ortho height,
  thin lens), the lights hidden from the camera like llull's, the world (uniform colour, the default 0.3, or the HDR with llull's
  orientation: a Mapping node rotates by −rotation about Z; Cycles' equirect lookup is the same u, v), bounces = maxBounces − 1, no
  clamping / denoising / adaptive sampling / blur glossy / light threshold, a 32-bit linear EXR. The Preetham sky has no Cycles
  counterpart (Nishita is a different model) and is refused: the corpus has no sky.
- **References** are rendered once at 4 096 spp and stored as `.cache/render-reference/<sha256>.exr` (never committed); the manifest
  pins the sha256, the Blender version and the render time, plus `sceneSha256`, a hash of the llull job without its sampling knobs. A
  changed scene is stale and must be re-baked (its thresholds are then measured again); a lost cache file of an unchanged scene is
  re-baked keeping its thresholds. Cycles stamps its render time into the EXR header, so a re-bake gives the same pixels (checked:
  relError 0, FLIP 0) but a new sha256.
- **Metrics** (`quality/render/compare.py`, on the linear RGB):
  - `relError` = Σ min(|Yt − Yr|, Yr + ε) / Σ Yr, Y the Rec.709 luminance, ε = 0.1 × mean(Yr): a luminance-weighted mean relative
    error where one firefly counts at most as a 100 % error at its pixel;
  - `bias` = ΣYt / ΣYr − 1 (signed; radiometry and energy errors show here first; per channel in `biasRgb`);
  - `flip` = mean HDR-FLIP (NVIDIA FLIP 1.x through `flip-evaluator`, 67 pixels per degree, automatic exposures).
  Reports, a side-by-side picture (reference | llull | FLIP map) and the FLIP map per scene land in `.cache/render-reference/reports/`.
- **Thresholds** are set at the first measurement: measured × 1.25 + 0.005, rounded up, stored in the manifest with the measurement,
  and only ever lowered by hand.

### Radiometry (llull §5b → Blender 4.0)

The four `cal-*` scenes light a pure Lambert plate (base #bcbcbc, `ior 1`: no specular layer) with one light each, black world,
orthographic top view. Every factor is **1**, mean luminance within 0.02 %: sun irradiance E W/m² = Blender sun strength (angle =
2 × angularRadius); point / spot power P W = Blender power (intensity P / 4π W/sr, sphere radiance P / (4π² r²)), spot size = the full
cone, spot blend = blend; area power P W = Blender area power (radiance P / (π A), one-sided, spread 180°). `cal-sun` also matches
the closed form: ρ E cos θ / π = 0.5029 × 3 × 0.98974 / π = 0.47532, llull 0.47534, Cycles 0.47532.

Pixel filter: llull's tent of radius 1 px matches Cycles' Blackman-Harris at **1.5 px** (Blender's default), not at 2.95 px, the width
whose variance equals the tent's on paper. Measured on a plate edge half a pixel off the grid: llull 0.140 / 0.889, Cycles 1.5 px 0.133 /
0.895, 2.0 px 0.20 / 0.82, 2.95 px 0.29 / 0.74.

### First measurement (2026-11-28, llull 256 spp vs Cycles 4 096 spp, 4-core container)

| scene | what | relError | FLIP | bias | threshold relError / FLIP / abs bias |
| ----- | ---- | -------- | ---- | ---- | ------------------------------------ |
| cal-sun | Lambert plate, 3 W/m² sun | 0.0001 | 0.0002 | +0.01 % | 0.0051 / 0.0054 / 0.51 % |
| cal-point | 50 W point, r 5 cm | 0.0007 | 0.0012 | 0.00 % | 0.0059 / 0.0065 / 0.51 % |
| cal-spot | 50 W spot, cone 0.9 rad, blend 0.3 | 0.0124 | 0.0800 | 0.00 % | 0.0206 / 0.1051 / 0.51 % |
| cal-area | 20 W 0.6 × 0.4 m area | 0.0121 | 0.0110 | +0.01 % | 0.0201 / 0.0188 / 0.52 % |
| furnace-dielectric | white rough dielectric sphere (ior 1.5) in a white world | 0.0795 | 0.0453 | −7.95 % | 0.1044 / 0.0617 / 10.44 % |
| cornell-box | classic albedos, area light, 8 bounces | 0.2416 | 0.3309 | −24.15 % | 0.3071 / 0.4186 / 30.69 % |
| balls-uniform | Lambert, rough metal, glass, coat; white world | 0.1550 | 0.2358 | −14.11 % | 0.1988 / 0.2998 / 18.14 % |
| balls-hdr | the same under the synthetic HDR, rotation 0.6 | 0.2360 | 0.2637 | −17.71 % | 0.3000 / 0.3347 / 22.64 % |
| plant-instanced | instance arrays: galvanised pipes, steel beams, painted columns; sun + sky colour (mm) | 0.1557 | 0.1806 | −15.28 % | 0.1996 / 0.2308 / 19.60 % |
| textured-lights | checker + roughness textures, point + spot | 0.0610 | 0.1095 | −0.96 % | 0.0813 / 0.1420 / 1.71 % |

What agrees: every light's radiometry, the camera (perspective, orthographic), instancing, the unit scale (the plant is in mm), the
HDR orientation and rotation (backdrop pixels identical, shadows aligned), texture placement, colour space and wrap, metals (within
3 %), clear glass (white glass in a white world 1.001). What differs, and is llull's (see each scene's `notes` in the manifest):

1. **Dielectric layering loses energy.** A non-absorbing dielectric (base colour 1, ior 1.5) in a white furnace returns 0.90 (roughness
   0.5) where an energy-preserving layered BSDF returns ~1 (Cycles 4.0: 0.98); base 0.8 gives 0.91 of Cycles at roughness 1 and 0.3. The diffuse weight
   (1 − F(cos i))(1 − F(cos o)) has no internal-reflection compensation, so every dielectric bounce loses ~8–9 %: −24 % in the Cornell
   box (−1.0 % when the walls are set to ior 1), −10 to −15 % on Lambert-like and coated objects. The coat layer loses the same way
   (ior-1 base under coat 1: 0.92 of Cycles).
2. **Transmission ignores the base colour.** Tinted glass (the library `glass`, base 0.74 / 0.87 / 0.91) renders untinted in llull
   (0.998) where Cycles, like glTF `KHR_materials_transmission`, tints it (0.754 / 0.875 / 0.913).

Legitimate differences kept out of the corpus or out of the numbers: the Preetham sky (no Cycles counterpart); Cycles' Multiscatter
GGX (the converter picks "GGX"); lights seen by camera rays (hidden in both); the spot cone edge of a finite emitter (a 1–2 px ring).

## Code-export oracle — `tests/unit/chamferCodegenOracle.test.ts`

The exported CadQuery / build123d program of a variable or two-leg chamfer is RUN with real OCP and compared with the analytic removed volume (the value the native kernel is held to) and with absolute vertex positions. It needs a python that imports OCP, cadquery and build123d: `uv venv` + `uv pip install cadquery build123d`, then `LLULL_PYTHON=<venv>/Scripts/python.exe npx vitest run tests/unit/chamferCodegenOracle.test.ts` (about 3 minutes). Without such a python the suite is skipped (counted as `python:ocp`); a run with `LLULL_REQUIRE_TOOLS=python:ocp` fails instead (the check job of CI sets it).

## Drawing gate — `quality/drawings/`

21 parts modelled in llull from published 2D technical drawings (Too Tall Toby, build123d) and
verified against the real part (official mass, reference solid, exact 3D IoU) with the
`drawing-to-model` skill. `npm run quality:drawings` replays each plan on the live OCC kernel and
checks the exact B-rep volume and the extents (`quality/drawings/manifest.json`). Results, proved
reference defects and the llull fixes it drove: `quality/drawings/README.md`.
