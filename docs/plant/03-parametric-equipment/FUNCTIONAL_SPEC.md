# Gap 03 EQP — Parametric process equipment: functional specification

Status: written 2026-10-18, nothing implemented yet. Authoring rules: [`../TEMPLATE.md`](../TEMPLATE.md) and
[`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md). Operator model:
[`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) (AF-nn). Companion:
[TECHNICAL_SPEC.md](TECHNICAL_SPEC.md). Validation: [validation/README.md](validation/README.md).

## 1. Summary

llull can place a piece of process equipment today only as a **footprint**: `add_equipment` draws a box, a vertical
cylinder or a horizontal cylinder with a height, a maintenance clearance and an operating weight typed in by hand
(`packages/domain-aec/src/industrial/equipment/`). There are no heads, no supports, no nozzles, no volumes, no code
thickness, no data sheet and no connection points for piping. A process plant model in AutoCAD Plant 3D, AVEVA E3D,
Hexagon Smart 3D or CADMATIC starts the other way round: the engineer picks an **equipment template** (vertical vessel,
horizontal drum, column, shell-and-tube exchanger, storage tank, pump), types the process / mechanical parameters,
and gets a correct 3D body with **nozzles** that the piping is then routed from.

This gap turns llull's equipment into **parametric, data-rich templates**:

- vessels and drums with ASME / DIN formed heads (2:1 ellipsoidal, torispherical F&D / Klöpper / Korbbogen,
  hemispherical, flat, conical), skirts, legs and saddles; columns with trays and platform clips;
- TEMA shell-and-tube exchangers from their three-letter designation, API 650 storage tanks with roofs and courses,
  centrifugal pumps from ISO 2858 / ASME B73.1 sizes;
- nozzles (size, rating, facing, projection, orientation angle, elevation or station) that are the **connection ports**
  of the routing gap 02 RTE;
- engineering numbers an agent can trust and explain: volumes (total and at a liquid level), weights (empty /
  operating / hydrotest), ASME VIII-1 UG-27 / UG-32 required thickness and MAWP, UG-99 test pressure, API 650
  one-foot-method course thicknesses, and an equipment data sheet.

Every value carries its method, inputs and sources; every code result is flagged `reviewRequired` because a pressure
vessel or a storage tank is safety-critical equipment that needs a qualified engineer and, for fabrication, a stamped
design.

## 2. Plant context and value

| Workflow | Who does it today, with what | What llull adds |
| -------- | ---------------------------- | --------------- |
| Equipment layout in FEED / detailed design | Plant 3D "Create Equipment" from parametric patterns, saved as `.peqs` templates; nozzles added with the Add Nozzle grip (top / bottom / radial / line; radius, angle, length fields) [R12]. E3D: EQUIPMENT elements built from primitives + catalogue nozzles, Design Templates [R13]. CADMATIC: GDL parametric components with connection nodes [R14]. CADWorx Equipment: palette of heads, shells, cones, skirts, body flanges [R15]. | The same templates as **registry commands**, scriptable in one `build_project` plan by an agent, with volumes, weights and checks in the same call |
| Vessel mechanical sizing | PV Elite, COMPRESS, CodeCalc (UG-27 / UG-32 / UG-99, MAWP) [R5]–[R7] | First-pass required thickness, MAWP and test pressure on the model's own dimensions, explained step by step; hand-off of the final design to those tools (V2) |
| Tank sizing | API 650 spreadsheets / TANK software | One-foot method per course with sourced allowables and minimums [R8]–[R10] |
| Pump layout | Vendor outline drawings; Plant 3D fixed pump shapes whose nozzle positions are pre-defined [R12] | ISO 2858 / B73.1 envelopes with the suction / discharge ports at the standard positions [R11] |
| Exchanger layout | Plant 3D / E3D exchanger shapes, HTRI / Aspen EDR datasheets | TEMA designation → correct heads, bundle-pull space, shell- and tube-side volumes, ports [R16] |
| Equipment list / data sheets | Excel, SmartPlant Instrumentation-like data managers | Data sheet generated from the model (JSON / CSV / sheet), same numbers as the 3D |
| Routing (02 RTE) and stress (07 PST) | Plant 3D connects pipes to nozzle ports; CAESAR II needs nozzle positions, directions and allowable loads | Stable port ids (`V-101:N1`) with position, direction, size, rating, facing |

