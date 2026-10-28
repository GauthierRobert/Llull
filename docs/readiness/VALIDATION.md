# Professional readiness gate — the validation layer

Status: specified 2026-10-28; not built. Owner question: "is the app usable by a professional engineer in their day-to-day work?"
This gate turns that question into a single verdict computed from the nine packs' validation cases, so the answer is measured
rather than asserted. Machine index: [`readiness_gate.json`](readiness_gate.json). VC record schema:
[`vc.schema.json`](vc.schema.json).

It sits on top of the two existing gates and does not replace them:

| Gate | Asks | Lives in |
| ---- | ---- | -------- |
| `npm run check` | is the code consistent? | typecheck, arch, lint, unit / golden / contract tests |
| Quality gates | does llull handle real CAD files? | [`../QUALITY_GATES.md`](../QUALITY_GATES.md) |
| Production gate | can an office do one scripted job and issue the deliverables? | [`../PRODUCTION_GATE.md`](../PRODUCTION_GATE.md) |
| **Readiness gate** | **can a professional work in llull every day: install it, trust it, be fast in it, exchange files, sign its results, buy and get support for it, and has that been shown with real users?** | this file |

## 1. Professional Readiness Levels (PRL)

A level is reached when **every gating MUST case** assigned to it, and to every level below it, passes on the required machine
profiles. Levels are cumulative; the gate reports the highest level reached and the cases blocking the next one.

| Level | Name | Means for an engineer | Packs (default level of their cases) | Exit evidence |
| ----- | ---- | --------------------- | ------------------------------------ | ------------- |
| PRL 0 | Capable | the commands exist and pass scripted jobs | — | today: `npm run check` + production gate green |
| PRL 1 | Installable and observable | installs on a locked-down office PC with no admin and no internet, every component works, and the shipped app is under automated test | 05 INS, 06 E2E | clean-VM matrix green; Electron harness drives the packaged app on 3 OSs |
| PRL 2 | Trustworthy | never loses work, never corrupts a file, stays responsive on real model sizes | 04 DSF, 03 PRF | fault-injection suite green; perf corpus within budget on `office-min` |
| PRL 3 | Daily-capable | the daily gestures are as efficient as the incumbent's, daily files round-trip, engineering results can be signed | 02 UXD, 08 XCH, 07 VNV | task benchmark within ratio; real-file corpus round-trips; worked-example V&V record complete |
| PRL 4 | Adoptable | an office can license it offline, read the help in its language, get support, and meet its legal duties | 09 COM | air-gapped activation, translated UI, help coverage 100 %, CRA / PLD checklist reviewed |
| PRL 5 | Field-proven | real offices did their real jobs in it and met the quantitative "usable daily" criteria | 01 PIL | pilot exit criteria met in ≥ the number of offices and personas set by pack 01 |

**The owner may state "usable by a professional engineer day to day" only at PRL 5**, and only for the personas whose pilots
met the criteria (a civil-site pass does not make llull a mechanical CAD replacement). Below PRL 5 the honest statement is the
level reached, e.g. "PRL 3: daily-capable in the lab, not field-proven".

A pack may assign an individual case to a lower level than its default when the case is a prerequisite (example: the
crash-detection self-test of the Electron harness is PRL 1 even though crash *recovery* is a PRL 2 case of pack 04).

## 2. What counts as a pass

Grading follows the plant template ([`../plant/TEMPLATE.md`](../plant/TEMPLATE.md)) with one addition, the spec budget:

| Case kind | `grade` | `gating` | Pass when |
| --------- | ------- | -------- | --------- |
| Reference value read in a primary source, measured, or a cited closed form | A | true | measured value within `tolerance` of `expected` |
| Budget set by a pack (latency, ratio, count, presence of a code) | target | true | measured value satisfies `target` (`op`, `value`) |
| Reference from one secondary extract | B | false | reported, never blocks; the pack must upgrade it to A or drop it before the level it sits in is claimed |
| Located, not confirmed | C | false | reported only |

- A **SHOULD** case never blocks a level; the report lists it. A **COULD** case is informational.
- A case whose `driver` cannot run in the current environment (no VM host, no pilot data yet) is **skipped**, and a skipped
  gating MUST case **blocks** its level. Skipping never counts as passing.
