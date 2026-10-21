# GDT — GD&T, Model-Based Definition (MBD) and semantic PMI — Functional specification

Gap id: **GDT** · Folder: `docs/aerospace/03-gdt-mbd-pmi/` · Status: specification (no implementation) · Date: 2026-10-15
Related gaps: 01 KRN (exact B-rep; owns `import_step_exact` and the face-query port) · 04 XCH (extends `import_step_exact` with verification and AP242 assembly/PMI transport; `export_step_ap242`,
validation properties, QIF) — GDT owns the semantic PMI **model, commands, checks, drawing integration, stack-up**
and the PMI stage of the AP242 translation.

## 1. Summary

llull can model exact B-rep solids (OCC kernel, `ShapeRecipe` boundary, KI5), draw associative 2D
dimensions (`add_dimension`: linear / aligned / radial / angular, 2D entities only) and generate live
drawing sheets from the 3D model (`create_sheet`, `create_drawing_view`, `add_section_view`,
`add_detail_view`, `export_sheet_svg`). It has **no notion of tolerance**: no datum, no datum reference
frame, no feature control frame (FCF), no size tolerance, no material condition modifier, no surface
texture requirement, no saved view, no annotation plane, no semantic link between an annotation and the
B-rep faces it controls, no tolerance stack-up, and no STEP AP242 PMI import/export. A dimension in llull
is a measurement of nominal geometry, not a requirement.

In aerospace, the nominal model is never the contract. Parts are bought, made and inspected against
tolerances (ASME Y14.5-2018 in the US, ISO GPS — ISO 1101:2017, ISO 5459, ISO 14405, ISO 2768 — in
Europe) [R1][R3][R5][R6][R7], and the primes have moved that requirement **into the 3D model** (MBD,
ASME Y14.41-2019 / ISO 16792:2021) [R2][R4]: Boeing suppliers must extract manufacturing and inspection
information from MBD datasets under D6-51991 [R23]; the F-35 digital thread uses the 3D solid models
directly for NC programming, CMM inspection and tooling [R24]; the DoD technical data package standard
MIL-STD-31000B (Oct 2018) added 3D (3D PDF) deliverables [R22]. Without semantic PMI, llull cannot
produce or consume a releasable aerospace part definition, cannot exchange one through STEP AP242
(the neutral MBD format whose semantic PMI the NIST test models exercise [R12][R13]), and cannot answer
the most common engineering question after "does it fit?": "does it fit **at the tolerance limits**?"
(stack-up). This gap closes that: semantic PMI as document data attached to B-rep faces through
commands, displayed in 3D (annotation planes, saved views) and on llull's drawing sheets, analysed
(well-formedness checks, worst-case / RSS / Monte Carlo stack-up) and exchanged (STEP AP242 semantic
PMI on desktop via the bundled CPython + OCP/XCAF, KI6).

## 2. Aerospace context & value

### 2.1 Who does it today, with which tools

| Actor | Practice (sourced) | Tooling today | llull opportunity |
| --- | --- | --- | --- |
| Boeing and its suppliers | D6-51991 "Quality Assurance Standard for Digital Product Definition at Boeing Suppliers" (Rev P current); §7.5: suppliers receiving Engineering/Tooling MBD datasets "must extract information from the dataset sufficient for manufacturing and inspection"; reduced-content drawings (§7.3) carry the same duty; Boeing runs an on-site DPD capability assessment [R23] | Commercial CAD (CATIA family), CMM software | A supplier-side viewer/checker that reads AP242 semantic PMI offline and reports what each feature must meet |
| Lockheed Martin F-35 | "Digital thread" = creation, use and reuse of 3D models by engineering and downstream functions; exact solid models used directly by manufacturing for NC, CMM inspection and tooling; reduced-dimension drawings in Phase 1; reported first-time part fit and less tool rework [R24] | Commercial CAD/PLM | MBD authoring with semantic links usable by CMM/NC tools via AP242 |
| Airbus | A350 "almost entirely digitally designed", "most complete 3D technical data" (maintenance documentation context) [R25] | CATIA 3D Master (vendor term) [R35] | Read-only consumption of 3D annotated data for MRO and suppliers |
| US DoD | MIL-STD-31000B (B revision Oct 2018 added 3D PDF to the TDP); TDP = authoritative description for manufacturing, inspection, logistics, CM [R22] | 3D PDF publishing tools | Export a TDP-style bundle (AP242 + sheets + manifest), V2 |
| NIST | MBE PMI Validation and Conformance Testing project (concluded 2015): test cases, CAD models, verification results measuring how CAD software and derived STEP/JT/3D PDF implement PMI [R12][R15][R16]; 411 PMI errors (98 unique) found across four CAD systems (2012/2015 versions) [R17]; STEP File Analyzer and Viewer (SFA) checks semantic/graphic PMI against CAx-IF practices [R18] | SFA (free, Tcl, Windows) | Use NIST test files + SFA as llull's PMI acceptance oracle |
| CAx-IF / MBx-IF | Recommended Practices for Representation and Presentation of PMI (AP242) v4.1, 2024-06-20 [R11]; uses the NIST test cases to test AP242 implementations [R12] | Vendor STEP translators | Conformance target for llull's AP242 PMI writer |

### 2.2 Value statements (sourced)

- NIST AMS 100-26 "The Model Based Enterprise" collects published estimates of avoidable cost: about
  $8.40 billion of engineer effort answering questions and producing extra drawings and $3.84 billion
  for machinists, plus $20.9–42.9 billion interoperability costs; these are secondary estimates quoted
  by NIST, not NIST measurements [R20]. llull's value proposition is the interoperability term: a
  semantic PMI model that round-trips through AP242.
- NIST GCR 18-015 defines a minimum information model for using a 3D model in place of a technical
  drawing [R21] — the information llull must hold to be MBD-capable.
- The NIST CAD verification work found that commercial CAD systems themselves produce semantic/graphic
  PMI errors (411 errors, 98 unique) [R17]: a deterministic, test-driven implementation measured on the
  same public test cases is a credible differentiator, and llull's command log (L8) makes every PMI
  edit auditable and replayable.

### 2.3 Key concepts (product vocabulary used in this spec)

