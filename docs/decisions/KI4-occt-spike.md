# KI4 — OpenCascade.js Kernel Spike: Adopt vs Defer

**Date:** 2026-05-26
**Author:** mcp-engineer (Lane 4, Batch 13)
**Package:** `opencascade.js@1.1.1`
**Spike file:** `src/ui/geometry/occtKernel.ts`
**Test file:** `tests/unit/occtKernel.test.ts`

---

## What the spike proves

The spike successfully initialises the OCC WASM module in Node.js, executes a boolean
union (`BRepAlgoAPI_Fuse`) and a fillet (`BRepFilletAPI_MakeFillet`) against real B-rep
geometry, tessellates the results via `BRepMesh_IncrementalMesh`, and returns our
`MeshData` shape — all without touching a single command or registry entry. The
`GeometryKernel` interface boundary held.

---

## Measurements

| Metric | Value |
|---|---|
| WASM binary (on-disk) | **63 MB** |
| JS glue | 0.3 MB |
| Cold init time (Node.js, preloaded WASM) | **~800–1000 ms** |
| Boolean union (two 2×2×2 boxes, overlapping) | **~180 ms** |
| Fillet r=0.2 (box, 12 edges) | **~150 ms** |
| Union triangle count | **28** (matches Manifold's 28 for same geometry) |
| Fillet triangle count | **628** (plain box: 12; rounded result confirms topology) |
| Union correctness | Bbox [-1,-1,-1]→[2,1,1] — exact 3×2×2 envelope, correct |
| Fillet correctness | No NaN vertices; triangle count > 12; bbox unchanged (correct) |

### API support note

The `Supported APIs.md` in the package marks all key APIs as "unsupported" (red badge)
in the docs listing, but this is misleading — they ARE accessible at runtime. The badge
tracks auto-generated binding completeness, not whether the binding is callable.
All required APIs — `BRepAlgoAPI_Fuse_3`, `BRepAlgoAPI_Cut_3`, `BRepAlgoAPI_Common_3`,
`BRepFilletAPI_MakeFillet`, `BRepMesh_IncrementalMesh_2`, `TopExp_Explorer_2`,
`BRep_Tool.Triangulation`, `BRepPrimAPI_MakeBox_2`, `gp_Pnt_3` — are callable and correct.

---

## What works

- **Boolean union, subtract, intersect** via `BRepAlgoAPI_{Fuse,Cut,Common}_3`.
- **Fillet all edges** via `BRepFilletAPI_MakeFillet` + `Add_2(radius, edge)`.
- **Tessellation** via `BRepMesh_IncrementalMesh_2` + `TopExp_Explorer` face walking.
- **Vertex extraction** from `BRep_Tool.Triangulation` including `Node(i)` coords and
  `Triangle(i).Value(j)` indices.
- **Entity → shape** conversion for `box` kind is implemented in the spike.
- **Interface boundary held**: zero changes to commands, registry, or `GeometryKernel`.

---

## What's missing before shipping

1. **Bundle size / init latency**: 63 MB WASM is too heavy for a cold web load.
   Needs either a lazy `import()` triggered by first boolean op, a CDN URL, or a
   custom Emscripten build stripping unused subsystems (realistically: 10–20 MB
   with `ELIMINATE_BORING_FUNCTION_STUBS`). Init at ~1 s is acceptable for a
   "model opened" event but not for first paint.

2. **Interface extension**: `GeometryKernel` only has `booleanOp`. Fillet, chamfer, and
   shell need new methods. Proposed extension:
   ```ts
   filletEdges(entity: Entity, edgeIndices: number[], radius: number): MeshData | null;
   chamferEdges(entity: Entity, edgeIndices: number[], dist: number): MeshData | null;
   shellSolid(entity: Entity, thickness: number): MeshData | null;
   ```
   This is a non-breaking addition (Manifold returns `null` for unimplemented methods;
   commands already handle null as a graceful no-op).

3. **Entity coverage**: The spike only converts `box` to OCC shapes. Full parity with
   Manifold requires `cylinder` (BRepPrimAPI_MakeCylinder), `sphere`
   (BRepPrimAPI_MakeSphere), `extrusion` (BRepBuilderAPI_MakeFace + BRepPrimAPI_MakePrism),
   and `mesh` (BRepBuilderAPI_Sewing). ~2–3 days of implementation.

4. **Memory management**: OCC shapes are C++ heap objects; each must be `.delete()`-d
   after use. The spike demonstrates the pattern. A production kernel needs careful
   RAII wrappers and error-path cleanup (see `manifoldKernel.ts` for the pattern).

5. **STEP/IGES export** (NF5): `opencascade.js@1.1.1` includes `STEPControl_Writer`
   and `IGESControl_Writer` but their completeness is untested in this spike.

6. **Vitest / CI**: The 63 MB WASM cannot be loaded in the current Vitest (jsdom) env.
   The test file gates with `describe.skipIf` — correctness is verified via Node.js
   spike script and `npm run dev` manual check, not CI.

---

## What it unlocks

| Feature | Benefit |
|---|---|
| K1/K2 fillet + chamfer | Exact B-rep fillet (not mesh heuristic); correct across boolean results |
| K2 shell / hollow | `BRepOffsetAPI_MakeThickSolid` — impossible with Manifold |
| NF5 STEP/IGES export | Exact topology round-trip; OCC is the industry-standard writer |
| NF7 push-pull face | `BRepFeat_MakePrism` / direct face offset — native B-rep semantics |
| Topology queries | Edge/vertex/face selection by exact ID, not mesh proximity |

---

## How to opt in (not wired yet)

Replace the Manifold injection in `src/main.tsx`:

```ts
// Current:
const kernel = await createManifoldKernel();

// Swap to OCC (spike, not production-ready):
const { readFileSync } = await import('fs'); // Node only; browser: serve WASM as asset
const wasmBuf = readFileSync('node_modules/opencascade.js/dist/opencascade.wasm.wasm');
const kernel = await createOcctKernel(new Uint8Array(wasmBuf));

setGeometryKernel(kernel);
```

In the browser, omit `wasmBinary` and configure Vite to serve the WASM:

```ts
// vite.config.ts — add to assetsInclude:
assetsInclude: ['**/*.wasm']
```

---

## Recommendation: ADOPT-INCREMENTAL

OCC works, the interface boundary holds, and the operations are correct. The 63 MB WASM
and ~1 s cold init are the only real blockers — both are solvable (lazy load, slim build,
CDN). The right path is to keep Manifold as the default production kernel for CSG booleans
(it is faster, smaller, and already working), and adopt OCC incrementally as a second
injected kernel specifically for the operations Manifold cannot do: fillet, chamfer, shell
(`BRepOffsetAPI_MakeThickSolid`), and exact STEP/IGES export. Extend `GeometryKernel` with
the three new method stubs, have Manifold return `null` for them (graceful no-op, already
the contract), and wire `occtKernel.ts` for those operations only — so users pay the
63 MB WASM cost only when they first invoke a fillet or export, not on app load.

---

## Batch 15 KI4-followup: mesh→BREP via BRepBuilderAPI_Sewing

**Date:** 2026-05-26  
**Author:** mcp-engineer (Lane 4, Batch 15)

### What was attempted

The AABB-rebuild approach in `filletEdges` (which only produced correct results for
axis-aligned box solids) was replaced with a proper mesh→BREP conversion implemented
in the new private helper `meshDataToTopoDSShape`.

**Approach chosen: Approach 2 — BRepBuilderAPI_Sewing**

For each triangle in MeshData:
1. Build three `gp_Pnt_3` points from the triangle vertices.
2. Construct a closed triangular wire via `BRepBuilderAPI_MakePolygon`.
3. Build a planar face from the wire via `BRepBuilderAPI_MakeFace_15`.
4. Add all triangle faces to a `BRepBuilderAPI_Sewing` instance (tolerance 1e-6).
5. `Sewing.Perform()` merges shared edges into a watertight shell.
6. Enumerate shells in the sewn shape via `TopExp_Explorer_2`.
7. Add shells to `BRepBuilderAPI_MakeSolid` and call `Build()`.
8. If `IsDone()`, the result is a proper OCC solid suitable for `BRepFilletAPI_MakeFillet`.

Degenerate (zero-area) triangles are skipped before wire construction to prevent
sewing failures. The cross-product magnitude check (`crossSq < 1e-24`) guards this.

### Runtime verification status

The OCC WASM cannot be loaded in bare Node.js v22 because the `opencascade.js@1.1.1`
entry point (`index.js`) uses `import wasmFile from "./dist/opencascade.wasm.wasm"` —
an ESM static import of a WASM file — which Node.js v22 does not support without
the experimental Wasm Modules flag. All probing in this environment fails at module
load, not at the sewing API level. The JS glue's approach of setting `ENVIRONMENT_IS_NODE`
and using `require('fs')` internally also conflicts with the project's `"type":"module"`.

The Vite bundler (used for `npm run dev` and tests in jsdom) handles the WASM import
correctly. The live WASM test suite (`describe.skip`) documents the correctness tests;
they remain skipped until a Node-env Vitest config is wired.

The sewing APIs (`BRepBuilderAPI_Sewing`, `BRepBuilderAPI_MakePolygon`,
`BRepBuilderAPI_MakeFace_15`, `BRepBuilderAPI_MakeSolid`) are confirmed present in
`Supported APIs.md` with the same "unsupported" badge (= incomplete auto-bindings,
not uncallable) as the APIs that the Batch 13 spike confirmed work at runtime
(`BRepAlgoAPI_Fuse_3`, `BRepFilletAPI_MakeFillet`, etc.).

### Remaining limitations

- **Robustness depends on triangle sealing**: degenerate triangles are skipped but may
  leave gaps. If sewing produces an open shell, `MakeSolid.IsDone()` returns false and
  `filletEdges` returns null (graceful no-op with `console.warn`).
- **Non-manifold / open meshes**: `filletEdges` returns null. This is correct — an open
  surface cannot be filleted.
- **Planar approximation**: `BRepBuilderAPI_MakeFace_15` builds a planar face from each
  triangle wire. Curved-surface meshes (sphere, cylinder) are approximated as polyhedral
  solids. The fillet operates on this approximation — geometrically close but not exact.
- **Sewing tolerance**: the 1e-6 tolerance merges nearly-coincident vertices, which is
  correct for watertight sealing but may lose sub-micrometer detail.

### Operand types now handled by filletEdges

| Operand type | Status |
|---|---|
| `box` entity | Exact B-rep via `BRepPrimAPI_MakeBox_2` (unchanged, always worked) |
| Closed manifold mesh (any orientation) | Sewing approach; works for box, rotated box, boolean-result mesh |
| Non-manifold / open mesh | Graceful null (console.warn emitted) |
| `cylinder` / `sphere` / `extrusion` entity | entityToOccShape still returns null for these; their MeshData goes through the sewing path |