Why this blocks plant use: without nozzles there is nothing to route from (02 RTE), nothing to put on a P&ID ↔ 3D
consistency check (04 PID), no equipment list (08 DAT), no nozzle load anchor (07 PST), and the 3D review (09 VIS)
shows boxes instead of vessels.

## 3. Personas and user stories

- **Operator: an AI agent driving the `llull` CLI** (AF-01..05). It reads a process brief or a P&ID line list,
  writes one plan (`add_vessel` → `add_nozzle` × n → `vessel_thickness` → `equipment_weights` → `check_equipment`),
  validates it with `llull run plan.json --validate`, runs it and reports with `--json`.
- **Owner: not an engineer** (a plant owner, a project developer, a process start-up founder). Asks "lay out the
  separator and the two pumps", wants a 3D model, a list of what was built and one sentence on what still needs an
  engineer. Never has to know what UG-27 is (AF-30, AF-36).
- **Qualified reviewer** — a pressure-vessel / mechanical engineer (and, for fabrication, the manufacturer's
  certified designer under ASME VIII-1 or EN 13445, or the tank designer under API 650). Reviews thickness, MAWP,
  test pressure, supports and nozzle loads; approves a data sheet revision (AF-33, AF-34). llull never claims a
  vessel is code-compliant: it says "computed by llull, not approved".

User stories:

1. As an agent, I create "a 1.5 m × 4 m vertical separator with 2:1 heads on a 2 m skirt, 10 barg, 150 °C" and get a
   3D vessel, its volume (7.952 m³) and a list of what is defaulted (FR-EQP-01..03, FR-EQP-09).
2. As an agent, I add four nozzles by size, rating, elevation and orientation angle and receive their port ids,
   positions and directions so the routing commands can connect to them (FR-EQP-08).
3. As an agent, I ask "is 10 mm enough?" and get the required thickness of shell and heads, the MAWP and the
   hydrotest pressure with the formulas and inputs used, flagged for review (FR-EQP-11).
4. As an owner, I ask "how heavy is it full of water for the test?" and get empty, operating and test weights with
   what is included (FR-EQP-10).
5. As an agent, I place a BEM exchanger by its TEMA type and get the bonnets, tubesheets, shell, saddles and the
   bundle-pull clearance, plus shell- and tube-side volumes (FR-EQP-06).
6. As an agent, I size an API 650 water tank course by course and see which courses are governed by the minimum
   thickness (FR-EQP-05, FR-EQP-12).
7. As an agent, I place "pump P-101A, ISO 2858 65-40-250" and its twin, with suction and discharge ports at the
   catalogue positions (FR-EQP-07).
8. As a reviewer, I open the data sheet of V-101, see every computed value with its source and the words "needs a
   qualified engineer", and approve the revision with my signature (FR-EQP-13, AF-34).
9. As an agent, I change the vessel diameter after a process revision; the element id and the nozzle port ids stay
   the same, so the connected pipes and the line list survive (FR-EQP-16).

## 4. Scope

