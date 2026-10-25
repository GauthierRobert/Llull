# Gap 09 VIS — Validation pack

This pack checks that llull's plant visualization and review commands are right. A visual look cannot be gated, so
every claim is reduced to something an agent can assert from `--json`:

- colour **category names** taken from cited scheme tables;
- exact geometry: camera conversions, section-box classification, LOD distances;
- deterministic counts from the batching rules: draw calls, instances, bytes;
- byte-identical render digests from the reference (TS) renderer. The optional native GPU renderer
  ([RS1](../../../decisions/RS1-native-compute.md), TECHNICAL_SPEC §2.A) is non-hash and checked by VC-VIS-60 only.

Sources and grades are in [sources.md](sources.md); the VC index is [expected_results.json](expected_results.json).
**No expected value was produced by running llull.** Each value is one of:

- quoted from a cited source;
- derived in closed form ([`data/derive_vis_expected.py`](data/derive_vis_expected.py), run with `python3 -I`);
- marked `TBD — measure` with its procedure.

## Gate policy

- Grade **A** rows and closed forms derived from them are pass / fail.
- Grade **B** rows are documentation or named defaults: A13.1 field lengths where vendors conflict, spacing, DIN 2403.
  They are never compared.
- Grade **C** values are never used. This covers every display hex (`llull_display_palette.json`), because no
  standard defines sRGB values and the only RAL table found is internally inconsistent.
- Frame times are regression-gated against a stored per-machine baseline (+20 %), never against an absolute number.

## Files

| File | Content | Grade |
| ---- | ------- | ----- |
| `data/service_colour_schemes.json` | ASME A13.1 categories (field / letter colour), legend size rows, placement; ISO 14726 main colours + RAL; BS 1710 basic colours + BS 4800; DIN 2403 group colours | A / B per row |
| `data/llull_display_palette.json` | named default display hex per colour name (RAL approximations from npm `ral-colors`) | C (display only) |
| `data/threejs_r186_facts.json` | three.js r186 facts T1–T9 (InstancedMesh, BatchedMesh, LOD, draw-call counting, SceneOptimizer, addons; three-mesh-bvh, drei) with file:line and file sha256 | A |
| `data/synthetic_pipe_rack_benchmark.json` | SYN-RACK-v1: synthetic pipe rack of 13 prototypes, N(n), batching bound, LOD switch distances, GPU bytes, frame-time procedure | closed forms |
| `data/derive_vis_expected.py` | reproduces every derived number | — |
| `data/bcf_3_0/` | BCF 3.0 `visinfo.xsd`, `markup.xsd`, documentation, example orthogonal viewpoint (verbatim, CC BY-ND 4.0) | A |
| `data/gltf_simple_instancing/` | Khronos SimpleInstancing (`EXT_mesh_gpu_instancing`, 125 instances), CC0 | A |
| `plans/sc-vis-0*.json` | CLI scenarios (`build_project` actions + `expected`), unbuilt commands named in `status` | — |
| `expected_results.json` | index of every VC | — |

## Real use cases

| # | Use case | What llull must do | VC / SC |
| -- | -------- | ------------------ | ------- |
| U1 | Owner wants "the Plant 3D look": pipes coloured by service | map services → A13.1 or ISO categories, report every line, flag unmatched | VC-VIS-01..03, SC-VIS-01 |
| U2 | Construction needs a pipe-marker list | legend size by OD with insulation, placement, reviewer gate | VC-VIS-04 |
| U3 | 60 % model review with the client, issues exchanged with a BCF tool | viewpoints, section boxes, redlines, issues, comments, BCF | VC-VIS-10..15, SC-VIS-02, SC-VIS-04 |
| U4 | Coordination: clashes become trackable issues | clash → issue with framed viewpoint, idempotent | VC-VIS-40, 41, SC-VIS-06 |
| U5 | A 10⁵–10⁶-component unit must stay interactive | instancing by prototype, LOD, cull, draw-call bound, measured frame time | VC-VIS-20..24, SC-VIS-03 |
| U6 | The agent must see its work in the review look | `render_view` perspective / profile / section box, deterministic | VC-VIS-30..32, SC-VIS-05 |
| U7 | Hand-off to an external viewer | glTF with GPU instancing | VC-VIS-25 |

## Validation cases

