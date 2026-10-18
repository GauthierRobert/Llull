# Gap 02 RTE — Spec-driven pipe routing: functional specification

Status: written 2026-10-18, nothing built yet. Authoring rules: [`../TEMPLATE.md`](../TEMPLATE.md) and
[`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md). Operator model:
[`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) (`AF-nn`). Validation:
[`validation/README.md`](validation/README.md).

## 1. Summary

Today a pipe in llull is a 3D polyline with a nominal size: `add_pipe_run` sweeps a circle along the points and
puts a sphere at every interior vertex (`packages/domain-aec/src/industrial/equipment/equipment.ts`,
`packages/domain-aec/src/industrial/evaluate.ts` `evaluatePipe`). There are no ports on equipment, no pipe
specification, no elbows, tees, reducers, flanges, gaskets, bolts or valves, no cut lengths, no connectivity
and no check that a line actually connects what it says it connects. The `from` / `to` fields are free text.

This gap turns a pipe into what AutoCAD Plant 3D, AVEVA E3D, Smart 3D and CADMATIC call a **spec-driven run**.
A run starts and ends on **ports** (equipment nozzles, tie-in points, open ends of other runs). It is drawn leg by
leg with a **compass** (direction + length, orthogonal by default). Every fitting comes from the line's **pipe
spec** (gap 01): elbows at turns, tees or olets at branches (from the spec's **branch table**), reducers at size
changes, and a **flange set** (mating flange, gasket, bolt set) at every flanged joint. Pipe is **cut back** at
every fitting so the cut lengths are right. Lines carry **line numbers**, service, design conditions,
**insulation** and **heat tracing**. A read-only **routing check** finds open ends, mismatched sizes, ratings and
end types, legs too short for their fittings, angles the spec cannot make, adverse slopes and unreachable valve
handwheels. Moving equipment **stretches** the connected runs. Automatic routing (A* / maze) is planned for V2.

Without this gap there is nothing for isometrics (05), stress (07), line lists (08) or a realistic plant review
(09) to work from. Every plant deliverable starts from a connected, spec-driven run.

## 2. Plant context and value

| Task | Who does it today, with which tool | What llull adds |
| ---- | ---------------------------------- | --------------- |
| Route a pump discharge line to a vessel nozzle | Piping designer in Plant 3D / E3D / Smart 3D / CADMATIC, clicking a compass from nozzle to nozzle [S1][S20][S21] | The same route as a CLI plan (`route_pipe` legs), checked and reproducible, written by an agent |
| Pick the right fittings | The spec drives part selection; the designer only picks routing points [S1][S21] | Same rule: no component exists unless the line's spec lists it (01 PSC) |
| Flange / gasket / bolt sets | Added automatically at flanged connections; errors when the spec lacks a gasket or bolt [S3][S4] | Same, with stable codes (`RTE_SPEC_NO_COMPONENT`, `RTE_NO_CONNECTION_RULE`) |
| Branch fittings | Branch table: header × branch → tee, reducing tee, olet [S2] | Same table, read from the spec; the choice is reported in `data` |
| Gravity drains, sloped lines | Slope set per run, fitting tolerance absorbs small deflections [S23] | Slope per line / leg in % or ratio, elbow tolerance from the spec, adverse-slope check |
| Validate the model | Plant 3D validation: disconnected ports, property mismatches [S25] | `check_piping` with codes, ids and remediation (AF-11, AF-20) |
| Hand-off to isometrics | PCF / IDF to ISOGEN [S26] | Connectivity graph and takeoff in `data`; PCF writer in 05 ISO |
| Brownfield edit: equipment moved | Designer stretches the connected lines by hand or with "move with connected" | Deterministic orthogonal stretch when equipment or a nozzle moves |

## 3. Personas and user stories

- **Operator: an AI agent driving the `llull` CLI** (AF-01..05). It reads a line list or a P&ID (04 PID), writes
  one `build_project` plan per line (ports, `create_pipeline`, `route_pipe`, inline valves, branches), runs
  `llull run plan.json --validate`, then the plan, then `check_piping`, and reports from `data`.
- **Owner: not an engineer** (a plant owner, a process engineer who is not a piping designer, a student). Asks
  "connect the pump to the drum with a 4-inch line and a valve". Needs a sentence on what was built, what passed,
  and what needs a human: "4 elbows, 1 gate valve, 4 flange sets, 10.6 m of pipe; spec CS150 is a stub, not
  approved; stress not checked".
- **Qualified reviewer: a piping engineer / lead piping designer**. Approves the spec (01), the stress and
  flexibility (07) and anything that could support a safety decision (pressure boundary, personnel protection,
  operability). In this gap the reviewer sees `reviewRequired` on heat-loss results, on lines built from an
  unapproved spec and on stub-ins needing reinforcement checks (AF-33).

User stories:

1. As an agent, I give two nozzle ports and four compass legs and get a connected DN100 line with four LR elbows,
   two flange sets and five cut pipe pieces, so the owner can see a buildable line (FR-RTE-03..06, 09, 15).
2. As an agent, I put a gate valve at 800 mm on the first leg; the pipe splits, two flange sets appear, and the
   check warns that the handwheel is above the project's reach limit (FR-RTE-07, 18).
3. As an agent, I branch a DN100 and a DN50 off a DN150 header; the spec branch table picks a reducing tee and a
   weldolet; the open DN50 end is reported (FR-RTE-08, 13).
4. As an agent, I route a drain at 1 % fall; the 89.43° turn takes a standard 90° elbow inside the spec tolerance;
   a 60° turn on a 90/45-only spec is refused with `RTE_NO_FITTING_FOR_ANGLE` (FR-RTE-05, 10).
5. As an owner, I move the vessel 500 mm and the line follows without me redrawing it (FR-RTE-14).
6. As an agent, I set "hot, insulated 50 mm" on a line; clash detection uses the insulated diameter and the
   line number shows the insulation code (FR-RTE-02, 16).
7. As a reviewer, I see every line whose spec is a stub or unverified, and every result that claims a heat loss or
   a reinforcement need, flagged for my review (FR-RTE-26).

## 4. Scope

| Phase | Content |
| ----- | ------- |
| **MVP** | Ports (tie-in points here, nozzles from 03 through one port contract); pipelines with line numbers; `route_pipe` by compass legs / via points / closing leg; spec-driven elbows (90/45, tolerance), flange sets, butt-weld and flanged joints, inline valves and reducers; branch table (tee, reducing tee, olet); cut-back and takeoff; connectivity graph; `check_piping` (open ends, mismatches, too-short legs, angles, weld spacing, slope); stretch on equipment move; conversion of legacy `add_pipe_run`; 3D geometry of all components |
| V1 | Sloped lines with pockets / high-point and low-point checks; socket-weld and threaded engagement; eccentric reducers with flat side; trimmed elbows and pulled bends (bend radius, tangent lengths); stub-in reinforcement flag hand-off to 07; insulation thickness tables and insulated envelope in clash and supports; heat tracing data and `line_heat_loss`; valve operators (handwheel, gear, actuator) with access envelope and reach check; move / copy of whole runs; delete-and-heal; spec change of a line with re-selection of components |
| V2 | Automatic routing: A* / maze on an orthogonal grid with bend cost, obstacles from the model, rack preference, keep-out zones; route optimisation of length + bends + supports; multi-line rack routing order; spec-driven jacketed piping |
| Out of scope | Spec / catalogue authoring (01 PSC); nozzle placement and equipment geometry (03 EQP); P&ID (04 PID); isometrics, PCF, spools, weld numbers (05 ISO); stress and flexibility (07 PST); line lists and IFC export (08 DAT); plant-scale rendering (09 VIS); point-cloud routing (10 SCN); heat-tracing circuit electrical design (IEEE 515 [S34], qualified engineer) |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source | AF |
| -- | --- | ----------- | --------- | ------ | -- |
| FR-RTE-01 | MUST | One **port** model for everything a pipe can connect to: equipment nozzles (03), tie-in / battery-limit points, inline component ends and open run ends. A port has a position, an outward direction (toward the pipe), DN, rating, facing and end type (BW, FL, SW, SC…). | Port-to-port routing; connectivity | [S1][S20] | AF-01 |
| FR-RTE-02 | MUST | **Pipelines** are data: line number from a project template (default `DN-service-sequence-spec[-insulation]`, named in the result), service, spec, DN, design pressure / temperature, insulation, tracing, from / to. Line numbers are unique; renaming a line updates every run. | Line designation, line list (08) | [S1] | AF-31 |
| FR-RTE-03 | MUST | **Route** a run from a port or point to a port or point by compass legs (axis or vector + length), by via points, or by a closing leg; orthogonal by default; a leg that does not reach the target port is closed automatically when one straight leg can do it. | Plant 3D compass routing | [S1] | AF-05 |
| FR-RTE-04 | MUST | Every component of a run is selected from the line's spec (01) by type, size, rating, facing and end type. Nothing is invented. A missing component refuses the route with `RTE_SPEC_NO_COMPONENT` and names what is missing. | Spec-driven design | [S3][S21] | AF-11, AF-30 |
| FR-RTE-05 | MUST | **Elbows** are inserted at every direction change whose angle the spec offers (90°, 45°…) within the spec's tolerance angle; any other angle is refused (`RTE_NO_FITTING_FOR_ANGLE`) unless the spec allows trimmed elbows or bends (V1, flagged non-standard). Centre-to-end comes from the catalogue, never from a formula. | Compass ticks = fitting angles; B16.9 45° B is a table value | [S1][S7][S8] | AF-30 |
| FR-RTE-06 | MUST | At every flanged joint (port or inline component) a **flange set** is added: mating flange, gasket and bolt set from the spec, using the spec's connection rule for the end-type pair. No rule → `RTE_NO_CONNECTION_RULE`. | Automatic flange / gasket / bolt insertion | [S3][S4] | AF-30 |
| FR-RTE-07 | MUST | **Inline components** (valves, strainers, spectacle blinds, reducers, instruments' flanged bodies) are inserted on a leg at a given centre distance or point; the pipe is split, joints and flange sets are added; the component can be moved along its leg. | Valves on lines | [S1] | AF-01 |
| FR-RTE-08 | MUST | **Branches** take their fitting from the spec's branch table (header DN × branch DN → tee, reducing tee, olet, stub-in). The choice and the table row are returned. A stub-in is flagged `reviewRequired` (reinforcement per ASME B31.3 to be checked in 07). | Branch tables | [S2][S34] | AF-33 |
| FR-RTE-09 | MUST | **Cut-back**: each pipe piece's cut length = leg length − centre-to-end (or flange length through hub) at each end − gaskets − weld gaps − socket engagement. A negative cut refuses the route (`RTE_SEGMENT_TOO_SHORT`); a zero cut is a fitting-to-fitting joint (warning). | Fabrication-correct lengths | [S7][S14][S18] | AF-21 |
| FR-RTE-10 | MUST | **Slope** per line or leg, as percent, ratio or degrees, with the fall direction. Turns stay standard elbows inside the tolerance angle. `check_piping` reports adverse slope (`RTE_ADVERSE_SLOPE`) and, in V1, pockets. | Gravity lines | [S23] | AF-04 |
| FR-RTE-11 | MUST | **Size changes** on a run insert a reducer from the spec (concentric by default; eccentric with flat side top / bottom in V1). A port of another size without a spec reducer is refused (`RTE_SIZE_MISMATCH`). | Reducers | [S4] | AF-11 |
| FR-RTE-12 | MUST | A **connectivity graph** per line and per plant: nodes = ports and joints, edges = pipe pieces and components; queried by `piping_connectivity` (open ends, connected equipment, path between two ports). | Validation, isometrics, stress hand-off | [S20][S26] | AF-10 |
| FR-RTE-13 | MUST | `check_piping` (read-only) returns pass / warn / fail with codes for: open end, disconnected port, size / rating / facing / end-type mismatch, spec mismatch across a joint, too-short leg, fitting-to-fitting, weld spacing below the named rule, angle not in spec, adverse slope, duplicate line number, from/to not matching the connected equipment, valve operator above the reach limit, unverified spec. | Agent self-check | [S25] | AF-20, AF-11 |
| FR-RTE-14 | MUST | **Editing** keeps runs connected: stretch a leg, move a PI, move a component along its leg; when equipment or a nozzle moves, connected runs are stretched orthogonally (displacement absorbed by parallel legs walking back from the port); if no orthogonal stretch exists, the run is marked broken (`RTE_STRETCH_FAILED`) instead of being bent silently. | Move with connected | [S1] | AF-13 |
| FR-RTE-15 | MUST | **Takeoff** per run and line: counts per component type and size, pipe pieces with cut lengths, butt welds, flanged joints, studs; stable shape for 05 ISO and 08 DAT. | BOM, cut list | [S26] | AF-10 |
| FR-RTE-16 | SHOULD | **Insulation**: code and thickness per line, from the spec's thickness table by DN and design temperature or given explicitly; the insulated envelope is used by `check_clashes` and reported in the takeoff (length, outer area). | Clash with insulation, insulation BOM | [S34] ASTM C585, ISO 12241 | AF-31 |
| FR-RTE-17 | SHOULD | **Heat tracing** data per line: type (electric / steam), number of tracers, allowances per valve / flange / support as project data; traced length in the takeoff. Electrical design stays with the qualified engineer. | Tracing lists | [S34] IEEE 515 | AF-33 |
| FR-RTE-18 | SHOULD | **Valve operators**: handwheel / lever / gear / actuator envelope from the catalogue, stem orientation; `check_piping` reports operator clashes and handwheel centre above a reach limit that is either given or taken from a named project table. | Operability | [S24] | AF-31 |
| FR-RTE-19 | MUST | `convert_pipe_run` turns a legacy `add_pipe_run` polyline into a spec-driven run (vertices → PIs, bends → elbows), keeping the line number; untranslatable angles are reported, not changed. | Migration | — | AF-13 |
| FR-RTE-20 | SHOULD | 3D geometry for every component (pipe, torus elbow, tee, reducer cone, flanges with bolt holes, valve body + operator, insulation as a translucent outer shell), coloured by service (colour rules in 09 VIS). | Visual review (AF-22) | — | AF-22 |
| FR-RTE-21 | MUST | Line list feed: every line exposes its designation fields and from / to ports so 08 DAT can build the line list and 04 PID can compare it with the P&ID. | Data consistency | — | AF-10 |
| FR-RTE-22 | COULD | `auto_route_pipe` (V2): grid A* / maze routing between two ports with bend cost, obstacles from the model, preferred elevations / racks and keep-out zones; result is an ordinary editable run. | Productivity | [S27]-[S33] | AF-40 |
| FR-RTE-23 | SHOULD | `line_heat_loss` (V1): steady heat loss per metre of an insulated line (series cylinder resistances); `reviewRequired: true`. | Insulation sizing support | [S19][S34] | AF-33, AF-35 |
| FR-RTE-24 | MUST | Every numeric param states its unit (mm or document units, degrees, %, °C, bar g); every refusal has an `RTE_*` code, ids, paths and a remediation; same plan → same ids and values. | Agent-first | — | AF-04, AF-11, AF-13 |
| FR-RTE-25 | SHOULD | Exports through the graph: PCF (05 ISO) and IFC `IfcPipeSegment` / `IfcPipeFitting` / `IfcValve` / `IfcFlowController` with ports (08 DAT). | Interop | [S26] | AF-10 |
| FR-RTE-26 | MUST | A run built on an unapproved or stub spec, or on catalogue rows marked unverified, carries `unverified: true` in every result computed from it; `check_piping` reports `RTE_SPEC_UNVERIFIED` as a warning that cannot be hidden. Stress and flexibility are never claimed (07). | Safety boundary | — | AF-32, AF-33 |

## 6. Workflows

### 6.1 CLI (primary, complete)

```bash
llull search "route pipe"                      # finds create_pipeline, route_pipe, add_branch, check_piping …
llull describe route_pipe                      # units, refusal codes, what to call next
llull load_pipe_spec @CS150.json               # 01 PSC (a plan step cannot read a file)
llull run sc-rte-01-pump-to-vessel.json --validate   # params + aliases checked before any geometry
llull run sc-rte-01-pump-to-vessel.json --json       # data.aliases: pump, pumpOut, vessel, vesselIn, line, run
llull check_piping --json                      # status pass | warn | fail, issues[{code, ids, paths, remediation}]
llull piping_takeoff runId=run-1 --json        # counts, pipePieces[{cutLengthMm}], welds
llull render_view --save line.png              # look at what was built (AF-22)
```

The agent finishes every job with `check_piping` and a plain-language summary (AF-36): what was built, what
passed, what needs a human (unverified spec, stress not checked, review flags).

### 6.2 MCP

Same commands in a `piping` toolset (today `add_pipe_run`, `add_pipe_support`, `add_cable_tray`,
`check_pipe_supports`, `pipe_hydraulics`; `packages/mcp/src/toolsets.ts` `PIPING_TOOLS`). The MCP prompt for the
toolset gains a routing section (AF-03): axes (+Z up, plan x / y), port direction convention (outward, toward
the pipe), the minimal correct plan (SC-RTE-01).

### 6.3 UI (review and approval)

The desktop app shows runs with their components, open-end markers, issue markers from `check_piping` and
the line list. A designer may route interactively with a compass that emits the same `route_pipe` legs; nothing
in the UI edits geometry outside a command (L1). The reviewer approves the spec (01) and accepts flagged
results; approvals are human gates (AF-34).

## 7. Acceptance criteria

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-01 | pump nozzle DN100 CL150 RF at (0,0,1000) facing +Z, vessel nozzle at (6000,3000,4000) facing −X, spec CS150 | `route_pipe` with legs +Z 1500, +Y 3000, +X 3000, +Z 1500 | 5 legs (closing leg +X 3000); 4 LR elbows, 2 WN flanges, 2 gaskets, 2 bolt sets (16 studs), 10 butt welds; cuts 1269 / 2696 / 2696 / 1196 / 2769 mm ± 0.01 | VC-RTE-01, 02 |
| AC-02 | the same run | `piping_takeoff` | centreline length 11 739.044 mm ± 0.01 (4 arcs π/2 · 152) | VC-RTE-03 |
| AC-03 | the same run | gate valve inserted at 800 mm on leg 0 | 4 flange sets, 6 pipe pieces, leg-0 cuts 527.5 and 354.5 mm | VC-RTE-04 |
| AC-04 | the valve's handwheel centre at 1800 mm, limit 1500 mm given | `check_piping` | `RTE_VALVE_OPERATOR_HEIGHT` with the valve id, status warn | VC-RTE-05 |
| AC-05 | DN150 header, DN100 and DN50 branches | `add_branch` | reducing tee 6×4 and weldolet 6×2 chosen from the branch table; header cuts 3857 / 5857, branch 1870 | VC-RTE-06 |
| AC-06 | the DN50 branch has a free end | `check_piping` | exactly one `RTE_OPEN_END` | VC-RTE-07 |
| AC-07 | DN50 drain at 1 % over 8000 mm plan length | `route_pipe` | drop 80 mm, slope 0.572939°, turn 89.427061°, standard 90° elbow; with tolerance 0.5° → `RTE_NO_FITTING_FOR_ANGLE` | VC-RTE-08 |
| AC-08 | DN100 line, nozzles DN80 / CL300 / SW | `route_pipe` | `RTE_SIZE_MISMATCH`, `RTE_RATING_MISMATCH`, `RTE_NO_CONNECTION_RULE`, document unchanged | VC-RTE-09 |
| AC-09 | legs 250 / 304 / 340 mm between two NPS 4 LR elbows | `route_pipe`, `check_piping` | refused (cut −54); fitting-to-fitting warning; weld-spacing warning naming the 50 mm project default | VC-RTE-10 |
| AC-10 | a 60° turn on a 90 / 45 spec | `route_pipe` | `RTE_NO_FITTING_FOR_ANGLE`, `detail.angleDeg` 60 | VC-RTE-11 |
| AC-11 | SC-RTE-01 built | vessel moved +500 X, then +500 Y | cuts become … / 3269, then 1269 / 3196 / 2696 / 1196 / 3269; still 4 elbows | VC-RTE-12 |
| AC-12 | hot DN80 line with insulation H from the spec table | `create_pipeline`, `check_clashes` | thickness 50, line number `80-HO-4001-CS150-H50`, envelope 188.9 mm, one insulation clash with a beam that clears the bare pipe | VC-RTE-13 |
| AC-13 | the same line, 180 °C fluid, 28 °C air | `line_heat_loss` (V1) | 73.12 W/m ± 1e-4 rel, `reviewRequired: true` | VC-RTE-14 |
| AC-14 | legacy `add_pipe_run` DN100 with two 90° bends | `convert_pipe_run` | 2 elbows, cuts 3848 / 2696 / 2348, 2 open ends, line number kept | VC-RTE-20 |
| AC-15 | the same plan run twice | compare `--json` outputs | identical ids, values and order | VC-RTE-17 |

## 8. Standards and practice alignment

- **ASME B31.3 Process Piping** [S34]: the code governing process piping design. This gap does not compute
  pressure design or stress. It provides the geometry and topology that B31.3 checks need (07 PST), flags
  stub-in branches for reinforcement, and uses the B31.3 socket-weld gap note as a documented default [S18].
  B31.3 sets no minimum distance between butt welds [S22], so weld spacing is a named project rule.
- **ASME B16.9 / B16.5 / B16.10 / B16.20-21 / B36.10M** [S34]: dimensions of fittings, flanges, valves, gaskets and
  pipe. Owned by the catalogue (01 PSC); this gap consumes centre-to-end, length-through-hub, face-to-face and
  gasket thickness from it.
- **EN 13480 / EN 10253 / EN 1092-1**: metric equivalents, through the same spec interface (01).
- **ASTM C585, ISO 12241, IEEE 515** [S34]: insulation dimensions, heat-loss calculation rules, electrical trace
  heating. Used for data shape and for the closed-form heat loss; thickness tables are project data.
- **Vendor practice** (Plant 3D, E3D, Smart 3D, CADMATIC) [S1]-[S4][S20][S21][S25]: port-to-port compass routing,
  spec-driven part selection, automatic flange sets, branch tables, validation of disconnected ports. Matched in
  behaviour, not copied in UI.

## 9. KPIs

| KPI | Target |
| --- | ------ |
| Plans of this pack that run and match `expected` | 9 / 9 when the MVP lands (SC-RTE-08 is V2) |
| Cut-length error against the closed form | ≤ 0.01 mm |
| Fitting counts against the closed topology | exact |
| Routing of a 10-leg line (`route_pipe`, no kernel) | ≤ 50 ms |
| `check_piping` on 1 000 lines / 20 000 components | ≤ 2 s |
| Refusals with a stable code and remediation | 100 % of `RTE_*` paths (VC-RTE-09..11) |
| Agent turns to build and check the pump-to-vessel line from a prose request | 1 plan + 1 check |

## 10. Risks and assumptions

| Risk / assumption | Mitigation |
| ----------------- | ---------- |
| 01 PSC spec format not final | Routing reads the spec through a narrow port (`SpecLookup`, TECHNICAL §3); the stub in `validation/data/spec_stub_cs150.json` defines the minimum it needs |
| 03 EQP nozzles not built | Tie-in points give ports in MVP; nozzles plug into the same `Port` contract |
| Catalogue values differ by source (WN flange Y 76 vs 74.7) | Expectations derive from the spec values the plan loads; only ≥ 2-source rows are gates |
| Agents route through steel or other lines | `check_clashes` already covers pipes; insulated envelopes added; V2 auto-route avoids obstacles |
| Over-automation: a wrong fitting silently chosen | Every choice is returned in `data` with the spec row; ambiguous spec rows refuse (`RTE_SPEC_AMBIGUOUS`) |
| Owners mistake a routed line for an approved design | Summary and `data` state "spec unapproved / stress not checked / review required" (AF-33) |
| Legacy pipes and supports | `add_pipe_run` stays; supports (`add_pipe_support`) attach to spec-driven runs through the same centreline interface |
| PCF samples could not be downloaded | Closed-form geometry gates; PCF round trip is a 05 ISO VC |

## 11. References

Source ids `[Sn]` are defined in [`validation/sources.md`](validation/sources.md). Main references:

- [R1] Autodesk, AutoCAD Plant 3D User Guide: About the Compass and Snaps; About Piping; About Placing Components and Valves — https://help.autodesk.com/cloudhelp/2023/ENU/Plant3D-UserGuide/ (accessed 2026-10) [S1]
- [R2] Autodesk, Plant 3D Spec Editor: About Branch Tables — https://help.autodesk.com/cloudhelp/2026/ENU/Plant3D-SpecEditor/files/GUID-7F6BEC75-9909-47D5-8BB3-67B956E22604.htm (accessed 2026-10) [S2]
- [R3] AVEVA, E3D Design reference: branches, heads / tails, p-points — https://help.aveva.com/AVEVA_Everything3D/2.1/DRMPGC/DRMPCM24.09.07.html (accessed 2026-10) [S20]
- [R4] Hexagon, Intergraph Smart 3D Piping: pipe features — https://docs.hexagonppm.com/r/en-US/Intergraph-Smart-3D-Piping/13.1/65730 (accessed 2026-10) [S21]
- [R5] ASME B31.3-2024 Process Piping; ASME B16.9-2024; ASME B16.5; ASME B16.10; ASME B36.10M — catalogue facts only [S34]
- [R6] ASTM C585-22; ISO 12241:2022 — https://www.iso.org/standard/74655.html; IEEE 515-2017 (accessed 2026-10) [S34]
- [R7] fluids 1.3.1 and ht 1.2.0, C. Bell, MIT — https://pypi.org/project/fluids/, https://pypi.org/project/ht/ (accessed 2026-10) [S5][S19]
- [R8] Lee 1961; Hart, Nilsson, Raphael 1968; Park & Storch 2002; Blanco et al. 2022 — [S27]-[S30]
