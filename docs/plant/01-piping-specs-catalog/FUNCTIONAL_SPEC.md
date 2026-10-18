# Gap 01 PSC — Piping specifications and component catalogue: functional specification

Status: written 2026-10-18, specification only (nothing implemented). Authoring rules: [`../TEMPLATE.md`](../TEMPLATE.md),
[`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md). Operator model:
[`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) (`AF-nn`). Validation:
[`validation/README.md`](validation/README.md).

## 1. Summary

In llull today a pipe is a 3D polyline with a service name, a line number and a nominal size DN (`add_pipe_run`,
`packages/domain-aec/src/industrial/equipment/equipment.ts`). The outside diameter comes from a 19-row table that mixes
EN 10220 diameters with ASME B36.10M standard walls (`industrial/piping/pipeSizes.ts`). There is no schedule, no
material class, no pressure rating, no fitting, flange, gasket, bolt or valve, and no rule that says which component
a line of a given service and size must use. Every plant design tool in this class (AutoCAD Plant 3D, AVEVA E3D,
Hexagon Smart 3D, CADMATIC) is **spec-driven**: the designer picks a pipe class ("CS150-A1": carbon steel, Class 150
raised-face flanges, 3 mm corrosion allowance) and the tool takes every pipe, elbow, tee, reducer, flange, gasket,
bolt set and valve from that class's spec sheet, sized from a dimensional catalogue that follows the ASME / EN standards.
Without specs, nothing downstream works: routing cannot place fittings (02 RTE), isometrics have no bill of materials
(05 ISO), stress analysis has no section properties or SIFs (07 PST), reports have no commodity codes (08 DAT), and
colour coding has no class (09 VIS).

This gap adds to llull:

1. a **component catalogue**: dimension tables for pipe (ASME B36.10M / B36.19M, EN 10220), butt-weld fittings
   (B16.9), flanges and bolting (B16.5; B16.47 and EN 1092-1 by import), gaskets (B16.20 / B16.21), valve face-to-face
   (B16.10), socket-weld / threaded fittings (B16.11, by import), each value carrying its source and a verified flag;
2. **pressure–temperature ratings** (B16.5 by material group, EN 1092-1 by PN and material) with interpolation;
3. the **pipe spec** (pipe class) as document data: service, rating, materials, corrosion allowance, size range,
   components per size range with end types and schedules, branch table, status and revision;
4. **spec resolution**: (spec, component type, size[, branch size]) → exactly one catalogue component with its
   dimensions, or a stable refusal code;
5. **checks** an agent runs at the end of a job: catalogue consistency, spec coverage, design conditions against the
   P-T rating, pressure-design wall (B31.3 eq. 3a, with explicit allowable stress), dimensional-standard mixing;
6. the bridge to today's model: `add_pipe_run` accepts `spec` + `nps`, takes OD / wall / schedule from the spec, and
   leaves legacy pipes unchanged.

## 2. Plant context and value

| Who | Typical question | Tool used today | What llull adds |
| --- | ---------------- | --------------- | --------------- |
| Piping materials engineer (EPC) | "Write the CS150 spec: which schedule per size, which fittings, which branch connection, which flange facing and gasket" | Plant 3D Spec Editor (`.pspx` + `.pspc`), E3D Paragon / SPECON, Smart 3D reference-data workbooks, Excel | spec as plain JSON data, built by commands an agent can drive, checked against the catalogue and the P-T table |
| Piping designer | "Route this 6-inch line in CS150 and give me the right elbows and flanges" | Plant 3D, E3D, Smart 3D, CADWorx | spec resolution behind routing (02 RTE) |
| Process engineer | "Can CS150 take 19.5 bar at 45 °C?" | B16.5 table in a PDF, spreadsheet | `pt_rating`, `check_pipe_spec` with a stable failure code |
| Structural / support engineer | "What does this line weigh full of water?" | pipe data charts | `pipe_section_properties` from the spec, fed to `check_pipe_supports` and the frame checks |
| Fabricator / buyer | "Studs, gaskets, flanges for these joints" | spec sheet + vendor catalogues | flange / bolt / gasket dimensions per joint, commodity codes (05 ISO MTO) |
| Owner-operator (brownfield) | "Is this line built to the spec it is labelled with?" | document review | read-only spec checks over the model |