| Phase | Content |
| ----- | ------- |
| **MVP** | Head library (2:1 and general ellipsoidal, torispherical with ASME F&D / 80-10 / DIN 28011 / DIN 28013 / custom f-k, hemispherical, flat, conical) with exact depth, volume, area; `add_vessel` (vertical / horizontal; skirt, legs, saddles); `add_column` (vertical vessel + tray stack + platform clip positions); `add_heat_exchanger` (TEMA letters, fixed-tubesheet and U-tube and floating-head envelopes); `add_storage_tank` (API 650, cone / dome / flat roof); `add_pump` (ISO 2858 / B73.1 envelopes from grade-A rows or explicit dimensions); `add_nozzle` / `update_nozzle` / `delete_nozzle` with ports; `update_equipment_parameters`; queries `vessel_volume`, `equipment_weights`, `vessel_thickness` (UG-27, UG-32, UG-99), `tank_shell_thickness` (one-foot), `equipment_ports`, `equipment_datasheet`; `check_equipment`; IFC proxy export with ports |
| V1 | Air coolers (bays, bundles, fans, plenums, header boxes) and compressor envelopes (explicit dimensions); exchanger tube layout (tube count, pitch, passes) and TEMA span check; kettle (K) shells; conical skirts and skirt openings; lifting lugs and trunnions (geometry); vessel boots and internal baffles; strapping tables (level ↔ volume, 1 mm steps) for all head types incl. horizontal torispherical; equipment templates saved / loaded by name (`.json` library, the `.peqs` analogue); centre of gravity; IFC4 typed entities (`IfcTank`, `IfcPump`, `IfcHeatExchanger`…) with `IfcDistributionPort`; nozzle orientation drawing (plan view of angles) and equipment GA sheet |
| V2 | Saddle (Zick), skirt, wind and seismic checks on columns; UG-37 nozzle reinforcement; API 650 variable-design-point method and roof / wind girder design; EN 13445-3 alternative formulas; hand-off to PV Elite / COMPRESS (neutral input file) and import of their results; agitated reactors with jackets, filters, fired heaters, packaged units from vendor STEP |
| Out of scope | Certified pressure-vessel design (stamped calculation packages), FEA of nozzles (05 CAE gap in aerospace may host it later), thermal / hydraulic rating of exchangers (HTRI / Aspen EDR), pump hydraulics and curves |

Sibling gaps referenced instead of re-specified: flanges, ratings, gaskets and pipe sizes come from
**01-piping-specs-catalog (PSC)**; pipes connect to the ports through **02-spec-driven-routing (RTE)**; equipment
symbols and tags on P&IDs and the P&ID ↔ 3D check are **04-pid-schematics (PID)**; nozzle loads are
**07-pipe-stress-flexibility (PST)**; platforms, ladders and davits around columns are
**06-plant-structures-access (STA)**; tag registry, equipment lists and IFC 4.3 are
**08-plant-data-reports-interop (DAT)**; colour coding, LOD and instancing are **09-plant-visualization-review (VIS)**.

## 5. Functional requirements

