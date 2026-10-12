---
name: drawing-to-model
description: Rebuild a part in llull from a 2D technical drawing (PDF/PNG/scan with front/top/side views, dimensions, title block) and PROVE it matches — mass/volume from the title block, overall extents, llull's own orthographic views and sections against the drawing views, and, when a real 3D exists (STEP/STL/CAD code), an exact 3D IoU with per-view diff images. Use for "model this drawing", "build the part from this blueprint", "check my model against the drawing/STEP", CAD-practice sheets (Too Tall Toby style "what is the mass"), or regression-testing llull on real drawings.
---

# Skill: drawing-to-model

Drawing → llull plan → **verify in layers** → fix the *reading*, not just the numbers. Running
plans is `llull-cli`; composing commands is `design-model`. This skill is the reading discipline
and the verification loop, distilled from 21 real drawings (`quality/drawings/`, all within the
official mass; `npm run quality:drawings` replays them).

## 1. Read the drawing before any command

- **Title block**: units (MMGS vs IPS → model in mm, ×25.4), material/density, the asked
  quantity. "Mass ± tol" is the strongest single check you will get — compute it.
- **Feature table** (write it down): feature · view it is dimensioned in · dimensions ·
  THRU/depth · count ("(4) PLACES", "6X") · symmetry (CL SYM). Every dashed (hidden) line must be
  explained by a feature — or it is a fillet's tangent edge (dashed arcs often are).
- **Parenthesised dims are reference = derived**: use them to *check* a reading (they fixed a
  flange angle, a bend side, where a taper starts). Small dims can run from a hole edge, not its
  centre; an inch "1.0"/".75" pair can be two ends of an asymmetric arc.
- **Undimensioned geometry**: measure px/mm from a known dimension on the original image and
  pixel-scan (row/column line positions) instead of eyeballing; on a 1:1 sheet read everything so.
  Unknown overall scale (hand sketch) → take it from one known extent/volume and say so.
- **Before modelling, hand-compute the expected volume** (prisms, Pappus for revolves,
  frustums, fillet corner terms). Agreement with mass ÷ density within ~0.1 % confirms the reading
  before any comparison run; a gap of one feature's volume names the feature.

## 2. Plan (llull specifics that bite)

- **Generate the plan with a small Python script** (helpers for line/arc loops, mirror, polar,
  booleans; exact tangent points / fillet centres in closed form; A/B variants by flag) and
  write JSON — never hand-type 200 steps. Normalise arc angles to [0, 2π) with end > start
  (`draw_arc` rejects sweeps > 2π).
- **Exact curves**: `draw_line` + `draw_arc` pieces → `extrude_sketch {ids}` /
  `revolve_profile {profileIds}`. Polygon profiles lose volume. No elliptical arc piece: use a
  dense `draw_spline` (mass error negligible) or a revolved/clipped `draw_ellipse`.
- **Sketch planes** (three.js XYZ Euler on `extrude_sketch` / `extrude_profile`): XY `[0,0,0]`
  (+Z) · XZ `["=pi/2",0,0]` (local y→Z, extrudes −Y) · YZ `["=pi/2","=pi/2",0]` (local x→Y,
  y→Z, extrudes +X). Tilted cutters: sketch in the face's own (s, w) frame, then
  `rotation [0, θ, 0]`. Prefer `rotation` to `axis` for sketches. Check every step's AABB.
- **Trim, don't build**: extrude the main outline full width, then `boolean_intersect` with one
  trim prism per other view (rounded ends, tapers, top-view corner radii). Avoid coplanar
  boolean junctions (overlap tools by ≥ 0.5; build multi-section lofts as one solid).
- **Fillets**: OCC (`--kernel occt`), `fillet_edge edgesNear` = any point on the edge (use the
  mid point from `inspect_topology`). OCC propagates along tangent chains, so for "R…, N
  PLACES" corners in a view prefer a rounded-rectangle prism intersect. A concave fillet against a
  cylinder or a corner where several blends meet is fragile: llull refuses it with a reason —
  build it instead: revolved arc ring, (disc − torus) ∩ box, or arcs in the profile.
- Booleans consume operands (`duplicate_entity` first; THRU tools overshoot); `rotate_entity`
  pivots about the entity `position` (a sweep: its path start) — compensate with `move_entity`.
  `loft_sections` resamples by arc length: a stadium→stadium loft twists (−8 %); build it as
  oblique circle-lofts ∪ trapezoid-prism ∩ trapezoid-prism.
- Don't leave variant tools in the document: `export_stl` exports every solid.

## 3. Verify in layers (cheap → strong); every failing layer names a feature

1. **Mass / volume**: `mass_properties` / `measure_volume` (OCC: exact B-rep,
   `data.method: "exact"`) vs the title block. Never judge mass from the STL (display mesh, up to
   0.4 % low on small curved parts).
2. **Extents**: `measure_bounding_box entityId=<solid>` vs the overall dims (whole-document bounds
   include leftover sketch pieces).
3. **llull's 2D views vs the drawing views**:
   `llull render_view view=front|top|right hide2D=true showGrid=false --save v.png` next to the
   drawing view; add `cut` for sections where the drawing shows hidden lines / section views.
4. **Real 3D, when one exists** (STEP/STL, or CAD code →
   `python -I .claude/skills/drawing-to-model/scripts/make_reference.py ref.py ref` needs
   `build123d`): `llull export_stl format=binary --save ours.stl`, then
   `python -I .claude/skills/drawing-to-model/scripts/compare_meshes.py ours.stl ref.stl --out diff/`
   (`pip install manifold3d trimesh pillow numpy scipy`). Exact 3D IoU (best of 24
   orientations), silhouette + mid-section IoU per view; images: grey both, **red = material you
   miss**, **blue = extra material**. Targets: IoU ≥ 0.99, views ≥ 0.98; volume via layer 1.
5. **Read the diff images numerically** (px/mm = 800 / (span + 2)): a constant-width band along an
   edge = an offset/tangency error (check signs); a quarter-circle at a corner = a missing fillet
   (r ≈ √(area / (1 − π/4))); a red/white/blue lens = a hole moved or resized; a fully blue
   feature = the reference lacks it. Rounded corners in `view_top` = vertical edges filleted.
   Good 2D scores but a volume gap → the difference is off every mid-plane: probe with
   `--no-rotate` by filling/adding candidate regions.

## 4. When the reference disagrees

The reference can be wrong (5 of 21 here). Build the reference's reading as a variant: if it
jumps to IoU ≥ 0.998, the defect is proved; keep the drawing-faithful plan and let the official
mass decide. A thin feature cut by a mid-plane section can tank that one section score — say so
rather than chase it.

## 5. Close the loop

A residual that is neither a reading error nor a reference defect is a llull bug: reproduce it
as a minimal plan, then `fix-bug`. Add the part to `quality/drawings/` (plan + manifest entry with
pinned drawing/reference URLs + README row) so `npm run quality:drawings` guards it.
