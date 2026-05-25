---
name: viewport-feature
description: Implement or change the 3D viewport and UI interaction in llull — react-three-fiber rendering, orbit/camera, selection, transform gizmos, grid/snapping, layer panels, and render branches for entity kinds. Use for any src/ui work or when improving the look/feel. Delegates to the viewport-engineer agent.
---

# Skill: viewport-feature

llull must look modern and beautiful and feel easy. Hold a high visual bar; avoid
generic AI defaults (consider the `frontend-design` skill). Delegate to the
`viewport-engineer` agent.

## References
- `.claude/context/model.md` (what to render), `.claude/rules/architecture.md` (L2, L4)

## The boundary
`ui/` renders and gathers params; it NEVER mutates the document. To change anything,
call `store.dispatch(commandName, params)`. If no command fits, stop and add one via
the `add-command` skill first — do not edit entities in a component.

## Steps
1. Confirm needed commands exist (`listCommands()`); request missing ones first.
2. Render from the live `CadDocument` (Zustand store) as the single source of truth:
   - iterate `order`, render each `entity` by `kind` — every kind needs a branch, both
     2D `Shape2DKind` (line, arc, polyline, ...) and 3D `SolidKind` (box, ...),
   - reflect `selection` (highlight), `layers[].visible/locked`, and `camera`,
   - support both views: 2D orthographic top-down draft view and 3D perspective (same
     scene, view mode is presentation only). For 2D drafting features, use the `draw-2d`
     skill; keep snap/ortho math pure in core/lib, applied (not computed) in the component.
3. Wire interactions (toolbar, gizmo drag, click-select) to `dispatch`.
4. r3f/drei declaratively; map `CameraState` (target/azimuth/polar/distance) to
   `<OrbitControls>`. Memoize geometry/materials; dispose on unmount; no per-frame allocs.
5. Verify in the running app with the `verify-llull` skill (Playwright): load the page,
   exercise the interaction, screenshot, confirm a clean console.
6. `npm run check` green (component tests cover panels/param-gathering, not geometry math).

## Done checklist
- [ ] Renders every entity `kind` from the store; selection/camera/layers consistent
- [ ] All document changes go through `dispatch` (no inline entity edits)
- [ ] Verified visually in `npm run dev`; console clean; checks green
