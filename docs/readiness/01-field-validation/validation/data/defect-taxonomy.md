# 01 PIL — Error and defect taxonomy (FR-PIL-08)

## Observation types (observer log, per attempt)

| Type | Definition |
| ---- | ---------- |
| `slip` | right intention, wrong action (mis-click, wrong field); recovered by the participant |
| `mistake` | wrong intention from a wrong model of the product (looked for the feature in the wrong place) |
| `assist` | the moderator gave a hint (R1 only) |
| `workaround` | goal reached by a path that a regular user would not accept (manual recalculation, external tool) |
| `defect` | the product behaved wrongly or unhelpfully. It gets an intake row |

## Defect types

| Type | Examples | Default pack |
| ---- | -------- | ------------ |
| `crash` | app, renderer or backend ended; crash report written | 04 DSF / 06 E2E |
| `data-loss` | work lost, file unreadable, undo / reopen did not restore | 04 DSF |
| `wrong-result` | a number, geometry or deliverable is wrong without a warning | 07 VNV / owning domain |
| `refusal-unclear` | a refusal whose message or remediation did not let the user fix it | owning command |
| `missing-capability` | the job needs a feature llull lacks | owning domain |
| `interaction` | snaps, selection, keyboard flow, discoverability, too many steps | 02 UXD |
| `exchange` | a file from or to the incumbent opens wrongly | 08 XCH |
| `performance` | a wait the user notices and complains about | 03 PRF |
| `install` | install, update, dependency | 05 INS |
| `docs` | help or kit text wrong or missing | 09 COM |

## Severity (Nielsen 0–4 [R21], plus overrides)

Rate frequency, impact and persistence [R21]. Then apply the overrides: a `data-loss` or `wrong-result` defect is **S4**
whatever its frequency, and a defect that blocks a critical task is at least **S3**.

| Sev | Meaning | Exit rule (EX-5) |
| --- | ------- | ---------------- |
| S0 | not a problem | closed |
| S1 | cosmetic | may stay open |
| S2 | minor: slows down, workaround acceptable | may stay open, ranked by the advisory group |
| S3 | major: blocks a task or needs an unacceptable workaround | **0 open at exit** |
| S4 | catastrophe: data loss, silently wrong result, crash losing work | **0 open at exit**; fix before the next round |

Two raters rate independently (VC-PIL-31). A disagreement at S3 / S4 is resolved by the higher rating unless both agree
otherwise in writing.

## Triage budget

Every intake row is triaged within 2 working days (spec budget, VC-PIL-14): severity, type, pack, duplicate-of, board id.
An S4 found in R1 or R2 stops that profile's next round until it is fixed.
