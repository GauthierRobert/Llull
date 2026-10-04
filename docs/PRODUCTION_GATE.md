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

| Driver | Who does the job | Proves |
| ------ | ---------------- | ------ |
| `scripted` | the tool calls a competent engineer makes, sent over `/mcp` (toolsets discovered and enabled like any MCP client) | the product can do the job |
| `ui` | Playwright drives the Building panel, properties, export buttons, Save / Open project | a person can do the job in the app |
| `agent` | Claude, given only the brief, through `/mcp` | an AI designer can do the job from the same brief |

All three are graded by the same criteria (`tests/production/criteria/`), which read only the
final document and the issued files. Files are read back with **independent parsers**
(`tests/production/oracle/`: IFC STEP, DXF, SVG sheets, CSV) and checked against **independent
references** (EN 10365 / EN 10210 section tables, EN 10220 pipe ODs, plain-maths geometry), never
against llull's own code paths. The brief, the script and the criteria are generated from one
design intent (`tests/production/plant/intent.ts`), so they cannot disagree.

### The ratchet

`scenario.knownIssues[driver]` lists the criteria that fail today. The scripted and UI gates are
green when **exactly** those fail: a new failure is a regression, and a known issue that starts
passing must be removed. The agent is non-deterministic, so it must pass at least
`scenario.agentBaseline` of the criteria per trial (`PRODUCTION_AGENT_TRIALS` for pass^k); raise
the baseline as llull improves.

## Scenarios

| id | job |
| -- | --- |
| `desmet-extraction-building` | Solvent extraction building of a 2 000 t/d soybean plant: 24 × 15 m, 4 levels (±0, +6, +12, +18), HEB300 columns, IPE450 / IPE300 floor beams under 30 mm gratings, 36 CHS bracing diagonals, extractor / desolventizer-toaster / miscella tank / conditioner (162 t operating), floor openings, two stair flights, four process lines with battery-limit tie-ins. Issue: IFC, DXF and plan sheet per level, south elevation, schedules, takeoff, project file. |
| `desmet-extraction-revision-b` | Change order on the issued model: extractor uprated (18 m, 72 t), pump E-502 and line L-105 added, revision B. The office edits the model; every untouched element must keep its id, mark and IFC GlobalId. |
| `desmet-pipe-rack` | Inter-unit pipe rack: portal bents on two tiers, process and utility lines, cable tray, road crossing. |

## Acceptance criteria

| area | criteria |
| ---- | -------- |
| structure | levels, grid, columns, floor beams, bracing (every member at its absolute axis, right section), floors, steel tonnage vs an independent section table |
| equipment | tags placed (level, position, envelope, weight, clearance), gratings cut where equipment passes through a floor, elevated equipment standing on a floor |
| piping | lines between their ends at DN outside diameter and routed length, no dangling pipe end, a line list (number, DN, from, to) |
| coordination / engineering | clash-free, stair flights (rise, 2R+G, wells), every steel member covered by a structural check |
| deliverables | IFC (well-formed, unique GlobalIds, counts, profiles, storeys + containment, equipment weights), DXF plans (cut columns, equipment, grid), plan sheets (ISO paper, standard scale, title block, tags), elevation datums, schedules vs takeoff |
| data integrity | save → reopen identical, history replay identical; revisions keep ids, marks and GlobalIds |

## Adding a scenario

1. Write a `PlantIntent` (or a new intent type for another kind of job) in `tests/production/scenarios/`.
2. Build the `Scenario` from `plantBrief`, `plantScript` and the criteria factories; add
   job-specific criteria in `tests/production/criteria/`.
3. Register it in `tests/production/scenarios/index.ts`, run `npx vitest run tests/production`,
   and record what fails as `knownIssues.scripted` — each entry must be a real llull gap.
4. Add a UI flow in `tests/production/ui/` and record `knownIssues.ui`.
