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
  by the command as `faceSignatures`): the area-weighted mean normal, the patch centre and the patch's own box extents (its `span`) as fractions of the body's bounding box, and the sign of
  normal . (centre - box middle) (outer or inner wall; a full cylinder wall has a zero mean normal and only this sign and the centre tell outer
  from inner). Resolution needs EXACTLY ONE patch with the same sign, normals within 0.4, centres within 0.35 and spans within 0.1 (box fractions); several candidates (stepped coaxial walls of a revolution all have mean normal 0) are ambiguous and count as no match. Margins: separate patches meet at a crease of 30 degrees or more, so neighbouring facet normals differ by at least 0.52 (tolerance 0.4); perpendicular box sides differ by 1.41 in normal, opposite sides by 1.0 in centre; a unit-normal strip against a whole wall by 1; coaxial walls of radius 1 and 1.5 in a body of 6 by 0.17 in span. A stored signature that matches nothing colours nothing. Nothing is written back on
  replay. No match (a revolution going from 32 to 6 segments) re-picks by `faceNear` (summary note, result still ok, so later regenerations do
  not fail), and without `faceNear` the step changes nothing, which the replay reports as a step that no longer changes the document. Mesh
  solids keep the `near` pick (their mesh is fixed). Collapsed-edge slivers (a profile touching the axis) may join a patch but never carry it
  on, so the top of a revolved cylinder does not reach its bottom. `render_view` draws the kind's own quads / rings coloured by their nearest triangle (no diagonal seams);
  glTF / GLB export and instance expansion (parametric non-uniform scale: picks scaled; baked: every coloured triangle re-picked on the baked mesh) carry them.
  Stored colours are validated on load (at most 4096, only on kinds with faces, `sig` only on parametric solids with a unit-bounded normal, a centre inside the box and a sign of 1 or -1). A revolution with few segments (facets beyond 30 degrees) has one
  patch per facet strip. The desktop viewport (`src/ui/viewport`) still draws a primitive in one colour: it must use `faceColorMesh` /
  `faceColorTriangles` like `meshSolidGeometry.ts` and keep coloured primitives out of the shared prototype (UI lane).
- DONE: fewer, longer fitted faces (`geometry/sweepEval/mergeFaces.ts`). The 24 cubic ring edges of a run chunk, each already fitted across the
  stations, are joined along u into `FACE_GROUPS = 2` B-spline faces (double knot at a C1 junction, triple at a corner; equal to the edge faces,
  pinned by `tests/unit/sweep/mergeFaces.test.ts`). One face per run is NOT used: a face closed on itself is not sewn to its own seam by the
  kernel's sewing (`kernelSheets.ts` already cuts closed faces for that reason), so a ring is cut in two halves that sew to each other. Rational or
  lower-degree sections (constant circles, profiles with arcs) keep one face per edge.
  Accuracy: BRepGProp's fixed Gauss rule reads a multi-span bicubic face ~5e-5 off (the merged duct read 452975.6 and the outer sweep 2235883.6
  where the per-edge layout read 452952.76 / 2235780.32), although an independent 5 x 5 Gauss quadrature of the fitted lateral faces gives the same
  1940669.07485 for both layouts to 4e-12 (the geometry is identical). The sheet solid therefore asks for the adaptive mass rule
  (`surfaces.cxx` `sheet_solid`: `refined_mass`, kept through booleans like a deformed body): duct 452952.76408 and outer 2235780.31773, within
  2e-9 of the per-edge layout.
  Measured (Linux, 4 cores shared with other work, `llull-kernel` release build, outer minus inner of the two 3-station smooth sweeps of
  `tests/unit/sweep/stationBreaks.test.ts`, kernel.evaluate of the boolean): 12.9 / 12.8 / 12.1 s before (96 faces per sweep, 10 748 triangles),
  3.3 / 3.4 / 2.9 s after (8 faces per sweep, 6 824 triangles).
  Not measured: the LLR-845 plan.
  Names (SC-N1): a sheet solid has no construction roles, so its faces are named `f<k>` by topology index and its edges `e(f<a>|f<b>)`; joining faces
  renumbers them (an old `e(f0|f1)` would be another edge). A new `faceLayout: 'joined'` field on a fitted sweep (set by `sweep_profile` when the sweep
  is fitted and recorded in its step) selects the joined layout; a step replayed WITHOUT it (`ctx.replaying`, a document made before) and an entity
  without it keep the per-edge layout, so stored face / edge names still resolve (`tests/unit/sweep/stationBreaks.test.ts`: replay of a step with the
  field removed gives 4 x 24 faces). No stored plan or golden in the repo names faces of a fitted sweep, so no replay of one could be shown.
  The adaptive rule was checked on neighbours it now reaches through booleans: a torus and a filleted cube unioned with a sheet solid read their
  closed-form volumes to 1e-8 (`features_tests.rs`).

## Left