| Concept | Meaning in llull | Notes / source |
| --- | --- | --- |
| Semantic PMI (representation) | machine-readable requirement linked to B-rep faces: characteristic, value, modifiers, datum reference frame | SFA docs: semantic PMI is the computer-interpretable representation of tolerances and datums [R18][R19] |
| Graphical PMI (presentation) | the drawn annotation (lines, text, tessellated glyphs) on an annotation plane; not computer-interpretable | SFA docs: graphic PMI "is not intended to be computer-interpretable" [R19] |
| Annotation plane | 3D plane on which an annotation is laid out and read | AP242 `ANNOTATION_PLANE` (present in all 17 NIST files, census) |
| Saved view | named camera + subset of PMI (and optionally section/entities) | AP242 `CAMERA_MODEL_D3` (1–23 per NIST file, census) |
| Datum feature / datum / DRF | a real face designated by a letter / its ideal simulated geometry / ordered set of ≤ 3 datums fixing a coordinate frame | ISO 5459 scope [R5]; AP242 `DATUM_FEATURE`, `DATUM`, `DATUM_SYSTEM` |
| Feature control frame (FCF) | characteristic + tolerance zone + modifiers + DRF | AP242 `*_TOLERANCE` entities |
| Feature of size (FOS) | cylinder, sphere, pair of opposed parallel planes: has a measurable size; can take MMC/LMC | AP242 `DIMENSIONAL_SIZE` |
| Material condition modifiers | MMC (max material: smallest hole / largest shaft), LMC, RFS; on datums MMB/LMB | AP242 `.MAXIMUM_MATERIAL_REQUIREMENT.` etc. occur in 12 of the 17 NIST files |
| Stack-up | the variation of a dependent dimension (gap, clearance) from its contributors' tolerances: worst case (arithmetic), RSS (statistical, independent normal), Monte Carlo (sampled, any distribution, non-linear) | derivations in `validation/generate_stackup_reference.py` |
| Model-only vs model + drawing | the two application methods of Y14.41 / ISO 16792 | [R2][R4] |

### 2.4 Comparison with existing tools (what users will expect)

| Tool | Semantic PMI authoring | AP242 PMI | Drawing link | Stack-up | Source / verification status |
| --- | --- | --- | --- | --- | --- |
| PTC Creo (GD&T Advisor) | yes, with an ASME Y14.5 rule set | yes (vendor) | yes | separate tools | PTC help page "ASME Y14.5 Rule Set" seen in search [R33]; feature detail not verified |
| Dassault CATIA (3D Master / FT&A) | yes | yes (vendor) | yes | separate tools | vendor blog [R35]; detail not verified |
| Four major CAD systems tested by NIST (CATIA, NX, Creo, SolidWorks; 2012/2015 versions) | yes | STEP/JT/3D PDF derived files tested | — | — | NIST found 411 PMI errors (98 unique) [R17] |
| OpenCascade (OCCT) | data model (XCAF `XCAFDimTolObjects`) | import per CAx-IF practices; export semantic only (forum report) | — | — | [R26][R27][R28][R29] |
| NIST SFA | — (analysis/viewing) | reads and checks semantic + graphic PMI; viewer for graphic PMI | — | — | [R18] |
| llull today | none | none | sheets without PMI | none | §1 |
| llull after this gap | commands (UI/MCP/CLI) with replay-stable face links | semantic import/export via OCP (V1) | PMI rendered on live sheets | WC/RSS/MC query | this spec |

### 2.5 Worked example of the value (from the reference data)

A housing depth H = 100 ± 0.10 mm receives four spacers (24.95 ± 0.05, 25.00 ± 0.03, 24.90 ± 0.04,
25.00 ± 0.02). Nominal gap 0.15 mm. Worst case says the gap ranges −0.09 … +0.39 mm (interference
possible); RSS (±3σ normal) says 0.026 … 0.274 mm, with a predicted interference probability of
1.44 × 10⁻⁴; if the parts are uniformly distributed instead of normal, the exact probability rises to
1.21 × 10⁻² (≈ 84× higher) — a decision that changes the tolerance allocation. llull must produce
exactly these numbers (`validation/stackup_reference.json`, SU-01/SU-02, derived analytically and by a
seeded Monte Carlo of 200 000 samples).

### 2.6 Why it blocks aerospace use

1. No releasable part definition: an aerospace part without tolerances cannot be quoted, made or
   inspected (Boeing D6-51991 §7.5 assumes the dataset carries manufacturing/inspection information [R23]).
2. No AP242 PMI exchange: llull's STEP export (`export_step_ap242`, AP214 B-rep) drops every
   requirement; imported supplier models lose their PMI.
3. No tolerance analysis: fit/clearance decisions are made on nominal geometry only.
4. Drawings without GD&T: `export_sheet_svg` can only add overall width/height (`showDimensions`).

## 3. Personas & user stories

Operating model: [`../AGENT_FIRST.md`](../AGENT_FIRST.md) (authoritative). The **operator** is an AI agent driving the
`llull` CLI (`--doc` headless or `--app` on the open desktop window; MCP for cloud agents). The **owner** asks the agent for
a result and is not assumed to be an engineer. A **qualified reviewer** (design engineer with GD&T competence, checker,
supplier-quality authority) is involved only where tolerances become a release or inspection contract.

| Persona | Who | Surface | Responsibility in this gap |
| --- | --- | --- | --- |
| **OP** Operator (primary) | CLI / MCP agent | `llull search/describe`, plan files, `run --validate`, `check_pmi`, `list_pmi`, `analyze_stackup`, `render_view --save` | Builds the part and its PMI from the owner's intent or a supplier file, checks it, explains it |
| **OW** Owner | Non-engineer requester (startup founder, buyer, programme assistant) | Talks to the agent; may watch the desktop app | States the goal ("make this bracket inspectable", "will these spacers fit?"), accepts plain-language results |
| **QR** Qualified reviewer | GD&T-competent engineer / checker / supplier quality | Desktop review surface (3D PMI, sheets), `check_pmi` report, release (gap 09) | Approves every tolerance an agent proposed before it becomes a contract (AF-33/AF-34) |

**Key risk.** An AI operator choosing tolerances is plausible-looking but unqualified engineering. Therefore every PMI item
created by an agent caller carries `reviewRequired: true` with a reason until a qualified reviewer accepts it
(`accept_pmi_review`, human gate), and `check_pmi` refuses nothing silently: every malformed or doubtful frame is a coded
finding (TECHNICAL_SPEC §7.2).