Commercial tools implement the same three layers, and llull follows them:

- **Catalogue** (dimensions per part family and size): Plant 3D catalogues, E3D catalogue components (CATE / SCOM
  with geometry and p-point sets), Smart 3D catalogue parts.
- **Spec** (which catalogue parts a class allows, per size range, with properties such as schedule and rating):
  Plant 3D spec sheet (`.pspc` SQLite) and its header + branch table (`.pspx` ZIP) [P3]; E3D SPEC with SELE
  question / answer selectors ending at a SPCOM that points to the catalogue component (CATREF), detail text,
  material text and bolting (BLTREF) [P6]; Smart 3D piping materials class with corrosion allowance, service limits,
  commodity filter and short codes [P7, P8].
- **Connection rules** (which joint connects two ends: flange + gasket + bolt set, matched by size, pressure class and
  facing) [P4, P5].

## 3. Personas and user stories

| Persona | Role (AF §1) | Needs |
| ------- | ------------ | ----- |
| **Agent operator** | Primary operator, drives the `llull` CLI (`--doc` headless or `--app`) | discoverable commands, JSON results with units, stable error codes, a bundled catalogue that works offline, one plan file per job |
| **Owner** | Non-engineer asking for a result ("model the cooling-water lines of the new compressor house in our usual carbon-steel class") | plain-language summaries; to be told when a value is unverified or needs a qualified person |
| **Qualified reviewer** | Piping materials engineer / lead piping engineer; a PE where the line falls under pressure-equipment rules (PED category, ASME B31.3 owner's inspector) | reviews and **approves** a spec revision (human gate), reviews pressure-design results, decides on unverified catalogue data |

User stories:

- US-1 (operator): I can list the bundled catalogue families and look up an NPS 6 Sch 40 pipe, an LR elbow, an NPS 4
  Class 150 WN flange with its gasket and bolts, and a gate valve's face-to-face, and every number comes with its
  unit, source and verified flag.
- US-2 (operator): I can create a spec from a JSON file or build it step by step (`edit_pipe_spec` operations), and
  `check_pipe_spec` tells me what is missing (sizes without a pipe, branch cells empty, components outside the
  catalogue).
- US-3 (operator): when I route a line with `spec: "CS150-A1", nps: 6`, the outside diameter and wall are those of
  the spec's schedule for that size; when the size is outside the spec, I get `PSC_SIZE_OUT_OF_RANGE` and the size
  range.
- US-4 (operator): I can ask for the branch connection of a 6 × 2 branch and get "weldolet WOL" from the branch
  table, or `PSC_BRANCH_UNDEFINED`.
- US-5 (owner): when I ask "is this line OK for 19.5 bar?", the agent can answer "no — CS150 flanges are rated
  19.37 bar at 45 °C (ASME B16.5 group 1.1); a qualified engineer must choose a Class 300 spec".
- US-6 (reviewer): I see a spec sheet (sizes × components × schedules, branch table, rating, CA, materials) with every
  unverified value marked, and I approve the revision with my signature; the agent cannot.
- US-7 (operator): I can import a company or vendor catalogue (for example B16.11 socket-weld fittings) with
  provenance and licence flags; values without a citation are refused.
- US-8 (reviewer): I can export the spec as a sheet (CSV / JSON) to compare with the company's master spec.

## 4. Scope

| Phase | Content |
| ----- | ------- |
| **MVP** | Catalogue data model and file format; bundled open catalogue: B36.10M / B36.19M pipe (all schedules), EN 10220 diameters, B16.9 LR / SR elbows, LR 45, straight tees, concentric / eccentric reducers (rows with two sources), B16.5 WN / SO / blind RF flanges Cl 150 / 300 / 600 NPS ½–12 bolt patterns and dimensions, B16.20 SWG (rows with two sources), B16.10 gate valves Cl 150; B16.5 group 1.1 P-T ratings (≤ 50 °C rows verified). Spec data model (components by size range, schedule rules, end types, facing, branch table, CA, mill tolerance, status). Commands: import / export / list / lookup catalogue; import / edit / list / export spec; resolve component, resolve branch; `pt_rating`; `pipe_section_properties`; `check_piping_catalog`; `check_pipe_spec`; `add_pipe_run` with `spec` + `nps`. Error codes. Human gate for approval. |
| **V1** | `pipe_wall_check` (B31.3 eq. 3a with explicit S, E, W, Y, c, mill tolerance) and schedule selection; joint rules (flange + gasket + bolt set by size, class, facing) and stud length; B16.47 A/B, B16.11, EN 1092-1 full PN table, EN 10253, MSS SP-97 olets, B16.21 non-metallic gaskets as importable families with schema validation; spec revisions and diff; spec sheet export (CSV); commodity codes and short descriptions; component geometry (shape recipes) for routing and rendering (with 02 RTE / 09 VIS); valve types (gate, globe, check, ball, butterfly) with operator envelopes. |
| **V2** | Import of Plant 3D specs exported as CSV / Excel and of PCF SKEY mappings; direct `.pspc` reading if the schema can be confirmed; E3D SPECON-like text import; P-T tables for further material groups and EN materials via import; spec templates per service; temperature-dependent allowables imported from a licensed library (08 materials). |

Out of scope: writing piping codes' allowables or full standards into llull (paywalled, licensed content enters only by
user import with licence flags); pipe stress (07 PST); routing algorithms (02 RTE); isometric drawings (05 ISO);
procurement / ERP.

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source | AF | VC |
| -- | --- | ----------- | --------- | ------ | -- | -- |
| FR-PSC-01 | MUST | Pipe dimension catalogue: OD and nominal wall by NPS (or DN) and schedule for ASME B36.10M (5..160, STD, XS, XXS) and B36.19M (5S..80S), and EN 10220 outside diameters; every row tagged with its standard, so Sch 10 and 10S never mix. | the base of every other dimension | S1, S2, P10 | AF-10, AF-30 | VC-01, VC-18 |
| FR-PSC-02 | MUST | Component catalogue for fittings, flanges, gaskets, bolting and valves: B16.9 (LR / SR 90, LR 45, tee, reducer, cap), B16.5 flanges (WN, SO, blind; OD, thickness, bolt circle, bolt count and size, hole, raised face), B16.20 spiral-wound gaskets, B16.10 valve face-to-face, EN 1092-1 flange connection dimensions; B16.11 / B16.47 / EN 10253 / olets as importable families. | fittings and joints are what a spec selects | S2–S15, S20–S24 | AF-10, AF-30 | VC-03, 04, 06, 12, 13, 14 |
| FR-PSC-03 | MUST | Catalogue file format (`llull-piping-catalog`) for import and export: families, sizes, dimensions with unit, provenance per value (citation or source id), licence flag; values without provenance are refused; `licensed-no-redistribution` families stay private to the machine (same rule as 08 MAT libraries). | company and vendor catalogues, licensed standards | 08 MAT pattern | AF-30, AF-35 | VC-05 |
| FR-PSC-04 | MUST | Section properties from catalogue data: ID, metal and flow areas, plain-end mass per metre, content mass, total mass, second moment of area and section modulus (for 07 PST), insulation mass when insulation thickness and density are given (V1). | weights for supports and frames, flow area for hydraulics | S16, S17 | AF-10, AF-35 | VC-02 |
| FR-PSC-05 | MUST | Flange P-T ratings by standard, material group and class (B16.5) or PN and material (EN 1092-1), with linear interpolation between tabulated temperatures and refusal outside the table. | spec's design envelope | S5–S7 | AF-30, AF-31 | VC-07 |
| FR-PSC-06 | MUST | Pipe spec as document data: id, title, service, dimensional standard (ASME / EN), rating (system + class or PN, material group), materials, corrosion allowance, mill tolerance, design temperature limits, size range, components (type, size range, branch size range, end types, facing, class, schedule or wall rule, catalogue reference, priority, short code / commodity code), branch table, status (draft / approved / superseded), revision, provenance. | same concept as Plant 3D spec sheet, E3D SPEC, Smart 3D PMC | P1–P8 | AF-05 | VC-08, VC-17 |
| FR-PSC-07 | MUST | Spec resolution: given spec, component type, size and optional filters (end type, facing, branch size, radius), return exactly one component with its dimensions, schedule, wall and provenance; refuse with `PSC_SIZE_OUT_OF_RANGE`, `PSC_NO_COMPONENT` or `PSC_AMBIGUOUS_COMPONENT`. | the routing engine's only source of parts | P1, P6 | AF-10, AF-11 | VC-08 |
| FR-PSC-08 | MUST | Branch table: header size × branch size → branch fitting kind (equal tee, reducing tee, weldolet, sockolet, threadolet, stub-in, reinforced stub-in) and component; empty cell → `PSC_BRANCH_UNDEFINED`. | Plant 3D branch table, standard EPC practice | P1 | AF-11 | VC-09 |
| FR-PSC-09 | MUST | `check_pipe_spec` (read-only): coverage (every size in range has a pipe; every routing fitting type is defined per size), catalogue references resolve, branch table complete for listed sizes, design conditions against the P-T rating and the temperature limits, dimensional-standard mixing, unverified data, status; pass / warn / fail list with codes. | the agent's end-of-job check (AF-20) | — | AF-20, AF-11, AF-32 | VC-10, 14, 16 |
| FR-PSC-10 | SHOULD | Pressure-design wall check (ASME B31.3 eq. 3a) with explicit allowable stress, joint factor, weld strength factor, Y, corrosion allowance and mill tolerance; lightest schedule that meets it; result flagged `reviewRequired`. | spec writers choose schedules this way | S18, S19 | AF-31, AF-33, AF-35 | VC-11 |
| FR-PSC-11 | MUST | Dimensional-standard and joint compatibility: flag EN 10220 pipe with ASME B16.9 fittings (end diameters differ), BW to SW without adapter, flanges of different class or facing in one joint. | real errors in mixed-standard projects | S25–S27, P4 | AF-11, AF-30 | VC-14 |
| FR-PSC-12 | MUST | `check_piping_catalog` (read-only): dimensions against rules from the standards (B16.9 LR = 1.5 × NPS for NPS ≥ ¾; SR = NPS; bolt hole = bolt + ⅛ in; flange bore / pipe OD consistent; values monotonic in size), duplicate keys, missing provenance. | imported catalogues from CAD add-ons carry wrong radii | S8–S11 | AF-20, AF-30 | VC-05 |
| FR-PSC-13 | MUST | `add_pipe_run` accepts `spec` and `nps` (or `dn`) and takes OD, wall and schedule from the spec; existing pipes without a spec keep today's behaviour (DN table); `check_pipe_spec` warns `PSC_PIPE_NO_SPEC` for them. | bridge to the existing industrial model | current state | AF-01 | VC-15 |
| FR-PSC-14 | MUST | Provenance and unverified propagation: every returned dimension carries `verified` and a source id; a resolution or check using an unverified value says so in `data` and as a warning that cannot be hidden. | owner is not an engineer | AF-32 | AF-32, AF-35 | VC-16 |
| FR-PSC-15 | MUST | Spec lifecycle: draft → approved (human gate, 09 PLM signature) → superseded; edits create a new draft revision; pipes record the spec id and revision they were resolved with; `check_pipe_spec` warns on draft or superseded use. | spec approval is a materials-engineering act | AF-34 | AF-33, AF-34 | VC-16 |
| FR-PSC-16 | MUST | Spec editing by commands (`edit_pipe_spec` operations: add / remove / update component, set size range, set schedule rule, set branch cell, set properties) with deterministic output; export / import round trip byte-stable. | the Spec Editor of commercial tools, as commands | P2 | AF-01, AF-05, AF-13 | VC-17 |
| FR-PSC-17 | SHOULD | Spec sheet export for humans (CSV and JSON; sheet SVG / PDF via the drawings layer in V1) and V2 import of Plant 3D spec CSV exports. | reviewers compare with the master spec | P2, P3 | AF-12 | VC-17 |
| FR-PSC-18 | COULD | UI review surface: catalogue browser, spec sheet grid, branch-table grid, approval button for the qualified reviewer; every view reads the same command `data`. | review, not authoring | — | AF-21 | VC-09, VC-16 |
| FR-PSC-19 | SHOULD | Component geometry: a shape recipe per component type built from catalogue dimensions (elbow torus segment, tee, cone reducer, flange disc with bolt holes and raised face, valve body envelope) for 02 RTE and 09 VIS. | the 3D model must show real fittings | — | AF-22 | VC-19 |

