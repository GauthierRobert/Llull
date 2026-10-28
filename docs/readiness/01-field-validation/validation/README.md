# 01 PIL — Validation plan

This pack validates a **programme**, not a geometry routine. Two kinds of cases follow:

- **Instrument cases** (recorder, crash capture, intake, analysis). They run in `npm run check`, through the CLI, under
  fault injection or in the Electron harness. They must pass before a participant is recruited (readiness level PRL1 /
  PRL4 as prerequisites).
- **Evidence cases** (driver `field`). They are computed by `scripts/pilot/analyse.mjs` (TR-PIL-11) from the round data and
  define "usable daily" (PRL5, the pack's level).

Grades follow [`../../../plant/TEMPLATE.md`](../../../plant/TEMPLATE.md). "Target" means a budget of this spec. Every number
is quoted from [`sources.md`](sources.md), derived below, or marked `TBD — measure with <tool>`. Machine profile for perf
cases: `ref-win11` (the owner's Windows 11 workstation).

Readiness levels: PRL1 installable + observable · PRL2 trustworthy · PRL3 daily-capable · PRL4 adoptable · PRL5 field-proven.

## Use cases

1. **UC-1 Lab round (R1, R2).** 5 participants per profile do the scripted tasks of [`plans/pilot-tasks.json`](plans/pilot-tasks.json)
   on sample data, with SEQ after each task and SUS after the session ([`plans/moderator-guide.md`](plans/moderator-guide.md)).
2. **UC-2 Field phase (F).** ≥ 2 offices per profile do one real job in llull and in their incumbent tool for ≥ 4 weeks
   ([`data/field-log.csv`](data/field-log.csv)).
3. **UC-3 Local diagnostics.** A participant turns on the recorder, marks tasks, exports, reviews, deletes.
4. **UC-4 Defect to fix.** Any channel → intake → board `PIL-D-nnn` → fix → recheck.
5. **UC-5 Agent complement.** `npm run production:agent`, k = 3, all scenarios.

## Statistics (derivations used by the exit criteria)

**D1. Participants per round.** Nielsen's model gives the share of problems found by n users as 1 − (1 − L)ⁿ, with L = 0.31
[R4]. For n = 5: 1 − 0.69⁵ = 1 − 0.1564 = 0.844, the "≈ 85 %" of [R4]. A single group of 5 can find as little as 55 % [R5], so the
programme runs two lab rounds (R1 formative, R2 confirmatory with new people) per profile. That gives 4 × 5 = 20
participants per round.

**D2. EX-1 completion.** The criterion is that the adjusted-Wald 95 % lower bound is ≥ 0.78, the median completion rate of
1,189 tasks [R25]. Formula [R26]: p̂ = (x + 1.9208)/(n + 3.8416); lower = p̂ − 1.96 √(p̂(1 − p̂)/(n + 3.8416)).

| Attempts n | x | p̂ | lower | Pass |
| ---------- | - | -- | ----- | ---- |
| 40 (5 participants × 8 core tasks) | 36 | 0.8649 | 0.7638 | no |
| 40 | 37 | 0.8878 | 0.7943 | **yes**: 37 / 40 is the minimum |
| 48 (5 × 8 + 8 extra) | 43 | 0.8665 | 0.7739 | no |
| 48 | 44 | 0.8858 | 0.7992 | **yes**: 44 / 48 is the minimum |

An attempt counts as a success only when the task oracle passes, the participant finishes within the task's time limit,
and the moderator gave no assist (an assist counts as a failure in R2).

**D3. EX-3a SUS.** The criterion is that the 90 % CI lower bound is ≥ 68, the average SUS [R6]. With the planning s = 17.7
[R12], the mean needed is 68 + t(n−1, 0.95) · 17.7 / √n:

- n = 20: 68 + 1.7291 × 3.9579 = 74.84, so the mean must be ≥ 74.9;
- n = 40 (R2 + F): 68 + 1.6849 × 2.7986 = 72.72, so the mean must be ≥ 72.8.

The gate uses the observed s, not 17.7. For comparison, 74 is about the 70th percentile (grade B−) [R6].

**D4. EX-3c SEQ.** Every core task needs a mean ≥ 5.3, the lower end of the 5.3–5.6 historical average [R7].

**D5. Times.** Task times are reported as the geometric mean with a log-scale t interval (n < 25) [R27]. Failed attempts are
excluded from time. The real-job ratio (EX-2b) is exp(mean(ln(t_llull / t_inc))) over the profile's offices, with a 90 %
interval. The gate uses the point value ≤ 1.0, and the interval is reported.

**D6. Zero events.** With 0 crashes or data-loss events in n sessions, the 95 % upper bound is ≈ 3/n for n > 30 [R28]. For
example, 200 sessions give 1.5 %. This is reported; the gate is on the count (EX-5).

**D7. Recorder overhead.** The budget is 1 % of the fastest KLM operator (K = 0.2 s [R23]): ≤ 2 ms p95.

## Validation cases

| VC | Proves | Level | Driver | Input | Expected | Tolerance | Source / grade |
| -- | ------ | ----- | ------ | ----- | -------- | --------- | -------------- |
| VC-PIL-01 | FR-PIL-01, FR-PIL-02 | PRL5 | review | recruitment register (codes, screener answers), per round | ≥ 5 per profile in R1 and in R2 (R2 ∩ R1 = ∅); ≥ 2 offices per profile in F; every participant passes the screener | exact | D1; [R4][R5] (A/B) → target |
| VC-PIL-02 | FR-PIL-03, TR-PIL-05 | PRL4 | review | [`data/consent-form.md`](data/consent-form.md) + counsel / DPO review record; signed forms | review approves; 100 % of participants have a signed form dated before their first measure; recorder checkbox unticked by default | exact | [R8]–[R11] A |
| VC-PIL-03 | FR-PIL-04, FR-PIL-05 | PRL5 | unit | [`plans/pilot-tasks.json`](plans/pilot-tasks.json) | validates against its inline schema: every task has `start`, `goal` (no command names: no `[a-z]+_[a-z_]+` token), `oracle`, `timeLimitMin`, `critical`; P-CIV tasks reference S5 hashes; each profile has ≥ 8 core tasks | exact | target |
| VC-PIL-04 | FR-PIL-07, TR-PIL-11 | PRL1 | unit | analysis script on worked vectors | SUS all-3 = 50, (5,1,…) = 100; adjusted Wald 9/10: p̂ = 0.789, CI [0.574, 1.000]; geometric mean {60,120,240} = 120; D2 table rows reproduced | 1e-3 | [R6][R26][R27] A |
| VC-PIL-05 | FR-PIL-09, FR-PIL-11 | PRL1 | electron | fresh profile (`LLULL_DATA_DIR` empty), 100 commands from the civil plan | `session_metrics_status.enabled = false`; no file under `session-metrics/`; no badge | exact | [R11] A |
| VC-PIL-06 | FR-PIL-10, TR-PIL-04 | PRL1 | cli | recording on; civil production plan (23 calls) via `--app`; params seeded with sentinel `ZZSENTINEL`; project name "Hillside business park — plot 4" | the JSONL contains none of: `ZZSENTINEL`, the project name, any survey coordinate string (e.g. `1000.000`), any entity id pattern `[a-z]+-\d+`, the home path; every record's keys ⊆ the allowlist | exact | [R8][R10] A |
| VC-PIL-07 | FR-PIL-11, TR-PIL-10 | PRL1 | fault | same run with a socket-connect spy in the server and desktop main processes; dep-cruiser rule | 0 non-loopback connections; the rule rejects an injected `import 'https'` in `server/src/sessionMetrics/` | exact | product directive (AF-41) |
| VC-PIL-08 | FR-PIL-12, TR-PIL-02, TR-PIL-08 | PRL1 | unit | registry; `PilotDiagnosticsDialog` component test | 6 tools present in `toToolSchemas()`; each dialog button calls `store.dispatch` with the matching command; the component has no `fs` / settings write | exact | laws L1 / L5 |
| VC-PIL-09 | FR-PIL-12, TR-PIL-01 | PRL1 | unit | `llull --doc x.llull.json session_metrics_status`; `set_session_metrics enabled=true` without `acknowledge`; `mark_pilot_task event=end` without a start | `PIL_METRICS_UNAVAILABLE`; `PIL_METRICS_CONSENT_REQUIRED`; `PIL_TASK_NOT_STARTED`; the document is unchanged in all three | exact | target |
| VC-PIL-10 | FR-PIL-13, TR-PIL-03 | PRL1 | unit | fixture JSONL: 10 commands (3 refused with 2 codes), 2 undo, 1 undo 4 s after an `ok` mutation, task T-CIV-01 start / end 90 s apart | `perCommand`, `refusalsByCode`, `undo = 2`, `undoWithin10s = 1`, `tasks.T-CIV-01[0].durationS = 90` equal the hand count; and on the VC-06 run: record count = 23, Σ durationMs ≤ the run's wall time | exact | target |
| VC-PIL-11 | FR-PIL-11, TR-PIL-06, TR-PIL-07 | PRL1 | cli | export → `clear_session_metrics confirm=true` → `set_session_metrics enabled=false` → 10 commands; and a consent with `endDate` in the past at startup | export validates against [`data/session-metrics.schema.json`](data/session-metrics.schema.json); after clear, 0 files; after disable, 0 new records; past `endDate` → files deleted at startup | exact | [R8] 5(1)(e), [R9] 7(3) A |
| VC-PIL-12 | FR-PIL-13, TR-PIL-15 | PRL1 | perf | 1,000 × `measure_distance` via `--app`, recording off vs on | p95 added latency ≤ 2 ms | ± 10 % | D7; [R23] A |
| VC-PIL-13 | FR-PIL-14, TR-PIL-09 | PRL1 | electron | `webContents.forcefullyCrashRenderer()` in the pack-06 harness, network spy on | a minidump in `crashDumps`; a crash entry with source `desktop-renderer` listed by `llull crashes`; 0 upload attempts | exact | baseline A (S1): no handler, no record; [R22] A |
| VC-PIL-14 | FR-PIL-15, TR-PIL-12 | PRL4 | review | 10 seeded defects, 2 per channel (observer, issue draft, feedback mail, metrics export, crash) | 10 intake rows; each triaged ≤ 2 working days with severity, type and pack; 10 `PIL-D-nnn` board lines, each with a reproducer or a reason; reporter notified | exact (2 working days = spec budget) | target |
| VC-PIL-15 | FR-PIL-16, TR-PIL-13 | PRL4 | unit | pilot build env (`VITE_LLULL_PILOT=1`, `VITE_LLULL_ISSUES_URL=<private>`) | the issue-draft link host = the private intake; no `github.com` link is rendered; Feedback shows the participant-code field app-wide | exact | baseline A: `issueDraft.ts:7` targets GitHub |
| VC-PIL-16 | FR-PIL-06, FR-PIL-17 (EX-4) | PRL5 | field | F real-job deliverables; tolerance sheet signed before the job | every row within tolerance (P-CIV: PILOT.md table, e.g. pad volumes ≤ 2 %, pipe sizes identical, HGL ≤ 5 cm) | per sheet | S2 (spec budget) |
| VC-PIL-17 | FR-PIL-17 (EX-1) | PRL5 | field | R2 attempts per profile | adjusted-Wald 95 % lower bound ≥ 0.78 | D2 | [R25][R26] A |
| VC-PIL-18 | FR-PIL-17 (EX-3a) | PRL5 | field | SUS of all R2 + F closing sessions | 90 % CI lower bound ≥ 68 | D3 | [R6][R12] A |
| VC-PIL-19 | FR-PIL-17 (EX-3b) | PRL5 | field | SUS per profile (R2 + F) | mean ≥ 68 | — | [R6] A |
| VC-PIL-20 | FR-PIL-07, FR-PIL-17 (EX-3c) | PRL5 | field | SEQ per core task, R2 | mean ≥ 5.3 for every core task | — | [R7] A |
| VC-PIL-21 | FR-PIL-17 (EX-2a) | PRL5 | field | P-CIV R1: launch → first plan-profile sheet or LandXML on the sample survey (tasks T-CIV-01…07) | geometric mean ≤ 45 min | — | S2 (PILOT.md budget) → target; [R27] |
| VC-PIL-22 | FR-PIL-17 (EX-2b) | PRL5 | field | F field log, end of week ≥ 3 | geometric-mean ratio llull / incumbent ≤ 1.0 (90 % interval reported) | D5 | target (TECHNICAL Q3) |
| VC-PIL-23 | FR-PIL-08, FR-PIL-17 (EX-5) | PRL5 | field | all sessions R1–F; defect register at exit | data-loss events = 0; open S4 = 0; open S3 = 0; open `wrong-result` = 0 | exact | [R2] (freedom from risk) → target |
| VC-PIL-24 | FR-PIL-17 (EX-6), FR-PIL-22 | PRL5 | field | F closing interviews; issue records | ≥ 1 deliverable per profile issued to a third party from llull after the office's check; > 50 % "yes" or "with changes" | exact | target |
| VC-PIL-25 | FR-PIL-19, TR-PIL-14 (EX-7) | PRL5 | cli | `PRODUCTION_AGENT_TRIALS=3 npm run production:agent` on 5 scenarios (4 + mechanical) | every trial ≥ `agentBaseline` (0.6); divergence table human vs agent per task in the pilot report | exact | S3 A (baseline: not run) |
| VC-PIL-26 | FR-PIL-18 | PRL5 | review | pilot report per round | every VC of this table present with n, estimate, CI, deviations; sha256 of the pseudonymised raw data; PILOT.md success table and MARKET_READINESS gap 1 updated | exact | target |
| VC-PIL-27 | FR-PIL-20 | PRL5 | review | advisory group charter + first minutes | charter (purpose, cadence, confidentiality); ≥ 1 member per profile; first meeting held ≤ 3 months after F | exact | [R18] C → not gating |
| VC-PIL-28 | FR-PIL-21 | PRL5 | field | F week 1 vs week ≥ 4: SUS and real-job time ratio | both reported; time ratio at the end ≤ the ratio at the start | — | [R19] B → target |
| VC-PIL-29 | FR-PIL-22 | PRL4 | review | pilot build metadata; packs 04 and 05 gate records | pinned version + "pre-release" label in About; 04 DSF and 05 INS gates green on that version before F; master-of-record clause in the office agreement | exact | [R15] A |
| VC-PIL-30 | FR-PIL-23 | PRL5 | field | 5 fragments per profile: KLM prediction vs the fastest R2 time | ratio reported per fragment; ratio > 2 is flagged to pack 02 UXD | TBD — measure with the analysis script | [R23] A → not gating (COULD) |
| VC-PIL-31 | FR-PIL-08 | PRL4 | review | 20 R1 defects rated independently by 2 raters ([`data/defect-taxonomy.md`](data/defect-taxonomy.md)) | agreement reported; 0 unresolved disagreements at S3 / S4 | exact | [R21] A |
| VC-PIL-32 | FR-PIL-07 | PRL5 | field | R2 critical-task attempts | raw TLX present for 100 % of critical attempts; SEQ for 100 % of attempts | exact | [R7][R13] |

FR → VC coverage:

- FR-01, FR-02 → 01;
- FR-03 → 02; FR-04, FR-05 → 03; FR-06 → 16;
- FR-07 → 04, 20, 32; FR-08 → 23, 31;
- FR-09 → 05; FR-10 → 06; FR-11 → 05, 07, 11;
- FR-12 → 08, 09; FR-13 → 10, 12; FR-14 → 13;
- FR-15 → 14; FR-16 → 15; FR-17 → 16–24;
- FR-18 → 26; FR-19 → 25; FR-20 → 27; FR-21 → 28; FR-22 → 24, 29; FR-23 → 30.

Every TR is proved by at least one VC (01 → 08/09, 02 → 08, 03 → 10, 04 → 06, 05 → 02, 06 → 11, 07 → 11, 08 → 08,
09 → 13, 10 → 07, 11 → 04, 12 → 14, 13 → 15, 14 → 25, 15 → 12).

## Plans and data

| File | Runs today | Purpose |
| ---- | ---------- | ------- |
| [`plans/pilot-tasks.json`](plans/pilot-tasks.json) | yes (as a script for a human; oracles for P-CIV, P-STL, P-PLT are existing production-gate criteria) | task scripts for the 4 profiles |
| [`plans/moderator-guide.md`](plans/moderator-guide.md) | yes | session protocol R1 / R2 / F, wording, assist rules |
| [`data/consent-form.md`](data/consent-form.md) | draft (needs legal review, VC-02) | consent + information notice |
| [`data/questionnaires.md`](data/questionnaires.md) | yes | SUS / F-SUS, SEQ, raw TLX, closing interview, CSV layout |
| [`data/defect-taxonomy.md`](data/defect-taxonomy.md) | yes | types × severities S0–S4 |
| [`data/defect-intake.csv`](data/defect-intake.csv), [`data/observation-log.csv`](data/observation-log.csv), [`data/field-log.csv`](data/field-log.csv) | headers | record layouts |
| [`data/session-metrics.schema.json`](data/session-metrics.schema.json) | target (M1) | export schema |

Expected values are indexed in [`expected_results.json`](expected_results.json) (schema: [`../../vc.schema.json`](../../vc.schema.json)).