| Id | Priority | Requirement | Rationale | Source / AF |
| -- | -------- | ----------- | --------- | ----------- |
| FR-EQP-01 | MUST | Formed-head library: 2:1 and general ellipsoidal (ratio), torispherical by named standard (ASME F&D f=1 k=0.06, ASME 80/10, DIN 28011, DIN 28013) or custom crown / knuckle radius, hemispherical, flat, conical (half-angle). Each gives exact depth, volume, inside area and the revolve profile. | heads drive volume, weight, thickness and look | [R1], [R2], [R3]; AF-30 |
| FR-EQP-02 | MUST | `add_vessel`: vertical or horizontal vessel from inside diameter, tangent-to-tangent length, two heads, shell / head thickness, corrosion allowance, plan position and rotation; generated as exact solids of revolution; one equipment element with a unique tag. | the core template of every plant | [R12], [R13] |
| FR-EQP-03 | MUST | Supports: straight skirt (height, thickness, base ring), legs (count, height, pitch circle, section), saddles (stations, width, height to axis). Support base sits on the level; the tangent elevation follows. | supports set elevations and loads | [R12], [R15] |
| FR-EQP-04 | MUST | `add_column`: vertical vessel with a tray stack (count, spacing, first-tray elevation, type label), tray numbers, and platform-clip / davit positions exported for 06 STA. | towers are the tallest equipment and carry platforms | [R13] |
| FR-EQP-05 | MUST | `add_storage_tank` (API 650): diameter, shell height, course heights, roof (cone with slope, dome, flat), bottom (flat / cone), design liquid level and SG; body with courses, roof, bottom, top angle. | tank farms are a large share of plant equipment | [R8], [R9] |
| FR-EQP-06 | MUST | `add_heat_exchanger`: TEMA three-letter type (front A/B/C/N/D, shell E/F/G/H/J/K/X, rear L/M/N/P/S/T/U/W) → channels / bonnets, tubesheets, shell, floating-head cover or U-bend end, saddles, bundle-pull clearance zone; tube data (OD, wall or BWG, count, length, passes); invalid letters refused. | exchangers are the second most common item | [R16] |
| FR-EQP-07 | MUST | `add_pump`: horizontal end-suction pump from an ISO 2858 or ASME B73.1 size (grade-A table rows) or explicit envelope dimensions, with baseplate, coupling guard and driver box, API 610 type label (OH1, OH2, OH3, BB…, VS…), suction and discharge nozzles at the envelope positions. Untabulated size without dimensions refused; grade-B rows flagged `unverified`. | pump nozzles are routing start points | [R11]; AF-32 |
| FR-EQP-08 | MUST | `add_nozzle` / `update_nozzle` / `delete_nozzle`: mark, DN (or NPS), rating (PN / Class), facing (RF / FF / RTJ), service, location (shell: elevation or station + orientation angle; head: radial offset + angle; channel; pump), projection (axis-to-face for shell nozzles, tangent-to-face for head nozzles), optional angle off radial. Each nozzle is a **connection port** `<tag>:<mark>` with position, outward direction, size, rating and facing, consumed by 02 RTE. Flange geometry from 01 PSC; until present, a placeholder flange flagged `unverified`. | P&ID nozzles must exist in 3D | [R12], [R13] |
| FR-EQP-09 | MUST | `vessel_volume`: total internal volume and liquid volume at one or more levels (from the lowest point), for vertical and horizontal vessels with any MVP head, tanks, and the shell / tube sides of an exchanger; closed forms, no mesh. | process hold-up, level settings, test water | [R1], [R2] |
| FR-EQP-10 | MUST | `equipment_weights`: empty, operating (liquid SG and level), hydrotest (full of water) weights with a breakdown (shell, heads, supports, nozzles, internals, insulation if given) and the method of each line; centre of gravity in V1. | foundations, lifting, structure loads (existing floor-load path uses `weight`) | AF-35 |
| FR-EQP-11 | MUST | `vessel_thickness` (ASME VIII-1): UG-27(c)(1) circumferential and (c)(2) longitudinal shell thickness, UG-32 2:1 ellipsoidal / torispherical / hemispherical heads, in the corroded condition; MAWP of each part and of the vessel; UG-99(b) hydrotest pressure; applicability limits; allowable stress and joint efficiency never defaulted. | first-pass sizing on the model's own dimensions | [R4]–[R7]; AF-31 |
| FR-EQP-12 | MUST | `tank_shell_thickness` (API 650 one-foot method): td and tt per course, sourced Sd / St table rows, minimum nominal thickness by diameter, governing thickness; refused above 60 m diameter. | tank shells | [R8]–[R10] |
| FR-EQP-13 | MUST | `equipment_datasheet`: one record per equipment — identification, design data, geometry, nozzle schedule, volumes, weights, code results, provenance, review status — as JSON / CSV, and as a drawing sheet table (via the existing sheet commands). | data sheets are the contract between process, mechanical and vendor | AF-10, AF-35 |
| FR-EQP-14 | MUST | `check_equipment`: read-only pass / warn / fail list with stable codes: under-thickness, MAWP below design pressure, formula out of range, nozzle overlap, nozzle on a head knuckle or crossing a support, nozzle inside a skirt without opening, port facing into the shell, duplicate tags / marks, missing design data, unverified or unsourced data, clearance violations (existing `check_clashes` zone reused). | the agent ends every job with it | AF-20, AF-11 |
| FR-EQP-15 | MUST | Every catalogue or standard table (head proportions, pump envelopes, TEMA letters and tubes, API 650 stresses and minimums) is **data** with source and grade; grade < A rows produce `unverified` results that propagate into weights, data sheets and checks. | non-engineer owner; paywalled standards | AF-30, AF-32 |
| FR-EQP-16 | MUST | `update_equipment_parameters`: change any template parameter in place; element id, tag, nozzle marks and port ids are kept; nozzles keep their face positions where the convention allows, and connected pipes (02 RTE) are reported as needing re-route instead of being silently broken. | design revisions | L8, AF-13 |
| FR-EQP-17 | MUST | Refusals and check findings use stable `EQP_*` codes with ids / param paths and a one-line remediation; every query result is in `data` with units in field names. | AF-10, AF-11 |
| FR-EQP-18 | SHOULD | IFC export of equipment with its nozzles as distribution ports (MVP: `IfcBuildingElementProxy` + ports; V1: typed entities), consistent with 08 DAT. | BIM hand-off | [R17] |
| FR-EQP-19 | SHOULD | Equipment templates: save the parameter set of an equipment (with nozzles) under a name, list, and insert by name with overrides — the `.peqs` analogue, as plain JSON. | repeated equipment (pump pairs, identical drums) | [R12] |
| FR-EQP-20 | SHOULD | Exchanger tube layout (count for a bundle diameter, pitch and layout angle, passes) and TEMA maximum unsupported span check (V1). | bundle weight and baffle spacing | [R16] |
| FR-EQP-21 | SHOULD | Air coolers and compressors (V1) with explicit envelope dimensions and ports. | completes the Plant 3D template set | [R12] |
| FR-EQP-22 | SHOULD | Nozzle orientation view (plan of angles, elevations and projections) and an equipment GA sheet using the existing drawing / sheet commands (V1). | orientation drawings are the vessel vendor's input | — |
| FR-EQP-23 | COULD | Saddle, skirt, wind and seismic checks; UG-37 reinforcement; EN 13445 alternative (V2). | full mechanical design | [R18] |
| FR-EQP-24 | COULD | PV Elite / COMPRESS neutral-file hand-off and result import (V2). | certified design stays in certified tools | [R5], [R6] |

