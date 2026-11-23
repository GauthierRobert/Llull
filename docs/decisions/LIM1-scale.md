# LIM-1 (10) — scale: many parts, glTF size, hundreds of patterned booleans

Status: done 2026-10-21 (board LIM-1 item 10). Gate: `node scripts/scaleGate.mjs` (guards: `tests/unit/scaleLim1.test.ts`).

## Measured (Windows, native `llull-kernel` OCCT 7.9.2, `llull run` through the CLI)

**LLR-845 rocket-engine plan** (108 steps, 160 parts, 105 of them polar-array copies):

|                                 | before                                             | after                                                 |
| ------------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| `llull run` wall / sum of steps | 18.9 s / 16.9 s                                    | unchanged (native-bound, see below)                   |
| `.llull.json` document          | 11.0 MB                                            | unchanged                                             |
| `export_gltf` .glb              | **25.4 MB**, 160 meshes, unindexed (72 B/triangle) | **6.15 MB**, 62 meshes, all indexed (17.5 B/triangle) |
| `export_gltf` wall / JS CPU     | 4.8 s / 8.9 s                                      | 2.7 s / 2.7 s                                         |

Where the plan time goes: one step, the 5 mm tapered turbine-exhaust duct (`boolean` of two variable-section smooth sweeps), takes
13–15 s inside OCCT (80 % of the plan); the JS side of the whole run is < 1 s (CPU profile: the main thread waits on the sidecar). Its
display mesh is 80 k triangles because the native display deflection is an absolute 0.1 mm (`solver/crates/llull-kernel-occt/src/mesh.rs`),
which also makes the hollow torus manifolds 25–43 k triangles each and the document 11 MB (six boolean meshes = 10.7 MB of JSON).

**Patterned cuts** (liner Ø320 × 300 with N axial Ø2–4 channels, array_polar of one cutter):

| N   | N sequential `boolean`s (before)        | one `boolean` with `b` = list of N tools (after) |
| --- | --------------------------------------- | ------------------------------------------------ |
| 50  | 2.3 s (12 → 80 ms per cut)              | —                                                |
| 100 | 8.3 s (→ 160 ms per cut: quadratic)     | 0.30 s                                           |
| 200 | **fails at cut ~120** after a 30 s hang | 0.63 s                                           |
| 400 | fails                                   | 1.9 s                                            |

Gate run (`scaleGate.mjs`, liner + 160 pattern parts): 300 channels, plan 2.0 s wall (boolean 1.0 s), GLB 1.02 MB for 64 k triangles
(15.9 B/triangle; the old layout would be 4.6 MB), 161 mesh nodes → 4 meshes. `--sequential --channels 100`: 5.7 s; 150: aborts at cut
120 in 6.9 s with the cure in the summary.

## Root causes and fixes

1. **glTF wrote a world-space triangle soup per entity**: three float corners per triangle (no index buffer) and no reuse between
   identical pattern copies. Now every mesh is indexed (corners welded on position + creased normal + UV, u16/u32 indices) and parts
   with bit-identical local geometry and the same appearance share one local-frame mesh placed by each node `matrix`
   (`commands/exchange/gltfMeshData.ts`, `gltfScene.ts`, `gltfBuilder.ts`). A unique part keeps its world-space mesh.
2. **Export CPU**: `uint8ArrayToBase64` built one string per character (2.2 s for 25 MB); crease normals keyed vertices with
   `toFixed(5)` strings. Base64 now encodes into one byte buffer; the weld key is three rounded integers.
3. **Sequential cuts nest the recipe one level per cut**: each result stores `boolean(previous, tool)`, so cut k re-sends and re-hashes a
   k-deep tree and OCCT re-fuses a growing solid (quadratic), and at ~125 levels the sidecar's JSON parser (serde_json depth 128)
   rejects the request. `boolean` now takes `b` as a list of tool ids (union / subtract): the tools are unioned as a balanced tree
   (depth log2 N) and applied in one evaluation. A refused cut deep in a chain says so and names the list form.
4. **The host hung 30 s on an unreadable request**: the sidecar answers it with `id: null`, which the session ignored. It now settles
   the oldest pending request at once (`server/src/native/kernelSession.ts`).
5. **Dense boolean results could overflow the stack**: the empty-result check spread every coordinate into `Math.max(...)` (throws past
   ~150 k vertices); it is a linear scan now.

## Follow-ups (2026-11-23)

