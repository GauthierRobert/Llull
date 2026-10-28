# 01 PIL — Field validation — Technical specification

Status: specification only (2026-10-28). Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md). Laws: [`../../../.claude/rules/architecture.md`](../../../.claude/rules/architecture.md).

## 1. Current state in llull (read on main f1351cff, 2026-10-28)

| Area | Where | Behaviour today | Limit for a pilot |
| ---- | ----- | --------------- | ----------------- |
| Pilot kit | `docs/PILOT.md` | civil only: sample survey (911 points; `public/samples/pilot-site-survey.csv`, sha256 `aa67be20…e204`, 912 lines with header), a 45 min tutorial, a comparison table, success criteria with empty "Measured" and "Met?" columns, a feedback template | no protocol, no consent, no instruments, no steel / plant / mechanical profile, never run |
| Market review | `docs/MARKET_READINESS.md` §Gaps 1 | "no pilot customer has used it yet"; proposes 2–3 site-development offices and a time-to-first-deliverable measure | not executed |
| Production gate | `docs/PRODUCTION_GATE.md`; `tests/production/` (`contract.ts`, `grade.ts`, `scenarios/`, `criteria/`, `oracle/`, `ui/`); `server/tests/production/{scripted,agent}.gate.ts`, `agentLoop.ts` | 4 scenarios, graded by independent oracles; scripted and UI pass 27/27, 30/30, 28/28, 11/11. Agent driver: "not run (needs API credentials)". `agentBaseline: 0.6` per scenario (`tests/production/scenarios/civilSite.ts:21` etc.). The UI driver is legacy browser Playwright (LC1) | self-authored jobs; no mechanical scenario; agent never run |
| Civil feedback | `src/ui/panels/civil/feedbackMail.ts`, `CivilFeedback.tsx` | `mailto:` with app version + anonymous counts (entities, unit, civil categories); recipient from `VITE_LLULL_FEEDBACK_EMAIL`, else empty | civil panel only; free text; no participant code, no severity |
| Issue draft | `src/ui/components/ReportIssueDialog.tsx`, `src/ui/report/{failureStore,classifyFailure,reproducer,issueDraft,redact}.ts` | on an *internal* command failure: editable title, body and `build_project` reproducer; Copy, Save reproducer, "Open GitHub issue draft" → `https://github.com/GauthierRobert/Llull/issues/new` (`issueDraft.ts:7`); nothing sent automatically | public tracker target; only internal failures; user errors and refusals are not offered |
| Crash reports | `server/src/crashReports.ts` (`<data dir>/llull/crashes/<id>/`: document, command log, error, meta; keep 20; home path redacted); `server/src/serverCrash.ts`, `liveCommandLog.ts` (≤ 2,000 commands, then rebase); `server/src/crashRoutes.ts` (`GET /crashes/latest`); `server/src/cli/crashes.ts` (`llull crashes`); desktop `desktop/src/main.ts:285-286` (`uncaughtException`, `unhandledRejection` in main); Help › Crash Reports (`desktop/src/menu.ts:51`) | JS errors in the server and the desktop main process are captured locally | no `crashReporter`, no `render-process-gone` / `child-process-gone` handler in `desktop/src` (grep, 2026-10-28): a renderer or GPU crash leaves no record |
| Command choke point | `server/src/commandBus.ts` (`applyCommand`, `runCommand`, `commit`, `applyCommandAsync`; "the ONLY mutation path of the shared live document"); `server/src/liveRoutes.ts:113-114` (`POST /undo`, `/redo`) | every UI (desktop is always backend-connected) and `llull --app` command passes here; `source: 'rest' \| 'cli'` (`packages/protocol/src/liveSync.ts:20`). Undo / redo are host operations, not registry commands | no timing, no outcome statistics |
| Refusal codes | `packages/core/src/commands/types.ts` `CommandResult.error: CommandError { code, ids, paths, remediation, detail? }`, `rejected?: true` | a stable code on every refusal (AF-11) | ready to count by code |
| Host ports | `packages/core/src/commands/context.ts` (`raster`, `humanSignature`, …), `rasterPort.ts`, `signaturePort.ts` | pattern: a core getter / setter for an optional host capability, injected by the composition root | template for the metrics port |
| Data dir | `crashReports.ts` `userDataDir`: `$LLULL_DATA_DIR`, `%LOCALAPPDATA%`, `~/Library/Application Support`, `$XDG_DATA_HOME` | shared by backend, CLI and desktop | reused for metrics |

