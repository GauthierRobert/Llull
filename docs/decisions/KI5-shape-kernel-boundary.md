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
- Edge indices are stable and meaningful: a box has 12 edges, not 18 triangle edges.
- Replay is cheap: the kernel cache spans steps, so editing step k rebuilds only the nodes whose
  recipe changed.
- The server's worker-isolated kernel proxies four calls. Handles cross the thread as plain data.
- Documents grow: a result embeds its operands' definitions. That is the recipe, by design (L8).
- Manifold stays mesh-only: fillet/chamfer/shell recipes, `topology` and `exportStep` return
  null, and the commands no-op as before.
- Gotcha: this opencascade.js build corrupts `STEPControl_Writer.Write` paths longer than about
  12 characters, so the writer uses a fixed `/out.step`.