| Story id | As … I want … so that … |
| --- | --- |
| US-GDT-01 (OP) | define datums A/B/C on faces addressed by points (`facesNear`) and add FCFs with material modifiers through one plan file, so that the model carries the requirement, not just the shape |
| US-GDT-02 (OP) | set size tolerances on holes and shafts whose nominal llull measures from the B-rep, so that I never type a nominal that disagrees with the model |
| US-GDT-03 (OP) | read every PMI item as JSON (`list_pmi --json`: text, faces, plane, units) and look at it in a PNG (`render_view --save`), so that I can verify placement without a UI |
| US-GDT-04 (OP) | export a drawing sheet whose views show the PMI and get `data.pmi.placed/skipped`, so that MBD and drawing never diverge |
| US-GDT-05 (OP for OW) | run `analyze_stackup` (worst case, RSS, seeded Monte Carlo) and get numbers with units, method and probability of interference, so that I can answer "will it fit?" in one sentence the owner understands |
| US-GDT-06 (OP) | import a customer AP242 file offline and list every semantic PMI item with the face it controls, so that a supplier's inspection plan can be drafted (D6-51991 §7.5 duty [R23]) |
| US-GDT-07 (OP) | run `check_pmi` and get coded errors/warnings with remediation, so that I can fix malformed callouts myself before anyone sees them |
| US-GDT-08 (OP) | export STEP AP242 with semantic PMI and have it checked by NIST SFA in CI, so that downstream CAx tools receive the same requirements |
| US-GDT-09 (OW) | get a plain-language summary ("4 tolerances proposed by the agent, not yet approved by an engineer"), so that I know what still needs a qualified person |
| US-GDT-10 (QR) | review the agent's proposed PMI on the desktop (3D, sheet, `check_pmi` report) and accept or reject each item, so that only reviewed tolerances become a contract |
| US-GDT-11 (OP) | export a TDP-style package (AP242 + sheets + manifest) with revision data (V2) [R22] |

## 4. Scope / out of scope

### 4.1 Phases

| Phase | Content |
| --- | --- |
| **MVP** | PMI data model in the document (`doc.pmi`); standard selection (ASME Y14.5-2018 / ISO GPS) and a general-tolerance note; features (face sets on an OCC solid, re-resolved by points on replay); datum features A–Z and datum reference frames (up to 3 refs + datum material boundary modifiers); FCFs for the 14 ISO 1101 / ASME characteristics recognised by AP242 and OCC XCAF (15 incl. concentricity, see §8) with zone value, diametral zone, MMC/LMC/RFS, projected zone, free state, tangent plane, statistical, unequally disposed (UZ) value; size dimensions (± / limits / fit code text, count "nX"); location dimensions between two features; basic dimensions; notes; surface texture symbol (Ra/Rz value + unit) as an attached requirement; 3D display on auto annotation planes; saved views; `check_pmi` (well-formedness); `list_pmi`; 1D stack-up query (WC / RSS / Monte Carlo, seeded); PMI on drawing sheets (FCF frames, datum feature symbols, size callouts rendered in `export_sheet_svg`); all reachable from UI, MCP, CLI |
| **V1** | STEP AP242 semantic PMI **import** (desktop: OCP XCAF `STEPCAFControl_Reader` → JSON → commands) validated on the 17 NIST files; AP242 semantic PMI **export** (`STEPCAFControl_Writer` with GD&T mode); composite / multiple single-segment FCFs; datum targets; all-around / all-over / between; profile of a line; pattern stacks from PMI (auto-collect contributors along a dimension chain); ISO 14405 size modifiers (E, LP, GG …) as data; ISO 2768 class as a title-block note (values supplied by the user, never shipped) |
| **V2** | Graphical (presentation) PMI in AP242 (tessellated annotation occurrences); PDF sheet export of PMI; 3D tolerance zone visualisation; 2D/3D vector-loop stack-up with GD&T-derived contributors; TDP bundle export (MIL-STD-31000B-style manifest); QIF interop study; weld symbols (optional, see §4.2) |

### 4.2 Out of scope

- Re-publishing paywalled standard content: llull ships **no** clause text, figure, symbol table
  values or ISO 2768 / ISO 286 tolerance tables. Rule tables that encode a standard's requirements are
  data files the customer fills from their licensed copy (TECHNICAL_SPEC §5.6).
