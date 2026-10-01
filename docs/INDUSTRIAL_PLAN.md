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

- [ ] **I1 — Steel profile catalogue.** European sections IPE, HEA, HEB, UPN, SHS, RHS, CHS, L with
      dimensions, area, mass per metre; `list_steel_profiles`.
- [ ] **I2 — Steel members.** `add_steel_member` (column / beam / rafter / brace / purlin / rail) with a
      catalogue profile between two 3D points, roll angle; exact section mesh; `update_steel_member`.
- [ ] **I3 — Portal frame hall generator.** `add_portal_frame_building`: span, length, bay spacing, eave
      height, roof pitch, column / rafter profiles, purlins and side rails, roof & wall bracing,
      pad footings, roof and wall cladding — a complete pre-engineered hall in one undoable step.
- [ ] **I4 — Foundations & cladding.** `add_footing` (pad footing, auto under columns), `add_panel`
      (planar cladding / sheeting / sandwich panel on any plane, e.g. a pitched roof).
- [ ] **I5 — Crane runway.** `add_crane_runway`: rail beams on column brackets, crane capacity and
      hook height recorded for schedules.
- [ ] **I6 — Process equipment & piping.** `add_equipment` (machines with a maintenance clearance
      zone), `add_pipe_run` (3D polyline, diameter, service / fluid), cable trays.
- [ ] **I7 — Clash detection.** `check_clashes`: hard clashes between structure, equipment and pipes,
      and clearance-zone violations, with element ids and overlap sizes.
- [ ] **I8 — Steel takeoff & fabrication lists.** Steel tonnage by profile, member cut list (lengths),
      paint surface; integrated into `quantity_takeoff`, `building_schedule` and `estimate_cost`;
      IFC export of members (IfcColumn / IfcBeam / IfcMember with I-shape profiles), footings,
      equipment and pipes.
- [ ] **I9 — Elevations & sections.** `export_elevation_sheet` (north / south / east / west and
      cut sections) — hidden-line drawings projected from the 3D model on a scaled sheet with title
      block.
- [ ] **I10 — UI + verification.** Industrial tools in the Building panel (hall generator, member,
      equipment, pipe, clash check, steel list, elevations), Playwright workflow tests, docs and MCP
      prompt.