## 6. Workflows

### 6.1 CLI (primary, complete)

```bash
# 1. discover
llull search "pipe spec"                      # import_pipe_spec, resolve_spec_component, check_pipe_spec ...
llull describe resolve_spec_component         # params with units, codes, next command
llull list piping                             # whole toolset

# 2. look up the bundled open catalogue
llull lookup_piping_component --json type=pipe nps=6 schedule=40
llull lookup_piping_component --json type=flangeWeldNeck nps=4 class=150 facing=RF

# 3. bring the spec (company file or built step by step)
llull --doc plant.llull import_pipe_spec --param-file spec=CS150-A1.json
llull --doc plant.llull edit_pipe_spec --json specId=CS150-A1 ops='[{"op":"setBranchCell","header":6,"branch":3,"fitting":"RT"}]'
llull --doc plant.llull check_pipe_spec --json specId=CS150-A1 design='{"pressureBar":18,"temperatureC":120}'

# 4. use it (routing proper is 02 RTE)
llull --doc plant.llull run plan.json --validate && llull --doc plant.llull run plan.json --json

# 5. end of job
llull --doc plant.llull check_pipe_spec --json scope=document
llull --doc plant.llull export_pipe_spec specId=CS150-A1 format=csv --save CS150-A1.csv
```

A complete job is one plan file (AF-05); [`validation/plans/`](validation/plans/) holds five.

