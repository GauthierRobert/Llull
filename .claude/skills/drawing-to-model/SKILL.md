---
name: drawing-to-model
description: Rebuild a part in llull from a 2D technical drawing (PDF/PNG/scan with front/top/side views, dimensions, title block) and PROVE it matches — mass/volume from the title block, overall extents, llull's own orthographic views and sections against the drawing views, and, when a real 3D exists (STEP/STL/CAD code), an exact 3D IoU with per-view diff images. Use for "model this drawing", "build the part from this blueprint", "check my model against the drawing/STEP", CAD-practice sheets (Too Tall Toby style "what is the mass"), or regression-testing llull on real drawings.
---

# Skill: drawing-to-model

Drawing → llull plan → **verify in layers** → fix the reading, not just the numbers. Building the
plan is `design-model` + `llull-cli`; this skill is the reading discipline and the verification
loop. Corpus of 21 verified parts: `quality/drawings/` (`npm run quality:drawings`).

## 1. Read the drawing (before any command)

- Title block: units (MMGS vs IPS → model in mm, 25.4), material/density, the asked quantity
  (mass ± tol = your strongest single check). Projection (1st/3rd angle) decides which view is
  where; the iso render on the sheet settles doubts.
- Build a **feature table**: feature, view it is dimensioned in, dimensions, "THRU"/depth,
  count ("(4) PLACES", "6X"), symmetry (CL SYM). Parenthesised dims are reference = derived —
  use them as checks. Hidden (dashed) lines = internal features; every one must be explained.
- Pick the frame: top view = XY, front view = XZ (Z up), right view = YZ; origin at a datum the
  drawing dimensions from (or the symmetry centre).
- Undimensioned geometry: read by scale (pixels / a known dimension), and say so in the report.

## 2. Plan (llull specifics that bite)

- Exact curves: sketch pieces (`draw_line` + `draw_arc`) → `extrude_sketch {ids}`; avoid
  sampled polygons (they lose exactness and volume).
- Sketch-plane rotations (three.js XYZ Euler) for `extrude_sketch` / `extrude_profile`:
  XY `[0,0,0]` (+Z) · XZ `["=pi/2",0,0]` (local y→Z, extrudes −Y) · YZ `["=pi/2","=pi/2",0]`
  (local x→Y, y→Z, extrudes +X). Prefer `rotation` over `axis` for sketches (axis fixes only
  the normal). Check the AABB in every step summary.
- Booleans consume operands (`duplicate_entity` first); tools for THRU features overshoot.
- Fillets: `--kernel occt`, `fillet_edge edgesNear` = any point on the edge. OCC propagates a
  fillet along tangent-continuous chains, so "R in the top view, N places" corners are cleaner as
  `boolean_intersect` with a rounded-rectangle prism.
- Mass: `mass_properties` (OCC → exact B-rep volume, `data.method: 'exact'`).

## 3. Verify in layers (cheap → strong); every layer that fails names a feature

1. **Mass / volume** vs the title-block answer (± tol). Wrong by a round feature's volume ⇒
   that feature is missing/extra.
2. **Extents**: `measure_bounding_box` vs the overall dims.
3. **2D views vs the drawing**: `llull render_view view=front|top|right showGrid=false --save`
   and read them next to the drawing view; add `cut` (section) for hidden-line features (holes,
   pockets, counterbores) and compare with the dashed lines.
4. **Real 3D (when available)**: export STL and run
   `python -I .claude/skills/drawing-to-model/scripts/compare_meshes.py ours.stl ref.stl --out diff/`
   (`pip install manifold3d trimesh pillow numpy`). Prints volume ratio, exact 3D IoU (best of 24
   orientations), silhouette and mid-section IoU per view; images: grey both, **red = missing
   material**, **blue = extra material**. Targets: volume ±0.3 %, IoU ≥ 0.99, views ≥ 0.98.
   A STEP reference → convert to STL first (CadQuery / build123d `export_stl`).
5. Diagnose from the image, re-read the drawing at that spot, fix the plan, re-run. A residual
   difference is either a reading error, a reference defect (prove it from the drawing) or a
   llull limitation (write the repro, then `fix-bug`).

## Lessons from the corpus

See `quality/drawings/README.md` (per-part findings) — keep it updated when a part teaches
something new.
