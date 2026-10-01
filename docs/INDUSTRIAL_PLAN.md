# Industrial (factory builder) plan

Target users: companies that design and build **factories and industrial halls** — steel portal
frames, crane runways, foundations, process equipment and piping, delivered as fabrication-ready
quantities and drawings. Inspired by Tekla Structures / Advance Steel (steel members, profile
catalogue, tonnage), pre-engineered-building software (portal frame generators), AutoCAD Plant 3D
(equipment, pipe runs, clash detection) and Revit (elevations / sections from the model).

Builds on the construction module ([`CONSTRUCTION.md`](CONSTRUCTION.md)): same constructive building
model, same "one command = UI + MCP" law, new element categories evaluated into ordinary entities
(exact cross-sections as watertight meshes).

## Steps

Each step ships with unit tests and is covered by the Playwright suite.

- [x] **I1 — Steel profile catalogue.** European sections IPE, HEA, HEB, UPN, SHS, RHS, CHS, L with
      dimensions, area, mass per metre; `list_steel_profiles`.
- [x] **I2 — Steel members.** `add_steel_member` (column / beam / rafter / brace / purlin / rail) with a
      catalogue profile between two 3D points, roll angle; exact section mesh; `update_steel_member`.
- [x] **I3 — Portal frame hall generator.** `add_portal_frame_building`: span, length, bay spacing, eave
      height, roof pitch, column / rafter profiles, purlins and side rails, roof & wall bracing,
      pad footings, roof and wall cladding — a complete pre-engineered hall in one undoable step.
- [x] **I4 — Foundations & cladding.** `add_footing` (pad footing, auto under columns), `add_panel`
      (planar cladding / sheeting / sandwich panel on any plane, e.g. a pitched roof).
- [x] **I5 — Crane runway.** `add_crane_runway`: rail beams on column brackets, crane capacity and
      rail height recorded for schedules.
- [x] **I6 — Process equipment & piping.** `add_equipment` (machines with a maintenance clearance
      zone), `add_pipe_run` (3D polyline, diameter, service / fluid).
- [x] **I7 — Clash detection.** `check_clashes`: hard clashes between structure, equipment and pipes,
      and clearance-zone violations, with element ids and overlap sizes.
- [x] **I8 — Steel takeoff & fabrication lists.** Steel tonnage by profile, member cut list (lengths),
      paint surface; integrated into `quantity_takeoff`, `building_schedule` and `estimate_cost`;
      IFC export of members (IfcColumn / IfcBeam / IfcMember with I-shape profiles), footings,
      equipment and pipes.
- [x] **I9 — Elevations & sections.** `export_elevation_sheet` (north / south / east / west and
      cut sections) — hidden-line drawings projected from the 3D model on a scaled sheet with title
      block.
- [x] **I10 — UI + verification.** Industrial tools in the Building panel (hall generator, member,
      equipment, pipe, clash check, steel list, elevations), Playwright workflow tests, docs and MCP
      prompt.

## Phase 2 — closing the remaining gaps

- [x] **I11 — Section poché.** Cut faces in `export_elevation_sheet` sections are filled: steel
      solid black, concrete / masonry hatched, other materials grey (as in Revit / Tekla sections).
- [x] **I12 — Multi-span halls.** `add_portal_frame_building` `spans: [...]` — several spans side by
      side with internal columns on shared column lines, valley gutters between the roofs.
- [x] **I13 — Cable trays.** `add_cable_tray` (3D route, width, height, system), clash detection,
      takeoff (m by system), plan symbol, IFC `IfcCableCarrierSegment`.
- [x] **I14 — Steel connections.** `add_base_plates`: base plates with anchor bolts under every steel
      column foot; plate steel mass and bolt counts in the takeoff; IFC `IfcPlate` /
      `IfcMechanicalFastener`.
- [ ] **I15 — DXF hatches.** Cut walls, concrete columns and steel sections in `export_dxf` plans
      get ANSI31 / solid hatch patterns (R12-compatible LINE / SOLID entities on `*-PATT` layers).
- [ ] **I16 — Curved walls.** `add_curved_wall` (arc through start / mid / end): evaluation, plan,
      quantities, DXF arcs and IFC.
