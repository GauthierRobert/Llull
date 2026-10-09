# Roadmap

Priorities reflect the v1 goals: **(1) a working demo you can click around in,
(2) clean architecture to build on, (3) the MCP integration (the sole path for
AI control — there is no in-app AI bridge).**

## v0.1 — Working demo (current scaffold)

- [x] Command-layer architecture + registry
- [x] Document model (box, cylinder, sphere, extrusion)
- [x] Command unit tests + coverage gate
- [ ] React-Three-Fiber viewport with orbit controls
- [ ] Toolbar that dispatches commands
- [ ] Selection + transform gizmo
- [ ] Undo/redo via snapshot stack

## v0.2 — 2D drafting + modeling depth

- [ ] 2D entities (line, polyline, arc, circle, rectangle, point, text, dimension)
- [ ] 2D draw commands + orthographic top-down drafting view (2D ⇄ 3D view toggle)
- [ ] Snapping (endpoint/midpoint/center/intersection/grid) + ortho/polar tracking
- [ ] Dimensions & annotations
- [ ] Extrude-from-sketch (the 2D→3D bridge: closed profile → extrude)
- [ ] Boolean operations (union/subtract/intersect)
- [ ] Layers panel (visibility, lock)

## v0.3 — MCP server (the AI integration)

- [x] Tool schemas generated from the registry (`toToolSchemas()`)
- [x] Express-hosted MCP endpoint (`/mcp`) exposing the same registry
- [x] Auth + rate limiting
- [x] Example external agent script

> AI control is delivered entirely through MCP. There is intentionally no in-app
> AI assistant / Claude proxy — any MCP client (including Claude) drives llull by
> calling the same commands the UI does.

## v0.5 — Parametric & constraints (the leap to "real CAD")

- [ ] Named parameters / variables (`set_parameter`) — change a value, model regenerates
- [ ] Geometric + dimensional constraints + a pure constraint solver
- [ ] Feature history / timeline: insert, reorder, edit-params, suppress → re-evaluate
- [ ] Constructive vs evaluated geometry split (`entities` becomes a derived cache)
- See the `parametric` skill, architecture L8.

## v0.6 — Measurement & inspection (read-only MCP tools)

- [ ] `measure_distance` / `measure_angle` / `area_of` / `perimeter_of` / `volume_of`
- [ ] `bounding_box`, `mass_properties` (needs material density), `check_interference`
- [ ] `CommandResult.data` channel for query values
- See the `measure` skill.

## v0.7 — Geometry kernel upgrade (behind a `core/` interface, L9)

- [x] `GeometryKernel` interface; start mesh-based (three.js / Manifold)
- [ ] Exact boolean operations (union / subtract / intersect)
- [ ] Fillet / chamfer / shell; later NURBS surfaces
- [x] Swap-in path for OpenCascade.js (B-rep) without touching commands (`?kernel=occt`, `LLULL_KERNEL=occt`)

## v0.8 — Interop & persistence

- [x] Native save/load + document versioning (llull-document v2; v1 still read)
- [x] 2D: DXF import (`import_dxf`) + export (`export_dxf`, `export_civil_dxf`); DWG still open
- [x] 3D exchange: STEP export (exact B-rep, via CadQuery/OpenCascade) + STEP import (as meshes) — docs/CAD_EXCHANGE.md
- [x] Parametric code exchange: CadQuery / build123d (round-trip), OpenSCAD + FreeCAD macro (export)
- [ ] IGES; STEP feature recognition (import as editable primitives)
- [ ] Mesh/print: STL / 3MF / OBJ / glTF; PDF export of drawings

## v0.9 — Assemblies

- [ ] Components & instances, transforms, references
- [ ] Mates / joints; bill of materials (BOM)

## v1.0 — Drawings & documentation

- [ ] 2D drawings generated from 3D: orthographic / section / detail views
- [ ] GD&T, dimension styles, title blocks, sheets (paper space)

## Civil / site engineering — see docs/CIVIL.md, docs/MARKET_READINESS.md

- [x] Survey import, TIN surfaces + contours, platforms + cut/fill balance, surface volumes
- [x] Road alignments, profiles, templates, corridor volumes, long / cross sections
- [x] Storm drainage networks: Manning, rational method, sizing, schedules
- [x] LandXML 1.2 + civil DXF export
- [ ] DWG, spirals + superelevation, CRS, civil plan sheets (see MARKET_READINESS gaps)

## Construction (AEC / BIM) — see docs/CONSTRUCTION_PLAN.md

- [x] Levels, structural grids, project info
- [x] Parametric walls (auto joins), hosted doors / windows, slabs, columns, beams, stairs, rooms
- [x] Quantity takeoff, schedules, cost estimate
- [x] DXF (R12) plans, scaled SVG plan sheets with title block, IFC4 export
- [x] Building panel, 2D Wall tool, per-level floor plan in the 2D view, starter templates
- [x] Slab openings (stair wells, shafts)
- [x] Sections / elevations (`export_elevation_sheet`)
- [x] DXF hatches (R12 LINE / SOLID pattern layers)
- [x] Curved walls (`add_curved_wall`)
- [x] Wall build-ups (`set_wall_layers`)
- [x] Openings in curved walls

## Industrial (factory builders) — see docs/INDUSTRIAL_PLAN.md

- [x] Steel profile catalogue, steel members, portal-frame hall generator, crane runways
- [x] Pad footings, cladding panels, process equipment, pipe runs
- [x] Clash detection, steel tonnage / paint / cut lists, IFC steel export
- [x] Multi-span halls, cable trays, base plates with anchor bolts, section poché
- [x] Moment connections (end plates, haunches, bolts)
- [x] Frame analysis, member and bolt checks, automatic sizing, weld detailing
- [x] Wind / crane load cases, buckling, sway stability and deflection checks
- [x] Lateral-torsional buckling, crane runway fatigue, bracing and foundation checks

## Target architecture migration (Wave 7) — see docs/MIGRATION_PLAN.md

- [x] Golden replay corpus, schema conformance and tool-schema snapshot tests
- [x] Execution context: kernel, ids and registry injected per `execute`; one kernel choice for browser and server
- [x] One zod schema per command (`defineCommand`): TS type, MCP JSON Schema and runtime validation
- [x] Step-scoped deterministic ids; replay re-mints identical ids
- [x] Replay prefix cache; parameter edits regenerate only dependent steps; kernel memoization
- [x] Derivation guards; saved files omit plugin-derived geometry (llull-document v2)
- [ ] Kernel (boolean / fillet) mesh results as a derived cache, not stored in files
- [x] Command-log live sync (`/live`), offline outbox; UI bridge retired
- [x] Plugins (building, industrial); npm workspaces; MCP tool discovery (`search_tools` / `enable_toolset`)
- [x] Every source file under 500 code lines
- [ ] History-based undo (MG5.4)

## Later

- [ ] Materials library (physical + visual / rendering)
- [ ] Simulation / CAE (FEA, thermal, motion)
- [ ] CAM / fabrication (toolpaths / G-code, sheet-metal unfold, slicing)
- [ ] Real-time multi-user collaboration (comments, permissions, version branches)
