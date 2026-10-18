# Gap 06 STA — Plant structures and access: functional specification

Status: proposal, written 2026-10-18. Nothing in this gap is built yet. Authoring rules:
[`../TEMPLATE.md`](../TEMPLATE.md), [`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md). Operator model:
[`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md). Validation:
[`validation/README.md`](validation/README.md).

## 1. Summary

llull can already frame a steel structure: members, grid columns, beams and bracing, portal halls, base plates and
footings. It checks every member to EN 1993 (`check_steel_members`), treats a pipe-rack bent as a moment frame, and has
concrete stairs with landings (`add_stair`). It cannot yet produce the **access** steel that makes up most of the
piece count of a process unit. That means grating panels with a span check, platforms around vessels, fixed ladders with
cages or ladder safety systems, guardrails with knee rails and toe plates, steel stringer stairs, and a pipe-rack
generator. It also cannot answer the questions a plant reviewer asks first:

- Can every valve and instrument be reached?
- Does every ladder, stair and guardrail meet ISO 14122 or OSHA 1910?
- Which steel needs fireproofing?

This gap adds those **objects**, as generators that compose existing steel commands. It adds a **rule engine** that
checks access geometry against sourced ISO 14122-2/3/4 and OSHA 29 CFR 1910.23/25/28/29 tables with stable codes. It
adds a **reachability check** over an access graph (grade → stairs / ladders → platforms → operating points), and
fireproofing zones with quantities. All results are numeric and can be scripted by an agent. Everything that touches
fall protection is flagged for a qualified reviewer.

## 2. Plant context and value

| Task in a plant project                         | Who does it today, with what                                                                                                         | What llull adds                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Platforms, ladders, stairs, railings in the 3D model | Structural / layout designer: AutoCAD Plant 3D structure tools (platforms, stairs with railings, ladders) [S28]; AVEVA E3D Stairs, Ladders and Handrails (SLH) with configurable standards [S26]; CADMATIC template "structural units" such as the circular platform [S25]; Advance Steel with Graitec PowerPack cage-ladder and platform-cover macros [S27] | one `build_project` plan an agent writes: platform + grating + railing + ladder in a few steps, with the rules applied at creation and in `check_access` |
| Access compliance                               | layout reviewer with ISO 14122 / OSHA checklists, by eye on the model or on paper                                                    | `check_access`: every ladder, stair, guardrail and platform checked against a sourced rule table, with codes and remediation |
| Operability review ("can I reach HV-101?")      | 3D model review sessions (Navisworks), by eye                                                                                        | `check_reachability`: route from grade and operating height per target, as numbers                    |
| Grating selection                               | designer + manufacturer load tables (NAAMM MBG 531 basis in the US)                                                                  | `check_grating`: allowable load and deflection per panel from the grating type, reproducing two manufacturer tables |
| Pipe-rack layout                                | piping layout + structural, from company guides (bents typically 6 m, 4.6–8 m) [S31]                                                 | `add_pipe_rack`: bents, tiers, struts, bracing in one undoable step, then `check_steel_members`       |
| Fireproofing extent and quantities              | loss-prevention engineer from API RP 2218 fire-scenario envelopes [S29]; quantity surveyor by hand                                   | `set_fireproofing` over explicit zones + `fireproofing_takeoff` (area, volume) per member              |

Without this gap, an agent asked to "model the access for this column" has to place dozens of members and slabs one by
one. It has no way to check them, and the result cannot be handed to a reviewer.

## 3. Personas and user stories

- **Operator: an AI agent driving the `llull` CLI** (AF-01..05). It finds the commands with
  `llull search platform` / `llull list plant_structures`, writes one plan, validates it with
  `llull run plan.json --validate`, runs it, and ends with `check_access` and `check_reachability` (AF-20).
- **Owner: not an engineer.** For example the operator of a small skid builder, or a process engineer who owns a unit
  revamp. They want "the access is in and it passes", in plain words, with a list of what still needs a human.
- **Qualified reviewer**: a structural or safety engineer (PE / chartered engineer, or the site's competent person for
  fall protection). They approve access means and fall-protection choices. llull never claims compliance: every
  `check_access` result carries `reviewRequired: true` and says "computed by llull, not approved" (AF-33).

