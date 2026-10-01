# Construction (AEC / BIM) guide

llull includes a building workspace for construction companies: model a building by
**levels, grids, walls, doors, windows, slabs, columns, beams, stairs and rooms**, get
**quantities, schedules and cost estimates**, and deliver **plan sheets (PDF via print),
DXF for AutoCAD users and IFC4 for BIM coordination**. Every action is a command, so the
same workflow is available in the *Building* panel and to MCP agents.

The plan and status of this work: [`CONSTRUCTION_PLAN.md`](CONSTRUCTION_PLAN.md).

## Concepts

| Concept | What it is |
| --- | --- |
| **Building model** | `CadDocument.building` — the *constructive* definition (levels + elements + project info + cost rates). It is the source of truth. |
| **Evaluated entities** | Each element regenerates ordinary entities (boxes, extrusions, lines, text…) with ids `<elementId>:<part>`, names like "Wall W3", tags `bim`, `<category>`, `element:<id>`. Edit the element, never these entities — generic commands that would change them (move, delete, layer delete…) are refused; Delete on a selected wall deletes the wall element. |
| **Layers** | AIA / US National CAD Standard: `A-WALL`, `A-DOOR`, `A-GLAZ`, `S-SLAB`, `S-COLS`, `S-BEAM`, `A-FLOR-STRS`, `A-AREA`, `S-GRID`, plus `A-ANNO-DIMS` in drawings. |
| **Units** | Model lengths use the document unit (default mm; `set_units` for m, cm, in, ft). Quantities are always metric (m, m², m³, ea); drawing dimensions are in mm. |
| **Levels** | Storeys with an elevation (finished floor) and floor-to-floor height. The *active level* receives new elements. A "Level 0" is created automatically if you start drawing without one. |

## Elements

| Element | Command(s) | Notes |
| --- | --- | --- |
| Structural grid | `add_grid_system`, `add_grid_line` | Numbered axes along X, lettered along Y (I and O skipped). |
| Wall | `add_wall`, `draw_walls`, `update_wall` | Plan centerline, thickness, height (default: level height), material. L / T / X joints close automatically. Also drawn with the **Wall** tool in the 2D view (Enter to finish, click the first point to close). |
| Curved wall | `add_curved_wall` | Arc centreline from start through a point to end; thickness, height, base offset, material. Counted with walls in quantities and the wall schedule; hatched cut in plans, IfcWall in IFC. No hosted openings or automatic joins. |
| Door / window | `add_door`, `add_window`, `update_opening` | Hosted by a wall: cut it exactly, travel with it, refused if they do not fit or overlap. Doors draw their swing in plan. |
| Slab / roof / foundation | `add_slab` | From a boundary or a closed loop of walls (`wallFace`: outer / center / inner). Top at level + offset. |
| Slab opening | `add_slab_opening`, `delete_slab_opening` | Stair wells (from a `stairId`: the floor slab above is found automatically), shafts, risers. Deducted from quantities, crossed in plan, IfcOpeningElement in IFC. |
| Column | `add_column` | Rectangular or circular; one location or every grid intersection. |
| Beam | `add_beam` | Top under the next floor by default. |
| Stair | `add_stair` | Equal risers from the level height; reports the Blondel rule 2R + G (600–650 mm). |
| Room | `add_room` | Name + number, from a boundary or the inner faces of walls; area tag. |
| Typical floors | `copy_level_elements` | Repeat a level onto others (walls keep their openings). |
| Edits | `move_building_element`, `delete_building_element`, `update_level`, `delete_level` | Moving a level moves everything on it; full-height walls / columns and stairs follow a new level height. Element ids are never reused, and building commands report the element id first in `affected` (so `build_project` aliases and history replay keep hosts linked). |
| Starter | `add_building_template` | `house` or `office`, created in one undoable step. |

## Quantities, schedules and costs

- `quantity_takeoff` — bill of quantities by category × material × unit (walls measured on their built body — joints applied, no double counting at corners —
  openings deducted). Each line has a key such as `wall.masonry.m3`, `slab-roof.concrete.m2`, `door.timber.ea`.
- `building_schedule` — wall, door, window, room, slab, column, beam or stair schedule (CSV).
- `set_cost_rates` + `estimate_cost` — unit rates by key or wildcard (`wall.*.m2`, `*.concrete.m3`);
  price **one** unit per category to avoid double counting. Unpriced lines are listed.

The *Building* panel shows the live takeoff + estimate and downloads CSV files.

## Deliverables

| Output | Command | Opens in |
| --- | --- | --- |
| Plan sheet | `export_plan_sheet` { levelId, paper A4–A0, scale } | Any browser; print to PDF at 100 % for a true-scale drawing. Title block from `set_project_info`, north arrow, scale bar, dimensions. |
| DXF | `export_dxf` { levelId } | AutoCAD, BricsCAD, DraftSight, LibreCAD, QCAD, Revit… (R12 ASCII, AIA layers, cut at 1.2 m; cut walls / concrete columns hatched ANSI31 and steel sections solid on `*-PATT` layers). |
| IFC4 | `export_ifc` | Revit, ArchiCAD, Tekla, Solibri, BIMcollab, Navisworks, BlenderBIM… Walls with real openings (IfcOpeningElement + fills), slabs, columns, beams, stairs, spaces, materials; stable GlobalIds. Validated with IfcOpenShell (schema + EXPRESS rules). |
| Native | Save / Open (JSON) | llull — the building model round-trips. |

## Known limits

- Curved walls do not host doors / windows or join other walls; wall layers (build-ups) are not modelled yet.
- Plans cut every element of the level at 1.2 m; elevations and sections come from `export_elevation_sheet` (see [`INDUSTRIAL.md`](INDUSTRIAL.md)).
- DXF hatches are written as R12 LINE / SOLID entities (no associative HATCH objects).