No session metrics, consent state, task markers, questionnaires or analysis tooling exist anywhere in the repo
(grep for `session_metrics`, `SUS`, `telemetry` on 2026-10-28: none outside lock files).

## 2. Target architecture

| Milestone | Layer | Placement | Laws |
| --------- | ----- | --------- | ---- |
| M1 session-metrics recorder | core: port + 6 commands (`packages/core/src/commands/diagnostics/`); host: recorder + store (`server/src/sessionMetrics/`); UI: dialog + indicator (`src/ui/components/PilotDiagnosticsDialog.tsx`); desktop: Help menu item | the commands read and write through `ctx.sessionMetrics` (a port), like `ctx.raster`; the host implements the port and observes `commandBus` | L1 (all actions are commands), L2 (no fs in core), L5, L6 (host holds no logic beyond recording), L9-style injected port |
| M2 native crash capture | `desktop/src/main.ts` + `server/src/crashReports.ts` | `crashReporter.start({ uploadToServer: false })` before `ready`; handlers for `render-process-gone` / `child-process-gone` write a crash entry that points to the minidump | L6; AF-41 offline |
| M3 defect pipeline | `src/ui/report/issueDraft.ts`, `feedbackMail.ts` (build config); process docs; `.claude/work/BOARD.md` line format | pilot builds target a private intake (configured URL or mail); intake schema; board ids `PIL-D-nnn` | no document change: UI and process only |
| M4 analysis | `scripts/pilot/analyse.mjs` (+ tests in `tests/unit/pilot/`) | pure functions: SUS scoring, adjusted Wald, geometric mean with t interval on logs, ratio, rule of three; reads exported metrics + questionnaires CSV | repo script, not product code |
| M5 mechanical scenario | `tests/production/scenarios/mechanical*.ts` + criteria + oracle | a mechanical office job graded like the others, for P-MEC tasks and the agent complement | production gate conventions |

**Why the recorder is a port and not a document slice.** Metrics are host and machine state, like crash reports. They are
not design data: they must survive `New` / `Open`, must never be saved into a `.llull.json` sent to a client, and must
never enter undo or history. A document slice would break all three. The commands that control the recorder are
`readOnly` for the **document** (same document returned, `affected: []`, no FeatureStep). Their effect lives in the host
behind the port, like `capture_viewport` in pack [08 ASC](../../design/08-assembly-scale/TECHNICAL_SPEC.md) and the export
commands (`writesArtifact`). No law changes. One open point is an annotation for host side effects (Q5).

**Why recording sits in the host bus and not in `execute`.** `execute` is pure and runs during replay (`replayHistory`), in
`build_project` sub-steps and in tests. Timing there would count replays as user actions. `commandBus.commit` sees exactly
one top-level user or CLI command, its outcome and its source, and it already handles undo and redo. In local mode (no
backend: `src/ui/store/localMode.ts`, renderer dev only) nothing is recorded, and status reports `available: false`.

### Technical requirements

