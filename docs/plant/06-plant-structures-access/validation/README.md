# Gap 06 STA — Validation pack

This pack defines how llull's plant access structures (gratings, platforms, ladders, guardrails, steel stairs, pipe
racks, fireproofing, reachability) will be proven right. Every reference value is either quoted from a source graded in
[sources.md](sources.md) or derived from a cited closed form in [`data/derive_expected.py`](data/derive_expected.py)
(run it with `python3 -I data/derive_expected.py`). **No expected value comes from running llull.** The commands do not
exist yet, so every plan is marked `PROPOSED` and names the commands that are missing.

When the commands land, the cases run without a human:

- Unit tests read `data/access_rules.json`, `data/grating_19w4_load_table.json` and `expected_results.json` directly.
- `tests/unit/plantStructures/scenarioPlans.test.ts` runs every plan in `plans/` through `build_project`, which is the
  same path as `llull run plan.json --json`. Each `expected` row is a JSON path into a step's `data`, a value and a
  tolerance (AF-23).

## Gate policy

- Only **grade A** rules and cited closed forms are pass / fail thresholds.
- Grade **B** rules are loaded but can only produce a `warn` finding, always paired with `STA_RULE_UNVERIFIED`. A warning
  cannot be suppressed (AF-32).
- Grade **C** rules are not loaded at all. They are listed in `access_rules.json` so the gap is visible.
- Every `check_access` result carries `reviewRequired: true`. Access means are safety equipment, and a qualified person
  signs them off (AF-33).

## Files

| File                                  | Content                                                                                                                       | Grade         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `data/access_rules.json`              | 38 access rules (ISO 14122-2/3/4, OSHA 1910.23/25/28/29) in mm / N / deg with the original imperial value, clause and source | A / B / C per row |
| `data/grating_19w4_load_table.json`   | NAAMM-basis 19-W-4 1-1/4 x 3/16 grating: published U row from two manufacturers vs the closed form, pedestrian span           | A             |
| `data/ifc4x3_enums/*.md`              | buildingSMART IFC 4.3 enum definitions for railings, stairs (incl. LADDER), stair flights, slabs, plates, members (unchanged copies + licence notice) | A |
| `data/derive_expected.py`             | closed-form derivation of every computed expected value                                                                        | —             |
| `expected_results.json`               | index of the 14 VCs: inputs, expected values, tolerance, source, FR, test file                                                 | —             |
| `plans/sc-sta-0*.json`                | 7 CLI scenarios (`build_project` actions + `expected` rows)                                                                    | —             |

## Real use cases

| #   | Use case                                                                                       | What llull must do                                                         | VC / scenario                      |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| U1  | Access to the top manway of a 7.3 m drum: caged ladder to a platform                           | ladder with a uniform pitch, cage from 2.2 m, rules for the site's region  | VC-STA-01..03, SC-STA-01           |
| U2  | Operator stair to a +3.0 m process platform                                                    | stringer stair with equal risers, 2h + g check, both rulesets              | VC-STA-04, SC-STA-02               |
| U3  | Half-round platform at +6.0 m around a distillation column                                     | brackets off the shell, grating segments, railing with posts and toe plate | VC-STA-07, SC-STA-03               |
| U4  | 60 m two-tier pipe rack in a unit                                                              | bents, tier beams, longitudinal struts, bracing, verified by `check_steel_members` | VC-STA-09, SC-STA-04         |
| U5  | Grating selection for a walkway on beams at 900 / 1800 mm                                      | allowable load and deflection per span from the grating type               | VC-STA-06, SC-STA-06               |
| U6  | Can an operator reach valve HV-101?                                                            | access graph from grade, operating-height check per target                 | VC-STA-11, SC-STA-07               |
| U7  | Fireproofing quantities for the rack columns in a fire-scenario zone                           | encasement area and volume over a height given by the project              | VC-STA-10                          |
| U8  | Deliberately wrong access design                                                               | stable codes with remediation, unverified-rule warnings, review flag       | VC-STA-05, VC-STA-13, SC-STA-05    |

## Validation cases