FR → VC map: FR-EQP-01 → VC-01..04; 02 → VC-03, 13, 14; 03 → VC-09 (legs), 13 (skirt), 14 (saddles); 04 → VC-21;
05 → VC-17; 06 → VC-11, 15; 07 → VC-10; 08 → VC-12, 13; 09 → VC-01, 02; 10 → VC-04, 09; 11 → VC-05..07; 12 → VC-08,
17; 13 → VC-13; 14 → VC-14, 16; 15 → VC-10, 16; 16 → VC-14, 19; 17 → VC-16; 18 → VC-20; 19 → VC-22; 20 → VC-18;
21 → VC-23; 22 → VC-24; 23, 24 → VC-25 (TBD, V2).

AF mapping: FR-EQP-02..09 → AF-01, AF-02, AF-04, AF-05; FR-EQP-09..13 → AF-10, AF-21, AF-35; FR-EQP-11/12 → AF-31,
AF-33; FR-EQP-14 → AF-20, AF-11; FR-EQP-15 → AF-30, AF-32; FR-EQP-16 → AF-13; data-sheet approval → AF-34 / AF-34a
(09 PLM signatures).

## 6. Workflows

### 6.1 CLI (primary)

```bash
llull search vessel                      # finds add_vessel, add_nozzle, vessel_thickness, check_equipment…
llull describe add_vessel                # units of every param, head types, support types, codes it can return
llull run plans/sc-eqp-01-vertical-vessel-skirt.json --validate   # params checked before any geometry
llull run plans/sc-eqp-01-vertical-vessel-skirt.json --json > v101.json
llull vessel_thickness '{"equipment":"V-101"}' --json
llull equipment_datasheet '{"equipment":"V-101","format":"csv"}' --save V-101.csv
llull render_view '{"view":"iso","ids":["$v101"]}' --save v101.png          # AF-22
```

A typical plan (abridged from SC-EQP-01):

