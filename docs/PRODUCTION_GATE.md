# Production gate — can an engineering office use llull?

`npm run check` proves the code is consistent; the [quality gates](QUALITY_GATES.md) prove llull
handles real CAD files. The production gate asks the question a client asks: **can a bureau
d'études do a real job with llull and issue the deliverables?**

The first client profile is a process-plant EPC office (Desmet type: oilseed extraction, refining,
biodiesel plants). Each scenario is one real job: a brief from the lead engineer, the model to
build, and the acceptance criteria the office checks before anything leaves the building.

```bash
npx vitest run tests/production   # in-process scripted run, part of npm run check (seconds)
npm run production:scripted       # the same calls through the real /mcp endpoint
npm run production:ui             # a human-like flow in the browser (Playwright)
npm run production:agent          # Claude gets only the brief and works through /mcp (API credentials, costs money)
npm run production                # scripted + ui
```

Reports land in `.cache/production/reports/<driver>/<scenario>.json`, with
`.cache/production/reports/SUMMARY.md` across every driver (✅ pass · ⚠️ known gap · ❌ regression).
The agent driver also stores its transcript and final project file.

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
| `desmet-pipe-rack`             | Inter-unit pipe rack: 54 m, 10 portal bents (HEB240 / IPE300) with tiers at +5.0 and +6.5 m, nine lines DN50–DN300 battery limit to battery limit, a 600 mm cable tray, a road crossing needing 4.5 m clear. Rack checks: every line supported at every bent, clear height, line spacing, line metres per DN across design / takeoff / schedule.                                                                                                                |

## Acceptance criteria

| area                       | criteria                                                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| structure                  | levels, grid, columns, floor beams, bracing (every member at its absolute axis, right section), floors, steel tonnage vs an independent section table                                                                                         |
| equipment                  | tags placed (level, position, envelope, weight, clearance), gratings cut where equipment passes through a floor, elevated equipment standing on a floor                                                                                       |
| piping                     | lines between their ends at DN outside diameter and routed length, no dangling pipe end, a line list (number, DN, from, to)                                                                                                                   |
| coordination / engineering | clash-free, stair flights (rise, 2R+G, wells), every steel member covered by a structural check                                                                                                                                               |
| deliverables               | IFC (well-formed, unique GlobalIds, counts, profiles, storeys + containment, equipment weights), DXF plans (cut columns, equipment, grid), plan sheets (ISO paper, standard scale, title block, tags), elevation datums, schedules vs takeoff |
| data integrity             | save → reopen identical, history replay identical; revisions keep ids, marks and GlobalIds                                                                                                                                                    |

## Results (2026-10)

| scenario            | scripted | ui      | agent                           |
| ------------------- | -------- | ------- | ------------------------------- |
| extraction building | 25 / 25  | 25 / 25 | not run (needs API credentials) |
| revision B          | 28 / 28  | 28 / 28 | not run                         |
| pipe rack           | 26 / 26  | 26 / 26 | not run                         |

Every acceptance criterion passes through `/mcp` and through the browser; `knownIssues` is empty
for both drivers. The structure, equipment, lines, openings and stairs are modelled exactly; the
model is clash-free; the steel tonnage matches an independent table to 0.02 %; every steel member
passes `check_steel_members`; the IFC parses with unique GlobalIds, correct storeys, containment and
equipment weights; DXF plans and plan sheets show the columns crossing each level and a complete
title block; the line list carries line number, DN, from and to; schedules agree with the takeoff;
the project reopens and replays identically; a revision keeps every id, mark and IFC GlobalId.

### Gaps the gate found, and how they were closed

| #   | gap (first run)                                                                          | criterion             | fix                                                                                                              |
| --- | ---------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | No line list: a pipe had no line number, DN, from / to                                   | `line-list`           | `add_pipe_run` takes `line`, `dn` (OD from the DN table), `from`, `to`; the pipe schedule is a line list         |
| 2   | No structural verification outside portal frames (0 / 117 and 0 / 48 members)            | `structural-coverage` | `check_steel_members` (EN 1993, loads from the model — see INDUSTRIAL.md)                                        |
| 3   | IFC equipment had no property set (operating weight)                                     | `ifc-equipment-data`  | `Pset_llullEquipment` (operating weight, clearance), GlobalIds stable across revisions                           |
| 4   | Upper-floor plans did not draw the columns passing through                               | `dxf-plans`           | plans / DXF draw every column crossing the level's cut height                                                    |
| 5   | The default `/mcp` rate limit (60 / min / IP) throttled a real job (140–300 calls)       | —                     | default raised to 600 / min; the gate runs on default server settings                                            |
| 6   | UI: no slab material, no equipment tag, no equipment editing, no level picker on exports | (UI driver)           | Building panel fields, Equipment section editor (`update_equipment`), "Export level" picker; no palette fallback |
| 7   | Design: IPE450 main beams under the 60 t extractor fail deflection (1.05)                | `structural-coverage` | the scenario design was corrected (IPE500), as an engineer would — the check was not weakened                    |

`check_steel_members` still warns (without failing) about two things the scenario designs leave
out: the process lines of the extraction building rest on no modelled pipe support, and the pipe
rack's transverse bents have no modelled stability system. Both are next scenario refinements.

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
