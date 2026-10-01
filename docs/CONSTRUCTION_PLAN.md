# Construction (AEC / BIM) plan — closing the gap for building companies

llull started as a mechanical-style 2D + 3D CAD. A construction company needs
**building elements, levels, grids, quantities, schedules, and deliverables that the rest
of the industry can open** (DXF for AutoCAD users, IFC for BIM coordination, printable
plan sheets with a title block). This plan closes that gap. It takes its cues from
Revit / ArchiCAD (levels, hosted openings, schedules, IFC), AutoCAD Architecture
(AIA layer standard, DXF), and estimating tools (quantity takeoff → cost).

## Design (respects the architecture laws)

- **Constructive vs evaluated (L8).** A new optional `CadDocument.building` holds the
  *constructive* building model: levels, grid lines, walls, openings, slabs, columns,
  beams, stairs, rooms and project info. Every building command edits that model and
  then re-evaluates it into ordinary entities (`box`, `extrusion`, `line`, `arc`, `text`,
  …). No new entity kinds ⇒ rendering, selection, STL/STEP/OBJ export, measure and
  `check_model` keep working untouched (OCP).
- Evaluated entities have deterministic ids (`<elementId>:<part>`), a readable `name`
  ("Wall W3"), `tags` (`['bim', '<category>', 'element:<id>']`) and sit on
  **AIA/NCS standard layers** (`A-WALL`, `A-DOOR`, `A-GLAZ`, `S-SLAB`, `S-COLS`,
  `S-BEAM`, `A-FLOR-STRS`, `A-AREA`, `S-GRID`).
- **Walls are parametric hosts.** Openings (doors/windows) are stored on the wall; the
  wall evaluates into exact rectangular pieces around the openings — no mesh CSG, so
  quantities stay exact. Walls sharing an endpoint on the same level are joined
  (ends extended to close the corner).
- Quantities, schedules, costs, DXF, IFC and plan sheets are **pure functions of the
  building model**, exposed as read-only query commands returning `data`. Everything is
  one command ⇒ one UI action + one MCP tool.

## Steps

Each step ships with unit tests (happy + failure path, purity) and is covered by the
Playwright end-to-end suite (`npm run test:e2e`).

- [x] **S0 — Plan + e2e infrastructure.** This document; `@playwright/test`,
      `playwright.config.ts`, `tests/e2e/`.
- [x] **S1 — Building model, levels, project info.** `add_level`, `update_level`,
      `delete_level`, `set_project_info`, `describe_building`.
- [x] **S2 — Structural grid.** `add_grid_line`, `add_grid_system` (lettered/numbered
      axes with bubbles).
- [x] **S3 — Walls.** `add_wall`, `draw_walls` (chain/closed loop), `update_wall`,
      automatic corner joins, `delete_building_element`, `move_building_element`.
- [x] **S4 — Doors & windows.** `add_door`, `add_window`, `update_opening` — hosted,
      cut the wall, door swing drawn in plan.
- [x] **S5 — Structure & circulation.** `add_slab` (floor / roof / foundation, or from a
      closed wall loop), `add_column`, `add_beam`, `add_stair`.
- [x] **S6 — Rooms.** `add_room` with name, number, area tag.
- [x] **S7 — Quantities & cost.** `quantity_takeoff` (lengths, areas, volumes, counts by
      material — metric m/m²/m³), `building_schedule` (wall / door / window / room /
      column schedules, CSV), `estimate_cost` (unit rates → priced bill of quantities).
- [x] **S8 — DXF export.** `export_dxf` — AutoCAD-readable plan per level (wall poché,
      openings, door swings, grids, rooms, plus the document's 2D drafting).
- [x] **S9 — Plan sheets.** `export_plan_sheet` — scaled (1:20…1:500) SVG floor plan on
      ISO paper (A4…A0) with title block, north arrow, scale bar, grid bubbles, room
      tags, overall dimensions; print to PDF from the browser.
- [x] **S10 — IFC export.** `export_ifc` — IFC4 (ISO 16739) with project / site /
      building / storeys, walls, slabs, columns, beams, doors, windows, stairs, spaces.
- [x] **S11 — UI.** A *Building* panel: project info, levels (active level), element
      tools with parameter forms, quantity / cost table, schedule CSV, DXF / IFC / sheet
      downloads.
- [x] **S12 — Verification.** Unit tests for every command, Playwright e2e covering the
      full workflow in a real browser, MCP prompt + docs (`docs/CONSTRUCTION.md`).
