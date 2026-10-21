# Gap 08 — Aerospace materials (allowables, basis) & standard parts libraries — Functional spec

Gap id **MAT** · Status: specification (no implementation) · Written 2026-10-15
Companion: [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Sources: [validation/sources.md](validation/sources.md)

---

## 1. Summary

Today llull has one generic material record: a name, one density number, and PBR colour fields
(`create_material` / `assign_material` in `packages/core/src/commands/document/materials.ts`). Density is stored
implicitly in g/(document unit)³. `mass_properties` multiplies it by volume and always reports grams. There is
no product form, temper, specification, statistical basis, temperature dependence or data provenance. There
are no standard parts: no fasteners, no grip-length logic, no hole/fastener/nut stacks. The bill of
materials (`bill_of_materials`) counts component instances only.

Aerospace structures are designed against **design allowables**. These are minimum strengths, statistically
based (A- or B-basis) or specification minima (S-basis), tied to an alloy, temper, product form, thickness range, grain direction,
temperature and source edition. Airframes are joined by **standard fasteners** whose part numbers encode
diameter and grip. An aerospace user cannot use llull for a fitting, bracket or skin splice until it can:
(1) record a material the way a stress engineer and a certification authority expect, with provenance;
(2) compute mass in a unit-safe way; (3) pick the right NAS/MS/Hi-Lok fastener for a stack and put the hole,
fastener, washer and nut into the model and the BOM. This gap delivers those three capabilities. It respects
the licensing of MMPDS, NAS and CMH-17 data and export-control rules.

## 2. Aerospace context & value

### 2.1 Why allowables and basis matter (regulation)

- **14 CFR 25.613** requires material design values to be "established on a statistical basis" from tests of
  material meeting approved specifications. Single-load-path structure needs **99 % probability with 95 %
  confidence**. Redundant (fail-safe) structure needs **90 % / 95 %**. Higher values are allowed by premium
  selection, testing each item [R1].
- FAA **AC 25.613-1** accepts the A and B properties published in MIL-HDBK-5 or ESDU 00932 [R2]. The 2003
  Federal Register preamble says MIL-HDBK-5 and -17 "A" and "B" values are acceptable without further
  statistical analysis [R3].
- **MMPDS** (Battelle, under FAA funding) succeeded MIL-HDBK-5. MIL-HDBK-5J (31 Jan 2003) is equivalent to
  MMPDS-01 and was cancelled [R4][R5]. MMPDS defines **A-basis** as the value that ≥ 99 % of the population
  equals or exceeds with 95 % confidence (the lower of T99 and the specification minimum). **B-basis** is T90 at
  95 % confidence. **S-basis** is used when the A-basis sample-size or distribution requirements are not met
  [R5]. MMPDS-2024 is sold in two volumes: Vol I conventional metals and fasteners, Vol II C/D/S-basis
  process-intensive materials [R6]. MMPDS values are accepted by FAA, DoD and NASA [R7].
- Composite allowables live in **CMH-17**. It has six volumes; Vol 2 holds PMC property data. SAE distributes
  it and WSU/NIAR hosts the programme. CMH-17 defines B-basis as the 95 % lower confidence bound on the 10th
  percentile [R8]. Composite lamina allowables are owned by gap **06 CMP**
  (`docs/aerospace/06-composites/`). This gap supplies the shared material-record and provenance model that
  gap 06 extends.

A real hazard is that published secondary material gets basis definitions wrong. One textbook appendix
quoting MIL-HDBK-5J swaps the 95 % / 99 % figures [R9]. llull must carry the definition from the
authoritative source (R1/R5), not from wherever a value was copied.

Allowables also change between editions. An engineering forum reports that 7075-T6 bare-sheet Fbru dropped
from 156 ksi (MMPDS-04 and earlier) to 146 ksi (MMPDS-05 on) [R10]. Whatever the exact figures, a
model that does not record **which edition** a value came from cannot be re-checked when the handbook changes.

### 2.2 Standard parts in airframes

- Airframes use fasteners by the million. A Boeing 747-400 is quoted at about 6 million parts, half of them
  fasteners (a fan site quoting Boeing). Trade press gives "nearly 1.5 million fasteners", and notes the 787
  uses far fewer because of composites [R11]. The order of magnitude is not in dispute, and manual fastener
  definition does not scale.
- Fastener families are standardised by AIA (**NAS**), DoD (**MS/AN**, now often NASM), SAE (**AS**),
  ASD-STAN (**EN** aerospace series: bolts such as EN2114, EN3032, EN3660 [R12]), and manufacturers such as
  Hi-Shear (**Hi-Lok**, product specification 342 [R13]).
- Part numbers are parametric. **NAS6203-6220** are 160 ksi alloy-steel close-tolerance hex bolts. In
  NAS62dd-gg, dd is the diameter dash and gg the grip in 1/16 in. Length = grip + a thread length that depends
  only on diameter: .323 / .370 / .438 / .454 in for -3 / -4 / -5 / -6 [R14][R15]. **Hi-Lok** HLnn-d-g gives
  the diameter in 1/32 in and the *maximum* grip in 1/16 in (HL19-8-10 = 1/4 in pin, .5625–.625 in grip) [R13].
  **MS20470** universal-head rivets encode the diameter in 1/32 in and the length in 1/16 in [R16].
- Installation rules are public. FAA **AC 43.13-1B** says bolt grip equals the material thickness. A
  slightly longer grip is allowed with washers under the nut or head, up to 1/8 in combined, and at least one
  thread must protrude through the nut [R17]. Rivet minimum edge distance is 2 D and minimum spacing 3 D
  (par. 4-57(c)) [R18]. NASA **RP-1228** *Fastener Design Manual* is a public US Government work covering
  grip length, locking, washers, inserts, rivets and lockbolts [R19].

### 2.3 Who does this today, with which tools

| Tool | Capability (public documentation) |
| ---- | --------------------------------- |
| CATIA V5/3DEXPERIENCE "Fastening" | Based on the "PLM Spot Assembly Fastener Model", built from aeronautics customers' key requirements [R20]. |
| CENIT FASTJOINT (CATIA add-on) | Automatic joint analysis (position, direction, thickness), fastener selection, and edge-distance, pitch, grip and length checks [R21]. |
| SOLIDWORKS Toolbox / Smart Fasteners | Populates holes with fasteners and adds whole fastener stacks. Included with Professional and Premium [R22]. |
| Granta MI, MMPDS e-data, CMH-17 database | Licensed allowables databases (not redistributable). |
| Spreadsheets + MIL-HDBK-5J PDF | What small suppliers and MRO shops actually use. |

**llull's value proposition.** It is an offline desktop tool (KI6) in which a material record carries basis,
spec and provenance, and a fastener stack is one command reachable from UI, CLI and MCP. A local agent
(Claude Code + `llull` CLI) can then *select, insert, check and bill* fasteners across a model and explain
every choice with citations. No licensed data is redistributed: the user imports their own MMPDS / NAS data.

## 3. Personas & user stories

Roles follow [`../AGENT_FIRST.md`](../AGENT_FIRST.md) §1. The owner is not assumed to know what an A-basis value, a grip
dash or an ITAR marking is, so llull carries those rules itself: units are explicit, every value carries its basis and
source, **unverified or typical data is flagged and the flag follows every result computed from it** (mass, FEA, allowable
queries; AF-32), and certification-relevant results say they need a qualified engineer (AF-33).

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent driving the `llull` CLI (cloud agents: MCP) | `llull run`, `llull get_material_allowable`, `llull select_fastener`, `llull mass_properties`, `llull check_materials`, `llull bill_of_materials --json` | Commands with units in every param, results with units, basis, provenance and `unverified` flags, stable error codes |
| **Owner** | The person asking for the part, weight or BOM. **Not assumed to be an engineer** | Natural language to the agent; may watch the desktop app | A defensible answer: which numbers are verified, which are typical/unverified, what needs a human |
| **Qualified reviewer** | Stress engineer or M&P engineer (allowables for certification), export-control officer (markings) | Desktop app review surfaces; library and marking dialogs | Approves allowables used for certification, imports licensed libraries, sets or lowers export-control markings (human gates) |

User stories:

- **US-1 (owner → operator).** "What does this 7075 fitting weigh?" The agent assigns the material record and runs
  `mass_properties --json`. It reports mass in g, kg and lb, the density used with its source and basis, and, if the density is a
  typical or legacy value, `unverified: true` with the reason, in plain words.
- **US-2 (operator).** The agent asks `get_material_allowable` for Ftu, L, A-basis at a thickness. If only S-basis or typical exists it
  gets `available: false` with candidates and the code `MAT_ALLOWABLE_NOT_AVAILABLE`, never a silent fallback. Every returned allowable
  carries `reviewRequired: true` because it can feed a certification decision.
- **US-3 (reviewer).** The M&P engineer registers a licensed MMPDS/company library as **private** in the desktop app; it never leaves the
  machine and is never embedded in shared documents.
- **US-4 (operator).** "Bolt these two plates with NAS6204, MS21042 nut, NAS1149 washer." The agent runs `select_fastener` and gets the
  grip dash, washer shim, length and protrusion check, each rule with its source and every default named (max washer stack 1/8 in from
  AC 43.13-1B). Failures come with codes (`FAST_STACK_OUT_OF_RANGE`, `FAST_PROTRUSION_SHORT`). Then `insert_fastener_stack`.
- **US-5 (operator).** The agent exports a BOM with standard-part rows and raw-material rows (`bill_of_materials --json`, CSV with `--save`).
- **US-6 (operator).** The agent sees a record marked ITAR; an export attempt returns `MAT_EXPORT_CONTROLLED` and the agent hands over to
  the owner. Only a human confirmation in the desktop app (export-control officer) releases the export (AF-34).
- **US-7 (operator).** The agent ends every job with `check_materials`, which lists unverified values, superseded sources, unresolved
  private libraries, representative fastener geometry and pending human gates.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | Rich material record (designation, temper, form, specs, physical properties with units, basis, provenance). Unit-aware density and mass reporting. Read-only allowable query. Library import/export JSON. Seed library of public MIL-HDBK-5J values (once re-verified). Fastener catalogue model for NAS6203-6220, MS20470, MS21042, NAS1149 and Hi-Lok HL10/11/18/19 (encoding rules plus user-supplied dimensions). `select_fastener` (read-only grip/length selection). BOM standard-part rows. |
| **V1** | `insert_fastener_stack` (hole cut through the OCC kernel + fastener, washer and nut solids as instances). Fastener patterns along a row (pitch / edge-distance checks). Temperature-dependent property curves (tabulated, interpolated). Library licensing/IP flags. Export-control markings. Material lines in the BOM. EN aerospace series and AN families via user-imported catalogues. |
| **V2** | Joint check hooks (bearing/shear with allowables → margins; links gap 05 FEA). Blind fasteners and inserts (catalogue-driven). Lockbolts and collars. Composite allowables delegated to gap 06. Automatic fastener assignment from hole features (gap 07 FTR). PLM effectivity of library revisions (gap 09). |

**Out of scope.** Shipping any MMPDS, CMH-17, NAS-sheet or ASD-STAN-sheet tables; computing new statistical
allowables from raw test data (that is CMH-17 / MMPDS methodology, a separate V3 item); torque
specification; corrosion/finish compatibility rules beyond recording the finish code; certification
substantiation.

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-MAT-01 | MUST | A material record identifies the alloy/designation, temper/condition, product form, thickness range, and zero or more material specifications (body + id + revision, e.g. SAE AMS 4045). | Allowables depend on all of these. | R5, R23 |
| FR-MAT-02 | MUST | Every numeric property carries an explicit **unit**. llull converts between unit systems exactly (1 in = 25.4 mm, 1 lb = 453.59237 g). A material defined in lb/in³ gives correct mass in a mm document and vice versa. | Today density is implicit g/unit³ and mass is always "g". | Exact SI definitions; VC-MAT-03 |
| FR-MAT-03 | MUST | Every strength property carries a **basis** ∈ {A, B, S, typical, supplier_unstated, company} and, for statistical bases, the definition is the authoritative one (A 99/95, B 90/95). | 14 CFR 25.613 distinguishes single vs redundant load path. | R1, R5 |
| FR-MAT-04 | MUST | Every property value carries **provenance**: source document, edition/revision, table/figure locator, access date, and an optional file hash. Two values for the same property from different sources can coexist; one is marked `preferred`. | Editions change values (7075-T6 Fbru example); sources disagree (Ti-6-4 density 0.160 vs 0.163). | R10, VC-MAT-02 |
| FR-MAT-05 | MUST | `mass_properties` reports mass in the unit system of the material/document (g, kg, lb) and names the density source. | Weight reports are audited. | VC-MAT-04 |
| FR-MAT-06 | MUST | A read-only query returns the allowable for (material, property, direction L/LT/ST, basis, thickness, temperature), or a structured "not available" with the nearest candidates. It never silently falls back from A to B or from B to typical. | Silent fallback is a safety defect. | R1 |
| FR-MAT-07 | SHOULD | Properties can be temperature-dependent: tabulated (T, value or % of RT) with linear interpolation inside the range and refusal outside it, plus exposure-time qualifiers. | MIL-HDBK-5 provides curves of strength against temperature and exposure time. | R24 |
| FR-MAT-08 | MUST | Libraries are imported and exported as versioned JSON. A library is **document-embedded** (travels with the file) or **workstation-private** (referenced by id + hash and never embedded). | Licensed MMPDS / company data must not leak into shared files. | R7, R25 |
| FR-MAT-09 | MUST | Each library and record carries **licence / IP flags** (`public-domain-us-gov`, `licensed-no-redistribution`, `company-proprietary`, `vendor-catalogue`) and an **export-control marking** (`none`, `EAR99`, `EAR-ECCN:<x>`, `ITAR`). Export, share and cloud-sync paths warn or refuse according to the flags. | NAS = AIA IP; MMPDS licensed; ITAR/EAR public-domain rules differ. | R25, R26, R27 |
| FR-MAT-10 | MUST | llull ships only a **seed library** limited to public-domain data (MIL-HDBK-5J values, re-verified against the primary PDF, with table locators), clearly labelled "cancelled handbook — for reference / preliminary design; use current MMPDS for certification". | MIL-HDBK-5J is cancelled but public; MMPDS supersedes it. | R4 |
| FR-MAT-11 | MUST | A **fastener catalogue** models families parametrically: part-number grammar (fields, codes), size table per diameter dash, grip increment, length rule, material and finish codes, and dimension ranges (min/max), each with provenance. | NAS/Hi-Lok/MS part numbers are rule-based. | R13–R16 |
| FR-MAT-12 | MUST | `select_fastener` (read-only): given family, diameter, stack thickness (from selected solids along an axis, or a number), nut and washer family, return part numbers for bolt/pin, washers and nut, with the grip, length, shim gap and protrusion checks. Out-of-range stacks fail with reasons. | Core joint-design task. | R17; VC-MAT-07, VC-MAT-08 |
| FR-MAT-13 | MUST | Grip selection rule: the smallest catalogue grip ≥ stack (Hi-Lok: the pin whose ((g−1)/16, g/16] range contains the stack). Gap = grip − stack is filled by catalogue washers totalling ≥ gap and ≤ 1/8 in. At least one full thread must protrude beyond the nut's maximum height. | AC 43.13-1B 7-37 rules. | R17 |
| FR-MAT-14 | SHOULD | Rivet selection: length = stack + 1.5 D, rounded to a 1/16 in catalogue length (the rounding mode is configurable, default up). Report the minimum shop-head size (1.5 D × 0.5 D), minimum edge distance 2 D and minimum pitch 3 D. | Shop practice; AC 43.13-1B 4-57(c). | R18, R28; VC-MAT-09 |
| FR-MAT-15 | MUST | `insert_fastener_stack` (mutating) places the hole (exact OCC cut, close-tolerance or clearance per catalogue) and the fastener, washer(s) and nut as component instances with the part number as component key, in one undoable step. | One command = one UI action = one MCP tool (L1). | VC-MAT-10 |
| FR-MAT-16 | MUST | `bill_of_materials` gains standard-part rows (part number, family, description, quantity, unit mass if known) and raw-material rows (material id, spec, form, total mass). Existing output stays backward compatible. | BOM integration. | VC-MAT-11 |
| FR-MAT-17 | SHOULD | Fastener geometry is generated parametrically from catalogue dimensions. Where a dimension is unknown the solid is flagged `representative` and excluded from mass unless overridden. | No fabricated dimensions. | TEMPLATE rule |
| FR-MAT-18 | SHOULD | Fastener rows/patterns: place N fasteners along a curve or between points with pitch and edge-distance checks against FR-MAT-14 minima, reporting violations. | Skin splices, rows. | R18; VC-MAT-12 |
| FR-MAT-19 | SHOULD | The catalogue supports EN aerospace series, AN, AS and company standards through user-imported catalogue files, with no code change. | European programmes use EN (ASD-STAN). | R12 |
| FR-MAT-20 | COULD | Joint strength hook: a read-only query gives single-shear / bearing capacity from fastener Fsu and sheet Fbru allowables, with basis propagation (the result basis is the weakest input basis). | Feeds gap 05 margins. | R14 |
| FR-MAT-21 | MUST | Material and fastener edits are commands (pure, recorded in featureHistory, replayable). Library imports record only the library id, version and hash in the step, never licensed values in clear when the library is private. | L1/L3/L8; IP. | — |
| FR-MAT-22 | SHOULD | Composite material records (lamina/laminate allowables, CMH-17 basis) reuse FR-MAT-03/04/08/09 and are specified in gap 06. This gap provides the shared envelope. | Avoid two provenance systems. | R8 |
| FR-MAT-23 | MUST | Backward compatibility: existing documents with `{name, density, color, metalness, roughness}` load unchanged. Their density is interpreted as g/(document unit)³, marked basis `unspecified`, provenance `legacy`. | No data loss. | VC-MAT-01 |
| FR-MAT-24 | SHOULD | A "library diff" query compares two library versions (edition change) and lists changed values with old/new and source. | Re-checks after MMPDS edition updates. | R10; VC-MAT-13 |
| FR-MAT-25 | MUST | **Unverified propagation** (AF-32): a property value is `unverified` unless it traces to a cited, verified source with a statistical basis where one applies (basis `typical`, `supplier_unstated`, `unspecified`, provenance `legacy`, or status not verified ⇒ `unverified`). The flag and its reasons propagate into every result computed from it: `mass_properties`, BOM material rows, `get_material_allowable`, gap 05 FEA results and margins, and joint capacity. | Typical values are not allowables; the owner cannot tell them apart | AF-32; VC-MAT-22, VC-MAT-23 |
| FR-MAT-26 | MUST | **Readiness check** (AF-20): read-only `check_materials` returns pass / warn / fail items with codes for unverified values in use, superseded sources, unresolved private libraries, preferred conflicts, representative fastener geometry, regrip needed after edits, export-control markings and pending human gates. | The agent proves its own work | AF-20; VC-MAT-24 |
| FR-MAT-27 | MUST | **Stable error codes** (AF-11) from TECHNICAL_SPEC §7.1 on every refusal and check item, with offending ids/paths and a remediation. | Agents act on codes | AF-11; VC-MAT-24 |
| FR-MAT-28 | MUST | **Named defaults** (AF-31): every rule threshold used without an explicit param is named in the result with its source and `defaulted: true` (max washer stack 1/8 in — AC 43.13-1B 7-37; protrusion ≥ 1 thread pitch — AC 43.13-1B, llull reading; rivet length rounding `up` — llull choice OQ-MAT-04; edge 2 D / pitch 3 D — AC 43.13-1B 4-57(c)). | No silent safety value | AF-31, R17, R18; VC-MAT-26 |
| FR-MAT-29 | MUST | **Review flag** (AF-33): every allowable returned by `get_material_allowable`, every `forCertification` query and every joint capacity carries `reviewRequired: true` with a reason. | Allowables feed certification decisions | AF-33; VC-MAT-23 |
| FR-MAT-30 | MUST | **Human gates** (AF-34): releasing an export of export-controlled content, lowering or removing an export-control marking, and accepting a value for certification use require a human confirmation in the desktop app (export-control officer / qualified reviewer, gap 09 signing). An agent caller gets `MAT_HUMAN_GATE`; it may raise a marking, never lower it. | Approval acts are human | AF-34; VC-MAT-25 |
| FR-MAT-31 | MUST | **Units in params and results** (AF-04, AF-10): quantities are `{ value, unit }` or carry the unit in the field name (`massKg`, `gripIn`); no unit is inferred from the document unit without being stated in the result. | Today mass is labelled "g" whatever the density unit | AF-04, AF-10; VC-MAT-03, VC-MAT-04 |

## 6. Workflows

### 6.1 CLI (`llull`, the operator's primary path; KI6)

Proposed commands are those of TECHNICAL_SPEC §4. Library files are registered with a transport called like the
existing exchange tools (`file=PATH`), not a CLI special case (AF-01).

```bash
llull search material allowable ; llull search fastener grip      # discover (AF-01)
llull describe get_material_allowable select_fastener              # units of every param (AF-02, AF-04)

# 1. libraries: public seed or a user file (private storage stays on this machine)
llull register_material_library file=libs/company-mmpds.llull-matlib.json storage=private --doc part.llull.json --json
llull import_material_library 'libraryId=company-mmpds' version=2024.1 sha256=… --doc part.llull.json --json

# 2. one plan: geometry, material assignment, fastener stacks (build_project)
llull run plans/fastener_stack_nas6203_proposed.json --validate --doc part.llull.json
llull run plans/fastener_stack_nas6203_proposed.json --doc part.llull.json --kernel occt --json

# 3. numbers (AF-10): every value with unit, basis, source, unverified
llull mass_properties entityId=box-3.1 massUnit=kg --doc part.llull.json --json
llull get_material_allowable '{"material":"aa7075_t7351","property":"Ftu","direction":"L","basis":"A","thickness":{"value":1.5,"unit":"in"}}' --doc part.llull.json --json
llull select_fastener '{"family":"NAS6203-6220","diameterDash":"3","stack":{"value":0.51,"unit":"in"},"nut":"MS21042","washer":"NAS1149"}' --json

# 4. check, look, hand off
llull check_materials --doc part.llull.json --json                 # pass/warn/fail with codes (AF-20)
llull render_view view=iso --save out/stack.png --doc part.llull.json
llull bill_of_materials includeStandardParts=true --doc part.llull.json --json
llull export_bom_csv --save out/bom.csv --doc part.llull.json      # V1
```

`--dry-run` works for every mutating material and fastener command (AF-42). Refusals exit 1 with `data.code` and a remediation
(TECHNICAL_SPEC §7.1). The agent's report to the owner lists, in order: what was computed, which inputs are verified, which are
`unverified` (and why), and what needs a qualified reviewer.

### 6.2 MCP agent (cloud)

The `materials` toolset exposes `get_material` and `get_material_allowable` (read-only, safe) and the mutating
`create_material` / `assign_material`. The `@aero` plugin's `fasteners` toolset exposes `list_fastener_families` and
`select_fastener` (read-only) and the mutating `insert_fastener_stack` / `insert_fastener_row` (TECHNICAL_SPEC §4.2, §7).
An agent asked to "fasten the doubler to the skin with NAS6204 at 4D pitch" calls `select_fastener` on the stack and then
`insert_fastener_row`. It reports each part number with the AC 43.13-1B rule that justified it. Private-library values are
redacted for cloud clients (TR-MAT-32) and export-controlled content is refused (`MAT_EXPORT_CONTROLLED`).

### 6.3 Desktop UI (review and approval surface only)

1. **Libraries panel**: licence, storage and marking badges; the M&P engineer registers private libraries here.
2. **Material inspector**: property table with basis, direction, thickness, source and `unverified` badges (same data as `get_material`).
3. **Fastener preview**: shows the stack the agent selected (`NAS6203-9 · 1× NAS1149 .063 · MS21042L3 · protrusion 0.124 in ✓`).
4. **Human gates** (AF-34): export-control confirmation, setting or lowering a marking, marking an allowable as accepted for certification.
5. **BOM panel**: standard-part and raw-material sections.

## 7. Acceptance criteria

Each criterion is a CLI invocation with a JSON assertion against `validation/expected_results.json` (VC id in the last
column). `D` = `--doc case.llull.json --json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | a v2 document with a legacy material `{density: 0.00785}` on a 10 mm cube | `llull mass_properties entityId=… D` | `data.mass` = 7.85 (g) as today; `data.densitySource.provenance: "legacy"`, `data.unverified: true` (reason `legacy`) | VC-MAT-01, 22 |
| AC-2 | a material with two density values from two sources | `llull set_material_property … preferred=true D`; `mass_properties D` | `data.densitySource` names the preferred entry; `get_material` lists both | VC-MAT-02 |
| AC-3 | density 0.101 lb/in³ | `llull convert_quantity value=0.101 from=lb/in^3 to=g/cm^3 --json` (or `get_material`) | 2.795670376 g/cm³ (= 0.101 × 453.59237 / 16.387064, rel. 1e-9) | VC-MAT-03 |
| AC-4 | `plans/mass_7075_block_current.json` (runs on today's llull) | `llull run <plan> D` | last step `data.mass` = 140.5, `data.unit: "g"` (rel. 1e-6) — verified on the current registry | VC-MAT-04 |
| AC-5 | an allowable requested at basis A that only exists at basis S | `llull get_material_allowable … basis=A D` | exit 1, `data.code: "MAT_ALLOWABLE_NOT_AVAILABLE"`, `data.candidates[0].basis: "S"`; no value returned as A | VC-MAT-05 |
| AC-6 | catalogue NAS6204, dash 10 | `llull decode_part_number partNumber=NAS6204-10 --json` | `gripIn` 0.625, `lengthIn` 0.995 (published) | VC-MAT-06 |
| AC-7 | a 0.510 in stack, NAS6203 + MS21042L3 + NAS1149 | `llull select_fastener … --json` | `partNumber: "NAS6203-9"`, `washersIn: [0.063]`, `protrusionIn: 0.124`, `maxWasherTotal.source: "AC 43.13-1B 7-37"`, `defaulted: true` | VC-MAT-07, 26 |
| AC-8 | a 0.600 in stack, HL19 1/4 in | `llull select_fastener family=HL19 … --json` | `partNumber: "HL19-8-10"`, `gripRangeIn: [0.5625, 0.625]` | VC-MAT-08 |
| AC-9 | a 0.125 in stack, MS20470AD4 | `llull select_fastener family=MS20470 … --json` | `MS20470AD4-5`; `minEdgeDistanceIn` 0.25, `minPitchIn` 0.375; rounding `{value: "up", defaulted: true}` | VC-MAT-09, 26 |
| AC-10 | two plates and a hole point | `llull run plans/fastener_stack_nas6203_proposed.json D --kernel occt`; `llull undo` | hole + 1 bolt + 1 washer + 1 nut instances; undo restores the document hash | VC-MAT-10 |
| AC-11 | a model with 2 stacks | `llull bill_of_materials D` | `standardParts`: NAS6203-9 ×2, MS21042L3 ×2, NAS1149(.063) ×2; raw-material rows | VC-MAT-11 |
| AC-12 | a row at 2.5 D pitch | `llull insert_fastener_row … D` | exit 1, `data.code: "FAST_PITCH"` citing min pitch 3 D (or warnings with `allowViolations`) | VC-MAT-12 |
| AC-13 | a library flagged licensed-no-redistribution, storage private | save, snapshot, `export_code`, live-sync log | outputs contain only library id, version and hash | VC-MAT-14 |
| AC-14 | a record flagged ITAR | agent runs `llull export_step_ap242 --save x.step D` | exit 1, `data.code: "MAT_EXPORT_CONTROLLED"`; with `confirmExportControlled=true` from the agent: `MAT_HUMAN_GATE`; nothing written | VC-MAT-15, 25 |
| AC-15 | the 7075 block with the **typical** MatWeb density (basis `typical`) | `mass_properties D`; FEA `compute_margins` on a typical E; `get_material_allowable` on a typical Ftu | each result `unverified: true` with reasons; `check_materials` warning `MAT_VALUE_UNVERIFIED` | VC-MAT-22, 23 |
| AC-16 | the deliberately wrong inputs of VC-MAT-24 | the failing command | each returns the documented code and remediation (TECHNICAL_SPEC §7.1) | VC-MAT-24 |

## 8. Standards & regulatory alignment

### 8.1 Certification basis
- 14 CFR 25.613 (and the equivalent CS 25.613) statistical design values [R1]. AC 25.613-1 accepts MIL-HDBK-5 / ESDU 00932 A and B
  [R2].
- MMPDS (current edition MMPDS-2024; licensed) [R6][R7]. MIL-HDBK-5J (2003, cancelled, public) [R4].
- CMH-17 for composites (gap 06) [R8].

### 8.2 Material specifications
- SAE AMS (e.g. AMS 4037 2024-T3 sheet/T351 plate, AMS 4045 7075-T6 sheet/T651 plate, AMS 4911 Ti-6Al-4V
  sheet/strip/plate). Titles as listed by suppliers [R23]. llull stores spec id and revision; it does not store
  spec content.

### 8.3 Licensing / IP of catalogue data
- **NAS**: "all work created or published as part of the NAS standards program is the intellectual property of
  AIA". Distributing copies is outside the licence [R25]. llull may store *facts* a user enters (dimensions,
  coding rules, already published openly by distributors [R14][R15][R16]). It must not ship scanned or
  transcribed NAS sheets. MS/AN military standards are US Government documents. NASM successors are
  AIA-published.
- **MMPDS**: sold or licensed by Battelle [R7]. Import is supported, redistribution is not. Default
  storage is private.
- **CMH-17**: sold by SAE [R8]. Same as MMPDS.
- **Hi-Lok**: Hi-Shear proprietary product specifications [R13]. Treated as a vendor catalogue.
- **ASD-STAN EN**: sold standards [R12]. Facts only, user-imported.

### 8.4 Export control (ITAR / EAR)
- ITAR 22 CFR 120.34: public domain = information that is published and generally accessible to the public
  [R26]. EAR 15 CFR 734.7: "published" = available to the public without restrictions on further
  dissemination, including public internet posting [R27]. The two regimes define these terms differently, so a
  record that is "published" under one is not automatically public domain under the other [R26][R27].
- llull therefore does not decide classification. It records the marking the user's ECO assigns, propagates
  it (document marking = most restrictive of its libraries and records) and gates export, share and cloud
  paths (FR-MAT-09). Marking semantics are shared with gap 09 PLM.

## 9. KPIs / success metrics

| KPI | Target |
| --- | ------ |
| Mass error vs analytic (OCC, VC-MAT-04 set) | ≤ 1e-6 relative |
| Grip-selection correctness on validation set (VC-MAT-07/08/09) | 100 % |
| Seed-library values with primary-source locator + re-verification record | 100 % |
| Values with basis and provenance (seed library) | 100 % |
| Time to insert 100 fastener stacks (desktop OCC) | ≤ 10 s (TECHNICAL_SPEC §8) |
| Licensed values leaking into a saved shared document (fuzz test) | 0 |
| Results computed from unverified data without the `unverified` flag (mass, FEA, allowables) | 0 (VC-MAT-22, 23) |
| Human-gated acts completed by an agent | 0 (VC-MAT-25) |
| Agent driver completes the bracket-splice scenario unattended except the human gates | ≥ 9 of 10 runs (AF-23) |

## 10. Risks & assumptions

| Risk | Mitigation |
| ---- | ---------- |
| Users treat seed (cancelled MIL-HDBK-5J) values as certification allowables. | Banner and record flag "superseded handbook"; a `forCertification` query option refuses non-current sources unless overridden. |
| IP infringement through catalogue data. | Facts-only seed; licence flags; private storage; no bundled NAS/ASD-STAN tables; legal review before V1 ships the sample catalogue. |
| Wrong dimensions produce wrong mass or clash results. | Min/max ranges with provenance; `representative` flag; unknowns are excluded from mass. |
| Sources disagree (density 0.160 vs 0.163; AN dash meaning). | Multi-valued properties + `preferred` + open questions OQ-MAT-04/05. |
| Export-controlled data synced to the cloud. | Marking gates in `server/` and the MCP layer; desktop-first default (KI6). |
| Fastener counts in the 10⁴–10⁶ range blow up document size. | Instances share one component per part number. Patterns store parameters, not N copies (TECHNICAL_SPEC §8). |
| Assumption | OCC is the desktop kernel (hole cuts exact); gap 07 provides hole features later; gap 09 provides markings UI. |

## 11. References

All entries below were read through web-search index content only (direct fetches were blocked); the grade of
each one (primary index, supplier, secondary) is in [validation/sources.md](validation/sources.md).


- [R1] 14 CFR § 25.613 — eCFR / Cornell LII / govinfo — https://www.ecfr.gov/current/title-14/chapter-I/subchapter-C/part-25/subpart-D/subject-group-ECFRff93ea3edba9270/section-25.613 (accessed 2026-10)
- [R2] FAA AC 25.613-1 — FAA — https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC25.613-1.pdf (accessed 2026-10)
- [R3] Revised Requirement for Material Strength Properties and Design Values for Transport Airplanes — Federal Register 2003-08-05 — https://www.federalregister.gov/documents/2003/08/05/03-19748/revised-requirement-for-material-strength-properties-and-design-values-for-transport-airplanes (accessed 2026-10)
- [R4] MIL-HDBK-5J listing, notices — EverySpec — https://everyspec.com/MIL-HDBK/MIL-HDBK-0001-0099/MIL_HDBK_5J_139/ (accessed 2026-10; index only, fetch blocked)
- [R5] Definition of Design Allowables for Aerospace Metallic Materials — Battelle/MMPDS — https://www.mmpds.org/wp-content/uploads/2015/03/mmpds_2015_2007aeromat_presentation.pdf (accessed 2026-10)
- [R6] Battelle Publishes New Volume of MMPDS — Battelle — https://www.battelle.org/insights/newsroom/press-release-details/battelle-publishes-new-volume-of-mmpds--the--bible--of-aerospace-metallic-material-properties (accessed 2026-10)
- [R7] MMPDS slick sheet — mmpds.org — https://www.mmpds.org/wp-content/uploads/2025/05/Slick-Sheet_884_Metallic-Materials-Properties-Development-and-Standardization-MMPDS.pdf (accessed 2026-10)
- [R8] About CMH-17 — Wichita State NIAR — https://www.wichita.edu/industry_and_defense/NIAR/cmh-17/about-cmh-17.php ; SAE CMH-17 — https://store.accuristech.com/standards/sae-cmh-17?product_id=2565974 (accessed 2026-10)
- [R9] Juvinall Appendix F (MIL-HDBK-5J excerpt) — cittastudi — https://www.cittastudi.it/repository/3281/Juvinall%20%20Appendice%20F_Metalic%20Materials%20and%20Elements%20for%20Aerospace%20Vehicle%20Structures.pdf (accessed 2026-10; cited as a counter-example)
- [R10] Reduction in Fbru for 7075-T6 Sheet as of MMPDS-05 — Eng-Tips forum — https://www.eng-tips.com/threads/reduction-in-fbru-for-7075-t6-sheet-as-of-mmpds-05.425251/ (accessed 2026-10; secondary)
- [R11] Fun Facts from Boeing — boeing-747.com — https://www.boeing-747.com/fun_facts_from_boeing.php ; Aerospace Fastening in the 21st Century — Assembly Magazine — https://www.assemblymag.com/articles/90348-aerospace-fastening-in-the-21st-century (accessed 2026-10; secondary)
- [R12] ASD-STAN presentation April 2024 — ASD-STAN — https://cms.stan-shop.org/wp-content/uploads/2024/04/ASD-STAN-presentation-April-2024.pdf ; Aerospace Fastener Standards — Sucatec — https://www.sucatec.com/industries/aerospace-defence/aerospace-fastener-standards/ (accessed 2026-10)
- [R13] HL18 drawing — Hi-Shear (via AAE) — https://www.aaestore.com.au/media/specs/HL18.pdf ; HL19-8-10 — SpecLok — https://speclok.com/pn/hl19-8-10 (accessed 2026-10)
- [R14] NAS6203-6220 — AIA/NAS catalogue (GlobalSpec) — https://standards.globalspec.com/std/10028029/NAS6203-6220 (accessed 2026-10)
- [R15] NAS6203 / NAS6204 / NAS6205 / NAS6206 — Airfasco — https://airfasco.com/products/NAS/NAS6203THRUNAS6220/NAS6203.php (and …/NAS6204.php, …/NAS6205.php, …/NAS6206.php) (accessed 2026-10)
- [R16] MS20470AD4-4 / AD5-8 / AD6-8 — Military Fasteners — https://military-fasteners.com/rivets/solid+rivets/ms20470ad4-4 ; MS20470AD6-6 — Monroe Aerospace — https://catalog.monroeaerospace.com/item/all-categories/solid-rivets-1/ms20470ad6-6 (accessed 2026-10)
- [R17] AC 43.13-1B Chapter 7 — FAA — https://www.faa.gov/sites/faa.gov/files/2023-08/AC_43.13-1B_Ch7.pdf (accessed 2026-10)
- [R18] AC 43.13-1B Ch. 4 Sec. 4 excerpt (par. 4-57) — Scribd — https://www.scribd.com/document/358907798/section-4-metal-repair-procedures (accessed 2026-10)
- [R19] NASA RP-1228 Fastener Design Manual (Barrett, 1990) — NASA NTRS — https://ntrs.nasa.gov/citations/19900009424 (accessed 2026-10)
- [R20] Getting Started with CATIA Fastener Design and its CAA Openness — Dassault Systèmes — https://www.3ds.com/support/documentation/resource-library/getting-started-catia-fastener-design-and-its-caa-openness (accessed 2026-10)
- [R21] FASTJOINT by CENIT AG — Dassault Systèmes partner page — https://www.3ds.com/partners/solutions/200000000001731_PDT00000001402_FASTJOINT (accessed 2026-10)
- [R22] SOLIDWORKS Toolbox Smart Fasteners — Hawk Ridge Systems — https://hawkridgesys.com/blog/solidworks-toolbox-smart-fasteners (accessed 2026-10)
- [R23] AMS 4037 — Smiths Advanced — https://www.smithsadvanced.com/ams-4037.htm ; AMS list — Falcon Aerospace — https://www.falconaerospace.com/ams-specifications/ (accessed 2026-10)
- [R24] MIL-HDBK-5H CN1 Ch. 3.2.3 2024 Alloy (excerpt) — METU — https://www.ae.metu.edu.tr/~ae462/2024Alloy.pdf (accessed 2026-10)
- [R25] TOC-1 Development Procedures for National Aerospace Standards — AIA — https://www.aia-aerospace.org/wp-content/uploads/TOC-1-REV-3-Development-Procedures-for-NAS.pdf ; NAS410.com About — https://www.nas410.com/about-us.html (accessed 2026-10)
- [R26] 22 CFR Part 120 (§ 120.34) — eCFR — https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-120 (accessed 2026-10)
- [R27] 15 CFR Part 734 (§ 734.7) — BIS — https://www.bis.gov/regulations/ear/734 (accessed 2026-10)
- [R28] Rivet calculator (grip + 1.5 D; shop head 1.5 D × 0.5 D) — AMELogbook — https://amelogbook.com/aviatools/RivetCalculator/ ; Setting or Driving Solid Rivets — EAA — https://www.eaa.org/eaa/news-and-publications/eaa-news-and-aviation-news/bits-and-pieces-newsletter/09-2015-setting-or-driving-solid-rivets (accessed 2026-10; secondary)