### 6.2 MCP

Same commands as tools in the `piping` toolset; the MCP prompt for the toolset carries the AF-03 guide section:
NPS vs DN, schedules vs series, units (mm, bar gauge, °C; `{ value, unit }` accepted), the minimal plan (import spec
→ resolve → route → check).

### 6.3 UI (review and approval)

Catalogue browser and spec sheet grid in a panel; the branch table as a grid of codes; warnings and unverified values
highlighted; the **Approve revision** action, which requires the reviewer's signature (09 PLM). No authoring path
exists in the UI that is not a command.

## 7. Acceptance criteria

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-1 | the bundled catalogue | `lookup_piping_component type=pipe nps=6 schedule=40 --json` | `outsideDiameterMm` 168.3, `wallMm` 7.11, `verified` true, `source` names B36.10M | VC-PSC-01 |
| AC-2 | NPS 6 Sch 40, water | `pipe_section_properties` | `massKgPerM` 28.264 ± 0.001, `totalMassKgPerM` 46.909 ± 0.002, `provenance.formula` present | VC-PSC-02 |
| AC-3 | the bundled catalogue | lookup LR 90 NPS 6 and LR 45 NPS 4 | 228.6 mm and 63.5 mm | VC-PSC-03 |
| AC-4 | a user catalogue with an "LR" elbow of radius 126.2 mm at NPS 6 | `check_piping_catalog` | `fail`, `PSC_CATALOG_DIM_MISMATCH`, path `families.0.sizes.0.centreToEnd`, remediation names the 1.5 × NPS rule | VC-PSC-05 |
| AC-5 | a catalogue value without citation | `import_piping_catalog` | refused, `PSC_PROVENANCE_MISSING`, document unchanged | VC-PSC-05 |
| AC-6 | the bundled catalogue | lookup WN RF NPS 4 Cl 150 | OD 228.6, bolt circle 190.5, 8 bolts 5/8 in, hole 19.05 | VC-PSC-06 |
| AC-7 | B16.5 group 1.1 | `pt_rating class=150 temperatureC=45` | 19.3667 bar ± 0.0005, `method: "linear interpolation"` | VC-PSC-07 |
| AC-8 | spec CS150-A1 imported | `resolve_spec_component type=elbow90 nps=6` | `componentId` E90-LR, schedule 40, centre-to-end 228.6, wall 7.11 | VC-PSC-08 |
| AC-9 | spec CS150-A1 | `resolve_spec_component type=elbow90 nps=30` | `PSC_SIZE_OUT_OF_RANGE`, remediation lists NPS ½–24 | VC-PSC-08 |
| AC-10 | spec CS150-A1 | `resolve_branch headerNps=6 branchNps=2` / `headerNps=4 branchNps=6` | `W` (WOL) / `PSC_BRANCH_UNDEFINED` | VC-PSC-09 |
| AC-11 | spec CS150-A1 | `check_pipe_spec design={19.5 bar, 45 °C}` | `fail`, `PSC_PT_RATING_EXCEEDED`, data shows rating 19.3667 bar and margin −0.133 bar | VC-PSC-10 |
| AC-12 | NPS 4, 1200 psi, S 19 000 psi, E = W = 1, Y = 0.4, c = 3 mm, 12.5 % | `pipe_wall_check` | t 3.5205 mm, required 7.452 mm, schedule 80, `reviewRequired` true; with `schedule=40` → `PSC_WALL_INSUFFICIENT` | VC-PSC-11 |
| AC-13 | a spec with EN 10220 pipe and B16.9 elbows | `check_pipe_spec` | `PSC_DIM_STANDARD_MIXED` on the elbow component | VC-PSC-14 |
| AC-14 | spec CS150-A1 | `add_pipe_run spec=CS150-A1 nps=2.5` and a legacy `add_pipe_run dn=65` | OD 73.0 vs 76.1 (legacy unchanged) | VC-PSC-15 |
| AC-15 | draft spec, agent caller | `approve_pipe_spec` | refused `PSC_HUMAN_GATE`; `check_pipe_spec` reports `PSC_SPEC_NOT_APPROVED` | VC-PSC-16 |
| AC-16 | any spec | export → import → export | identical sha256 | VC-PSC-17 |
| AC-17 | NPS 14 | lookup Sch 10 (B36.10M) and 10S (B36.19M) | 6.35 and 4.78 mm, each with its standard | VC-PSC-18 |
| AC-18 | LR 90 NPS 6 Sch 40 component shape | `measure_bounds` | 312.75 × 312.75 × 168.3 mm within 0.5 % | VC-PSC-19 |