| Id | Requirement | FR |
| -- | ----------- | -- |
| TR-PIL-01 | `packages/core/src/commands/sessionMetricsPort.ts`: `interface SessionMetricsPort { status(): MetricsStatus; setEnabled(req: EnableRequest): MetricsStatus; report(q: ReportQuery): MetricsReport; exportTo(target: ExportTarget): ExportResult; clear(scope: ClearScope): ClearResult; markTask(m: TaskMark): MarkResult }`; getter / setter as `rasterPort.ts`; `ExecutionContext.sessionMetrics?` set by `context.ts` when a port is installed | 12 |
| TR-PIL-02 | Six core commands in `commands/diagnostics/catalog.ts` (§4), toolset `diagnostics`; each refuses `PIL_METRICS_UNAVAILABLE` without the port | 12 |
| TR-PIL-03 | `server/src/sessionMetrics/recorder.ts`: hooks `commandBus` at `commit` (sync) and at the settle of `applyCommandAsync`, and wraps `undo()` / `redo()`. It takes `performance.now()` before `runHostCommand` and after `commit`, and appends one record per top-level command. It does not record its own six commands (no self-observation) | 10, 13 |
| TR-PIL-04 | Records are built by **allowlist** (§3): `name` is kept only if `getCommand(name) !== undefined`, else `"<unregistered>"`; `errorCode` is kept only if it matches `^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$`, else `"<other>"`. Params, ids, summaries, `data`, paths and `detail` are never read into the record | 10 |
| TR-PIL-05 | Consent state in `<data dir>/llull/session-metrics/consent.json` `{ schema: 1, enabled, consentVersion, enabledAt, endDate, participantCode? }`. A missing or unreadable file means disabled. Only the port writes it. `participantCode` matches `^P-(CIV\|STL\|PLT\|MEC)-\d{2}$` or is absent | 3, 9 |
| TR-PIL-06 | Storage: `<data dir>/llull/session-metrics/<sessionId>.jsonl`. One file per host start; append-only; flushed per record (best effort, never throws, like `crashReports.ts`). Rotation at 5 MB per file. At startup, files whose session started after `endDate` are deleted, and every file is deleted once `endDate` is past | 11 |
| TR-PIL-07 | Export: JSON `{ schema: 1, exportedAt, appVersion, os, participantCode?, sessions: [...], report }` per [`validation/data/session-metrics.schema.json`](validation/data/session-metrics.schema.json); `--save` writes it (CLI). In the UI the dialog shows the content first, then saves through the export command's artifact (same path as other exports) | 11 |
| TR-PIL-08 | UI: Help › **Pilot diagnostics…** (desktop menu → renderer dialog). The consent checkbox is unticked. Buttons dispatch only `store.dispatch(<command>)`. A status-bar badge "● Recording" shows while `enabled`. Per-task Start / Done / Give up buttons when a task script is loaded (`taskIds` from the plan file the moderator opens) | 9, 12 |
| TR-PIL-09 | Desktop: `crashReporter.start({ uploadToServer: false, compress: true })` before `app.on('ready')`; `app.on('render-process-gone' \| 'child-process-gone')` → `writeCrashReport({ source: 'desktop-renderer' \| 'desktop-child', … , minidumpDir: app.getPath('crashDumps') })` (new `CrashSource` members); `llull crashes` lists them; the minidump is listed with a warning "may contain document data", never copied into an issue draft | 14 |
| TR-PIL-10 | No network: `server/src/sessionMetrics/**` may import only `fs`, `path`, `os`, `crypto` (`randomUUID`) and `@core` / `@protocol` types. A dependency-cruiser rule forbids `http`, `https`, `net`, `dgram`, `tls`, `undici` and `fetch` use there | 11 |
| TR-PIL-11 | `scripts/pilot/analyse.mjs`: inputs are the questionnaire CSV ([`validation/data/questionnaires.md`](validation/data/questionnaires.md) layout), [`validation/data/observation-log.csv`](validation/data/observation-log.csv), the exported metrics and [`validation/data/field-log.csv`](validation/data/field-log.csv). Output is `pilot-report.json` with every EX value, n, point estimate, CI and pass / fail. Formulas in §5 | 7, 17, 18 |
| TR-PIL-12 | Intake: [`validation/data/defect-intake.csv`](validation/data/defect-intake.csv) columns. Board line `[TODO] PIL-D-nnn <S#> <type> <pack> — <one line> (reproducer: <path>\|none: <reason>)`. Only the orchestrator edits the board (BOARD conventions) | 15 |
| TR-PIL-13 | Pilot build flags: `VITE_LLULL_ISSUES_URL` (default = today's GitHub URL; the pilot build sets the private intake), `VITE_LLULL_FEEDBACK_EMAIL` (exists), `VITE_LLULL_PILOT=1` (shows Pilot diagnostics, the pre-release label and the participant-code field in Feedback). Feedback becomes app-wide (not civil-only) when `VITE_LLULL_PILOT=1` | 15, 16, 22 |
| TR-PIL-14 | Production gate: add scenario `mechanical-bracket-drawing` (part + holes + fillets + drawing sheet + STEP; criteria read by independent oracles: STEP entity count / bbox, SVG sheet title block, mass vs closed form). Run `npm run production:agent` with `PRODUCTION_AGENT_TRIALS=3` on all 5 scenarios before R2; reports attached to the pilot report | 19 |
| TR-PIL-15 | Recorder overhead ≤ 2 ms p95 per command (§8 derivation); recording failures never affect the command result | 13 |

## 3. Data model

```ts
// packages/core/src/commands/sessionMetricsPort.ts (types only; no fs)
export type MetricsOutcome = 'ok' | 'noop' | 'refused' | 'threw';
export type MetricsSource = 'ui' | 'cli';            // from LiveCommandSource: 'rest' -> 'ui', 'cli' -> 'cli'
export interface CommandRecord {
  readonly t: number;                                // ms since session start (monotonic), never wall-clock per record
  readonly kind: 'command';
  readonly name: string;                             // registered name or '<unregistered>'
  readonly outcome: MetricsOutcome;
  readonly errorCode?: string;                       // CommandError.code (allowlisted pattern) or '<other>'
  readonly durationMs: number;                       // rounded to 0.1 ms
  readonly source: MetricsSource;
  readonly readOnly: boolean;                        // from annotations
}
export interface HistoryRecord { readonly t: number; readonly kind: 'undo' | 'redo'; readonly applied: boolean }
export interface TaskRecord { readonly t: number; readonly kind: 'task'; readonly taskId: string; readonly event: 'start' | 'end' | 'abandon' }
export type MetricsRecord = CommandRecord | HistoryRecord | TaskRecord;
export interface SessionHeader {                     // first line of each .jsonl
  readonly schema: 1; readonly sessionId: string;    // random UUID, not derived from machine or user
  readonly startedAt: string;                        // ISO date-time, minute precision
  readonly appVersion: string; readonly os: 'win32' | 'darwin' | 'linux' | 'other';
  readonly consentVersion: string; readonly participantCode?: string;
}
export interface MetricsStatus {
  readonly available: boolean; readonly enabled: boolean; readonly consentVersion?: string; readonly endDate?: string;
  readonly sessions: number; readonly records: number; readonly bytes: number; readonly directory: string; // home redacted to ~
}
```

`MetricsReport` (returned in `data`):

- `perCommand[name] = { count, ok, noop, refused, threw, medianMs, p90Ms }`;
- `refusalsByCode[code] = count`;
- `undo`, `redo` (applied counts);
- `undoWithin10s`: an applied undo whose previous command record is `ok`, not `readOnly`, and ≤ 10,000 ms earlier;
- `tasks[taskId] = [{ startT, endT, outcome: 'end' | 'abandon', durationS }]`;
- `activeMinutes`: the sum of gaps ≤ 5 min between consecutive records (a gap > 5 min counts as idle).

The 10 s and 5 min windows are **spec parameters**, reported with the data and not gated (Q6). There is no document
schema change and no document version bump.

## 4. Commands

All are in core `commands/diagnostics/`, toolset `diagnostics`. "readOnly" means the document is returned unchanged with
`affected: []` and no FeatureStep. The effect is in the host through `ctx.sessionMetrics`.

| Command | Params (zod sketch) | Annotations | `@affects` / `@invariant` / `@failure` |
| ------- | ------------------- | ----------- | -------------------------------------- |
| `session_metrics_status` | `{}` | readOnly, idempotent | `@affects` none · `data: MetricsStatus` · `@failure PIL_METRICS_UNAVAILABLE` |
| `set_session_metrics` | `{ enabled: boolean, consentVersion?: string.min(1), acknowledge?: literal(true), endDate?: isoDate, participantCode?: regex }` | readOnly, idempotent | `@affects` host consent file · `@invariant` enabling needs `acknowledge: true` + `consentVersion` + `endDate` > today; disabling needs nothing and stops recording before the next command · `@failure PIL_METRICS_CONSENT_REQUIRED`, `PIL_METRICS_END_DATE_PAST`, `PIL_METRICS_UNAVAILABLE`, `PIL_METRICS_WRITE_FAILED` |
| `session_metrics_report` | `{ sessionIds?: string[], since?: isoDate }` | readOnly, idempotent | `data: MetricsReport` · works while disabled on the data still stored · `@failure PIL_METRICS_UNAVAILABLE` |
| `export_session_metrics` | `{ sessionIds?: string[], includeRecords?: boolean = true }` | readOnly, writesArtifact | `data: { fileName, json }` (CLI `--save`) · `@failure PIL_METRICS_EMPTY`, `PIL_METRICS_UNAVAILABLE` |
| `clear_session_metrics` | `{ sessionIds?: string[], confirm: literal(true) }` | readOnly, destructive | deletes the files (all when no ids) · `@failure PIL_METRICS_CONFIRM_REQUIRED`, `PIL_METRICS_UNAVAILABLE`, `PIL_METRICS_WRITE_FAILED` |
| `mark_pilot_task` | `{ taskId: regex ^T-(CIV\|STL\|PLT\|MEC)-\d{2}$, event: 'start' \| 'end' \| 'abandon' }` | readOnly | appends a TaskRecord · `@invariant` `end` / `abandon` need an open `start` of the same id; a second `start` closes the open one as `abandon` · `@failure PIL_METRICS_DISABLED`, `PIL_TASK_NOT_STARTED`, `PIL_METRICS_UNAVAILABLE` |

The six commands are not recorded (TR-PIL-03). Every command has happy and failure unit tests against a fake port
(NON-NEGOTIABLE 2).

## 5. Algorithms (analysis script, TR-PIL-11)

| Measure | Formula | Source |
| ------- | ------- | ------ |
| SUS per respondent | odd items: `r − 1`; even items: `5 − r`; sum × 2.5 → 0–100 | [R6] |
| SUS group CI | mean ± t(n−1, 1 − α/2) · s / √n, using the sample s; for planning, s = 17.7 | [R12] |
| Completion rate CI | adjusted Wald: p̂ = (x + z²/2) / (n + z²); p̂ ± z √(p̂(1−p̂)/(n + z²)), clipped to [0, 1]; z = 1.96 | [R26] |
| Task time | geometric mean = exp(mean(ln tᵢ)) for n < 25; CI = exp(mean ± t · s_ln / √n); failed attempts are excluded from time and reported apart | [R27] |
| Real-job ratio | per office: ln(t_llull / t_incumbent); geometric mean ratio = exp(mean); 90 % t interval on the logs | derived from [R27] |
| Zero-event bound | 0 events in n sessions ⇒ 95 % upper bound ≈ 3 / n (n > 30) | [R28] |
| SEQ | arithmetic mean per task, 7-point | [R7] |
| Raw TLX | mean of 6 subscales (0–100), no pairwise weights | [R13] |
| KLM (FR-PIL-23) | T = Σ operators: K 0.2 s (≈ 0.28 s average user), P 1.1 s, H 0.4 s, M 1.35 s | [R23] |

Worked checks (unit tests, VC-PIL-04):

- SUS: all answers 3 → (5 × 2 + 5 × 2) × 2.5 = 50. Answers (5, 1, 5, 1, …) → 40 × 2.5 = 100.
- Adjusted Wald: 9 of 10 → p̂ = 10.9208 / 13.8416 = 0.789, interval ≈ [0.574, 1.00]. MeasuringU gives ≈ 0.79 and
  0.57–1.00 [R26].
- Geometric mean of {60, 120, 240} = 120 (exact).

## 6. Interop and persistence

- Metrics: JSONL per session and the export JSON (schema in `validation/data/session-metrics.schema.json`). They are
  never in a `.llull.json` document, never in crash reports and never in `/live` events.
- Questionnaires and logs: CSV with UTF-8 and a header (layouts in `validation/data/`). The analysis reads only
  pseudonymous codes. The key that maps codes to names is held by the pilot lead outside the repo and the data folder.
- Crash minidumps: Electron `crashDumps` directory [R22], listed by `llull crashes`.

## 7. Surfaces and stable error codes

| Surface | Path |
| ------- | ---- |
| UI | Help › Pilot diagnostics… (consent, start / stop, task buttons, report view, export, delete); status-bar "● Recording" badge; app-wide Feedback with participant code (pilot build) |
| CLI | `llull session_metrics_status --app`, `llull set_session_metrics enabled=true consentVersion=PIL-C1 acknowledge=true endDate=2027-03-31 --app`, `llull mark_pilot_task taskId=T-CIV-03 event=start --app`, `llull export_session_metrics --save m.json --app`, `llull clear_session_metrics confirm=true --app`; `llull crashes` |
| In-process CLI (`--doc`) | no port: every diagnostics command → `PIL_METRICS_UNAVAILABLE` |

| Code | Meaning | Remediation (one line) |
| ---- | ------- | ---------------------- |
| `PIL_METRICS_UNAVAILABLE` | no host recorder (local mode, `--doc`, tests) | run the desktop app or `--app` |
| `PIL_METRICS_CONSENT_REQUIRED` | enable without `acknowledge: true` + `consentVersion` + `endDate` | read the notice and pass the three fields |
| `PIL_METRICS_END_DATE_PAST` | `endDate` ≤ today | choose the pilot end date from the consent form |
| `PIL_METRICS_DISABLED` | task marker while recording is off | enable recording first |
| `PIL_TASK_NOT_STARTED` | `end` / `abandon` without an open `start` | send `event=start` first |
| `PIL_METRICS_EMPTY` | export with no stored session | record a session first |
| `PIL_METRICS_CONFIRM_REQUIRED` | clear without `confirm: true` | pass `confirm=true` |
| `PIL_METRICS_WRITE_FAILED` | data dir not writable | check `$LLULL_DATA_DIR` / disk |

## 8. Performance and robustness budgets

| Budget | Value | Derivation |
| ------ | ----- | ---------- |
| Recorder overhead per command | ≤ 2 ms p95 | 1 % of the fastest KLM operator, K = 0.2 s [R23]: 0.01 × 200 ms = 2 ms. Below the resolution of any human time on task |
| Log size | ≤ 5 MB per file, rotated | spec budget; one record ≈ 120 B, so 5 MB ≈ 40,000 commands (derived) |
| Failure isolation | a recorder exception never changes `CommandResponseBody`; it is counted in `status.writeErrors` | as `crashReports.ts` "never throws" |
| Crash capture | `crashReporter.start` before `ready` | renderers started earlier are not monitored [R22] |

## 9. Test strategy

| Test | Kind | VC |
| ---- | ---- | -- |
| diagnostics commands against a fake port: happy + every failure code; `is pure` (document unchanged) | unit (`tests/unit/commands/diagnostics/`) | 08, 09 |
| `toToolSchemas()` snapshot includes the 6 tools | contract | 08 |
| `PilotDiagnosticsDialog` dispatches only commands; checkbox unticked; badge shown when enabled | component | 05, 08 |
| recorder allowlist: fuzzed params with sentinel strings and numbers never appear in the JSONL | server test | 06 |
| civil scripted production plan through `--app` with recording on: record count = calls; report matches a recomputation | server / cli | 06, 10 |
| network: socket hook (`net.Socket.prototype.connect` spy) during the civil run, plus the dep-cruiser rule | fault + arch | 07 |
| overhead: 1,000 `measure_distance` calls with recording off and on | perf | 12 |
| renderer crash via `webContents.forcefullyCrashRenderer()` | electron (pack 06 harness) | 13 |
| analysis script: worked examples of §5 | unit | 04 |
| issue-draft target from `VITE_LLULL_ISSUES_URL`; Feedback participant code | component | 15 |
| `mechanical-bracket-drawing` scenario | production gate | 25 |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| M0 programme pack | consent text + legal review, screener, scripts and instruments in `validation/`, incentive decision | owner decisions §11 | TBD — owner |
| M1 recorder | TR-PIL-01…08, 10, 15 | — | TBD — estimate at task start |
| M2 crash capture | TR-PIL-09 | pack [06 E2E](../06-desktop-e2e/) harness for the VC | TBD |
| M3 defect pipeline | TR-PIL-12, 13 | private intake decided (Q2) | TBD |
| M4 analysis | TR-PIL-11 | M1 export schema | TBD |
| M5 mechanical scenario + agent runs | TR-PIL-14 | API credentials for `production:agent` | TBD |
| R1 → R2 | lab rounds | M0–M4, pack [05 INS](../05-install-deploy/) installer | per round TBD |
| F | field phase | R2 passed EX-1 and EX-3c; packs [04 DSF](../04-data-safety/) and 05 passed; pack [08 XCH](../08-exchange-fidelity/) for the profile's exchange formats | ≥ 4 weeks |

As stated in the track README, this pack closes the track. Recorder and crash capture (M1, M2) are prerequisites that can
ship early (PRL1 in the VC table).

## 11. Open questions and proposed decisions

| # | Question | Proposed decision |
| - | -------- | ----------------- |
| Q1 | Who is the GDPR controller for pilot data (the owner as a person or a company), and who reviews the consent form? | Name a controller entity in the consent form. Have counsel or a DPO familiar with Belgian practice [R24] review it (VC-PIL-02, driver `review`). Use consent as the basis (Art. 6(1)(a)) rather than legitimate interest: participation is voluntary and research-like |
| Q2 | Is `github.com/GauthierRobert/Llull` public? Where do pilot defects go? | Pilot builds route the issue draft and Feedback to a private intake (private repo or mailbox, TR-PIL-13). Publishing a defect needs the participant's separate consent |
| Q3 | Is "no slower than the incumbent at week ≥ 3" (EX-2b ≤ 1.0) the right bar? | Yes as the definition of daily use: a tool that costs more time per deliverable than the incumbent is not adopted daily. Report the 90 % interval. The owner may record a lower bar per profile, with a reason |
| Q4 | Incentives and recruitment channel (professional bodies, universities' alumni, CAD user groups)? | Owner decision. Offer a free licence for the pilot period (pack 09) + a summary of results; no cash panel |
| Q5 | Should a host side effect get its own annotation (`hostEffect: true`) instead of `readOnly` + port? | Proposed: add `hostEffect` (not emitted in tool schemas) when a second command family needs it. `capture_viewport` (08 ASC) is the other candidate |
| Q6 | Undo-within-10 s and 5-min idle windows | Keep as reported diagnostics. Calibrate on R1 data before using them in any gate |
| Q7 | Dutch-speaking participants: no validated Dutch SUS was found | Use the English SUS, or a translation validated before R1; record the language per response |

## 12. References

[`validation/sources.md`](validation/sources.md).