```json
[
  { "command": "add_vessel", "params": { "tag": "V-101", "orientation": "vertical", "location": [5000, 5000],
    "insideDiameter": 1500, "tangentLength": 4000,
    "heads": { "top": { "type": "ellipsoidal", "ratio": 2 }, "bottom": { "type": "ellipsoidal", "ratio": 2 } },
    "shellThickness": 10, "headThickness": 10, "corrosionAllowance": 3,
    "support": { "type": "skirt", "height": 2000 },
    "design": { "pressure": { "value": 1.0, "unit": "MPa" }, "temperatureC": 150,
      "allowableStress": { "value": 137.9, "unit": "MPa", "source": "user input" }, "jointEfficiency": { "shell": 1, "heads": 1 } } },
    "as": "v101" },
  { "command": "add_nozzle", "params": { "equipment": "V-101", "mark": "N1", "dn": 150, "rating": "CL150", "facing": "RF",
    "location": { "on": "shell", "elevation": 3200, "orientationDeg": 0 }, "projection": 1000 } },
  { "command": "vessel_thickness", "params": { "equipment": "V-101" } },
  { "command": "check_equipment", "params": { "equipment": ["V-101"] } }
]
```

Then 02 RTE routes from `V-101:N1`; 07 PST reads the same port for nozzle loads.

### 6.2 MCP

Toolset `plant` (shared with 01 PSC / 02 RTE): the same commands. The `llull guide` / MCP prompt gains a "plant
equipment" section (AF-03): units (document units for lengths, MPa / bar / psi with explicit unit for pressures, °C),
the angle convention (0° = plant north, clockwise seen from above; horizontal vessels 0° = top), tag and port-id rules,
and the minimal plan above.

### 6.3 UI (review and approval)

- The command palette lists the equipment commands; the existing parameter dialog gathers params (`src/ui`).
- Viewport: vessels, exchangers, tanks and pumps render as solids; nozzles show their port arrow; selecting an
  equipment shows its data sheet in the properties panel.
- Review: a reviewer opens the data sheet, sees `reviewRequired` items with their formulas, and records an approval
  through the 09 PLM signature flow (AF-34). The UI never offers a capability the CLI lacks.

## 7. Acceptance criteria

| Given | When | Then | VC |
| ----- | ---- | ---- | -- |
| the 14 vertical-tank cases of Jones (D 132 in, a 33 in, ASME F&D) | `vessel_volume` at each level | volume equals the published / reference-code value within 1e-9 relative | VC-EQP-01 |
| 7 horizontal cases (ellipsoidal and conical heads, D 108 in, L 156 in, a 42 in) | `vessel_volume` | within 1e-9 relative | VC-EQP-02 |
| a D 1 m ASME F&D head | `add_vessel` + `vessel_volume` | depth 0.169338 m, volume 0.0809990 m³; OCC solid volume within 1e-6 | VC-EQP-03 |
| the UG-27 examples (P 100 psi / R 30 in / S 18 800; P 200 / D 46 / S 20 000 / E 0.85 / CA 0.125) | `vessel_thickness` | 0.160085 in and 0.398993 in (published 0.1601, 0.3990) | VC-EQP-05 |
| four UG-32 examples | `vessel_thickness` | 0.450563, 1.491699, 0.053127, 0.017709 in | VC-EQP-06 |
| P > 0.385 SE, or no allowable stress | `vessel_thickness` | `EQP_FORMULA_OUT_OF_RANGE` / `EQP_ALLOWABLE_MISSING` with the param path | VC-EQP-07 |
| D 7.7 m, H 10.2 m, G 0.895, Sd 137, St 154, CA 3 | `tank_shell_thickness` | td 5.4402 mm, tt 2.4255 mm | VC-EQP-08 |
| SC-EQP-01 | `equipment_weights` | empty 2633.47 kg, operating 5262.10 kg, test 10585.63 kg (1e-6) | VC-EQP-09 |
| size 65-40-250 / 99-99-999 | `add_pump` | shaft height 180, discharge face 225 above shaft / `EQP_PUMP_SIZE_UNKNOWN` | VC-EQP-10 |
| "BEM" / "BXZ" | `add_heat_exchanger` | B-E-M fixed tubesheet / `EQP_TEMA_INVALID` at `temaType.2` | VC-EQP-11 |
| nozzle N1 at 3200 mm, 0°, projection 1000 on V-101 | `equipment_ports` | port `V-101:N1` at [5000, 6000, 5200], direction [0, 1, 0] | VC-EQP-12 |
| the four scenario plans | `llull run --json` | every `expected[]` row within tolerance; exit code 0 except the deliberate refusal steps | VC-EQP-13/14/15/17 |
| any code result | any EQP query | `reviewRequired: true` with the standard named; grade-B data → `unverified: true` and a warning in `check_equipment` | VC-EQP-16 |
| a column ID 2000, T/T 15 000, 20 trays at 600 from 1500 / 30 trays | `add_column` | trays at 1500 … 12 900 mm / `EQP_TRAYS_DONT_FIT` at `trays.count` | VC-EQP-21 |
| V-101 diameter changed to 1800 mm | `update_equipment_parameters` | same element id and port ids, nozzle faces unchanged, volume 11.705574 m³ | VC-EQP-19 |

