# KI5 — The kernel boundary is a shape, not a mesh

Status: accepted (2026-10).

## Problem

`GeometryKernel` took and returned `MeshData`. Under OpenCascade a boolean's exact result was
tessellated at once, and a later fillet re-sewed those triangles into a solid of planar facets
before rounding them. So exact topology never survived an operation: no true faces or edges,
fillets on facets (edge indices counted triangle diagonals), and no faithful STEP export. OCC
was mostly decorative.

## Decision

- Commands describe geometry as a `ShapeRecipe`: a serializable construction tree with primitive
  leaves (`solid`) and `boolean`, `fillet`, `chamfer`, `shell`, `place` and `scale` nodes
  (`packages/core/src/geometry/shapeRecipe.ts`).
- `GeometryKernel` = `evaluate(recipe) → ShapeHandle | null`, `tessellate(handle)`,
  `topology(handle)`, `exportStep(handles)`. The `ShapeHandle` is opaque to core: a branded
  token that carries its recipe.
- Concrete kernels implement `KernelOps<S>` on their native shape (an OCC `TopoDS_Shape`, a
  Manifold solid). `kernelFromOps` (`shapeKernel.ts`) evaluates recipes and caches native shapes
  by `recipeKey`, a content hash that ignores presentation fields. Eviction releases WASM memory,
  shapes in use by a running evaluation are pinned, and a handle whose shape was evicted (or
  whose worker was recycled) is rebuilt from its recipe.
- Results are `mesh` entities with `mesh` (the display tessellation) plus `brep` (the recipe).
  The next operation resumes the exact tree (`recipeOf`). When the current kernel cannot rebuild
  the tree, the stored triangles are the fallback (`operandRecipe`).
- New read-only commands: `inspect_topology`, which lists exact faces and unique edges (its
  indices are what `fillet_edge` / `chamfer_edge` select), and `export_step_exact`, which writes
  STEP AP214 straight from the B-rep with no Python.

## Consequences

- OCC booleans take every operand as an exact solid. A fillet on a boolean result rounds a true
  edge: a drilled cube's hole lip becomes a torus face. STEP exports carry `CYLINDRICAL_SURFACE`
  and `ADVANCED_FACE`s, not triangles.
- Edge indices mean something now: a box has 12 edges, not 18 triangle edges. Seam edges (a
  cylinder's) and degenerate edges (a sphere's poles) are flagged, and `fillet_edge` rejects
  them along with out-of-range or repeated indices.
- Topological naming: an index is stable only for an unchanged source recipe; after an upstream
  parametric edit a stored `edgeIndices: [3]` can name a different edge. `fillet_edge` and
  `chamfer_edge` therefore also take `edgesNear` (points). The feature history keeps the points, and
  each replay re-resolves them to the roundable edge with the nearest mid point on the regenerated
  B-rep, so a fillet follows its edge through a resize (`server/tests/occtParametricEdges.test.ts`).
  A full persistent-naming scheme (face/edge history from OCC's BRepTools_History) remains future
  work.
- Replay is cheap: the kernel cache spans steps, so editing step k rebuilds only the nodes whose
  recipe changed.
- Fallback to triangles happens only for a capability gap (`GeometryKernel.supports`), never
  because of a transient refusal, and the summary names the faceted operand.
- A cached failure is dropped when the native module reports degradation (`failureEpoch`).
- The server's worker-isolated kernel proxies these calls. `evaluate` replies with a key-only
  handle, and output calls send key-only handles, resending the recipe only when the worker no
  longer caches the shape (`SHAPE_NOT_CACHED`). Recipes are therefore cloned across the thread
  once per evaluation, not on every call.
- Recipes loaded from files or snapshots are validated down to their leaves (3D solid kinds,
  persisted-entity checks, well-formed mesh arrays) before any kernel sees them.
- Documents grow: a result embeds its operands' definitions. That is the recipe, by design (L8).
- Manifold stays mesh-only: fillet/chamfer/shell recipes, `topology` and `exportStep` return
  null, and the commands no-op as before.
- Code export (`export_code`, and through it the Python `export_step`) rebuilds kernel results
  from their construction too. History steps become `fillet(…)`, `chamfer(…)` and `shell(…)` calls,
  and a stored `brep` (snapshot export) is lowered node by node (`codegen/recipeLowering.ts`). Fillet
  and chamfer edges travel as indices plus their exact mid points; the runtime selects edges by
  nearest mid point, which is robust to edge-order differences between OCC builds (opencascade.js vs
  CadQuery's OCP). OpenSCAD has no fillets, so it receives the exact result's triangles. The trace
  round-trips: `apply_code_trace` replays `fillet_edge` / `chamfer_edge` / `shell_solid`. This is
  verified against real CadQuery (`server/tests/brepCodeExchange.integration.test.ts`).
- Gotcha: this opencascade.js build corrupts `STEPControl_Writer.Write` paths longer than about
  12 characters, so the writer uses a fixed `/out.step`.