User stories:

1. As an agent, I put a half-round platform at +6.0 m around column C-101, with a grating, a railing and a caged ladder
   from grade. I get the steel and grating quantities and a pass / fail list (FR-STA-02/03/05/09).
2. As an agent, I add a stair from grade to the +3.0 m platform. The riser count and going are chosen so that
   2h + g is between 600 and 660 mm and the OSHA limits hold. The stair has grating treads and railings on both sides
   (FR-STA-04).
3. As an owner, I ask "is every valve reachable?" and get a table: tag, the surface it is operated from, height above
   it, route to grade, and OK / not OK with the reason (FR-STA-10).
4. As an agent, I generate a 60 m two-tier pipe rack with 6 m bents, run `check_steel_members`, and report the
   tonnage (FR-STA-06).
5. As an agent, I check that a 900 mm grating span carries 5 kPa and give the deflection (FR-STA-01).
6. As a reviewer, I open the desktop app, see every finding highlighted on the model, and either accept the design or
   send it back (FR-STA-16; the acceptance is a human gate, AF-34).
7. As an agent working for a US site, I switch the ruleset to `osha_1910`. The ladder above 24 ft then fails until I
   give it a ladder safety system (FR-STA-03/09).

## 4. Scope

| Phase   | Content |
| ------- | ------- |
| **MVP** | Grating types (NAAMM 19-W-4 family, from bar geometry) and grating panels on beams with a span check. Rectangular platforms on beams. Circular and partial-circular platforms around vertical vessels (brackets off the shell, grating segments). Fixed ladders: through / side-step exit, cage, or ladder safety system marker, landings. Guardrails: top rail, knee rails, toe plate, posts, gates at openings. Steel stringer stairs with grating treads and landings. Pipe-rack generator (bents, tiers, struts, bracing). Rule tables ISO 14122-2/3/4 and OSHA 1910.23/25/28/29 with grade-aware severities. `check_access`, `check_reachability` (explicit target points), `platform_takeoff`. IFC export of all new elements. Plan-sheet symbols. |
| V1      | Equipment support structures: table-tops, skid frames, vessel leg / skirt platforms, heat-exchanger stacking structures. Fireproofing zones (explicit or from equipment with a project envelope) with takeoff and IFC. Live loads from platforms fed to `check_steel_members`. Targets taken from valves / instruments of 02 RTE and 08 DAT. Project rule tables (company standard, AS 1657, other national rules). Re-derivation when the vessel or the supporting beams move. DXF / plan details of ladders and stairs. |
| V2      | Spiral stairs on API 650 tanks (with 03 EQP). Automatic access generation: propose platforms and ladders for every unreachable target. Grating layout optimisation (panel cut plan, clips). Advance Steel / SDNF / CIS/2 hand-off of access steel. Point-cloud as-built access check (with 10 SCN). |

Out of scope: detailed connection design of access steel (bolt groups for stair stringers; existing
`connections/` covers frames only). Ladder-safety-system product selection. Guardrail load testing. Escape-route
analysis for buildings (fire codes). Scaffolding.

## 5. Functional requirements