## 8. Standards and regulatory alignment

Public facts only; the standards are paywalled and were not read.

- **ASME BPVC Section VIII Division 1** (UG-16, UG-27, UG-32, UG-99) [R4]: formulas used are those reproduced by
  multiple public sources (validation/sources.md). Stamped design requires a certificate holder; llull only computes.
- **API Std 650** (welded tanks for oil storage, 13th ed.) [R8]: one-foot method (≤ 60 m), Table 5-2a allowables,
  5.6.1.1 minimum thickness.
- **ISO 2858** (end-suction centrifugal pumps, 16 bar: designation, nominal duty point, dimensions) [R11];
  **ASME B73.1** (horizontal end-suction centrifugal pumps for chemical process; dimensional interchangeability by
  designation); **API 610** (pump type classification OH / BB / VS).
- **TEMA Standards** (10th ed.) [R16]: type designation, tube sizes, clearances, spans.
- **DIN 28011 / DIN 28013** torispherical heads; **EN 13445-3** (V2 alternative to ASME).
- **IFC4 / IFC 4.3** (08 DAT) for the BIM hand-off.
- Pressure Equipment Directive 2014/68/EU and national rules make the design organisation responsible; this is why
  every result says "not approved" (AF-33) and approvals are human gates (AF-34).

## 9. KPIs / success metrics

- 100 % of VCs automated (unit tests + `validation/plans` replayed by `scenarioPlans.test.ts` and the production-gate
  agent driver, AF-23).
- An agent builds a vertical vessel with four nozzles, its thickness check and data sheet in ≤ 7 commands
  (SC-EQP-01 is 10 steps including the four queries).
- Each Plant 3D template family in scope (vertical vessel, horizontal drum, column, exchanger, tank, pump) has one
  command and one scenario plan by V1.
- Zero safety-relevant value defaulted silently (audit: every `defaulted: true` field has a `source`).
- A 200-equipment unit (≈ 1 000 nozzles) regenerates in ≤ 2 s and queries in ≤ 50 ms per equipment (TECHNICAL §8).

## 10. Risks and assumptions

- **Paywalled standards.** Only formulas and rows confirmed by ≥ 2 public sources gate. Tables are shipped as data
  with their grade; a user (or a licensed company library) can replace them with the licensed values.
- **Code misuse.** An owner may read "pass" as "safe". Mitigation: `reviewRequired` on every code number, plain
  summary "computed by llull, not approved — needs a qualified engineer", status `pass_with_review` (or `warn`) instead of `pass`.
- **Convention differences.** Sources differ on corroded radius (UG27-B vs UG27-C), angle origins (north vs east,
  clockwise vs counter-clockwise), projection origin (axis vs shell outside). llull fixes one convention, names it in
  every result, and offers explicit switches (`corrodedDimensions`, `angleConvention`) rather than guessing.
- **Flange geometry dependency on 01 PSC.** Until PSC lands, nozzles get a placeholder flange (neck OD from the
  existing DN table, flange OD flagged `unverified`).
- **Pump data scarcity.** Only five ISO 2858 rows and one B73.1 dimension are grade A; most pumps will be placed from
  vendor dimensions typed in or imported (flagged until two sources agree).
