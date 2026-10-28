# 07 VNV — Engineering checks a professional engineer can rely on, document and sign — Functional specification

Status: specification only (2026-10-28). Nothing in this pack is built. Gap id `VNV` (readiness track, [`../README.md`](../README.md)).
Template: [`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md), [`../../plant/TEMPLATE.md`](../../plant/TEMPLATE.md); operator model:
[`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) (AF-30 … AF-34). Technical view: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md).
Validation: [`validation/README.md`](validation/README.md).

**Id range.** The gap id `VNV` is already used by the physics V&V harness ([`../../physics/00-vv-harness/`](../../physics/00-vv-harness/),
FR-VNV-01…20, TR-VNV-01…, VC-VNV-01…22, built M1 + M2). This pack extends that harness and numbers its ids from **101**
(FR-VNV-101…, TR-VNV-101…, VC-VNV-101…) so the two never collide; [`../vc.schema.json`](../vc.schema.json) accepts 3-digit ids.

## 1. Summary

llull runs engineering checks: steel members to EN 1993-1-1 (`check_steel_members`), portal frames, bracing, purlins, crane
runways with fatigue, foundations and footings, pipe-support spans, pipe hydraulics, road alignment design checks, storm drainage
(Manning, Rational Method, IDF, HGL) and the CAE checks (FEA margins, thermal, fatigue, fracture, dynamics). The physics packs
already judge FEA / thermal results against NAFEMS benchmarks. **The building, civil and plant checks do not.** The code audit on
main f1351cff (TECHNICAL_SPEC §1) found:

| Finding | Evidence |
| ------- | -------- |
| No AEC check is tested against a published worked example. Tests use in-test hand calculations, echo the same table literals the code uses, or check self-consistency | `tests/unit/building/steelMembersCheck.test.ts:156`, `civil/drainage.test.ts:33`, `civil/roadCommands.test.ts:320`, `building/pipeSupportCheck.test.ts:59-97` |
| Clause references exist only as free text inside row labels (`'shear (§6.2.6)'`); no standard edition, no national annex | `industrial/steelDesign/steelMemberRows.ts:36` |
| Every Eurocode NDP is a constant at an assumed value (γM0 implicit 1, γM1 = 1.0, γM2 = 1.25, γMf = 1.15, μ = 0.45, γR,h = 1.1 …); no national-annex mechanism anywhere | `steelDesign.ts:10-11`, `runwayCheckModel.ts:40-80`, `foundationModel.ts:68-70`; grep `nationalAnnex|NBN|NDP` = 0 hits |
| Civil design tables (side friction f, minimum K) are "simple AASHTO-style tables" with no source; drainage cites no manual | `civil/road/roadChecks.ts:2,21-24`; `civil/drainage/*` |
| AEC refusals are plain text, not stable codes | `steelMembersCheck.ts:108-124` |
| No calculation report exists. Checks return a CSV table (Check, Value, Limit, Unit, Utilisation, Status, Combination) | `industrial/reports/checkReport.ts:7-37` |
| Signatures exist (PLM, Ed25519, human gate) but sign only releases / iterations, not a calculation | `packages/plm/src/types.ts:25-36` |

Transcribing the first published worked examples for this pack already found a **verdict-changing error in a published example**
(JRC EUR 27346 §2.1.8 uses αv = 0.6 for a class 6.8 bolt; the same report's Table 3.4 extract gives 0.5; the corrected group
resistance 550.6 kN < NEd 580 kN fails where the example passes, VC-VNV-125) and two unconservative roundings (VC-VNV-123, -124).
That is the case for a V&V record: a check is only as trustworthy as the evidence attached to it, and the evidence itself needs review.

This pack specifies: a V&V record per check, national-annex parameters as sourced data, a `calculation_report` command that
produces a reviewable, traceable report, a review-and-sign workflow on that report, out-of-scope refusals with codes, and a
regression suite of published worked examples gating CI. It closes gap 7 of the readiness track: **a professional engineer can
rely on, document and sign llull's engineering checks**.

## 2. Context and value

