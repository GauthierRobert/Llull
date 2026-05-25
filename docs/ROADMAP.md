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
- [ ] `GeometryKernel` interface; start mesh-based (three.js / Manifold)
- [ ] Exact boolean operations (union / subtract / intersect)
- [ ] Fillet / chamfer / shell; later NURBS surfaces
- [ ] Swap-in path for OpenCascade.js (B-rep) without touching commands

## v0.8 — Interop & persistence
- [ ] Native save/load + document versioning
- [ ] 2D: DXF / DWG import + export
- [ ] 3D exchange: STEP / IGES (kernel-dependent)
- [ ] Mesh/print: STL / 3MF / OBJ / glTF; PDF export of drawings

## v0.9 — Assemblies
- [ ] Components & instances, transforms, references
- [ ] Mates / joints; bill of materials (BOM)

## v1.0 — Drawings & documentation
- [ ] 2D drawings generated from 3D: orthographic / section / detail views
- [ ] GD&T, dimension styles, title blocks, sheets (paper space)

## Later
- [ ] Materials library (physical + visual / rendering)
- [ ] Simulation / CAE (FEA, thermal, motion)
- [ ] CAM / fabrication (toolpaths / G-code, sheet-metal unfold, slicing)
- [ ] Real-time multi-user collaboration (comments, permissions, version branches)
