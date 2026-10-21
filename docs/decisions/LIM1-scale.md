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

## Left (native kernel owner)

- serde_json `unbounded_depth` (+ a large-stack session thread) in `solver/bins/llull-kernel` so a long sequential chain still parses.
- A relative / size-aware display deflection (e.g. max(0.1, 1e-4 × bbox diagonal)) to cut boolean meshes, documents and GLBs of large
  parts 3–10×; and an OCCT multi-tool cut (`BRepAlgoAPI_Cut` with N tools) for the list form instead of the balanced union tree.
- The evaluator LRU holds 256 shapes; a list of > 256 tools re-builds leaves when the result is re-evaluated after eviction.
- The variable-section sweep boolean (13–15 s) is OCCT BSpline–BSpline intersection time.