| VC        | What                                                                         | Reference                                                                                 | Tolerance                          | Test                         |
| --------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------- |
| VC-STA-01 | Ladder rung count and pitch for H = 2.8 … 9.0 m                              | closed form `spaces = ceil(H / 300)`, `rungs = spaces − 1`; 300 = ISO pitch max (A)       | count exact, pitch 1e-3 mm         | `ladder.test.ts`             |
| VC-STA-02 | Ladder pitch, width, back clearance, rail extension per ruleset              | OSHA 1910.23(b)(2),(b)(4),(d)(2),(d)(4); ISO 14122-4 pitch 225–300 (A)                    | verdict exact                      | `accessRules.test.ts`        |
| VC-STA-03 | Fall-protection trigger (ISO 3000 mm, OSHA 24 ft), cage start, OSHA cage-not-primary, 50 ft cage landings | `access_rules.json` A rows                                    | verdict exact                      | `accessRules.test.ts`        |
| VC-STA-04 | Steel stair: risers, treads, h, 2h + g, pitch, run (3 cases) and rules       | closed form; ISO 14122-3 600–660; OSHA 1910.25(c) (A)                                     | 1e-3 mm, 1e-3°                      | `stair.test.ts`              |
| VC-STA-05 | Guardrail height, knee-rail gap, toe plate; post count                       | ISO 14122-3 1100 / 500 / 100 (A); OSHA 42 ± 3 in (A); toeboard 3.5 in (B)                 | verdict exact; spacing 1e-3 mm     | `railing.test.ts`            |
| VC-STA-06 | Grating U, D, C vs two manufacturer tables; pedestrian span                  | S20 + S21 agree; F, E from NAAMM header (S19)                                             | ≤ 0.5 psf; 1e-3 rel                | `grating.test.ts`            |
| VC-STA-07 | Circular platform radii, area, mass, arcs, posts, brackets                   | closed form annulus sector                                                                | 1e-6 rel                           | `circularPlatform.test.ts`   |
| VC-STA-08 | Rectangular platform area, mass, railing length with a gated opening         | closed form                                                                               | 1e-6 rel                           | `platform.test.ts`           |
| VC-STA-09 | Pipe rack: bents, columns, beams, struts, lengths, steel mass                | closed form, llull catalogue kg/m                                                         | exact / 1e-6 rel                   | `pipeRack.test.ts`           |
| VC-STA-10 | Fireproofing area and volume (boxed, 40 mm, 9 m)                             | closed form; height explicit                                                              | 1e-6 rel                           | `fireproofing.test.ts`       |
| VC-STA-11 | Reachability of three operating points; no-egress variant                    | scenario geometry, explicit project band                                                  | exact                              | `reachability.test.ts`       |
| VC-STA-12 | IFC classes / predefined types for ladder, railing, grating, stair, strut    | `data/ifc4x3_enums` (buildingSMART)                                                       | exact strings                      | `ifcAccess.test.ts`          |
| VC-STA-13 | Codes, remediation, B-rule warnings, `reviewRequired`                        | AF-11, AF-32, AF-33                                                                       | exact                              | `accessCodes.test.ts`        |
| VC-STA-14 | Purity and replay of every mutating command; golden snapshot                 | L3, L8, AF-13                                                                             | deep-equal                         | `tests/golden`               |

### Derivations used as expectations

- **Ladder (VC-STA-01).** The rungs are equally spaced between the departure level and the arrival level. The arrival
  level counts as the last step, so `spaces = ceil(H / pMax)`, `rungs = spaces − 1` and `pitch = H / spaces`. For
  H = 7300 mm: ceil(24.33) = 25 spaces, 24 rungs, pitch 292.0 mm. The pitch lies in ISO 225–300 mm and in OSHA
  254.0–355.6 mm (10–14 in), so a single default (pMax 300) satisfies both rulesets whenever `H / spaces ≥ 254`. If it
  does not, the generator increases `spaces` only while the pitch stays ≥ the active minimum. The check then reports the
  conflict (`STA_LADDER_PITCH_OUT_OF_RANGE`) and never adjusts it silently.
