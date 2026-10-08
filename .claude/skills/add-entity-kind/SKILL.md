---
name: add-entity-kind
description: Add a new entity kind to llull — a 2D Shape2DKind (like ellipse, spline) or a 3D SolidKind (like torus, wedge, pyramid). Use whenever a task means "support <new shape/solid>" rather than a new operation on existing kinds. A new kind touches ~10 layers and most switches have a silent default, so this checklist prevents an invisible or half-supported kind. For a new operation on existing kinds use add-command instead.
---

# Skill: add-entity-kind

Most dispatch sites have a tolerant `default` → a missed case **fails silently** (no triangles, no
render, no export). Only the sites marked ⚠ are compiler-checked. Use an existing kind of the same
family as a tracer: `grep -rn "'torus'" packages src server/src tests` (3D) or `'ellipse'` (2D).
Delegate in parallel when large: Lane 1 (`command-author`) model→codegen, Lane 2/3
(`viewport-engineer`) UI, then `cad-reviewer`.

## 1. Model (mandatory)
- `packages/core/src/model/types.ts`: add to `SOLID_KINDS` / `SHAPE2D_KINDS`, add an `XEntity`
  interface, add it to the `Entity` union. `is2D`/`is3D`, query `FILTERABLE_KINDS` and the
  persistence kind set derive from the arrays (→ tool-schema snapshot changes, intended).
- `.claude/context/model.md`: list the kind.

## 2. Commands (mandatory)
- Creating command next to its family: `geometryRound.ts` (round solids), `geometryPrismatic.ts`
  (wedge/pyramid-like), `draw2dCurves.ts` (2D curves; point series share `draw2dShared.ts`).
  Register in `registry.ts`. Follow `rules/commands.md` (pure, `.describe()`, graceful failure).
- ⚠ `commands/renderTessellation.ts` (`const exhaustive: never`), ⚠ `sceneBounds.ts` `localBounds`,
  ⚠ `transform.ts` `scaleGeometry`.
- `persistenceGuards.ts` `POSITIVE_FIELDS` (saved-doc validation); `check.ts`
  `checkDegenerateGeometry` + its issue-code description.

## 3. Geometry & measure (mandatory for 3D)
- `solidTriangulation.ts` `unrotatedTriangles` (default `[]` — feeds STL/OBJ, Manifold, mesh
  fallback); shared generators in `tessellation.ts`.
- `measureSolid.ts` `measure_volume` case + the kind lists in its description strings.
- 2D: `measureAreaPerimeter.ts` if area/perimeter applies.
- Optional: `sceneRotatedBounds.ts`, `instanceExpansion.ts`, `renderLabels.ts`.

## 4. Kernels (mandatory for 3D booleans)
- Kernel input is a `ShapeRecipe` whose leaves are any `SOLID_KINDS` entity — no recipe change;
  each kernel's native maker below must handle the kind.
- `packages/kernel-manifold/src/manifoldKernel.ts` `primitiveOf` / `entityToManifold` (or the
  welded `entityToTriangles` group).
- `packages/kernel-occt/src/occtShapes.ts` `entityToOccShape` is an if-chain that falls through to
  `revolvedPrimitive` — handle explicitly (exact maker) or add to `TRIANGULATED_KINDS`.

## 5. Codegen & exchange (3D expected; 2D export)
- ⚠ `codegen/program.ts` `ShapeSpec` member (then ⚠ `openscad.ts` `shapeSource`, ⚠ `pythonCalls.ts`
  `shapeCallOpen`), `featureProgram.ts` `lowerShape`, `pythonRuntime.ts` (cq + bd makers),
  `freecad.ts`, `identifiers.ts` reserved names, `commands/code_trace.ts` `add_*` list.
- 2D: `packages/domain-aec/src/dxfExport.ts` case (default skips). `export.ts` description string.

## 6. MCP
- `packages/mcp/src/toolsets.ts` (place the command), `conventions.ts` tables, `resources.ts`
  anchor summary.

## 7. UI
- 3D: `src/ui/viewport/3d/Entities.tsx` case + `entities/XMesh.tsx`, `primitiveGeometry.ts`,
  `lodSegments.ts`, `src/ui/viewport/2d/solidOutline.ts` (top-view footprint),
  `toolbar/solidPresets.ts` + `Icon.tsx`.
- 2D: `Entities2D.tsx` case + `entities/XRenderer.tsx`, `boxSelect.ts`, `modifyHelpers.ts`,
  `snapping/candidates.ts`, `dimensionGeometry.ts` (+ `annotate.ts` radial kinds), draw tool:
  `store/toolStore.ts` `DrawToolKind`, `toolbar/drawTools.ts`, `hintText.ts`, `Icon.tsx`,
  `hooks/shortcuts.ts`, `2d/useDrawTool.ts`, `drawHelpers.ts`, `DrawPreview.tsx`, `lineGeometry.ts`.

## 8. Tests
- Unit: creating command (happy / failure / pure), bounds, scale, triangulation, measure,
  persistence round-trip, check, codegen (`featureProgram`, `codeExchange`), kernel conventions.
- Golden: add a plan in `tests/golden/plans.ts` exercising the kind; generate its snapshot.
- Tool-schema snapshot: regenerate (`npx vitest run tests/unit/contract -u`) and review the diff.
- Component: mesh/renderer test (`NewSolidMeshes.test.tsx`, `DimensionRenderer2D.test.tsx`).
- Server (OCCT): `server/tests/occtPrimitives.test.ts` or `occtTessellatedKinds.test.ts`.

## Done
`npm run check` + `npm --prefix server test` green; kind renders in both views (`verify-llull`);
`grep -rn "'<tracer>'"` shows no site where the tracer is handled and the new kind is not.