- **Weights are body weights.** Internals, nozzles, insulation, platforms are added only when modelled; the data
  sheet lists what is included.
- **Data model placement.** Extending the existing building `EquipmentElement` keeps clash, floor loads, schedules,
  plan drawings and IFC working, but couples plant equipment to levels (open question Q1 in the TECHNICAL_SPEC).

## 11. References

- [R1] Jones D., "Calculating Tank Volume", 2015 — http://www.webcalc.com.br/blog/Tank_Volume.PDF (accessed 2026-10 via the `fluids` package, see validation S1/S2).
- [R2] Bell C. and contributors, fluids 1.3.1 (MIT) — https://pypi.org/project/fluids/ (accessed 2026-10).
- [R3] Wikipedia, "Head (vessel)" — https://en.wikipedia.org/wiki/Head_(vessel) (accessed 2026-10).
- [R4] ASME Boiler and Pressure Vessel Code, Section VIII Division 1 — ASME — https://www.asme.org/codes-standards/find-codes-standards/bpvc-viii-1-bpvc-section-viii-rules-construction-pressure-vessels-division-1 (catalogue page, accessed 2026-10).
- [R5] Hexagon, CodeCalc Help, "Example Shell Analysis" — https://docs.hexagonppm.com/r/en-US/CodeCalc-Help/25/303400 (search extract, accessed 2026-10).
- [R6] Codeware, INSPECT API-510 sample report — https://www.codeware.com/inspect/docs/INSPECT-API510-Sample-Report.pdf (search extract, accessed 2026-10).
- [R7] checalc.com, "Pressure Vessel Design: Thickness, MAWP & Hydrotest" — https://checalc.com/vessel_guide.html (search extract, accessed 2026-10).
- [R8] API Std 650, Welded Tanks for Oil Storage — American Petroleum Institute — https://www.api.org (catalogue / errata pages, accessed 2026-10).
- [R9] epcland.com, API 650 one-foot method — https://epcland.com/?p=49206; midstreamcalculator.com, "API 650 Tank Design Fundamentals" (search extracts, accessed 2026-10).
- [R10] CPEAA journal, Politeknik Perkapalan Negeri Surabaya, tank design article 1520 — https://journal.ppns.ac.id/index.php/CPEAA/article/download/1520/1070 (search extract, accessed 2026-10).
- [R11] ISO 2858:1975, End-suction centrifugal pumps (rating 16 bar) — ISO — https://www.iso.org/standard/7862.html; ASME B73.1-2020 — https://webstore.ansi.org/standards/asme/asmeb732020 (catalogue pages, accessed 2026-10).
- [R12] Autodesk, AutoCAD Plant 3D User Guide: "Create Equipment", "About Equipment", "About Equipment Shapes", "Add or Modify Nozzles (Change Location)" — https://help.autodesk.com/cloudhelp/2026/ENU/Plant3D-UserGuide/files/create_equipment_to.htm (and sibling pages; accessed 2026-10).
- [R13] AVEVA, E3D Design documentation: Design Templates, equipment and nozzles — https://help.aveva.com/AVEVA_Everything3D/2.1/DTI/DTI4.4.6.html (accessed 2026-10).
- [R14] CADMATIC, Plant "Component Modeller" — https://docs.cadmatic.com/plant/Content/Component%20Modeller/componentmodeller.htm (accessed 2026-10).
- [R15] Hexagon, CADWorx Equipment "Equipment Palette" — https://docs.hexagonppm.com/r/en-US/CADWorx-Equipment/22/357265 (accessed 2026-10).
- [R16] Tubular Exchanger Manufacturers Association, TEMA Standards — https://tema.org; tables as tabulated in ht 1.2.0 (MIT) — https://pypi.org/project/ht/ (accessed 2026-10).
- [R17] buildingSMART International, IFC4 ADD2 TC1 — https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/ (not fetched; entity names to confirm).
- [R18] Zick L. P., "Stresses in large horizontal cylindrical pressure vessels on two saddle supports", Welding Journal Research Supplement, 1951 (cited, not fetched).