| VC | What | Reference / expected | Tolerance | Test (proposed) |
| -- | ---- | -------------------- | --------- | --------------- |
| VC-VIS-01 | ASME A13.1 mapping: 6 categories → field / letter colour names | rows A13-FQ, TC, FO, CB, WA, CA of `service_colour_schemes.json` [S1, S3] | exact string | `tests/unit/aec/industrial/serviceColour.test.ts`, SC-VIS-01 |
| VC-VIS-02 | ISO 14726 mapping: 7 media → main colour | ISO-GN, GY, YE, BN, VT, RD rows [S8, S9] | exact string | same, SC-VIS-01 |
| VC-VIS-03 | First-match order, unmatched reporting, geometry invariance | a profile with overlapping rules: the earlier rule wins; nitrogen line → `VIS_COLOUR_UNMATCHED`; `document.entities` deep-equal before / after profile switch | exact | `tests/unit/display/colourRules.test.ts` |
| VC-VIS-04 | A13.1 legend band from OD (+ insulation) | TECHNICAL_SPEC §5.7 table: DN20 → 203.2 / 12.7 mm; DN25 → 203.2 / 19.05 interpolated; DN50 → 304.8 / 31.75 interpolated; DN100 → 304.8 / 31.75; DN100 + 50 ins → 609.6 / 63.5; DN150 → 609.6 / 63.5 interpolated; DN200 → 609.6 / 63.5; DN300 → 812.8 / 88.9 (letter heights grade A; field lengths grade B, documented) | exact (mm = in × 25.4) | `pipeMarkers.test.ts` |
| VC-VIS-10 | Viewpoint exact round trip incl. BCF metres ↔ mm | BCF 3.0 example camera [S22]: eye (18.674638207107783, −19.54805982455614, 10.538476791232824) m, ViewToWorldScale 9.673289179801941 m | 1e-12 rel | `viewpointCamera.test.ts`, SC-VIS-02 |
| VC-VIS-11 | Viewpoint → document camera | polar 1.2728948190113956 rad, azimuth 2.1402772048541396 rad (closed form, `derive_vis_expected.py` §5) | 1e-9 abs | same |
| VC-VIS-12 | Section box classification | SC-VIS-04: skid inside, pipe crossing, far box outside (exact AABB arithmetic) | exact | `tests/unit/review/sectionBox.test.ts`, `scVis04.test.ts` |
| VC-VIS-13 | Review data persistence | markups / issues / comments survive save → load, undo → redo; ids `vp-/mk-/iss-` identical on replay of the same plan | exact | `tests/unit/review/issueWorkflow.test.ts` |
| VC-VIS-14 | `check_review` codes and the human gate | `VIS_ISSUE_ENTITY_MISSING`, `VIS_ISSUE_OPEN`, `VIS_ISSUE_AWAITING_APPROVAL`; an agent `closed` → `VIS_HUMAN_GATE`, a signed human act passes | exact codes | `tests/unit/review/issueWorkflow.test.ts`, `scVis04.test.ts` |
| VC-VIS-15 | BCF export is schema-valid | output validates against `data/bcf_3_0/visinfo.xsd` and `markup.xsd` | valid | `server/tests/bcf.test.ts` (`xmllint --schema` when available) |
| VC-VIS-20 | Component count of SYN-RACK-v1 | N(n) = 227 n + 8 ⌊n/4⌋: 1832 / 10076 / 100071 / 1000037 for n = 8 / 44 / 437 / 4367 | exact | `renderPlan.test.ts`, SC-VIS-03 |
| VC-VIS-21 | Draw-call bound R-BATCH-v1 | `opaqueModelCalls` ≤ 2·13 + 4 = 30 at every size; identical with and without per-service colours | ≤ / exact equality | same |
| VC-VIS-22 | LOD switch distances | stud M16 (diag 92.8009 mm, 1080 px, FOV 45°): LOD0 < 2520.462 mm ≤ LOD1 < 15122.774 mm ≤ LOD2 < 120982.194 mm ≤ culled; visible LOD1 stays until 2268.416 mm (hysteresis 0.1, three LOD semantics T4); all 13 prototypes in `synthetic_pipe_rack_benchmark.json` | 1e-6 rel on distances; exact on level | same |
| VC-VIS-23 | Instance bookkeeping and memory | drawn + culled(frustum) + culled(pixel) = N; `gpuBytesEstimate` = 76 B × instances (+ 4 B state) for InstancedMesh buckets (T1) | exact | same |
| VC-VIS-24 | Frame time, SYN-RACK S / M / L | **TBD — measure** (procedure in `synthetic_pipe_rack_benchmark.json` `frameTime`); gate = +20 % vs stored baseline | regression | `tests/perf/plantViewport.perf.ts` |
| VC-VIS-25 | glTF instancing | SimpleInstancing → 125 instances, translation ∈ [0, 10]³, scale ∈ [1, 2]³, rotation quaternion w ∈ [0.5, 1]; re-export keeps 1 mesh + `EXT_mesh_gpu_instancing` with 125 instances | exact counts, 1e-6 on values | `gltfInstancing.test.ts` |
| VC-VIS-30 | `render_view` determinism | same doc + params ⇒ identical `svgSha256` (orthographic flat and perspective review); pinned digests **TBD — measure** per `rendererVersion` | exact | golden, SC-VIS-05 |
| VC-VIS-31 | Perspective projection | eye (0, −10000, 0) looking +Y, up +Z, FOV 45°, 800 × 600: world point (1000, 0, 500) projects to pixel (472.4264, 263.7868) (pinhole closed form) | 0.5 px | `renderPerspective.test.ts` |
| VC-VIS-32 | Section box in `render_view` | with SC-VIS-04's box, `data.visibleEntityIds` excludes `far` and includes `skid`; `pipe` drawn clipped with a cap | exact sets | same |
| VC-VIS-40 | Clash → issue idempotence | SC-VIS-06: 1 hard clash → `created` 1, re-run `created` 0 / `unchanged` 1 | exact | `clashIssues.test.ts` |
| VC-VIS-41 | Clash viewpoint framing | issue viewpoint section box = AABB(a) ∩ AABB(b) expanded by margin 500 on each side (exact arithmetic from the two element AABBs) | 1e-9 | same |
| VC-VIS-50 | Agent error contract (AF-11) | a wrong plan (unknown profile, min ≥ max box, screen point 1.2, direction ⟂̸ up) returns `VIS_PROFILE_NOT_FOUND`, `VIS_SECTION_BOX_INVALID`, `VIS_MARKUP_INVALID`, `VIS_VIEWPOINT_NOT_ORTHONORMAL` with `paths` and remediation | exact codes | `errors.test.ts` |
| VC-VIS-60 | Native vs reference (RS1, TR-VIS-26, TR-VIS-34) | (a) `llull-bvh` (native through `llull-compute geomq`, and WASM) frustum and ray queries return the same id sets as `instanceBvh.ts` on 10⁴ random AABBs and on SYN-RACK-v1 at n = 4367 (N = 1 000 037); broad-phase candidate pairs equal the TS pairs. (b) `render_view` with `renderer: 'native'` on SC-VIS-05: same `visibleEntityIds` and image size as the reference, no `svgSha256`, `deterministic: false`; the native CPU twin returns the reference RGBA byte for byte; the GPU picture (also walkthrough frames and BCF snapshots) agrees with the reference image at coverage IoU ≥ 0.97 and mean \|ΔRGB\| ≤ 8 levels over the pixels both cover (measured 2026-10-19 on an RTX 4080 Laptop GPU, Vulkan: IoU 1.0000, mean ≤ 0.01). `visibleEntityIds` is not built yet (VIS-M4). (c) The reference digest of VC-VIS-30 is the same with and without a raster port installed | (a) exact sets; (b) flags exact, CPU twin byte-identical, GPU IoU ≥ 0.97 and mean \|ΔRGB\| ≤ 8; (c) exact | `server/tests/visNativeParity.test.ts` (skips with a logged reason when the binary is absent; CI always); `llull-raster` `tests/scene_reference.rs` (fixture `tests/unit/native/sceneRasterReference.test.ts`); `tests/unit/renderViewPerspective.test.ts` (c); `llull-bvh` cargo tests |

