# Support drill (VC-COM-20) and CRA reporting tabletop (VC-COM-22)

Both are `review` cases: a human runs them and stores a record under `records/` (VALIDATION.md §5). The owner sets the tier
targets before the first run (FUNCTIONAL_SPEC §11 Q5); until then the drill measures and reports, it cannot pass.

## A. Support turnaround drill

Roles: **tester** (plays the office engineer, on an offline VM), **support** (the owner or a support engineer), **observer**
(records times). Clock: the observer's.

| Seed | Severity (FR-COM-19)                            | How it is seeded                                                                | Expected from support                                                    |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| D1   | S1 — work stopped / data at risk                | a build with a command that throws on a documented input (crash report written) | acknowledgement, workaround (e.g. alternative command or plan), fix plan |
| D2   | S2 — major function degraded, workaround exists | a wrong numeric result in a query on a fixture (known oracle)                   | acknowledgement, confirmation from the bundle, workaround                |
| D4   | S4 — question                                   | "how do I export a section to DXF in Dutch UI?"                                 | answer pointing to the help page                                         |

Steps per seed:

1. Tester hits the problem, opens Help › Create support bundle… (or `llull diagnostics create`), reviews every item, removes
   nothing for D1 / D2, opts in to the document only for D2, saves the bundle; for D1 also saves the `ReportIssueDialog` draft.
2. Tester sends bundle + draft through the tier's channel (e-mail for standard; the community tier uses the GitHub draft).
   Observer records `t0`.
3. Support issues a ticket id and acknowledges (`t_ack`), reproduces **from the bundle alone** (no questions back) (`t_repro`),
   and returns a workaround or answer (`t_work`).
4. Observer records times, whether reproduction needed extra information, and any personal data found in the bundle (must be 0,
   cross-check of VC-COM-19).

Pass: every seed within its tier's first-response and workaround targets; D1 and D2 reproduced from the bundle alone; 0 personal
data found. Record: `records/VC-COM-20-<date>.md` with the times table and the bundle manifests' sha256.

Runnable in part today: the crash report (`llull crashes`) and the issue draft (`ReportIssueDialog`) exist; the bundle does not.

## B. CRA reporting tabletop (Art 14)

Scenario: at `T0` a researcher reports, through the CVD contact, a path traversal in `import_*` file handling that is being used
against offices (an **actively exploited vulnerability**, Art 14(1)). The exploit details are fictitious.

| Step                                                                                   | Deadline (Art 14(2))                                | Output prepared in the drill                                                                               |
| -------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Triage, confirm "actively exploited", decide the Member States affected                | —                                                   | triage note                                                                                                |
| Early warning via the ENISA Single Reporting Platform to the Belgian CSIRT coordinator | ≤ T0 + 24 h                                         | filled early-warning form (Member States where the product is available)                                   |
| Vulnerability notification                                                             | ≤ T0 + 72 h                                         | general product info, nature of exploit, corrective / mitigating measures taken and for users, sensitivity |
| Inform impacted users (Art 14(8))                                                      | without undue delay                                 | advisory text EN / FR / NL / DE + machine-readable advisory                                                |
| Security update released (Annex I Part II (2)(8))                                      | as soon as possible                                 | signed patch release, separate from feature changes                                                        |
| Final report                                                                           | ≤ 14 days after the corrective measure is available | description, severity, impact, malicious actor info if any, update details                                 |

Checks: SRP account exists for the manufacturer (portal https://portal.cra-srp.enisa.europa.eu/ — R22); the runbook names who
submits and who replaces them when absent; templates exist in the 4 languages for the user advisory. Record:
`records/VC-COM-22-<date>.md` with the timestamps of each prepared output. Do **not** submit anything to the real SRP in a drill.
