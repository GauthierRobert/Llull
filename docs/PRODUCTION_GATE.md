# Production gate — can an engineering office use llull?

`npm run check` proves the code is consistent; the [quality gates](QUALITY_GATES.md) prove llull
handles real CAD files. The production gate asks the question a client asks: **can a bureau
d'études do a real job with llull and issue the deliverables?**

The first client profile is a process-plant EPC office (Desmet type: oilseed extraction, refining,
biodiesel plants); the second is a civil / site engineering office (site development: survey,
earthworks, access road, storm drainage — see the [pilot kit](PILOT.md)). Each scenario is one real job: a brief from the lead engineer, the model to
build, and the acceptance criteria the office checks before anything leaves the building.

```bash
npx vitest run tests/production   # in-process scripted run, part of npm run check (seconds)
npm run production:scripted       # the same calls through the real /mcp endpoint
npm run production:ui             # a human-like flow in the browser (Playwright)
npm run production:agent          # Claude gets only the brief and works through /mcp (API credentials, costs money)
# agent env: PRODUCTION_SCENARIOS, PRODUCTION_AGENT_MODEL (claude-opus-5-5), PRODUCTION_AGENT_EFFORT (high),
#            PRODUCTION_AGENT_MAX_TURNS (150), PRODUCTION_AGENT_TRIALS (1), PRODUCTION_AGENT_MAX_USD (20 per trial)
npm run production                # scripted + ui
```

Reports land in `.cache/production/reports/<driver>/<scenario>.json`, with
`.cache/production/reports/SUMMARY.md` across every driver (✅ pass · ⚠️ known gap · ❌ regression).
The agent driver also stores its transcript and final project file, and records token use and the
estimated spend; a trial stops when its estimate reaches `PRODUCTION_AGENT_MAX_USD`.

## One scenario, three drivers, one grader

| Driver     | Who does the job                                                                                                  | Proves                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `scripted` | the tool calls a competent engineer makes, sent over `/mcp` (toolsets discovered and enabled like any MCP client) | the product can do the job                        |
| `ui`       | Playwright drives the Building panel, properties, export buttons, Save / Open project                             | a person can do the job in the app                |
| `agent`    | Claude, given only the brief, through `/mcp`                                                                      | an AI designer can do the job from the same brief |

All three are graded by the same criteria (`tests/production/criteria/`), which read only the
final document and the issued files. Files are read back with **independent parsers**
(`tests/production/oracle/`: IFC STEP, DXF, SVG sheets, CSV) and checked against **independent
references** (EN 10365 / EN 10210 section tables, EN 10220 pipe ODs, plain-maths geometry), never
against llull's own code paths. The brief, the script and the criteria are generated from one
design intent (`tests/production/plant/intent.ts`), so they cannot disagree.

### The ratchet

`scenario.knownIssues[driver]` lists the criteria that fail today. The scripted and UI gates are
green when **exactly** those fail: a new failure is a regression, and a known issue that starts
passing must be removed. The agent is non-deterministic, so it is scored on the **job** only:
the criteria that fail on the starting document and are not known product gaps must pass, and a
criterion that passed at the start and fails at the end (the agent broke it) counts against it.
Each trial must complete at least `scenario.agentBaseline` of that (`PRODUCTION_AGENT_TRIALS` for
pass^k); raise the baseline as llull improves. Doing nothing scores 0, whatever vacuous checks
stay green.

## Scenarios