- Metrology execution (CMM programming, point-cloud evaluation of tolerance zones) — V2 study only.
- Certification of conformance to Y14.5 / ISO GPS (llull checks well-formedness, not legal interpretation).
- Weld symbols (AWS A2.4 / ISO 2553) — listed as optional; not in MVP/V1.
- 3D PDF (PRC/U3D) export — would need a third-party library; deferred.

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-GDT-01 | MUST | The document stores semantic PMI (datums, datum reference frames, feature control frames, size/location dimensions, surface texture, notes, saved views) as data, created and edited **only** by commands; replay of the feature history regenerates it identically | L1/L4/L8; PMI is part of the recipe | arch L1, L8 |
| FR-GDT-02 | MUST | Each PMI item references B-rep faces of a solid through a **feature**; the feature is re-resolved on every replay from stored points (`facesNear`), like `fillet_edge`'s `edgesNear`, so PMI follows its face through a parametric edit | topological naming; KI5 | KI5 |
| FR-GDT-03 | MUST | The document declares one governing standard: `ASME_Y14.5_2018` or `ISO_GPS` (ISO 1101:2017 family); symbols/rules shown accordingly; the choice is stored and exported | Y14.5 and ISO GPS differ in defaults and symbols | [R1][R3] |
| FR-GDT-04 | MUST | Datum features: labels A–Z (letters excluded by the standard configurable via rule table), unique per part, on a planar, cylindrical, conical or spherical feature; a datum feature symbol is displayed | datum reference frames need named datums | [R5] (catalogue) |
| FR-GDT-05 | MUST | Feature control frames: characteristic ∈ {straightness, flatness, roundness/circularity, cylindricity, profile of a line, profile of a surface, angularity, perpendicularity, parallelism, position, concentricity, coaxiality, symmetry, circular runout, total runout}; tolerance value > 0; diametral (Ø) / spherical zone; datum reference frame of ≤ 3 ordered datum references | these are the characteristics AP242 (census) and OCC XCAF (`XCAFDimTolObjects_GeomToleranceType`) represent | [R26], census |
| FR-GDT-06 | MUST | Modifiers on the tolerance: MMC (Ⓜ), LMC (Ⓛ), RFS (default, no symbol), projected zone with length, free state, tangent plane, statistical, unequally disposed with value; on datum references: MMB/LMB (Ⓜ/Ⓛ after the letter). Modifiers invalid for the feature type are **rejected** (e.g. MMC on a plane) | correctness of semantic PMI | [R26]; NIST files use MMR, LMR, F, T, ST, SEP REQT |
| FR-GDT-07 | MUST | Size dimensions on features of size (cylinder Ø/R, slot/tab width, sphere SØ): nominal **measured from the B-rep** (never typed), tolerance as ± (upper/lower), limits, or fit code text with explicit limits; pattern count `nX` from the number of resolved faces | nominal must equal model; NIST CTC/FTC heavily use `DIMENSIONAL_SIZE` | census |
| FR-GDT-08 | MUST | Location dimensions between two features (distance, angle), basic (theoretically exact) flag; basic dimensions shown boxed | position/profile are relative to basic dimensions | [R1] (catalogue) |
| FR-GDT-09 | MUST | Surface texture requirement on a feature: parameter (Ra, Rz …), value, unit µm, optional lay/process text; displayed with the surface texture symbol | ISO 21920-1 replaced ISO 1302 for indication [R8]; ASME B46.1 defines parameters [R9] | [R8][R9] |
| FR-GDT-10 | MUST | General tolerance / title-block note stored in the PMI model (free text, e.g. a class reference); llull never computes values from a paywalled general-tolerance table | ISO 2768-1 is paywalled [R7] | [R7] |
| FR-GDT-11 | MUST | `check_pmi` read-only query: reports errors (undefined datum referenced, duplicate datum label, feature not resolvable after replay, modifier invalid for feature, datum reference frame repeats a datum, size tolerance with lower > upper, form tolerance with datum reference) and warnings (feature with no PMI on a fully-dimensioned-required part, dangling saved view refs); returns structured `data` | US-GDT-07; NIST found PMI errors in commercial CAD [R17] | [R17] |
| FR-GDT-12 | MUST | `list_pmi` read-only query: every PMI item with id, kind, text rendering ("⌖ Ø0.3 Ⓜ A B C"), feature faces (indices + surface types), datum refs, status | inspection planning, AI agents | US-GDT-06/09 |
| FR-GDT-13 | SHOULD | 3D presentation for the qualified reviewer: each PMI item has an annotation plane (auto-chosen from the feature normal/axis, overridable) and a position; the viewport renders FCF frames, datum symbols, leaders on that plane. **CLI equivalent (MUST, AF-21/22):** `list_pmi` returns plane origin/normal/xDir (model units) and position per item; `render_view … --save view.png` draws the PMI so a multimodal agent can see it | Y14.41 / ISO 16792 annotation planes [R2][R4] | [R2][R4] |
| FR-GDT-14 | MUST | Saved views: named camera + set of visible PMI (+ optional section and entity filter); `create_saved_view`, `update_saved_view`, `delete_saved_view`, `activate_saved_view`; all CLI-callable (needed for AP242 exchange and for the reviewer's review views) | Y14.41 / ISO 16792 saved views; NIST files carry `CAMERA_MODEL_D3` views | census, [R2][R4] |
| FR-GDT-15 | MUST | Drawing integration: a sheet view shows PMI whose annotation plane is parallel to the view plane (`pmiMode: auto`), or an explicit list; `export_sheet_svg` renders FCFs, datum feature symbols, size/location callouts and surface texture symbols in paper mm at the view scale; `data` reports which PMI were placed and which were skipped (and why) | model + drawing method; existing drawings feature | `packages/core/src/commands/drawings` |
| FR-GDT-16 | MUST | Tolerance stack-up query `analyze_stackup`: 1D linear (sensitivities ±1 or any real coefficient) and non-linear expression of named contributors; methods worst-case (arithmetic), RSS, Monte Carlo (normal or uniform per contributor, seed, sample count); outputs nominal, mean, min/max, half-tolerance, σ, probability outside spec limits, per-contributor % contribution | US-GDT-05 | validation `stackup_reference.json` |
| FR-GDT-17 | MUST | Monte Carlo is deterministic for a given seed and sample count (document-independent PRNG), and bounded (max samples) | replay/purity L3, testability | arch L3 |
| FR-GDT-18 | SHOULD | Stack-up contributors may reference PMI items (size dimension or location dimension with tolerance) so the stack updates when the PMI changes | single source of truth | arch L4 |
| FR-GDT-19 | SHOULD | Fastener-fit helper (query): floating and fixed fastener positional tolerance and MMC bonus / virtual condition from sizes | common aerospace bolted-joint check | `stackup_reference.json` FF-01..03 |
| FR-GDT-20 | SHOULD (V1) | Import STEP AP242 semantic PMI (desktop): datums, datum systems, geometric tolerances with modifiers, dimensional size/location with ± or limits, saved views; each imported item attached to the imported solid's faces; counts must match the NIST census for the 16 semantic files | US-GDT-06; interoperability | [R13], census |
| FR-GDT-21 | SHOULD (V1) | Export STEP AP242 with semantic PMI (desktop, OCP XCAF writer); the result is accepted by NIST SFA with its semantic PMI report listing every llull PMI item | US-GDT-08 | [R18][R11] |
| FR-GDT-22 | SHOULD (V1) | Composite FCF (pattern-locating / feature-relating segments), multiple single-segment FCFs, datum targets (point/line/area), all-around / all-over / between indicators | present in NIST FTC files (all-around, placed datum targets) | census |
| FR-GDT-23 | SHOULD (V1) | ISO 14405-1 size specification modifiers (envelope Ⓔ, two-point LP, Gaussian GG …) stored as data and rendered | ISO GPS default independency | [R6] (catalogue) |
| FR-GDT-24 | MUST | Units (AF-04/AF-10): every numeric param states its unit in the schema description (document length unit, `deg` for angles, `um`/`uin` for surface texture); every `data` number carries its unit (field suffix or `unit` field); conversions exact | aerospace mixed units; operator cannot see the UI's unit display | AF-04, AF-10 |
| FR-GDT-25 | COULD (V2) | Graphical PMI (AP242 presentation: annotation planes, tessellated annotation occurrences) exported alongside semantic PMI | SFA viewer shows graphic PMI; OCC writer writes semantic only (forum report) [R27] | [R27] |
| FR-GDT-26 | COULD (V2) | TDP bundle export: AP242 + sheets (SVG/PDF) + JSON manifest (part number, revision, PMI standard, file hashes) | MIL-STD-31000B TDP structure [R22] | [R22] |
| FR-GDT-27 | COULD (V2) | Tolerance-zone visualisation in 3D (envelope of the zone around the feature) | review aid | — |
| FR-GDT-28 | MUST | Every PMI capability is a registered command reachable from CLI (`llull --app` / `--doc`, `search`, `describe`), MCP and UI; descriptions are written for an agent (units, refusals, next command); everything fits in one `build_project` plan checkable with `run --validate`; read-only queries are side-effect-free | L1, L5, KI6 | arch L1, KI6; AF-01, AF-02, AF-05 |
| FR-GDT-29 | MUST | PMI is preserved by save/load (document JSON), undo/redo, live sync, `build_project` plans, and is dropped with a clear summary when its solid is deleted (dependents) | persistence/history contracts | arch L8 |
| FR-GDT-30 | SHOULD | PMI requires an exact-topology kernel (OCC) for feature resolution; under Manifold the commands no-op with code `GDT_KERNEL_NO_TOPOLOGY` and remediation "rerun with --kernel occt" | KI5: Manifold has no topology | KI5 |
| FR-GDT-31 | MUST | **Review flag (AF-33).** Every PMI item carries `review: { required, reason, acceptedBy?, acceptedAt? }`. Items created or edited by an agent caller, and items imported from AP242, start with `required: true` ("tolerance proposed by an AI operator — not approved by a qualified engineer" / "imported — not verified against the customer drawing"). `list_pmi`, `check_pmi` (warning `GDT_REVIEW_REQUIRED`), `export_sheet_svg` (sheet note) and `analyze_stackup` (when a contributor is linked to such an item) report it; the summary says it in plain words | an AI operator is not a qualified GD&T author | AF-33 |
| FR-GDT-32 | MUST | **Human gate (AF-34).** `accept_pmi_review { pmiIds, decision: 'accept'\|'reject', comment }` clears or keeps the flag; it is refused for agent callers (`GDT_REVIEW_HUMAN_ONLY`). A gap-09 release refuses a document with unreviewed PMI | approval of tolerances is an engineering act | AF-34; gap 09 FR-PLM-17 |
| FR-GDT-33 | MUST | **Stable codes (AF-11).** Every refusal and every `check_pmi` finding has a stable code (`GDT_*`), the offending PMI ids / param paths and a one-line remediation naming the command to call; exit code 1 on refusal | operator must fix its own mistakes | AF-11, AF-20 |
| FR-GDT-34 | MUST | **Unverified propagation (AF-32).** `unverified: true` (+ reason) marks: imported items whose feature did not resolve (`unresolved_mesh`) or whose enum was unmapped; checks run without a customer rule table (built-in logic only); stack-up contributors typed by hand with `verified: false`. The flag propagates into `analyze_stackup` results and `check_pmi` warnings (`GDT_UNVERIFIED_INPUT`), never hidden | non-engineer loop | AF-32 |
| FR-GDT-35 | MUST | **Provenance and named defaults (AF-31/AF-35).** Computed values carry `provenance` (measured faces + kernel for sizes; method, formula id, inputs, PRNG and seed for stack-ups); defaults are named in the result (`sigmaPerHalfTolerance: {value: 3, source: 'llull default: ±3σ per half tolerance', defaulted: true}`, `samples`, `tolFace`); no general tolerance is ever defaulted | explainability to owner and reviewer | AF-31, AF-35 |
| FR-GDT-36 | SHOULD | `llull guide` gains a GD&T section (units, `facesNear` contract, minimal plate plan) and query results carry a one-sentence owner summary: done / passed / needs a human (AF-03, AF-36) | agent onboarding | AF-03, AF-36 |

## 6. Workflows

### 6.1 CLI — the operator's workflow (primary, complete; KI6, AF-05/20/22/23)

`D="--doc plate.llull.json --kernel occt"` (or `--app` to work in the open desktop window, OCC kernel on desktop).

```bash
llull search tolerance datum                                  # discover the pmi toolset (AF-01)
llull describe add_geometric_tolerance                        # params + units + refusals (AF-02/04)
llull guide                                                   # GD&T section: units, facesNear contract, minimal plan (AF-03)
llull $D run validation/draft_plan_gdt_plate.json --validate --json   # dry check of the whole plan, step paths on error
llull $D run validation/draft_plan_gdt_plate.json --json --progress   # part + datums + sizes + FCFs + texture + view + sheet
llull $D check_pmi --json                                     # pass/warn/fail, codes GDT_*, remediation (AF-11/20)
llull $D list_pmi --json > pmi.json                           # text, faces, plane, units, review/unverified flags
llull $D render_view view=top --save top.png                  # look at the PMI (AF-22)
llull $D export_sheet_svg sheetId=<aliases.sheet from the run report> --save plate_sheet.svg
llull $D run validation/draft_plan_stackup_su01.json --json   # WC / RSS / MC with units + provenance
llull $D export_step_ap242 includePmi=true --save plate_ap242.stp      # V1, command of gap 04 (GDT supplies the PMI stage)
```

The operator ends every job with `check_pmi` and reports to the owner in plain words: what was built, what passed, and
that agent-proposed tolerances still need a qualified reviewer (`reviewRequired`, FR-GDT-31). Exit code 1 means a step
was refused; the JSON names the code, the PMI id / param path and the remediation. Supplier intake (V1):
`llull $D import_step_exact file=customer.stp --json` (gap 01 command; AP242 PMI transport gap 04; GDT PMI stage) →
`list_pmi --json` (inspection-plan rows) → `check_pmi --json` (questions to the customer; imported items are
`reviewRequired` and, when unresolved, `unverified`).

### 6.2 MCP agent (cloud)

Same commands as tools of the `pmi` toolset (`search_tools` / `enable_toolset`): `describe_scene` → `inspect_topology`
→ `build_project` with the plate plan → `check_pmi` until no errors → `analyze_stackup` → `create_sheet` +
`update_sheet {pmiMode:'auto'}` → `export_sheet_svg`. Hidden tools remain callable via `execute` (L5).

### 6.3 UI — review and approval surface (qualified reviewer)

The desktop app shows the operator's work live (`--app`): PMI panel listing items with their `check_pmi` codes and
review state, 3D annotation planes and saved views, sheets with PMI. The reviewer accepts or rejects each agent-proposed
item (`accept_pmi_review`, human gate) and may adjust placement (`update_pmi`). Authoring in the UI is possible (same
commands) but is not the primary path.

## 7. Acceptance criteria

All criteria run as CLI scripts with `--json` and compare against `validation/expected_results.json` (AF-23).
`D` as in §6.1.

| AC | Invocation | JSON assertion | VC |
| --- | --- | --- | --- |
| AC-GDT-01 | `llull $D run draft_plan_gdt_plate.json --json` then `llull $D list_pmi --json`, `check_pmi --json` | 3 `datum_feature`, 2 `size_dimension` (hole `measuredMm` 6.6 ±1e-6, `count` 4; bore 20.0), 4 `geometric_tolerance`, 1 `surface_texture`, 1 saved view; `check_pmi.data.errors` = [] | VC-GDT-01 |
| AC-GDT-02 | same plan with thickness parameter, then `exec set_parameter '{"name":"t","expression":"16"}'`, `check_pmi --json` | all 10 items resolve (no `GDT_FEATURE_UNRESOLVED`), hole 6.6 ±1e-6, 0 errors | VC-GDT-02 |
| AC-GDT-03 | `llull $D run draft_plan_gdt_rejections.json --continue --json` | 1 accepted, 5 refused with codes `GDT_DATUM_DUPLICATE`, `GDT_DATUM_UNDEFINED`, `GDT_MC_ON_NON_FOS`, `GDT_ZONE_NON_POSITIVE`, `GDT_POINT_NOT_ON_FACE`, each with a remediation; exit code 1 | VC-GDT-03, VC-GDT-54 |
| AC-GDT-04 | unit test: any PMI command twice from the same input | input deep-equal before/after; same output | VC-GDT-04 |
| AC-GDT-05 | `llull $D export_sheet_svg sheetId=… --save s.svg --json` | `data.pmi.placed` per view = expected sets; `data.fits` true | VC-GDT-10/11 |
| AC-GDT-06 | V1: `llull $D import_step_exact file=<NIST file> --json`, `list_pmi --json` | per-category counts = `nist_pmi_census.json` | VC-GDT-20 |
| AC-GDT-07 | V1: `llull $D export_step_ap242 includePmi=true --save p.stp` then NIST `sfa-cl` | 4 GT, 2 dims, 3 datums; 0 errors | VC-GDT-22 |
| AC-GDT-08 | `llull $D run <SU-0n plan> --json` | `data.worstCase`, `rss`, `sigma`, exact corners within 1e-9 mm; MC within stated bounds; `data.provenance.method` present; `sigmaPerHalfTolerance.defaulted` true when omitted | VC-GDT-30..34, VC-GDT-58 |
| AC-GDT-09 | `llull exec fastener_tolerance '{…FF-0n…}' --json` | values of FF-01..03 within 1e-12 mm | VC-GDT-35 |
| AC-GDT-10 | save/load, undo/redo, live-sync, `build_project` replay | PMI identical (id-normalised) | VC-GDT-50 |
| AC-GDT-11 | `llull --doc p.llull.json --kernel manifold exec add_datum_feature …` | refused, code `GDT_KERNEL_NO_TOPOLOGY`, remediation mentions `--kernel occt` | VC-GDT-51 |
| AC-GDT-12 | V2 evaluator on ideal profiles | Ra, Rq, Rsk, Rku, Rz = `surface_texture_reference.json` ±1e-4 | VC-GDT-40 |
| AC-GDT-13 | plate plan run by an agent caller, then `list_pmi --json` and `check_pmi --json` | every item `review.required` = true with reason; `check_pmi.data.warnings` contains `GDT_REVIEW_REQUIRED` × 10; summary contains "not approved" | VC-GDT-56 |
| AC-GDT-14 | agent caller: `exec accept_pmi_review '{"pmiIds":["…"],"decision":"accept","comment":"ok"}'` | refused, code `GDT_REVIEW_HUMAN_ONLY`; human caller (UI) succeeds and the flag clears | VC-GDT-57 |
| AC-GDT-15 | stack-up with one contributor `verified: false` | `data.unverified` = true with the contributor name; `check_pmi`/result warnings include `GDT_UNVERIFIED_INPUT` | VC-GDT-55 |

## 8. Standards & regulatory alignment

| Standard | Edition / status (public catalogue facts only) | Used for in llull | Ref |
| --- | --- | --- | --- |
| ASME Y14.5 | 2018 (revision of Y14.5-2009; issued 2019-02-11); establishes uniform practices for stating and interpreting dimensioning, tolerancing and related requirements | `standard: 'ASME_Y14.5_2018'` symbol set and defaults | [R1] |
| ASME Y14.41 | 2019; requirements for preparation and revision of digital product definition data; exceptions/additions to other ASME standards for datasets; used with Y14.24, Y14.34, Y14.35, Y14.100; model-only and model + drawing methods | annotation planes, saved views, model + drawing linkage | [R2] |
| ISO 1101 | 2017 (2017-02, ISO/TC 213; replaces 2012); symbol language for geometrical specification; indirect indication on a CAD model per ISO 16792 | `standard: 'ISO_GPS'` | [R3] |
| ISO 16792 | 2021 (3rd edition, 2021-04, ISO/TC 10); digital product definition data practices; model-only and model + 2D drawing methods; marked "to be revised" (DIS in progress) | same as Y14.41 for ISO users | [R4] |
| ISO 5459 | 2011 (terminology, rules, methodology for datums and datum systems); a 2024 entry was seen in a national catalogue — status to confirm | datum / DRF data model | [R5] |
| ISO 14405-1 | 2016 edition shown as withdrawn on the ISO ICS 17.040.10 listing; current edition to confirm | size modifiers (V1) | [R6] |
| ISO 2768-1 | 1989, general tolerances for linear and angular dimensions without individual indications | note only; no table values shipped | [R7] |
| ISO 21920-1 | 2021 (2021-12-20; replaces ISO 1302:2002); indication of surface texture (profile) | surface texture symbol | [R8] |
| ASME B46.1 | 2019; surface texture terminology and parameters (vendor description) | parameter names (Ra, Rz …) | [R9] |
| ISO 10303-242 (STEP AP242) | ed. 1 2014, ed. 2 2020, ed. 3 2022 (per NIST README); NIST files also use an "e4" tag (Feb 2026 update) | semantic PMI exchange (V1) | [R13] |
| CAx-IF Rec. Practices PMI (AP242) | v4.1, 2024-06-20 (release) | writer/reader conformance target | [R11] |
| MIL-STD-31000B | B revision Oct 2018 (3D PDF added); a C revision is reported by a vendor blog (unverified) | TDP bundle (V2) | [R22] |
| Boeing D6-51991 | Rev P (current found) | supplier DPD workflow (import, list, check) | [R23] |

Characteristic set note: FR-GDT-05 lists the 15 characteristics represented by AP242 entity types
(see census: `CONCENTRICITY_TOLERANCE`, `SYMMETRY_TOLERANCE` occur in NIST files) and by OCC
`XCAFDimTolObjects_GeomToleranceType` (which has both `Coaxiality` and `Concentricity`) [R26]. Whether a
characteristic is permitted under the selected standard edition is a **rule-table entry** to be confirmed
from the licensed standard (TECHNICAL_SPEC §5.6), not hard-coded from memory.

Regulatory: no airworthiness regulation mandates a specific PMI format; the requirement comes from
customer quality systems (D6-51991 [R23]) and contract data requirements (MIL-STD-31000B [R22]).

## 9. KPIs / success metrics

| KPI | Target | Measured by |
| --- | --- | --- |
| NIST semantic PMI import recall (V1) | 100 % of census counts per category on the 16 semantic files | VC-GDT-20 |
| SFA acceptance of llull AP242 export (V1) | 0 SFA semantic-PMI errors on the 3 llull reference parts | VC-GDT-22 |
| Stack-up exactness | WC/RSS/σ exact to 1e-9 mm; MC within 5σ_SE | VC-GDT-30..34 |
| Replay robustness | 100 % of PMI items resolve after the parametric resize scenarios | VC-GDT-02 |
| Agent usability | an MCP agent tolerances the plate (3 datums, 4 FCFs) with 0 rejected calls after reading tool descriptions, in the golden agent transcript | VC-GDT-52 |
| Drawing completeness | 100 % of PMI with a plane parallel to a sheet view placed or reported as skipped with a reason | VC-GDT-11 |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| --- | --- | --- |
| R-1 opencascade.js 1.1.1 (browser/worker kernel) may not bind XCAF/STEPCAF GD&T classes | AP242 PMI only on desktop (Python OCP) | AP242 PMI exchange is desktop-only by design (KI6: bundled CPython); verify binding in a spike [R31][R32] |
| R-2 OCC `STEPCAFControl_Writer` reportedly writes semantic but no presentation PMI | no graphic PMI in exports | semantic first (MVP/V1); graphic PMI V2 via own writer or newer OCCT [R27] |
| R-3 Topological naming: face indices change after edits | PMI attaches to wrong face | `facesNear` re-resolution (KI5 pattern) + surface-type check + `check_pmi` error when ambiguous |
| R-4 Paywalled standards: rules cannot be shipped | incomplete checks | rule tables as customer-filled data; built-in checks limited to logical consistency |
| R-5 NIST test files contain known syntax errors ("NOT reference STEP files without any errors") [R13] | false failures on import | tolerant reader; census is the expected value, not a perfect file |
| R-6 NIST files change (Feb 2026 update replaced 5 files) [R13] | pinned hashes break | manifest pins zip + per-member sha256 and keeps the superseded hashes |
| R-7 Over-scoping (graphical PMI, 3D PDF, CMM) | delay | phase plan §4.1 |
| R-8 AI operator proposes plausible but wrong tolerances (the owner cannot judge them) | non-conforming parts, false confidence | `reviewRequired` on every agent-created item (FR-GDT-31), human-only `accept_pmi_review` (FR-GDT-32), release blocked by gap 09 while unreviewed; `check_pmi` codes for every malformed frame (FR-GDT-33); stack-up results show `provenance` and named defaults (FR-GDT-35) |
| A-1 Desktop (Electron + bundled CPython/CadQuery/OCP) is the primary product (KI6) | — | — |
| A-2 OCC is the desktop kernel; PMI attaches to OCC topology (KI5) | — | — |
| A-3 The primary operator is an AI agent on the CLI; the owner is not an engineer; a qualified reviewer approves tolerances before release (`../AGENT_FIRST.md`) | — | — |

## 11. References

- [R1] ASME Y14.5-2018 Dimensioning and Tolerancing — ASME — front matter: https://contentstaging12.asme.org/getmedia/88b96f5c-7fbb-4dfa-aa19-2ae5ddbf63c5/35976.pdf ; scope listing: https://standards.globalspec.com/std/1713468/asme-y14-5 (accessed 2026-10)
- [R2] ASME Y14.41-2019 Digital Product Definition Data Practices — ASME — https://cdn.asme.org/getmedia/12c9cc63-4d30-4242-a1ed-681f17a7da8b/35978.pdf ; https://webstore.ansi.org/standards/asme/ASMEY14412019 (accessed 2026-10)
- [R3] ISO 1101:2017 GPS — Geometrical tolerancing — ISO/TC 213 — https://iteh.es/catalog/standards/iso/8171a5e2-c3f2-4bbe-997a-ad8f3e82969c/iso-1101-2017 ; https://scc-ccn.ca/standardsdb/standards/8158661 (accessed 2026-10)
- [R4] ISO 16792:2021 Technical product documentation — Digital product definition data practices — ISO — https://www.iso.org/standard/73871.html (accessed 2026-10)
- [R5] ISO 5459:2011 GPS — Datums and datum systems — Austrian Standards radar — https://meinnormenradar.austrian-standards.at/radar/RadarDetails.action?id=400418 (accessed 2026-10)
- [R6] ISO 14405-1 GPS — Dimensional tolerancing — Linear sizes — ISO ICS 17.040.10 listing — https://www.iso.org/ics/17.040.10.html (accessed 2026-10)
- [R7] ISO 2768-1:1989 General tolerances — DIN reference list — https://din.de/en/getting-involved/standards-committees/natg/publications/wdc-beuth:din21:347172788/DEFAULT/quote (accessed 2026-10)
- [R8] ISO 21920-1:2021 GPS — Surface texture: Profile — Part 1 — ISO — https://www.iso.org/standard/72196.html (accessed 2026-10)
- [R9] ASME B46.1-2019 Surface Texture — listing — https://standards.nimonik.com/products/asme/b46pt1/ (accessed 2026-10)
- [R11] CAx-IF Recommended Practices for the Representation and Presentation of PMI (AP242) v4.1 — MBx-IF — https://www.mbx-if.org/home/wp-content/uploads/2024/06/rec_pracs_pmi_v41.pdf ; index https://www.mbx-if.org/home/?p=194 (accessed 2026-10)
- [R12] NIST MBE PMI Validation and Conformance Testing — download page — https://www.nist.gov/ctl/smart-connected-systems-division/smart-connected-manufacturing-systems-group/mbe-pmi-0 (accessed 2026-10)
- [R13] NIST-PMI-STEP-Files.zip README (Feb 2026 update) — NIST, usnistgov/SFA — https://raw.githubusercontent.com/usnistgov/SFA/master/Release/NIST-PMI-STEP-Files.zip (accessed 2026-10)
- [R15] Lipman R., Filliben J., Guide to the NIST PMI CAD Models and CAD System PMI Modeling Capability Verification Testing Results, NIST AMS 100-10 (2017) — https://doi.org/10.6028/NIST.AMS.100-10 (accessed 2026-10)
- [R16] Cheney D., Fischer B., Measuring the PMI Modeling Capability in CAD Systems: Report 1 — Combined Test Case Verification, NIST GCR 15-997 (2015) — https://nvlpubs.nist.gov/nistpubs/gcr/2015/NIST.GCR.15-997.pdf (accessed 2026-10)
- [R17] Lipman R., Filliben J., Testing Implementations of Geometric Dimensioning and Tolerancing in CAD Software, Computer-Aided Design & Applications 17(6) 2020 1241–1265 — https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=926080 ; results page https://pages.nist.gov/CAD-PMI-Testing/results.html (accessed 2026-10)
- [R18] NIST STEP File Analyzer and Viewer (SFA) — NIST — https://github.com/usnistgov/SFA (accessed 2026-10)
- [R19] NIST STEP File Analyzer documentation (semantic vs graphic PMI definitions) — NIST IR 7999 https://nvlpubs.nist.gov/nistpubs/ir/2014/NIST.IR.7999.pdf ; SFA user guide NIST AMS 200-12 https://nvlpubs.nist.gov/nistpubs/ams/NIST.AMS.200-12.pdf (accessed 2026-10)
- [R20] NIST AMS 100-26 The Model Based Enterprise — NIST — https://nvlpubs.nist.gov/nistpubs/ams/NIST.AMS.100-26.pdf (accessed 2026-10)
- [R21] NIST GCR 18-015 (minimum information model for a 3D model replacing a drawing) — NIST — https://nvlpubs.nist.gov/nistpubs/gcr/2018/NIST.GCR.18-015.pdf (accessed 2026-10)
- [R22] MIL-STD-31000B Technical Data Packages — ANSI listing https://webstore.ansi.org/Standards/DOD/MILSTD31000B ; J. Windham (US Army), MIL-STD-31000 update, NIST MBE Summit — https://www.nist.gov/document/16amil-std-31000updateand3dipdftdpjeffwindhampdf (accessed 2026-10)
- [R23] Boeing D6-51991 Rev P Quality Assurance Standard for Digital Product Definition at Boeing Suppliers — Boeing — https://www.boeingsuppliers.com/content/dam/boeing/boeingsuppliers/boeing-suppliers/becoming/quality/D6-51991_Rev_P.pdf ; https://www.boeingsuppliers.com/dpd.html (accessed 2026-10)
- [R24] The Digital Thread — Key to F-35 Joint Strike Fighter Affordability — Aerospace Manufacturing and Design — https://www.aerospacemanufacturinganddesign.com/article/amd-080910-f-35-joint-strike-fighter-digital-thread/ ; D. Kinard, F-35 digital thread production process — https://sldinfo.com/2018/11/the-f-35-digital-thread-production-process-donald-kinard-provides-an-overview/ (accessed 2026-10)
- [R25] Airbus FAST magazine #57 (Jan 2016) — Airbus — https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2022-04/Airbus-FAST57.pdf (accessed 2026-10)
- [R28] OCCT STEP translator user guide, GD&T section (via OCCT commit page) — https://git.rbts.co/OpenCascade/occt/commit/a8a3b37c0d5dd416a0f98a031be7a4fc05075e52 (accessed 2026-10)
- [R29] OpenCascade aerospace use cases — https://opencascade.com/use_cases_industry/aerospace (accessed 2026-10)
- [R33] PTC Creo help, "ASME Y14.5 Rule Set" (GD&T Advisor) — https://support.ptc.com/help/creo/creo_pma/r7.0/usascii/model-based_definition/asme/rule_set.html (accessed 2026-10)
- [R26] OCCT `XCAFDimTolObjects_*` headers (GeomToleranceType, GeomToleranceModif, DatumSingleModif, DimensionType, GeomToleranceObject) — Open Cascade SAS — https://github.com/Open-Cascade-SAS/OCCT/tree/master/src/DataExchange/TKXCAF/XCAFDimTolObjects (accessed 2026-10)
- [R27] OCCT forum: Missing presentation PMI in STEP export with STEPCAFControl_Writer — https://dev.opencascade.org/content/missing-presentation-pmi-step-export-stepcafcontrolwriter (accessed 2026-10)
- [R31] opencascade.js — https://github.com/donalffons/opencascade.js (accessed 2026-10)
- [R32] OCP (CadQuery OCCT bindings) — https://github.com/CadQuery/OCP (accessed 2026-10)
- [R35] Dassault Systèmes blog, 3D master model-based definition — https://blog.3ds.com/topics/manufacturing/3d-master-model-based-definition/ (accessed 2026-10)

Full source list with verification notes and access dates: `validation/sources.md`.
