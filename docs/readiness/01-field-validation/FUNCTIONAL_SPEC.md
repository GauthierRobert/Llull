# 01 PIL — Field validation: evidence from real users — Functional specification

Status: specification only (2026-10-28). Nothing in this pack is built. Gap id `PIL`. Track rules:
[`../README.md`](../README.md); template: [`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md); grades:
[`../../plant/TEMPLATE.md`](../../plant/TEMPLATE.md). Technical view: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md). External sources `[Rn]`: [`validation/sources.md`](validation/sources.md).

## 1. Summary

No professional has done real work in llull, so nobody knows whether they can. Every gate is self-authored. The production
gate grades four office jobs that the team wrote and solved itself ([`../../PRODUCTION_GATE.md`](../../PRODUCTION_GATE.md)). Its
`agent` driver, the only one that is not a script, has never run ("not run (needs API credentials)"). The civil pilot kit
([`../../PILOT.md`](../../PILOT.md)) is ready, but its "Success criteria" table is empty and no office has used it.
[`../../MARKET_READINESS.md`](../../MARKET_READINESS.md) names "validation with real users" as the first gap that still limits sales.
Feedback channels exist but are not a programme. They are:

- the Civil / Site **Feedback** mail (`src/ui/panels/civil/feedbackMail.ts`);
- the **Report this problem** issue draft (`src/ui/components/ReportIssueDialog.tsx`);
- local crash reports (`server/src/crashReports.ts`).

None of them measures effectiveness, efficiency or satisfaction. None reaches mechanical, steel or plant users.

This pack specifies the missing parts:

- a **field-validation programme**: profiles, recruitment, consent, a protocol in three rounds and a comparison on a real job against the user's own tool;
- the **instruments**: task scripts, task success, time on task, SEQ, SUS, raw NASA-TLX, and an error and defect taxonomy with severities;
- an opt-in **local session-metrics recorder**, run through registered commands, that never sends anything;
- a **defect pipeline** from intake to the board;
- **quantitative exit criteria** that define "usable daily";
- the **agent production gate** as a complement to the human pilot, not a substitute.

After this pack, "a professional can do their daily work in llull" is a measured statement with confidence intervals, or a
measured refusal.

## 2. Context and value

- **What "usable" means.** ISO 9241-11:2018 defines usability as the extent to which specified users can achieve specified
  goals with effectiveness, efficiency and satisfaction in a specified context of use [R1]. ISO/IEC 25022 gives measures for
  these quality-in-use characteristics, plus freedom from risk and context coverage [R2]. Since 2023 the quality-in-use
  model itself is in ISO/IEC 25019 [R3]. This pack measures all three ISO 9241-11 components on four contexts of use (the
  profiles). It measures freedom from risk as data-loss and wrong-result events.
- **How incumbents validate.** The CAD vendors that llull is compared with (README benchmark) run structured pre-release
  programmes:
  - Autodesk runs product betas through its Feedback Community, by application and pre-release agreement; AutoCAD Plant 3D
    has its own beta [R14].
  - Onshape runs Early Visibility. Users opt in per feature and accept a separate licence agreement. Onshape warns: do not
    use these documents "for business critical or production use" [R15].
  - SOLIDWORKS has run betas, now called previews, for subscription customers, with a beta forum [R16].
  - Bentley hosts public and private Beta, Early Access and Product Research programmes [R17].
  - Customer advisory boards of about 10–15 customers meeting quarterly are common B2B practice. This is grade C, used only
    for design, never for gating [R18].
- **What switching costs.** In surveys of companies that changed CAD tools, the learning curve (52 %) and productivity loss
  (28 %) are among the top obstacles. These figures come from vendor-reported Tech-Clarity data, grade B [R19]. A pilot
  must therefore measure llull **after** a learning period, not only at first contact (FR-PIL-21).
- **Why llull must close the gap.** The track question in [`../README.md`](../README.md) asks whether a professional can use
  llull as a daily tool. It cannot be answered by the team, by an agent or by a scripted gate. Only users can answer it, and
  only if the evidence is collected so that it can be trusted: users who are not the team, tasks fixed beforehand, outcome
  oracles, confidence intervals, and every defect traced to a fix.

## 3. Personas and user stories

| Persona | Who | Incumbent tools (track benchmark) |
| ------- | --- | --------------------------------- |
| **P-CIV** civil site office | site / civil engineer or technician; survey → terrain → earthworks → road → storm drainage | Civil 3D, 12d, AutoCAD / BricsCAD |
| **P-STL** steel / industrial | structural engineer or steel detailer; portal frames, halls, platforms, footings, takeoff | Tekla, Advance Steel, AutoCAD |
| **P-PLT** plant EPC | plant layout / piping designer; structure + equipment + lines + supports, IFC / DXF / line list | AutoCAD Plant 3D, AVEVA E3D, Smart 3D |
| **P-MEC** mechanical | mechanical design engineer; parts, assemblies, drawings, STEP | SOLIDWORKS, Inventor, Fusion |
| **Pilot lead** | runs sessions, observes, triages | — |
| **Owner** | decides go / no-go on the exit criteria | — |
| **Agent** | runs the production gate from the brief (CLI) | — |

- US-1 (P-*): "On my own machine, offline, I do the job I do every week, and I issue the deliverable after my usual checks."
- US-2 (P-*): "I know exactly what is recorded about me, I turn it on myself, I can see and delete it, and nothing leaves my
  machine unless I send the file."
- US-3 (P-*): "When something breaks I report it in one place. I get a reference, and I am told when it is fixed."
- US-4 (Pilot lead): "Every session produces the same measures in the same format. I compute the confidence intervals
  with one script."
- US-5 (Owner): "I get one report per round. It says per profile whether llull is usable daily against fixed thresholds,
  and it lists the defects that block it."
- US-6 (Agent): "I run the same jobs from the brief. My pass rate sits next to the humans' pass rate."

## 4. Scope

| Phase | Content |
| ----- | ------- |
| **MVP** (before any participant) | consent pack + legal review; task scripts for the 4 profiles; local session-metrics recorder (M1); offline native crash capture (M2); private defect intake and board pipeline (M3); analysis script (M4) |
| **V1** | round R1: moderated formative lab on sample data, 5 participants per profile. Fix S3 / S4 defects. Round R2: confirmatory lab, 5 new participants per profile. Agent gate k = 3 trials per scenario |
| **V2** | field phase F: ≥ 2 offices per profile, real job in parallel with the incumbent, at least 4 weeks (SUS and time re-measured at the end). Exit decision, pilot report, advisory board |
| Out of scope | remote or cloud telemetry of any kind (product directive); paid panels and recruiting agencies (owner decision, §11 Q4 of TECHNICAL_SPEC); certification of engineering checks (pack [07 VNV](../07-engineering-vnv/)); licensing and price (pack [09 COM](../09-commercial-support/)) |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-PIL-01 | MUST | Four profiles (P-CIV, P-STL, P-PLT, P-MEC). Each round R1 and R2 has ≥ 5 participants per profile (20 per round); the field phase has ≥ 2 offices per profile | 5 users find ~85 % of problems when L = 31 % [R4]; one group of 5 found as little as 55 % [R5], hence two rounds; ≥ 3 per group with several groups [R4]; "2 or 3 offices" in MARKET_READINESS | [R4][R5] |
| FR-PIL-02 | MUST | Recruitment screener. A participant: practises the profile's job as a paid professional; has used an incumbent tool for that job for ≥ 1 year; has never contributed to llull; is not related to the owner. R2 participants did not take part in R1 | outcome must not come from the team or from trained users | §2 |
| FR-PIL-03 | MUST | Informed consent before any measure. It is written and separate from other terms; nothing is pre-ticked; it states purposes, data, retention and the right to withdraw at any time, as easily as given; signed copies are kept. Participants are identified in all data by a pseudonymous code only | GDPR Art. 6(1)(a), 7(1)–(3), Recital 32; data minimisation Art. 5(1)(c) | [R8][R9][R10][R11] |
| FR-PIL-04 | MUST | Protocol in three rounds, fixed before recruitment: **R1** moderated formative lab (think-aloud, scripted tasks on sample data, ≤ 2 h); **R2** confirmatory lab after the R1 fixes (same scripts, no think-aloud, no help); **F** field phase on a real job | iterate small studies; retest after fixes [R4] | [R4] |
| FR-PIL-05 | MUST | Task scripts per profile, versioned in [`validation/plans/pilot-tasks.json`](validation/plans/pilot-tasks.json). Each task has a start state, a goal written in the user's words (no command names), an end condition checked by an oracle, a time limit, and a `critical` flag (issues a deliverable or protects data). P-CIV reuses `public/samples/pilot-site-survey.csv` / `.dxf` | comparable measures; outcome checked by an oracle, not by the moderator's opinion | PILOT.md, PRODUCTION_GATE.md |
| FR-PIL-06 | MUST | Real-job comparison in F: the office does one finished or live job in llull and in its incumbent tool. It compares the deliverables against tolerances written down **before** the job (P-CIV: the PILOT.md table) and logs both times | answers "can I do my work", not "can I do a demo" | PILOT.md |
| FR-PIL-07 | MUST | Instruments per attempt and per session: binary task success (oracle); time on task; SEQ after each task; SUS after each session; raw NASA-TLX after each critical task (diagnostic); an observer log of errors, assists and defects. French speakers get the validated F-SUS. Instruments are in [`validation/data/questionnaires.md`](validation/data/questionnaires.md) | standard, comparable instruments with published norms | [R1][R6][R7][R12][R13][R20] |
| FR-PIL-08 | MUST | Error and defect taxonomy (type × severity S0–S4). S4 = data loss, a silently wrong engineering result, or a blocked critical task. Severity follows frequency, impact and persistence | one shared scale for triage and exit | [R21] |
| FR-PIL-09 | MUST | A local session-metrics recorder, **off by default**. Only the user turns it on, with an explicit unticked consent step. While it records, a visible indicator says so | GDPR Art. 25(2), Recital 32 | [R9][R11] |
| FR-PIL-10 | MUST | The recorder keeps only: session start and end; per command the registered name, outcome (`ok` / `noop` / `refused` / `threw`), stable error code, duration in ms and source (`ui` / `cli`); undo and redo events; pilot task markers; app version; OS family. It never keeps parameters, entity ids, summaries, file paths, document content, user or machine names | data minimisation; Recital 26 (anonymous data) | [R8][R10] |
| FR-PIL-11 | MUST | Metrics stay on the machine. Nothing is ever sent automatically. The user exports a file, reviews it and sends it if they choose. Turning recording off or clearing it deletes or stops at once. Logs older than the consent end date are deleted | product directive (offline, AF-41); Art. 5(1)(e), 7(3) | [R8][R9] |
| FR-PIL-12 | MUST | Every recorder action (status, enable / disable, report, export, clear, task marker) is a registered command, reachable from the UI and from the `llull` CLI. The UI never writes metrics or settings itself | PRIME DIRECTIVE, L1, L5 | laws |
| FR-PIL-13 | MUST | The recorder report gives, per session and per command: counts; median and p90 duration; refusals by error code; undo and redo counts; the "undo within 10 s of a command" count (a proxy for an unintended result); task times from markers. Recording overhead stays within the budget of VC-PIL-12 | efficiency and error measures computed from real use, not self-report | [R2] |
| FR-PIL-14 | SHOULD | Native crashes (renderer, GPU, child processes) are captured offline as local minidumps, without upload, and listed beside the existing JS crash reports (`llull crashes`, Help › Crash Reports). A minidump is never attached automatically because it can hold document memory | today only main-process JS errors are caught | [R22] |
| FR-PIL-15 | MUST | One defect pipeline. Every channel (observer log, Report this problem, Feedback mail, metrics export, crash report) produces one intake record. A record is triaged within the budget, gets a severity and a pack, and becomes a board task `PIL-D-nnn` with a reproducer or a stated reason. Its status is returned to the reporter | no lost report, traceable fix | §2 |
| FR-PIL-16 | MUST | Pilot defects go through a **private** channel. A pilot build never opens a public issue draft by default. Nothing from a participant appears in a public tracker without that participant's separate consent | the issue draft targets a GitHub URL (`src/ui/report/issueDraft.ts:7`) | [R9] |
| FR-PIL-17 | MUST | "Usable daily" is decided per profile only by the exit criteria in §9 (EX-1 … EX-7), computed with the stated statistics | an objective go / no-go | §9 |
| FR-PIL-18 | MUST | One pilot report per round. It gives every VC with n, the point estimate, the confidence interval, deviations from protocol and the hash of the pseudonymised raw data file. The PILOT.md success table and MARKET_READINESS gap 1 are updated from it | the evidence is the deliverable | — |
| FR-PIL-19 | MUST | The agent production gate runs every scenario with k = 3 trials, each at or above the scenario's `agentBaseline`. Its results go in the pilot report next to the human results, with an analysis of where they diverge. It never replaces a human measure | agent driver never run; agents measure neither satisfaction nor human time | PRODUCTION_GATE.md |
| FR-PIL-20 | SHOULD | After F, a standing advisory group of pilot alumni (one per office, quarterly) ranks the backlog | vendor practice | [R18] (C) |
| FR-PIL-21 | SHOULD | Longitudinal measure: SUS and real-job time at the start and end of F (≥ 4 weeks apart) | learning curve is the main switching cost | [R19] |
| FR-PIL-22 | MUST | Field safety. The pilot build is a pinned, labelled pre-release. Packs [04 DSF](../04-data-safety/) and [05 INS](../05-install-deploy/) exit criteria have passed before F. During F the incumbent stays the master of record: nothing leaves the office from llull without the office's usual check | Onshape EV warning [R15]; no harm to live jobs | [R15] |
| FR-PIL-23 | COULD | A Keystroke-Level-Model estimate of the expert time for five core task fragments per profile, compared with the fastest R2 times. It separates interaction cost (pack [02 UXD](../02-drafting-interaction/)) from learning cost | KLM operators K, P, H, M [R23] | [R23] |

## 6. Workflows

### 6.1 Programme (owner and pilot lead)

1. MVP gates pass (VC-PIL-02 … 15).
2. Recruit (screener) → consent (signed, code assigned) → install the pinned build (pack 05) → R1 sessions.
3. Triage → board → fixes merged → new pinned build → R2 sessions with new participants.
4. F: office kickoff (job chosen, tolerances written down) → 4 weeks of use → closing session (SUS, time, interview).
5. Analysis (`validation/README.md` §Statistics) → pilot report → exit decision per profile.

### 6.2 Participant in a lab session (UI first; CLI equivalents in brackets)

1. Help › **Pilot diagnostics…** → reads the purpose → ticks "I agree" (unticked by default) → **Start recording**
   (`set_session_metrics enabled=true consentVersion=… acknowledge=true`). A "Recording" indicator appears in the status bar.
2. For each task the moderator reads the goal. The participant clicks **Start task T-CIV-03** (`mark_pilot_task taskId=T-CIV-03
   event=start`), works, then clicks **Done** or **Give up** (`event=end|abandon`) and answers the SEQ.
3. At the end: SUS and raw TLX on paper or form. **Export…** (`export_session_metrics --save pilot-P-CIV-03-R1.json`) →
   participant reviews the file → gives it to the moderator → **Stop and delete** (`set_session_metrics enabled=false`,
   `clear_session_metrics`).

### 6.3 Field phase

The participant works on the real job. Recording is on, by their choice. The office keeps an incumbent-time log
([`validation/data/field-log.csv`](validation/data/field-log.csv)). Every week the participant exports and sends the metrics
file, or does not: the metrics are optional, the field log is not.

### 6.4 Defect

Any channel → intake record ([`validation/data/defect-intake.csv`](validation/data/defect-intake.csv)) → triage (severity,
type, pack) → `PIL-D-nnn` on `.claude/work/BOARD.md` with a reproducer (a `build_project` plan from the issue draft, or a
failing test from the `fix-bug` skill) → fix → reporter told → recheck in the next round.

## 7. Acceptance criteria

- **Given** a fresh install, **when** 100 commands run, **then** no metrics file exists and `session_metrics_status` reports
  `enabled: false` (VC-PIL-05).
- **Given** recording on, **when** the civil production plan runs, **then** the log holds no parameter value, id,
  coordinate, project name or path (VC-PIL-06), and no non-loopback connection is opened (VC-PIL-07).
- **Given** `llull --doc file.llull.json session_metrics_status` (no host port), **then** it is refused with
  `PIL_METRICS_UNAVAILABLE` (VC-PIL-09).
- **Given** a renderer crash, **then** a minidump and a crash entry exist locally, and no upload is attempted (VC-PIL-13).
- **Given** R2 data for a profile, **when** the analysis runs, **then** EX-1 … EX-3 are computed with their confidence
  intervals and a pass or fail is given per profile (VC-PIL-17 … 22).
- **Given** the end of F, **then** each profile has an issued real deliverable, no open S3 / S4 defect and no data-loss event
  (VC-PIL-23, 24).

## 8. Standards and regulatory alignment

| Topic | Alignment |
| ----- | --------- |
| Usability definition | ISO 9241-11:2018 effectiveness / efficiency / satisfaction in a context of use [R1] |
| Quality in use measures | ISO/IEC 25022:2016 (effectiveness, efficiency, satisfaction, freedom from risk, context coverage) [R2]; model ISO/IEC 25019:2023 [R3]. Paywalled: only the public scope is used |
| Satisfaction | SUS [R6][R12], F-SUS for French speakers [R20], SEQ [R7]; workload NASA-TLX (raw) [R13] |
| Data protection | GDPR Art. 5(1)(c)(e), 6(1)(a), 7, 25, Recitals 26 and 32 [R8]–[R11]; Belgian supervisory authority: Gegevensbeschermingsautoriteit / APD [R24] |
| Crash capture | Electron `crashReporter` with `uploadToServer: false`, local `crashDumps` [R22] |

## 9. KPIs and exit criteria ("usable daily")

A profile is **usable daily** when it meets every MUST row below. The programme passes when all four profiles pass, or the
owner records an explicit, reasoned exception per failing profile. Derivations are in
[`validation/README.md`](validation/README.md) §Statistics.

| Id | Dimension | Criterion | Basis |
| -- | --------- | --------- | ----- |
| EX-1 | Effectiveness | R2 unassisted completion of the profile's core tasks: the adjusted-Wald 95 % **lower** bound ≥ 0.78 (with 40 attempts that means ≥ 37 successes; with 48 attempts, ≥ 44) | 78 % = median completion rate of 1,189 tasks [R25]; adjusted Wald [R26] |
| EX-2a | Efficiency (first use) | P-CIV, R1: time from launch to the first plan-profile sheet or LandXML on the sample survey, geometric mean ≤ 45 min | PILOT.md budget (spec); geometric mean for n < 25 [R27] |
| EX-2b | Efficiency (daily) | F, end of week ≥ 3: real-job time ratio llull / incumbent, geometric mean over the profile's offices ≤ 1.0 | break-even definition (§TECHNICAL 11 Q3) |
| EX-3a | Satisfaction | SUS over all R2 + F closing sessions: the 90 % CI **lower** bound ≥ 68 (with n = 20 the mean must be ≥ 74.9) | average SUS 68 [R6]; s = 17.7 [R12] |
| EX-3b | Satisfaction | SUS mean per profile ≥ 68 | [R6] |
| EX-3c | Perceived difficulty | SEQ mean ≥ 5.3 for every core task (R2) | historical SEQ average 5.3–5.6 [R7] |
| EX-4 | Correctness | every real-job deliverable within the tolerances written down before the job (P-CIV: PILOT.md table) | FR-PIL-06 |
| EX-5 | Freedom from risk | 0 data-loss events in all sessions; 0 open S4 or S3 defects; 0 open wrong-result defects at exit | ISO/IEC 25022 freedom from risk [R2] |
| EX-6 | Field proof | ≥ 1 real deliverable per profile issued to a third party from llull after the office's own check; > 50 % of F participants answer "yes" or "with changes" to "would you use it on a live job" | definition of daily use |
| EX-7 | Agent complement | `production:agent`: every scenario passes ≥ `agentBaseline` (0.6 today) on all k = 3 trials | PRODUCTION_GATE.md ratchet |

Reported, not gating: raw NASA-TLX per critical task, crash-free session rate (with a rule-of-three upper bound when there
are 0 crashes [R28]), Bangor adjective bands (grade B) [R29], KLM ratio (FR-PIL-23).

## 10. Risks and assumptions

| Risk | Mitigation |
| ---- | ---------- |
| Recruitment fails: an unknown product, no budget for incentives | MVP includes the incentive decision (TECHNICAL §11 Q4); civil first (kit ready); profiles may run in sequence |
| P-MEC has no production-gate scenario, so no agent complement and no task oracle exists yet | TR-PIL-14 adds a mechanical scenario before R1 P-MEC |
| Field use harms a live job | FR-PIL-22: incumbent is master of record; pack 04 passed first |
| Measuring the team instead of the product (a moderator who helps) | R2 does not allow help; an assist counts as a failure; script wording has no command names |
| Small n gives a falsely good result | thresholds apply to CI lower bounds, not to point estimates (EX-1, EX-3a) |
| Pilot data published by accident (public issue tracker) | FR-PIL-16, VC-PIL-15 |
| Metrics re-identify a person (a rare command sequence plus a small office) | no content, pseudonymous code, user reviews before sending, retention limited by the consent end date (Recital 26 test [R10]) |

## 11. References

See [`validation/sources.md`](validation/sources.md) (R1–R29, S1–S6).