- DONE: serde_json depth. The sidecar measures nesting with a linear scan (cap 4096 levels, refused by name with the list-form cure),
  parses with the recursion limit off and runs the session on a 512 MiB-stack thread (`solver/bins/llull-kernel/src/request.rs`).
- DONE earlier: size-aware display deflection (`solver/crates/llull-kernel-occt/src/mesh.rs`) and the OCCT multi-tool boolean for
  the list form (`cpp/boolean_many.cxx`, ASC M1a).
- DONE: the slow variable-section sweep boolean was not OCCT intersection time alone. The fitted faces were cut into runs only at
  path curvature jumps, so the C1 (smoothstep) / C0 (linear) blend at an interior station drove the fit to ~800 cells: 216 faces of
  ~95 spans per sweep. Runs now also break at interior stations (`packages/core/src/geometry/sweepEval/fitted.ts`). Stand-in duct
  (two 3-station smooth sweeps, outer minus inner; Linux, 4 cores): 96 faces of 12-37 spans per sweep, boolean 2 min 06 s -> 15.4 s,
  result 76 k -> 10.8 k triangles, volume unchanged to 1.7e-8. The LLR-845 plan itself was not re-measured (not in the repo).
- DONE: evaluator LRU > 256 tools. A fixed bound evicted the leaves of a long `many` list while its result was built, so a fallback or a
  re-evaluation rebuilt them. Both evaluators now size their cache to the request: a `boolean` with `many` (<= 1000, `MAX_BOOLEAN_TOOLS`)
  raises the capacity to `2 * leaves + 16` (leaves counted in the tree, never the claimed `many`) (leaves plus the balanced tree of the fallback), never shrinking (`Evaluator::reserve` in
  `recipe/many.rs`; `kernelFromOps`). Chosen over pinning: the bound stays a plain LRU, memory is bounded by the schema cap, and a hostile
  `many` never raises it. Test: `tests/unit/kernelManyToolsCache.test.ts` (300 tools, leaves built once), `many_tests.rs` (native, `cargo test -p llull-kernel-occt` green).
- DONE: per-face colour on parametric primitives. `set_face_color` takes box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion and
  revolution as well as mesh solids. A face is a smooth patch of the primitive's own tessellation (`geometry/faceColors.ts` `faceColorMesh`).
  Selector (regeneration): a stored `near` point cannot follow a resize (the replayed command no-ops), and a patch ordinal or count renames faces
  when a profile is reordered or a vertex is added. A picked patch is therefore stored as a resize-invariant SIGNATURE (`FaceColor.sig`, recorded
  by the command as `faceSignatures`): the area-weighted mean normal, the patch centre as fractions of the body's bounding box, and the sign of
  normal . (centre - box middle) (outer or inner wall; a full cylinder wall has a zero mean normal and only this sign and the centre tell outer
  from inner). Resolution picks the patch with the same sign whose normal differs by under 0.5 and centre by under 0.35 (box fractions), best
  score first: a resize keeps both within a few hundredths, while two faces of one body differ by 0.5 or more in at least one (perpendicular
  box sides: 1.41 in normal; opposite sides: 1.0 in centre; a unit-normal facet strip vs a whole wall: 1 in normal). Nothing is written back on
  replay. No match (a revolution going from 32 to 6 segments) re-picks by `faceNear` (summary note, result still ok, so later regenerations do
  not fail), and without `faceNear` the step changes nothing, which the replay reports as a step that no longer changes the document. Mesh
  solids keep the `near` pick (their mesh is fixed). Collapsed-edge slivers (a profile touching the axis) may join a patch but never carry it
  on, so the top of a revolved cylinder does not reach its bottom. `render_view` draws the kind's own quads / rings coloured by their nearest triangle (no diagonal seams);
  glTF / GLB export and instance expansion (parametric non-uniform scale: picks scaled; baked: every coloured triangle re-picked on the baked mesh) carry them.
  Stored colours are validated on load (at most 4096, only on kinds with faces, `sig` only on parametric solids with a unit-bounded normal, a centre inside the box and a sign of 1 or -1). A revolution with few segments (facets beyond 30 degrees) has one
  patch per facet strip. The desktop viewport (`src/ui/viewport`) still draws a primitive in one colour: it must use `faceColorMesh` /
  `faceColorTriangles` like `meshSolidGeometry.ts` and keep coloured primitives out of the shared prototype (UI lane).

## Left

- The remaining 15 s: the General Fuse still pairs 96 x 96 long strip faces; one face per run (the 24 ring edges as one closed
  surface) would cut the pairs ~500x on smooth sections.