## 8. Standards and regulatory alignment

| Standard | Use in llull | Data status |
| -------- | ------------ | ----------- |
| ASME B36.10M (welded and seamless wrought steel pipe, NPS ⅛–80) | pipe OD / wall by schedule | bundled (open transcription, two sources) |
| ASME B36.19M (stainless steel pipe, 5S–80S) | pipe OD / wall | bundled (one source → `verified: false` where single) |
| EN 10220 (seamless and welded steel tubes, dimensions and masses) | OD series (DN) | bundled diameters |
| ASME B16.9 (factory-made wrought butt-welding fittings) | elbows, tees, reducers, caps | bundled rows with two sources; rest by import |
| ASME B16.5 (pipe flanges and flanged fittings, NPS ½–24, Class 150–2500) | flange dimensions, bolting, P-T ratings | bundled Cl 150/300/600 NPS 1–12, group 1.1 ratings ≤ 50 °C |
| ASME B16.47 (large-diameter flanges NPS 26–60, Series A / B) | flanges above NPS 24 | import (V1) |
| ASME B16.20 / B16.21 (metallic / non-metallic flat gaskets) | gaskets | SWG NPS 4 rows bundled; rest import |
| ASME B16.10 (face-to-face and end-to-end of valves) | valve lengths | Cl 150 gate rows bundled |
| ASME B16.11 (forged socket-weld and threaded fittings) | small-bore fittings | import only |
| ASME B18.2.1 / B18.2.2 (bolts, nuts) | stud and nut sizes for bolt sets | V1 import |
| EN 1092-1 (steel flanges, PN designated) | EN flanges and P/T by material | PN16 connection dimensions bundled (one source except DN100) |
| EN 10253 (butt-welding pipe fittings) | EN fittings | import (V1) |
| ASME B31.3 (process piping) | pressure-design wall eq. 3a | formula only; allowables are user inputs |
| MSS SP-97 (integrally reinforced branch outlet fittings) | olets | import (V1) |
| PED 2014/68/EU, ASME B31.3 Ch. VI | regulatory context for approval | human gate only (no category logic in MVP) |

