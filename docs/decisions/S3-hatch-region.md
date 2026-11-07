# S3 — `region` entity and `hatch_region`

Status: built. Backlog item S3 (2D drafting): hatch a bounded area, measure it, extrude it.

## Decision

A new 2D entity kind `region` (L7: a planar `Entity` in the one bag, local `Vec2` on the entity plane, `position` / `rotation` place it)
and one command `hatch_region` that creates it from existing drawn shapes.

### Data model (`RegionEntity`, `model/types.ts`)

| field     | meaning                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| `loops`   | `Vec2[][]`, each >= 3 points, implicitly closed; `loops[0]` is the outer boundary               |
| `curves?` | one closed exact `CurveSegment<Vec2>` chain per loop (same order); `loops` is its tessellation  |
| `hatch?`  | `{ pattern: 'solid' \| 'lines' \| 'cross', angle (rad), spacing (> 0) }`; absent = outline only |

- **Fill rule is even-odd.** A loop inside the outer one is a hole, a loop inside a hole is an island, and so on. Net area = outer − holes +
  islands. One region has one outermost loop; a selection with several disjoint outermost loops makes one region per outermost loop.
- **Curves stay exact, like `ExtrusionEntity.curves`.** There is no bulge convention in the 2D model (`polyline` is straight edges), so
  arcs / ellipses / splines are kept as `CurveSegment` chains and `loops` is the display tessellation. Area, perimeter and snapping read
  the exact chain (a Ø20 hole is exactly 100π), render / DXF / hatch read the polygon. A command rewriting one rewrites both
  (`scale_entity` does).
- **Pattern.** The repo has one hatch engine, `@lib/hatch` (`hatchSegments`, ANSI31 = 45° lines, capped at 300 lines across the region). The
  region reuses it (`cappedHatch`, extracted from `ansi31Hatch`): `lines` at `angle` (45° default = ANSI31), `cross` = lines at `angle` and
  `angle + 90°`, `solid` = filled. Other ANSI / ISO patterns (ANSI32 brick, dots, AR-CONC) are not in the repo and not invented here:
  they are an extension of `hatch.pattern` (zod enum + `regionHatchLines`) if a drawing needs them. Colour = the entity `color`.
- **Even-odd clipping** of the pattern is `hatchSegments` itself (crossings paired), so lines never cross holes.

### `hatch_region`

Exactly one of:

- `ids` — closed shapes (circle, rectangle, ellipse, closed polyline, closed spline); all open pieces (line, arc, open polyline / spline)
  together must join end to end into one more loop (reuses `sketchLoop`). All shapes on one work plane (same rotation, no offset along the
  normal); the region sits at the first listed shape.
- `point` (+ optional `plane` = sketch plane id, default the world XY plane at z = 0) — pick-point hatch (AutoCAD BHATCH): the smallest
  closed shape on that plane around the point is the boundary, the closed shapes directly inside it are its holes. This works over **closed
  shapes**, not over a network of loose lines: there is no planar-graph face finder in `@lib` (`polygonBoolean` is a union of convex pieces),
  and a robust one (T-junctions, overlapping collinear lines, tolerance) is its own task. A shape crossing the chosen boundary is refused
  (`REGION_LOOPS_CROSS`) instead of guessed.

Refusals are coded (`codedRejection`, with remediation): `REGION_EMPTY_SELECTION`, `REGION_ENTITY_NOT_FOUND`, `REGION_UNSUPPORTED_KIND`,
`REGION_OPEN_BOUNDARY`, `REGION_PLANE_MISMATCH`, `REGION_DEGENERATE_LOOP`, `REGION_SELF_INTERSECTING`, `REGION_LOOPS_CROSS`,
`REGION_POINT_NOT_ENCLOSED`, `REGION_TOO_LARGE` (> 256 loops / 4000 tessellated points), `REGION_BAD_PARAM`. Loops that touch without
crossing are not detected (only proper crossings are); the even-odd result there is still well defined.

### Other layers

- **Measure.** `measure_area` returns the net area (exact), `measure_perimeter` the total boundary (outer + holes); `check_model` flags a
  region with no net area.
- **2D → 3D.** `extrude_profile id=<region>`: no holes / islands → plain exact `extrusion` (any kernel or none). Holes / islands → one
  kernel recipe (outer prisms united, hole prisms subtracted, the same method as font text) and a mesh solid with its exact B-rep;
  without a kernel: `REGION_NEEDS_KERNEL`. `ExtrusionEntity` has one polygon, so holes cannot live in it.
- **Transforms / copy.** move, rotate, mirror, array, duplicate act on `position` / `rotation` and are kind-agnostic; `scale_entity` scales
  loops, curves and the hatch spacing.
- **Export.** DXF (R12 has no HATCH entity): loop outlines as closed polylines, pattern lines (or SOLID triangles) on `<layer>-PATT`, the same
  convention as drawing fills. render_view SVG: stroked loops + hatch lines, solid = filled triangles. Sheets and technical views project
  3D solids only (`create_sheet` refuses 2D ids): regions are not sheet content. Code export (CadQuery, build123d, OpenSCAD, FreeCAD)
  emits solids; 2D drafting, `region` included, adds none (an extruded region is exported as the extrusion / mesh it produced).
- **Persistence.** `KIND_PROBLEMS.region` validates loops (count, points, caps), curves (parallel closed chains), hatch (pattern, finite angle,
  spacing > 0).
- **UI.** `RegionRenderer` (both views, via `Shape2DRenderer`), snapping (exact joints + straight-edge midpoints + every edge as a segment),
  box select, outline / interior picking (even-odd), property rows, and a one-click **Hatch** draw tool dispatching `hatch_region point`.

## Not done

- Associativity: a region copies the boundary geometry at creation; editing a source shape later does not move the region (re-run `hatch_region`).
- Pick-point detection over loose lines (planar face finding); hatch of a region from a DXF HATCH import.
- Other standard patterns, a hatch-edit command (delete and redo, or `scale_entity` / `set_entity_color`), hatch origin offset.
- `explode` of a region into polylines.