Priorities: MUST / SHOULD / COULD. AF ids: [`AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md).

| Id        | Pri    | Requirement | Rationale | Source | AF | VC |
| --------- | ------ | ----------- | --------- | ------ | -- | -- |
| FR-STA-01 | MUST   | Grating catalogue (type name, bar depth / thickness / pitch, cross-bar pitch, mass kg/m², material, `verified` flag) and `add_grating`: panels over a plan region, split at the supporting beams, bearing-bar direction explicit. `check_grating` returns per panel the span, the allowable uniform (kPa) and concentrated (kN/m) load, and the deflection under the design load, with pass / fail against explicit limits. | Grating is the walking surface of every platform; overspanned grating is a common defect. | S19–S22 | AF-10, AF-21, AF-30, AF-31 | VC-STA-06 |
| FR-STA-02 | MUST   | Platforms: `add_platform` (polygon on existing beams, or generates framing beams with a given profile), `add_circular_platform` around a vertical vessel (elevation, start angle, sweep, gap to shell, width, bracket profile, max bracket spacing at the outer edge, railing options). The result is one assembly with one id and a mark. Its parts (beams, brackets, grating segments, railings, toe plates) are entities of that assembly. | CADMATIC / E3D / Plant 3D all provide these as one parametric object [S25, S26, S28]. | S25–S28 | AF-01, AF-05 | VC-STA-07, VC-STA-08 |
| FR-STA-03 | MUST   | Fixed ladders: `add_ladder` from a base point and a climb height (or a target platform), facing direction, clear width, rung pitch (default: the largest pitch that satisfies every active ruleset), exit through or side-step, fall protection `none / cage / ladder_safety_system / pfas`, installation date (drives the OSHA rule), automatic cage start and landings / rest platforms when the active ruleset requires them. A ladder attached to a platform cuts the railing and adds a self-closing gate. | Ladders are the most rule-dense access item; OSHA changed the cage rules in 2016/2018 [S4]. | S1–S6, S11–S13 | AF-31, AF-33 | VC-STA-01..03 |
| FR-STA-04 | MUST   | Steel stairs: `add_steel_stair` from a start, direction and rise (or to a level / platform), width, maximum riser, going, stringer profile, tread type (grating or checker plate), intermediate landings (count or max flight rise), railings on either or both sides. The riser count is the smallest that respects `riserMax`, and all risers are equal. | Plant stairs are steel stringer stairs; the existing `add_stair` is a concrete waist slab. | S7, S8, S14, S15 | AF-31 | VC-STA-04 |
| FR-STA-05 | MUST   | Guardrails / handrails: `add_railing` along a 3D polyline or along chosen edges of a platform / grating / stair. Parameters: height, knee-rail count, toe-plate height, post profile and maximum spacing, rail profile, openings with gates. Posts are spaced equally with a post at every end and corner. The railing follows its host. | Every open edge needs edge protection; post count drives the steel takeoff. | S9, S10, S15, S16 | AF-30 | VC-STA-05, VC-STA-08 |
| FR-STA-06 | MUST   | Pipe-rack generator: `add_pipe_rack` along a direction, with length, bent spacing (or explicit stations), width (or bays across), tier elevations, column / tier-beam / strut / bracing profiles, base fixity, longitudinal struts per tier, bracing bays, optional walkway (grating + railing on one tier) and future-space note. It makes grid lines, members with rigid tier joints (so `check_steel_members` sees moment frames transversally) and longitudinal bracing. | A pipe rack is the backbone of a unit; today it is built member by member. | S31, docs/INDUSTRIAL.md | AF-05 | VC-STA-09 |
| FR-STA-07 | SHOULD | Equipment support structures (V1): table-top for exchangers / drums (four columns + beams + grating + access), skid base frames, platforms on vessel legs. | Second most common plant structure after racks. | — | AF-05 | (V1 pack extension) |
| FR-STA-08 | SHOULD | Fireproofing (V1): `set_fireproofing` on members, by ids or by a zone (equipment ids + radius + height above grade, **all explicit**), with type (cementitious / intumescent), rating label, thickness and method (boxed / contour). `fireproofing_takeoff` returns area and volume per member and in total. The rating and the envelope come from the project; no default. | API 2218 practice; the envelope dimensions are project decisions [S29]. | S29, S30 | AF-31, AF-35 | VC-STA-10 |
| FR-STA-09 | MUST   | `check_access` (read-only): checks ladders, stairs, guardrails, platforms and open edges against the active rulesets (`iso_14122`, `osha_1910`, project tables). Each finding has a stable code, the rule id, the clause, the measured and limit values with units, the offending ids and a remediation. Grade-B rules can only warn, and do so with `STA_RULE_UNVERIFIED`. Verdict `pass / warn / fail`. Always `reviewRequired: true`. | Agent self-verification; a non-engineer owner cannot judge compliance. | access_rules.json | AF-11, AF-20, AF-30, AF-32, AF-33 | VC-STA-02..05, VC-STA-13 |
| FR-STA-10 | MUST   | `check_reachability` (read-only): builds the access graph (grade and walking surfaces as nodes; stairs and ladders as edges) and, for each target (explicit point in the MVP; valves / instruments / nozzles from 02 RTE / 03 EQP / 08 DAT in V1), returns the surface it is operated from, height above it, horizontal reach, route to grade, and the findings `STA_OPERATING_HEIGHT`, `STA_REACH`, `STA_ACCESS_NO_EGRESS`. The operating-height band and reach are explicit project inputs. | "Every valve and instrument reachable" is a standard plant review item. | S32 (B, not a default) | AF-21, AF-31 | VC-STA-11 |
| FR-STA-11 | MUST   | Agent-first behaviour: every generator is one undoable command (one feature step), deterministic ids, `--dry-run`, `data` with counts, lengths, masses and the defaulted values named; every plan in `validation/plans` runs headless. | AF baseline. | — | AF-05, AF-10, AF-13, AF-42 | VC-STA-13, VC-STA-14 |
| FR-STA-12 | MUST   | Interop: IFC export with `IfcStair` LADDER, `IfcRailing` GUARDRAIL / HANDRAIL, grating as `IfcPlate` (ObjectType GRATING) or `IfcSlab` LANDING, `IfcStairFlight` STRAIGHT, `IfcMember` STRINGER / POST / STRUT; schedules (`building_schedule` kinds `ladder`, `railing`, `grating`, `platform`); `quantity_takeoff` lines (grating m² and kg, railing m, posts ea, rungs ea); plan-sheet symbols (ladder, stair arrow, grating hatch, railing line). | Hand-off to fabricators and to the owner's asset model. | S23 | AF-12 | VC-STA-12 |
| FR-STA-13 | SHOULD | Rule tables are data with a source per row and a grade; a project can add a ruleset (company standard, national rules) as a document extension, versioned. `list_access_rules` shows what is active. | Rules change (OSHA 2036 date under proposed repeal [S6]); companies have stricter rules. | — | AF-30 | VC-STA-13 |
| FR-STA-14 | SHOULD | Associativity: a circular platform follows its vessel (move / resize); railings follow their host edges; ladders follow the platform they serve; the access steel is re-derived, not edited by hand (derivation guard, L8). | Plants are revised constantly. | — | — | VC-STA-14 |
| FR-STA-15 | SHOULD | Loads: grating self-weight and a platform imposed load (explicit kPa, named default with source) are fed to `check_steel_members` like floor slabs today. | Platform steel must be checked with its real loads. | docs/INDUSTRIAL.md | AF-31 | (V1) |
| FR-STA-16 | COULD  | Review surface: findings listed and highlighted in the desktop app, with the rule and remediation; render a view of the access (`render_view --save`). | Reviewer and multimodal agent (AF-22). | — | AF-22, AF-34 | — |
| FR-STA-17 | COULD  | Automatic access proposal (V2): for each unreachable target, propose a platform / ladder / stair plan the agent can review and apply. | Saves layout time. | — | — | — |
| FR-STA-18 | COULD  | Spiral stairs on storage tanks (V2, with 03 EQP API 650 tanks). | Tank farms. | — | — | — |

### 5.1 Object behaviour (what the owner and the agent see)

**Grating.**
- It is a walking surface with a type (for example `19-W-4 1-1/4x3/16`), a bearing-bar direction and a top level.
- It is split into panels at its supports. Each panel knows its span, mass and allowable load.
- Equipment passing through it cuts it, as `add_equipment_openings` already does for slabs.
- In plan it shows as a hatch with an arrow for the bar direction.

**Platform.**
- One object holding its framing, grating and railings.
- Editing its outline, elevation or grating type regenerates all parts. Moving it moves everything.
- A ladder or stair that arrives on it cuts its railing and adds a gate.
- It reports area, grating mass, steel mass, railing length and the number of posts.

**Circular platform.**
- Belongs to a vertical vessel. It is defined by an elevation, a start angle, a sweep, the gap to the shell and a
  width.
- Brackets are spaced on the outer edge at no more than the given spacing, with one at each end. The grating is cut
  into one segment per bracket bay.
- When the vessel moves or its diameter changes, the platform follows.

**Fixed ladder.**
- Defined by a base and a climb height, or the platform it serves.
- The rung pitch is uniform and chosen automatically to satisfy every active ruleset. If no pitch works, the command
  refuses with a code rather than bending a rule.
- The cage or ladder safety system and the landings are added where the active rulesets require them.
- The ladder records its installation date, because OSHA's rule depends on it.

**Steel stair.**
- Defined by a start, a direction and a rise, or the surface it reaches.
- All risers are equal, and their number is the smallest that respects the maximum riser.
- It has grating or plate treads, two stringers, optional landings and railings on the chosen sides.

**Railing.**
- Runs along a path or the edges of a host. It has a top rail, knee rails and a toe plate.
- Posts are spaced equally, with a post at every corner and end.
- Openings can carry gates. The railing follows its host.

**Pipe rack.**
- One object with its grid. It has bents at a spacing, tiers at given elevations, struts on every tier, and bracing in
  chosen bays.
- `check_steel_members` sees the bents as moment frames and the longitudinal bracing as the lateral system along the
  rack.

**Fireproofing (V1).**
- An attribute on steel members: type, thickness, rating label, and the extent covered.
- The extent comes from a zone that the project defines explicitly. llull never guesses a fire envelope.

## 6. Workflows

### 6.1 CLI (primary, complete)

```bash
llull search ladder                            # -> add_ladder, check_access, list_access_rules
llull describe add_circular_platform           # units of every param, what it refuses
llull run plans/sc-sta-03-vessel-circular-platform.json --validate
llull run plans/sc-sta-03-vessel-circular-platform.json --doc unit.llull --json
llull check_access --doc unit.llull --rulesets iso_14122,osha_1910 --json > access.json
llull check_reachability --doc unit.llull --targets targets.json --json
llull platform_takeoff --doc unit.llull --json
llull export_ifc --doc unit.llull --save unit.ifc
llull render_view --doc unit.llull --view iso --save access.png
```

The agent's loop is: plan → `--validate` → run → `check_access` → fix the codes (each finding names the param to change)
→ `check_reachability` → report to the owner. A failing check exits with code 1 and lists the codes.

### 6.2 MCP

Same commands in toolset `plant_structures`. The MCP prompt for the toolset gives the minimal plan (platform → railing →
ladder → check) and the unit conventions: document units for geometry; ruleset limits always reported in mm and in the
original unit.

### 6.3 Owner report (AF-36)

At the end of a job the agent gives the owner one paragraph built from `data`, in the order *done / passed / needs a
human*. For example:

> Added a half-round platform at +6.0 m on C-101 (6.75 m² grating, 294 kg) with a caged ladder from grade (24 rungs).
> `check_access` under ISO 14122 and OSHA 1910: no failures. There are 2 warnings on rules llull could not verify
> against the standard text (cage hoop spacing, toe-plate height under OSHA). Valve HV-101 can be reached from the
> platform at 0.9 m. Computed by llull, not approved: the ladder fall protection and the railings need sign-off by a
> qualified engineer.

### 6.4 UI (review / approval)

The tool picker gets an **Industrial / access** group with forms for each generator, built from the same schemas. The
review panel lists `check_access` findings, and clicking one selects the offending element. Accepting a design with
open fall-protection findings is a reviewer action (AF-34) and is recorded with the reviewer's signature (09 PLM
mechanism).

## 7. Acceptance criteria (Given / When / Then)

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-01 | grade and a platform at +7300 mm | `add_ladder { climbHeight: 7300 }` with defaults | 24 rungs at 292.0 mm, cage starting 2200 mm above the base, `data.defaults` names `rungPitchMax 300 (ISO-LAD-PITCH)` | VC-STA-01 |
| AC-02 | the same ladder with `climbHeight: 8000`, cage, installed 2026 | `check_access --rulesets osha_1910` | `STA_LADDER_CAGE_NOT_PRIMARY` fail with remediation "set fallProtection to ladder_safety_system or pfas" | VC-STA-03 |
| AC-03 | a ladder with `rungPitch: 320` | `check_access` both rulesets | ISO fail `STA_LADDER_PITCH_OUT_OF_RANGE`, OSHA no finding | VC-STA-02 |
| AC-04 | rise 3000, riserMax 180, going 280 | `add_steel_stair` | 17 risers of 176.47 mm, 2h + g = 632.94 mm, 32.22°, run 4480 mm; `check_access` pass | VC-STA-04 |
| AC-05 | a stair with going 200 mm | `check_access --rulesets osha_1910` | `STA_STAIR_TREAD` fail (200 < 241.3 mm, 1910.25(c)(3)) | VC-STA-04 |
| AC-06 | a 1000 mm railing without knee rail or toe plate | `check_access` | ISO fails `STA_RAIL_HEIGHT_LOW`, `STA_RAIL_GAP`, `STA_TOE_PLATE_MISSING`; OSHA: no height finding, toe-plate warn + `STA_RULE_UNVERIFIED` | VC-STA-05 |
| AC-07 | 19-W-4 1-1/4 x 3/16 grating over 609.6 / 914.4 / 1800 mm spans | `check_grating` at 4.788 kPa, 6.35 mm | allowable 70.88 / 31.50 kPa (= 1480 / 658 psf of two tables); 1800 mm span fails `STA_GRATING_DEFLECTION` | VC-STA-06 |
| AC-08 | vessel OD 3000, gap 150, width 1000, 180° | `add_circular_platform` + `platform_takeoff` | area 6.7544 m², grating 293.5 kg, railing 10.325 m, 7 posts on the outer arc | VC-STA-07 |
| AC-09 | 60 m rack, 6 m bents, 2 tiers | `add_pipe_rack` | 11 bents, 22 columns, 22 tier beams, 40 struts, 33 716.4 kg excluding bracing; `check_steel_members` analyses every member | VC-STA-09 |
| AC-10 | HEB300 column, boxed 40 mm, 9.0 m zone | `fireproofing_takeoff` | 10.8 m², 0.4896 m³; result names the zone height as project input | VC-STA-10 |
| AC-11 | HV-101 900 mm above a platform reached by a ladder | `check_reachability` with band 0–1800 mm | ok, route grade → ladder → platform; without the ladder `STA_ACCESS_NO_EGRESS` | VC-STA-11 |
| AC-12 | a model with a ladder, railing, grating, steel stair | `export_ifc` | entities and predefined types per FR-STA-12, all strings present in the IFC 4.3 enums | VC-STA-12 |
| AC-13 | any `check_access` run | — | `reviewRequired: true`; every finding has code, rule id, clause, measured, limit, ids, remediation | VC-STA-13 |
| AC-14 | any plan of this pack | run twice | identical ids and `data`; input documents unchanged (`is pure`) | VC-STA-14 |

## 8. Standards and regulatory alignment

| Standard / regulation | Status in llull | Notes |
| --------------------- | --------------- | ----- |
| ISO 14122-1:2016 (choice of access) | cited, not encoded | the choice between stair / stepladder / ladder by angle is a V1 rule once the clause is read |
| ISO 14122-2:2016 platforms and walkways | width 600 / 800 and headroom 2100 encoded (A) | edition under revision [S17] |
| ISO 14122-3:2016 stairs, stepladders, guard-rails | 2h + g 600–660, width 600, guard-rail 1100, gaps 500, toe plate 100 (A); headroom 2300, flight rise 3000, toe gap 12 (B) | formula from the 2001 text; 2016 edition assumed the same until read |
| ISO 14122-4:2016 fixed ladders | pitch 225–300, fall protection from 3000, cage start 2200–3000 (A); width, hoop spacing, cage diameter, stile extension (B); flight height (C) | |
| 29 CFR 1910.23 ladders | pitch 10–14 in, width 16 in, back clearance 7 in, rail extension 42 in (A) | |
| 29 CFR 1910.25 stairways | 30–50°, riser ≤ 9.5 in, tread ≥ 9.5 in, width ≥ 22 in (A); landings (B) | stairs before 2017-01-17 deemed compliant via Table D-1 (not encoded) |
| 29 CFR 1910.28(b)(9) fixed-ladder fall protection | > 24 ft: LSS / PFAS for ladders installed from 2018-11-19; cage landings 50 ft (A); 2036 retrofit (B, proposed repeal) | `reviewRequired` always |
| 29 CFR 1910.29 guardrails, toeboards | 42 ± 3 in, 200 lbf (A); midrail, 150 lbf, 19 in, 3.5 in toeboard (B) | llull does not verify strength of the railing — it records the test-load requirement in the finding |
| ANSI/NAAMM MBG 531 / 534 | F 18 ksi, E 29 000 ksi, load convention (A via two tables) | metric tables (RAL-GZ 638) not found |
| API RP 2218, UL 1709 | scope only | envelope and rating are project inputs |
| IFC 4.3 (ISO 16739-1:2024) | enums copied | — |

## 9. KPIs

| KPI | Target |
| --- | ------ |
| Commands needed for "column platform + ladder + railing" | ≤ 3 plan steps (platform with railing, ladder, check) |
| VCs passing | 14 / 14 at V1, all grade-A thresholds |
| Rule coverage | every grade-A row of `access_rules.json` has a code and a test |
| `check_access` on 2 000 access elements | < 2 s (TECHNICAL_SPEC §8) |
| False "pass" on the negative plan SC-STA-05 | 0 |
| Agent run of the 7 scenario plans | unattended, exit codes only |

## 10. Risks and assumptions

| Risk | Mitigation |
| ---- | ---------- |
| ISO 14122 text not read in full; some values only from vendor extracts | grade-aware severities: B warns, C not loaded; the reviewer is always required; buy and read the 2016 parts before V1 |
| OSHA rule changes (2036 date proposed for repeal, 2026) | rule table versioned; a finding names the rule-table version; `reviewRequired` |
| Owner reads "pass" as "safe" | wording "meets the encoded geometric rules of <ruleset>; not approved"; strength of railings / ladder anchorage not checked and said so |
| Grating tables differ between manufacturers (serrated bars, bar thickness tolerances) | catalogue rows carry `verified` and the manufacturer; computed types flagged `unverified` (AF-32) |
| Generated geometry clashes with piping / equipment | `check_clashes` already covers members and slabs; new elements join its sets |
| Overlap with 03 EQP (vessel platforms, skirts) and 02 RTE (valve positions) | this gap owns access objects; it reads vessel geometry from `EquipmentElement` now and from 03 EQP later; targets from 02/08 in V1 |
| Large plants: tens of thousands of grating segments and posts | instanced rendering per 09 VIS; elements store parameters, entities are derived |

## 11. References

Source ids S1–S32 are listed with URLs and grades in [validation/sources.md](validation/sources.md) (accessed 2026-10).
Main ones:

- [S1] 29 CFR 1910.23 Ladders — OSHA — https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.23
- [S4] OSHA standard interpretation 2021-09-28 — https://www.osha.gov/laws-regs/standardinterpretations/2021-09-28
- [S7] 29 CFR 1910.25 Stairways — eCFR — https://www.ecfr.gov/current/title-29/subtitle-B/chapter-XVII/part-1910/subpart-D/section-1910.25
- [S9] 29 CFR 1910.29 — OSHA — https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.29
- [S11] ISO 14122-4:2016 — ISO — https://www.iso.org/standard/61283.html
- [S14] EN ISO 14122-3 — text extract (2001 edition)
- [S17] ISO 14122-2:2016 — ISO — https://www.iso.org/standard/61282.html
- [S19] ANSI/NAAMM MBG 531 / 534 — NAAMM — https://www.naamm.org/division/publications/8
- [S20] Grating Pacific 19-space steel grating load table — https://gratingpacific.com/wp-content/uploads/2019/05/LOAD-TABLE-19-SPACE-STEEL-BAR-GRATING-GP.pdf
- [S21] Marco Specialty Steel 19-W-4 load table — https://www.marcospecialtysteel.com/content/uploads/2016/09/Bar-Grating-Load-Deflection-Table-19-W-4.pdf
- [S23] buildingSMART IFC 4.3 — https://github.com/buildingSMART/IFC4.3.x-development
- [S25] CADMATIC circular platform — https://docs.cadmatic.com/plant/
- [S26] AVEVA E3D SLH — https://docs.aveva.com/bundle/e3d-design/page/1041135.html
- [S29] API RP 2218 — catalogue page
- [S31] AISC Engineering Journal pipe-rack article — https://ej.aisc.org/index.php/engj/article/download/991/990

Sibling gaps referenced (not re-specified here): 02-spec-driven-routing (valves, routed lines), 03-parametric-equipment
(vessel geometry, skirts, nozzles, API 650 tanks), 08-plant-data-reports-interop (tag registry, IFC 4.3 process export),
09-plant-visualization-review (instancing, review sessions), 10-pointcloud-brownfield (as-built access check).