- **Stair (VC-STA-04).** `n = ceil(rise / riserMax)`, `h = rise / n`, `treads = n − 1`, `run = treads · g`. For
  3000 / 180 / 280: n = 17, h = 176.4706, 2h + g = 632.9412, pitch = atan(176.4706 / 280) = 32.2213°, run 4480 mm.
  This is the same convention as the existing `add_stair` (the last riser lands on the upper floor) and Bonsai's
  `NumberOfRisers = treads + 1` [S24].
- **Grating (VC-STA-06).** A 1 ft strip of 12 / 1.1875 = 10.105 bars of 1.25 × 0.1875 in gives S = 0.49342 in³/ft and
  I = 0.30839 in⁴/ft. The uniform allowable is `U = 96 F S / L²` (psf, L in in, F = 18 000 psi). At 24 / 30 / 36 in
  this gives 1480.26 / 947.37 / 657.89 psf. Two manufacturer tables print 1480 / 947 / 658, and Marco also prints 483
  at 3'-6" (closed form 483.35). The maximum pedestrian span (100 psf, D ≤ 1/4 in) is
  `L = (0.25 · 384 E I / (5 w))^(1/4)` = 67.374 in = 1711.3 mm. The deflection at 100 psf over 36 in is
  0.13407 · 100 / 657.895 = 0.020379 in = 0.5176 mm.
- **Circular platform (VC-STA-07).** ri = 3000 / 2 + 150 = 1650 mm, ro = 2650 mm,
  A = (π / 2)(2.65² − 1.65²) = 6.754424 m². The mass at 8.9 psf (43.4536 kg/m²) is 293.504 kg. The outer arc is
  π · 2.65 = 8.325221 m, plus two 1.0 m ends gives 10.325221 m of railing. Outer posts = ceil(8325.22 / 1500) + 1 = 7.
- **Pipe rack (VC-STA-09).** 60 / 6 = 10 bays, so 11 bents and 22 columns of 7.0 m (154 m). There are 22 tier beams of
  6.0 m (132 m) and 2 × 10 × 2 = 40 struts of 6.0 m (240 m). The mass is 154 × 117 + 372 × 42.2 = 33 716.4 kg, using
  the catalogue rows HEB300 117 kg/m and IPE300 42.2 kg/m in `packages/domain-aec/src/steel/profiles.ts`.
- **Fireproofing (VC-STA-10).** Boxed HEB300: perimeter 2(300 + 300) = 1.2 m, area 1.2 × 9 = 10.8 m²,
  volume (380² − 300²) × 9 = 0.4896 m³.
- **Unit conversions.** 1 in = 25.4 mm, 1 lbf = 4.4482216 N, 1 psf = 0.04788026 kPa, 1 psf = 4.882428 kg/m².

### Known choices (documented, not failures)

- **Post layout.** llull spaces posts equally with a post at each end: `ceil(L / sMax) + 1`. Bonsai uses a fixed
  spacing and centres the remainder, `floor(L / s) + 1` [S24]. Both are valid. llull's choice puts a post at every
  corner and end, which most fabrication details need.
- **OSHA 24 ft boundary.** OSHA requires fall protection only on a ladder that extends *more than* 24 ft. A climb of
  exactly 7315.2 mm therefore passes; 7315.3 mm does not.
- **2036 OSHA retrofit date.** A proposed rule (Federal Register 2026-04-06) would repeal this date. llull reports
  the date in a warning, pins it to a rule-table version, and sets `reviewRequired` [S6].

## What could not be verified

- The ISO 14122-2/3/4:2016 clause text was not read in full (paywalled). Several values are not confirmed: the cage
  hoop spacing (1000 vs 1500 mm), the 6 m single-flight rule, the toe-plate gap (10 mm in 2001, 12 mm in 2016), the
  guard-rail post spacing, and the guard-rail test loads. They are B or C in the rule table and gate nothing.
- No extracts were found for the API 2218 fire-scenario envelope dimensions or the PIP pipe-rack criteria. llull takes
  them as explicit project inputs and never defaults them.
- No metric (RAL-GZ 638 / DIN 24537) grating load table was found. Metric grating types will be computed from bar
  geometry with the same closed form and flagged `unverified` until a table is cross-checked.