- **Who is responsible.** In Belgium, the professional who performs intellectual services for building works (architect,
  surveyor, "autre prestataire du secteur de la construction", which covers a consulting engineer) carries the civil liability
  for them and must be insured for it (loi du 9 mai 2019, art. 2 4° and art. 3 [L1]; ten-year liability insurance, loi du
  31 mai 2017 [L2]; architects may not practise uninsured, loi du 20 février 1939 art. 2 § 4 [L3]). The software is a tool, not a
  party. So the product must give the engineer what they need to take responsibility: what was checked, against which clause and
  annex, with which inputs and assumptions, how far the tool is validated, and a record of who reviewed and signed it.
- **What a standard says.** ASME V&V 10 gives the vocabulary and framework for verification and validation of computational solid
  mechanics [R1]; V&V 20 the counterpart for fluids and heat transfer [R2]. NAFEMS ESQMS:01 (which replaced the QSS supplement to
  ISO 9001 in March 2020) interprets ISO 9001:2015 for engineering simulation [R3]. NQA-1 Subpart 2.7 (reference only; nuclear) asks
  for documented software requirements, review, configuration management and problem reporting for design software [R5].
  llull uses these terms: **code verification** (the formula is implemented right: closed forms, manufactured cases), **calculation
  verification** (this check reproduces a published worked example), **validation** (the method suits the physical case: physics
  packs, field review).
- **How incumbents do it.** Dlubal publishes verification examples "based on known analytical solutions or published reference
  cases" [R6]; Tekla Tedds compares each calculation "to published examples from trusted industry sources" [R7]; SCIA compares its
  EN 1993 steel code check to benchmark projects and lists the supported articles in a theory document [R8]; Tekla Structural
  Designer's Eurocode guide has a verification section [R9]. All of them ship national-annex parameters as selectable per-country
  tables [R10][R13], and a printable calculation report is the deliverable an engineer signs.
- **Free worked examples exist.** The JRC report *Design of Steel Buildings — Worked examples* (EUR 27346) [W1], FHWA HEC-22 *Urban
  Drainage Design* 4th ed. [W2], state-DOT manuals reproducing the AASHTO sight-distance basis [W3][W4], and NAFEMS benchmarks reproduced
  in vendor manuals [W6][W7]. Paywalled sources (SCI P363 [W8], Access Steel [W9], ECCS, designers' guides, the Green Book, the NBN
  annexes) are named but never transcribed.
- **Why llull must close it.** The production gate passes four office jobs ([`../../PRODUCTION_GATE.md`](../../PRODUCTION_GATE.md))
  but every "check passes" there is llull grading itself. `docs/INDUSTRIAL.md:266` already says "preliminary design aid, not a
  substitute for the engineer of record". Until the evidence exists, that disclaimer is the product's ceiling.

## 3. Personas and user stories

- **Design engineer (primary operator, desktop app).**
  - US-1: "I pick the design basis once per project (EN 1993 with the Belgian annex) and every check uses it and says so."
  - US-2: "For each check I see its V&V status (validated against N published examples, or verified only) and its limits."
  - US-3: "I produce a calculation report for the members I checked: inputs, clauses, intermediate values, utilisation, software
    version, document hash. I can hand it to a checker."
  - US-4: "When a member is outside what the check covers (class 4 section, tapered member, fire), llull refuses with a code and
    says why, instead of returning a number."
- **Checking / signing engineer (reviewer, desktop app).**
  - US-5: "I open the report, trace any number to its clause and its input, and see the V&V evidence for the check that produced it."
  - US-6: "I sign the report with my key; if anyone edits the model afterwards, the report shows it is stale and my signature no
    longer applies to the current model."
- **Agent (CLI).**
  - US-7: "I run the checks and `calculation_report` from the CLI; I can never sign (human gate)."
- **llull maintainer.**
  - US-8: "When I change a check, CI tells me which published examples it no longer reproduces."

## 4. Scope