- A `review` case passes only with a stored review record (§5): reviewer role, date, scope, decision, the artefacts hashed.
- **Ratchet** (as the production gate): `knownIssues` in `readiness_gate.json` lists gating cases that fail today. The run is
  green when exactly those fail; a new failure is a regression; a known issue that starts passing must be removed from the list
  in the same change. Known issues block their level; the ratchet only stops silent regressions in the meantime.

## 3. Drivers and runners

Every case declares one driver. Each driver has one runner that takes a pack's `expected_results.json` plus a list of VC ids and
writes one result record per case (§4). Runners are built by the pack that owns them; the gate only orchestrates.

| Driver | Runner (owner pack) | Environment | Runs in |
| ------ | ------------------- | ----------- | ------- |
| `unit` | vitest (`tests/readiness/<pack>/`) | node, no app | `npm run check` (fast cases only) |
| `cli` | `llull` CLI scripts against a document or `--server` | any dev / CI machine | `npm run readiness -- --driver cli` |
| `electron` | Electron harness (06 E2E) | dev build or packaged app, fixed window / DPI / GPU backend | `npm run readiness -- --driver electron` |
| `fault` | fault-injection runner (04 DSF): kill during save, disk full, corrupt bytes, concurrent writers, network share | local machine, scratch volume | nightly |
| `perf` | perf corpus runner (03 PRF) on a named machine profile | reference machines only, nothing else running (heavy lock) | nightly; release |
| `install-vm` | clean-VM matrix (05 INS) | disposable VMs from fixed images, offline | release candidate |
| `field` | pilot evidence importer (01 PIL): session-metrics exports, SUS sheets, task timings | pilot offices, anonymised, user-exported | after each pilot |
| `review` | review-record checker | human reviewer (qualified engineer, counsel, IT admin) | when the artefact changes |

Cadence: `unit` on every commit; `cli` + `electron` on every merge to main; `fault` + `perf` nightly; `install-vm` per release
candidate; `field` and `review` when their evidence changes. A release may only carry the PRL its candidate build reached on
all runs of that build — results from an older commit never count (§4 `commit`).

## 4. Result record and report

Each runner writes `.cache/readiness/results/<driver>/<VC id>.json`:

```json
{
  "id": "VC-PRF-04",
  "status": "pass | fail | known | skipped",
  "measured": 0.0,
  "unit": "s",
  "target": { "op": "<=", "value": 0.0 },
  "machineProfile": "office-min",
  "commit": "<git sha of the build under test>",
  "build": "dev | packaged <version>",
  "startedAt": "<ISO 8601>",
  "durationMs": 0,
  "artefacts": ["<relative paths: screenshots, logs, dumps, reports, with sha256>"],
  "skipReason": "<only when skipped>",
  "note": "<free text, never parsed>"
}
```

`npm run readiness` (to build, M-G1 below) then:

1. validates every pack index against [`vc.schema.json`](vc.schema.json) and the cross-pack rules (§6);
2. runs the drivers requested (`--driver`, `--pack`, `--level`, `--vc`), or only reads stored results (`--report`);
3. writes `.cache/readiness/REPORT.md` and `.cache/readiness/report.json`:
   - the PRL reached, per persona and overall;
   - for the next level: every blocking case (id, pack, metric, measured vs target, last run, artefacts);
   - per pack: MUST / SHOULD / COULD pass counts, grade B / C debt, skipped cases and why;
   - regressions against the previous report on the same machine profile (any case pass → fail, any budget worse by > 20 %);
4. exits non-zero on a regression or a schema / traceability error; a level not reached is reported, not an error.

## 5. Human evidence (`review` and `field`)

Some proofs cannot be automated: a qualified engineer signing a V&V record, counsel reading the EULA, an IT administrator
deploying silently, an office comparing volumes with Civil 3D. They still go through the gate:

- Stored under `docs/readiness/<pack>/validation/records/<VC id>-<date>.md` with a front-matter block: `vc`, `role` (never a
  name unless the person agrees), `date`, `scope`, `decision` (accept / reject / accept-with-conditions), `artefacts` (paths +
  sha256), `buildUnderReview` (version + commit).
- The checker passes the case when the latest record's `decision` is accept, its artefacts still hash to the same bytes, and
  `buildUnderReview` is not older than the last change to the files the pack declares as the review scope. Any change in scope
  invalidates the record (status `skipped`, reason `review stale`).
- Field data follows pack 01's consent and minimisation rules: only user-exported, anonymised session metrics and forms are
  imported; coordinates, names and project data never enter the repo.