| id                             | job                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desmet-extraction-building`   | Solvent extraction building of a 2 000 t/d soybean plant: 24 × 15 m, 4 levels (±0, +6, +12, +18), HEB300 columns, IPE450 / IPE300 floor beams under 30 mm gratings, 36 CHS bracing diagonals, extractor / desolventizer-toaster / miscella tank / conditioner (162 t operating), floor openings, two stair flights, four process lines with battery-limit tie-ins. Issue: IFC, DXF and plan sheet per level, south elevation, schedules, takeoff, project file. |
| `desmet-extraction-revision-b` | Change order on the issued model: extractor uprated (18 m, 72 t), pump E-502 and line L-105 added, revision B. The office edits the model; every untouched element must keep its id, mark and IFC GlobalId.                                                                                                                                                                                                                                                     |
| `desmet-pipe-rack`             | Inter-unit pipe rack: 54 m, 10 moment-frame bents (HEB240 / IPE300, rigid joints) with tiers at +5.0 and +6.5 m, IPE240 stringers and mid-bay tier beams (a shoe every 3 m), nine lines DN50–DN300 battery limit to battery limit, a 600 mm cable tray, a road crossing needing 4.5 m clear. Rack checks: every line supported at every bent, clear height, line spacing, line metres per DN across design / takeoff / schedule.                                |
| `civil-site-development`       | Civil office job on the pilot sample survey (911 points, local grid, metres): existing-ground TIN, 50 × 40 m building pad balanced with swell 1.1, 130 m access road (R 60 m, 40 m clothoids, profile, 3 m lanes, 6 % superelevation, 40 km/h), four-manhole storm network sized against an IDF curve with an HGL check from the stream tailwater. Issue: plan-profile sheet (A2), LandXML, project file. |

## Acceptance criteria

| area                       | criteria                                                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| structure                  | levels, grid, columns, floor beams, bracing (every member at its absolute axis, right section), floors, steel tonnage vs an independent section table                                                                                         |
| equipment                  | tags placed (level, position, envelope, weight, clearance), gratings cut where equipment passes through a floor, elevated equipment standing on a floor                                                                                       |
| piping                     | lines between their ends at DN outside diameter and routed length, no dangling pipe end, a line list (number, DN, from, to), supports within the standard span                                                                                |
| coordination / engineering | clash-free, stair flights (rise, 2R+G, wells), every steel member verified and passing, every storey braced or framed in both directions                                                                                                      |
| deliverables               | IFC (well-formed, unique GlobalIds, counts, profiles, storeys + containment, equipment weights), DXF plans (cut columns, equipment, grid), plan sheets (ISO paper, standard scale, title block, tags), elevation datums, schedules vs takeoff |
| data integrity             | save → reopen identical, history replay identical; revisions keep ids, marks and GlobalIds                                                                                                                                                    |
| civil (survey → drainage)  | every survey point at its E/N/Z with its code; TIN over the survey hull (±1 %) with the exact z range; pad on the brief outline balanced (\|cut × swell − fill\| < 1 % of fill, level within 0.5 m of the mean surveyed ground); road through the brief PIs with clothoids ≥ Barnett's minimum, the brief template and superelevation, no `alignment_report` design-check failure at the design speed, grades ≤ 8 %, full banking reached, profile over the whole road; storm network falling pipe by pipe to the outfall in commercial sizes, no surcharged pipe / flooding manhole / check failure under the IDF storm and tailwater, Manning full-bore capacity (computed independently) ≥ design flow; plan-profile sheet on ISO A2 at a standard scale with title block; LandXML well-formed (independent reader) with CgPoints, TIN Surface, Alignment (spirals + profile) and PipeNetwork, pipe slopes = invert drop / length as ratios |

## Results (2026-10)

| scenario            | scripted | ui      | agent                           |
| ------------------- | -------- | ------- | ------------------------------- |
| extraction building | 27 / 27  | 27 / 27 | not run (needs API credentials) |
| revision B          | 30 / 30  | 30 / 30 | not run                         |
| pipe rack           | 28 / 28  | 28 / 28 | not run                         |
| civil site          | 11 / 11  | 11 / 11 | not run                         |

Every acceptance criterion passes through `/mcp` and through the browser; `knownIssues` is empty
for both drivers. The structure, equipment, lines, openings and stairs are modelled exactly; the
model is clash-free; the steel tonnage matches an independent table to 0.02 %; every steel member
passes `check_steel_members` and every storey has a lateral system (bracing or moment frames) in
both directions; every line is carried on supports within its standard span; the IFC parses with unique GlobalIds, correct storeys, containment and
equipment weights; DXF plans and plan sheets show the columns crossing each level and a complete
title block; the line list carries line number, DN, from and to; schedules agree with the takeoff;
the project reopens and replays identically; a revision keeps every id, mark and IFC GlobalId.

The civil scenario (added with the [pilot kit](PILOT.md)) passes all 11 criteria in-process
(`npx vitest run tests/production`), through `/mcp` (`npm run production:scripted`, 23 calls) and in
the browser (`npm run production:ui`, 23 / 23 calls through Civil / Site panel controls, no palette
detour). Its UI report still lists four `uiGaps`: the panel has no field for `minVelocity` /
`diameters` on sizing or `minCoverM` / `minVelocity` on the check — the defaults equal the brief's
values here, so the outcome is unaffected. Balance residual 0.01 %; design checks at 40 km/h all
pass; no surcharged or flooding pipe (Ø225 / Ø300 / Ø375); LandXML 911 CgPoints, 1 705 faces, 2
spirals, 4 structures / 3 pipes.

Run of 2026-10-09 (`npm run production`): scripted 4 / 4 scenarios green; UI 3 / 4 on the first
pass — `desmet-extraction-revision-b` failed in the harness, not the product: the element inspector
now renders the same equipment editor as the Equipment section, so `equipment-edit-*` matched two
inputs (Playwright strict mode). The UI driver now scopes the editor to the Equipment section
(`tests/production/ui/panel.ts`); re-run: revision B 30 / 30.

### Gaps the gate found, and how they were closed

| #   | gap (first run)                                                                          | criterion             | fix                                                                                                              |
| --- | ---------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | No line list: a pipe had no line number, DN, from / to                                   | `line-list`           | `add_pipe_run` takes `line`, `dn` (OD from the DN table), `from`, `to`; the pipe schedule is a line list         |
| 2   | No structural verification outside portal frames (0 / 117 and 0 / 48 members)            | `structural-coverage` | `check_steel_members` (EN 1993, loads from the model — see INDUSTRIAL.md)                                        |
| 3   | IFC equipment had no property set (operating weight)                                     | `ifc-equipment-data`  | `Pset_llullEquipment` (operating weight, clearance), GlobalIds stable across revisions                           |
| 4   | Upper-floor plans did not draw the columns passing through                               | `dxf-plans`           | plans / DXF draw every column crossing the level's cut height                                                    |
| 5   | The default `/mcp` rate limit (60 / min / IP) throttled a real job (140–300 calls)       | —                     | default raised to 600 / min; the gate asserts every job fits it                                                  |
| 6   | UI: no slab material, no equipment tag, no equipment editing, no level picker on exports | (UI driver)           | Building panel fields, Equipment section editor (`update_equipment`), "Export level" picker; no palette fallback |
| 7   | Design: IPE450 main beams under the 60 t extractor fail deflection (1.05)                | `structural-coverage` | the scenario design was corrected (IPE500), as an engineer would — the check was not weakened                    |
| 8   | No pipe supports: line weight never reached the steel, spans unchecked                   | `pipe-supports`       | `add_pipe_support` (shoe / hanger / guide / anchor on steel) and `check_pipe_supports` (MSS SP-69 spans)         |
| 9   | Only braced frames: a pipe rack's bents had no verifiable transverse stability           | `lateral-stability`   | rigid joints / base fixity on steel members; `check_steel_members` solves moment frames (N+M, sway, αcr)         |
| 10  | Design: 6 m rack bents exceed the support span of 7 of 9 lines                           | `pipe-supports`       | the rack design was corrected: stringers and mid-bay tier beams, a shoe every 3 m                                |
| 11  | Risers were not checked; supports kept a dangling member after edits; no plan symbol     | `pipe-supports`       | riser rule (guide spacing, weight carried), supports re-attach on delete / move / copy, P-SUPP plan symbols      |
| 12  | Civil UI: no spiral, superelevation, IDF, outfall-level, sheet-paper or document-unit control | (UI driver, civil)    | Civil / Site panel: Spiral lengths, Superelevation, IDF a / b / c, Outfall level, Sheet paper, Work in metres     |
| 13  | Civil: the profile cannot end exactly at the road end (end station shown to 1 cm, a PVI past it is refused) | `road-design-checks`  | closed: `set_alignment_profile` snaps end PVIs within 5 cm onto the alignment start / end (the scenario's 130.00 m PVI still passes; the criterion's 5 cm tolerance is kept) |

`check_steel_members` warnings left are informational: equipment standing on grade (carried by
foundations, not by the steel). The two long risers (into the extractor, out of the desolventizer)
are guided from HEA100 posts and pass the riser rule.

The UI driver does every call through the Building panel forms: no command-palette fallback and no
`uiGaps`. Placement is explicit (each form has a Level selector), equipment is revised in the
Equipment section's editor (`update_equipment`: same id, tag and GlobalId), and plan / DXF exports
take an "Export level" picker. Any call without a panel control is still recorded as a `uiGap`.

## Adding a scenario

1. Write a `PlantIntent` (or a new intent type for another kind of job) in `tests/production/scenarios/`.
2. Build the `Scenario` from `plantBrief`, `plantScript` and the criteria factories; add
   job-specific criteria in `tests/production/criteria/`.
3. Register it in `tests/production/scenarios/index.ts`, run `npx vitest run tests/production`,
   and record what fails as `knownIssues.scripted` — each entry must be a real llull gap.
4. Add a UI flow in `tests/production/ui/` and record `knownIssues.ui`.