Paywalled standards are cited by catalogue page (sources P10); llull ships only values available from two public
sources and marks the rest as unverified or leaves them to licensed import.

## 9. KPIs

| KPI | Target |
| --- | ------ |
| VCs passing (`expected_results.json`) | 19 / 19 |
| Grade-A catalogue rows reproduced exactly | 100 % (86 pipe rows, 24 flange bolt patterns, all fitting rows marked A) |
| Spec resolution time for one component (bundled catalogue, 50-component spec) | < 1 ms median, < 5 ms p99 |
| `check_pipe_spec` on a 30-spec, 1 000-line document | < 500 ms |
| Agent job "create spec from file, resolve 20 components, check" with no human input | 1 plan, 0 retries in the production-gate driver |
| Unverified values surfaced in every result that used them | 100 % (VC-PSC-16) |

## 10. Risks and assumptions

| Risk | Impact | Mitigation |
| ---- | ------ | ---------- |
| Standards are paywalled; bundled tables could be challenged | legal / redistribution | bundle only values from open-licensed packages (MIT / LGPL) or two public sources; licence flag per family; licensed data enters by user import and stays private (FR-PSC-03) |
| A transcription error in bundled data reaches a fabrication drawing | wrong parts ordered | two-source rule for `verified`, `check_piping_catalog` rules, reviewer approval of the spec, `reviewRequired` on pressure design |
| Owner treats a llull spec as approved | safety | status draft by default, human gate for approval, plain-language summary "not approved — needs a qualified piping engineer" (AF-33) |
| Mixed ASME / EN projects | wrong end diameters | dimensional-standard tag on every row, `PSC_DIM_STANDARD_MIXED` |
| Legacy pipes keep the EN/ASME-mixed table | inconsistent weights | warn `PSC_PIPE_NO_SPEC`; `assign_pipe_spec` migrates a pipe explicitly |
| Spec format diverges from what 02 RTE / 05 ISO / 07 PST need | rework | the spec and catalogue types are owned here and reviewed with those packs before M1 |
| Plant 3D `.pspc` schema is undocumented | V2 import may be impossible | CSV export route first; direct read only if the schema is confirmed |

Assumptions: NPS is the primary size key for ASME specs and DN for EN specs, with a fixed NPS↔DN map; pressures are
gauge; temperatures in °C (°F accepted with unit); the bundled catalogue is read-only and versioned with llull.

## 11. References

- [P1]–[P10], [S1]–[S27]: see [`validation/sources.md`](validation/sources.md) (URLs, accessed 2026-10-18).
- Sibling gaps: [`../02-spec-driven-routing/`](../02-spec-driven-routing/) (routing uses spec resolution),
  [`../05-isometrics-fabrication/`](../05-isometrics-fabrication/) (MTO, PCF SKEYs),
  [`../07-pipe-stress-flexibility/`](../07-pipe-stress-flexibility/) (section properties, SIFs),
  [`../08-plant-data-reports-interop/`](../08-plant-data-reports-interop/) (commodity codes, line lists),
  [`../09-plant-visualization-review/`](../09-plant-visualization-review/) (spec colours, component geometry).
- Aerospace precedents reused: [`../../aerospace/08-materials-standards-libraries/`](../../aerospace/08-materials-standards-libraries/)
  (library / licence / provenance model), [`../../aerospace/09-plm-configuration-traceability/`](../../aerospace/09-plm-configuration-traceability/)
  (signatures, human gates).