| Phase | Content |
| ----- | ------- |
| **MVP** | V&V record format + records for `check_steel_members` (cross-section, flexural buckling, LTB), bolts / welds rows, `check_drainage_network` / `size_drainage_pipes`, `alignment_report` design checks · design basis + NDP tables (EN recommended set, BE set with grades) · structured clause on every row · `calculation_report` (HTML, JSON) · out-of-scope codes · regression suite VC-VNV-120…146 in `npm run check` |
| **V1** | records for every remaining AEC check (portal frames, sway, bracing, purlins, crane runways incl. fatigue, foundations, footings, pipe supports, pipe hydraulics) · report PDF (desktop, offline) · sign workflow on reports · staleness · errata register · qualified-engineer review of three reports |
| **V2** | further corpora (SCI P363 member tables under licence, ECCS / designers' guides if licensed, more HEC-22 chapters, NAFEMS sets already owned by physics packs) · other national annexes (NL, FR, UK) as data |
| Out of scope | Certifying llull to a standard (no claim of ISO 9001 / ESQMS conformity); performing the engineer's legal role; checks not implemented today (pipe stress B31.3 is pack [`../../plant/07-pipe-stress-flexibility`](../../plant/07-pipe-stress-flexibility/)) |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-VNV-101 | MUST | Every engineering check command has a **V&V record**: scope (what it checks, which member / element types), governing standard with edition and clauses, national-annex parameters it reads, assumptions, limits of validity, verification cases (published targets, tolerance, grade), status, record version. A check without a record cannot be called "validated" anywhere | US-2; vendors publish the same | [R6][R7][R8] |
| FR-VNV-102 | MUST | Every result row of a check carries a structured reference: standard, edition, clause (and table / equation), national annex id and edition, record id. Free-text "§6.2.6" in a label is not enough | US-5; today text only | audit |
| FR-VNV-103 | MUST | A document has an explicit **design basis**: standard set and national annex chosen by the user (e.g. `EN-recommended`, `BE`). A Eurocode check on a document with no design basis refuses (`VNV_DESIGN_BASIS_MISSING`); nothing falls back silently | US-1; AF-31; NBN: an EN is used officially in Belgium only with its annex | [R12] |
| FR-VNV-104 | MUST | Nationally determined parameters are **sourced data tables** (parameter, clause, value, annex document + edition + clause, grade, verified flag). A value the user overrides is recorded with the reason and shown in every result and report | AF-30, AF-31 | [R10][R13] |
| FR-VNV-105 | MUST | An NDP whose value is not confirmed from the annex text (grade B/C, e.g. today's BE γM values from a vendor page) is flagged `unverified`; the flag propagates to every result and to the report as a warning that cannot be hidden (`VNV_NDP_UNVERIFIED`) | AF-32; the BE annex edition itself is unconfirmed | [R10][R11] |
| FR-VNV-106 | MUST | A read-only `calculation_report` command produces a report for a selection (members, networks, alignments, analyses) and a set of checks: project and document identity, design basis and NDP table, per item the inputs (section, material, lengths, loads, combinations), the governing clause chain with intermediate values, utilisation and verdict, warnings, assumptions, out-of-scope refusals, V&V status per check | US-3, US-5 | — |
| FR-VNV-107 | MUST | The report is traceable and reproducible: it states llull version and build commit, the document content hash (`document_content_hash`), the V&V record versions, the NDP table version, and its own SHA-256. The same document and selection give byte-identical report data | US-6; signature needs fixed bytes | [R5] (configuration management) |
| FR-VNV-108 | MUST | Intermediate values are reported with the formula reference and unrounded values (rounded only for display, with the display precision stated). The report never rounds a factor before using it | VC-VNV-122…124: published rounding moves results by up to 2 % | W1 |
| FR-VNV-109 | SHOULD | The report exports as self-contained HTML and (desktop) PDF, offline, plus a JSON data file and the existing CSV table | AF-41; signable deliverable | — |
| FR-VNV-110 | MUST | Review and sign: a human reviewer records review / approval of a report through the existing PLM signature path (Ed25519, trusted key, human gate). The signature covers the report's SHA-256; an agent caller is refused (`PLM_HUMAN_GATE`) | US-6, US-7; AF-33, AF-34 | [L1] |
| FR-VNV-111 | MUST | After any change to the document, an existing report and its signatures are marked **stale** (`VNV_REPORT_STALE`) in `calculation_report` status and in the UI; re-issuing creates a new report, never edits a signed one | US-6 | — |
| FR-VNV-112 | MUST | A check refuses items outside its record's limits with a stable code and a plain sentence (e.g. `STL_SECTION_CLASS4`, `STL_TAPERED_MEMBER`, `DRN_PRESSURE_FLOW_UNSUPPORTED`, `ALN_SPEED_OUT_OF_TABLE`; list in TECHNICAL_SPEC §7). The refusal appears in the report; it is never a silent pass | US-4 | audit (plain-text failures today) |
| FR-VNV-113 | MUST | A regression suite of published worked examples runs in `npm run check` and fails CI on any grade-A case outside tolerance. It holds ≥ 15 grade-A cases across steel, drainage, alignment and FEA at MVP | US-8 | [R6][R7] |
| FR-VNV-114 | MUST | Comparison rules are explicit: the gate compares with the formula recomputed in full precision from the published inputs; the published (rounded) value is checked within a stated rounding tolerance; a published value that contradicts its own source is recorded as an **erratum** and llull follows the corrected value | VC-VNV-124, -125 | W1 |
| FR-VNV-115 | MUST | Every check result and every report carries `reviewRequired: true` with the reason, and the report's first page says in plain words that the results are computed by llull and need a qualified engineer's review and signature | AF-33; liability sits with the engineer | [L1] |
| FR-VNV-116 | MUST | Each check shows a V&V status: `validated` (≥ 1 grade-A published case per governing clause group passes), `verified` (closed forms only), `unvalidated` (neither). The status is in the result data, the UI and the report | US-2 | — |
| FR-VNV-117 | SHOULD | Change control: a change to a check's code or tables bumps its record version and re-runs its cases; the report lists record versions; an engineering CHANGELOG lists changes that can move a result | NQA-1 2.7 config mgmt, problem reporting | [R5] |
| FR-VNV-118 | SHOULD | An errata register lists every published-source error found (source, page, nature, effect) and is shown from the V&V record | VC-VNV-125 | W1 |
| FR-VNV-119 | SHOULD | A qualified engineer (Belgian practising structural engineer) reviews the record template and three generated reports (steel, drainage, alignment) and records findings; MUST findings are fixed before the pack is closed | field proof at PRL3 | — |
| FR-VNV-120 | MUST | Every check, `calculation_report` and every refusal is a registered command or a coded result reachable from the CLI (`llull … --app`); no capability exists only in the UI | AGENT_FIRST | CLAUDE.md |

## 6. Non-functional requirements

- Offline: reports, records and NDP tables ship with the app (AF-41); no network.
- Determinism: report data JSON is canonical (sorted keys, fixed number formatting) so its hash is stable across machines.
- Performance: `calculation_report` for 500 members ≤ 10 s on the reference machine (target; measured in pack 03 PRF corpus).
- Language: report text in English at MVP; FR / NL labels are pack 09 COM localisation.
- Nothing in a report is invented: every number is an input, a computed value with its formula, or a table value with its source.

## 7. Acceptance

The pack is closed when every MUST FR has a passing VC in [`validation/README.md`](validation/README.md), ≥ 15 grade-A
worked-example cases gate CI, the two errata found by transcription are fixed or documented as in VC-VNV-125 / -124, and the
qualified-engineer review (VC-VNV-119) has no open MUST finding. Readiness level: **PRL3 daily-capable**
([`../VALIDATION.md`](../VALIDATION.md)).

## 8. Open questions for the owner

1. **Belgian annex text.** The BE values in the NDP table (γM0 = 1.0, γM1 = 1.0, γM2 = 1.25) come from one vendor page [R10], and
   vendors cite three different editions (ANB:2008, an update in 2018, NBN/NA:2015-07 [R11]). Will you buy the current NBN EN 1993-1-1
   ANB (and -1-8 ANB) so the table can be graded A? Until then BE results carry `VNV_NDP_UNVERIFIED`.
2. **Sources to license.** SCI P363 (Blue Book), ECCS worked examples and the AASHTO Green Book would give many more cases (and
   source llull's civil tables f / K, today unsourced). Buy, or stay on free sources (JRC, HEC-22, DOT manuals) and keep the civil
   tables `unverified`?
3. **Who signs, and must reports require PLM?** Signing today needs a PLM-managed document and a registered key. Do you want a
   lighter "sign this report" path for engineers who do not use PLM, and who is the first qualified engineer for VC-VNV-119?