### Derivations used as expectations

- **N(n)**: per bay there are 2 columns + 1 beam + 8 pipes + 16 flanges + 64 studs + 128 nuts + 8 shoes = 227
  components, plus 8 valves every 4 bays.
- **Draw-call bound**: 13 prototypes × (LOD0 + LOD1) + 4 material-class LOD2 box buckets = 30. Colour is a
  per-instance attribute, so 8 services do not change the count. Today's `grouping.ts` key includes the colour: the
  same rack would split the 8 pipes into 8 colour batches instead of 2.
- **LOD**: p = D·H / (2 d tan(φ/2)) ⇒ d = k·D/p with k = 1080 / (2 tan 22.5°) = 1303.6753236814714 px.
- **BCF camera**: o = −v/|v|, polar = acos(o_z), azimuth = atan2(o_x, o_y) (`set_camera` convention in
  `packages/core/src/commands/document/camera.ts`). |v| = 0.9999999894, v·up = −2.77e-8, both inside the 1e-6
  orthonormality tolerance.
- **Perspective pixel**: x_ndc = (X/Z) / (tan(φ/2)·aspect), y_ndc = (Y/Z) / tan(φ/2), px = (x_ndc + 1)/2·W,
  py = (1 − y_ndc)/2·H.
- **GPU bytes**: InstancedMesh 16 floats (matrix) + 3 floats (colour) = 76 B per instance (T1). For BatchedMesh at
  10⁶ instances: matrices texture 2000² × 16 B + colours 1000² × 16 B + indirect 1000² × 4 B = 84 MB (T2).

### Known biases (expected, not failures)

- The ASME A13.1 rows come from vendor extracts of the 2007 / 2015 editions. The 2020 / 2023 text could move band
  edges. Every marker result carries `reviewRequired: true` and names the edition assumption.
- The display colours are approximations. The HEX and rgb fields of the one RAL table found disagree by up to 29 units
  in one channel (RAL 5015 red channel: 0x28 = 40 vs 11).
- `render_view` digests depend on the JS engine's `Math` functions. They are pinned per `rendererVersion` and Node
  major version. Native GPU output is never pinned (non-hash, TECHNICAL_SPEC §2.A).

## What could not be verified

See [sources.md](sources.md) "Not verified": Navisworks clash statuses, A13.1 steam colours and spacing, the ISO
14726 maroon RAL code, Z535.1 Munsell values, any absolute timing, and a public industrial-plant model.