## 6. Validating the validation layer

The gate checks itself before it trusts any result. Each rule is a unit test of the gate (`tests/readiness/gate.test.ts`, to
build) and fails `npm run readiness` when broken:

| Rule | Check |
| ---- | ----- |
| G-01 Schema | every `validation/expected_results.json` conforms to [`vc.schema.json`](vc.schema.json) |
| G-02 Unique ids | every FR / TR / VC id is unique across the track; VC ids match their pack's gap id |
| G-03 Traceability | every FR in a `FUNCTIONAL_SPEC.md` table is proved by ≥ 1 VC; every `proves` entry names an FR / TR that exists |
| G-04 MUST coverage | every MUST FR is proved by ≥ 1 gating case |
| G-05 Sources | every `source` id resolves to a row of the pack's `sources.md`; grade A rows have a URL or a measurement record |
| G-06 Grade policy | `gating: true` only on grade A or target; a grade B / C case never gates |
| G-07 No orphan plans | every `plan` path exists; every file in `validation/plans` and `validation/data` is referenced by a case |
| G-08 Levels | every case resolves to a PRL (its pack default or an explicit `level`); no level is empty of gating cases |
| G-09 Driver coverage | every driver used by a case has a registered runner, or the case is reported `skipped: no runner` (and blocks) |
| G-10 Freshness | a pass recorded on a commit older than the build under test is not counted |
| G-11 Mutation check | the gate is run once against a fixture where one gating case is forced to fail and one known issue is forced to pass; both must turn the run red (proves the ratchet and the level logic are not vacuous) |
| G-12 Determinism | two report runs over the same stored results produce byte-identical `report.json` |

## 7. Personas

The verdict is per persona, because llull's maturity differs by domain. A persona reaches a level when the track-wide cases
plus the persona-tagged cases (`personas` field on a case; absent = all personas) pass.

| Persona | Daily work | Incumbent benchmark | Persona-specific evidence |
| ------- | ---------- | ------------------- | ------------------------- |
| `civil` | site development: survey, terrain, earthworks, roads, storm drainage, plan / profile sheets | Civil 3D, 12d, Covadis | 01 civil pilot; 07 drainage and alignment V&V; 08 DWG + LandXML round-trip |
| `steel` | steel halls, platforms, racks, connections, member checks, IFC | Tekla Structures, Advance Steel, SCIA / RFEM for checks | 07 EN 1993 V&V; 08 IFC; 01 steel pilot |
| `plant` | process-plant layout, piping, structures, deliverables | Plant 3D, E3D, CADMATIC | production-gate plant scenarios; 01 plant pilot |
| `mechanical` | parts, assemblies, drawings, STEP exchange | SOLIDWORKS, Inventor, Fusion | 02 3D task benchmark; 08 STEP B-rep; 03 assembly budgets; 01 mechanical pilot |

## 8. Machine profiles

Timing budgets are only meaningful on a stated machine. Profiles live in [`readiness_gate.json`](readiness_gate.json):
`ref-win11` (the owner's workstation, used for baselines), `office-min` (the minimum supported engineering PC that pack 03 / 05
specify — budgets gate on this one), and the clean-VM images of pack 05. A budget measured on another machine is reported, never
used to pass a case.

## 9. Delivery of the gate itself

| Milestone | Content | Depends on |
| --------- | ------- | ---------- |
| M-G1 | `scripts/readiness/` orchestrator: schema + traceability validation (G-01..G-08, G-12), report from stored results, ratchet; `npm run readiness`; unit tests incl. G-11 fixtures | packs' `expected_results.json` |
| M-G2 | `unit` and `cli` drivers wired; the `unit` cases of every pack run in `npm run check` | M-G1 |
| M-G3 | `electron` driver = 06 E2E runner; `perf` driver = 03 PRF runner; `fault` driver = 04 DSF runner | 06 M1, 03 M1, 04 M1 |
| M-G4 | `install-vm` driver = 05 INS matrix; `review` checker; release rule (a release carries the PRL of its build) | 05 M1 |
| M-G5 | `field` importer = 01 PIL; per-persona verdict; the readiness line in `docs/MARKET_READINESS.md` generated from `report.json` instead of hand-written | 01 M1 |

The gate is green (M-G1 done) before any pack claims a level; until then the honest status for every persona is PRL 0.
