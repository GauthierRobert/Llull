# GDT — GD&T, Model-Based Definition (MBD) and semantic PMI — Functional specification

Gap id: **GDT** · Folder: `docs/aerospace/03-gdt-mbd-pmi/` · Status: specification (no implementation) · Date: 2026-10-15

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
2. No AP242 PMI exchange: llull's STEP export (`export_step_exact`, AP214 B-rep) drops every
   requirement; imported supplier models lose their PMI.
3. No tolerance analysis: fit/clearance decisions are made on nominal geometry only.
4. Drawings without GD&T: `export_sheet_svg` can only add overall width/height (`showDimensions`).

## 3. Personas & user stories

| Persona | Story id | As a … I want … so that … |
| --- | --- | --- |
| Design engineer (P1) | US-GDT-01 | define datums A/B/C on faces of my part and add FCFs (flatness, position, profile …) with material condition modifiers, so that the model carries the requirement, not just the shape |
| P1 | US-GDT-02 | set size tolerances (± / limits / fit code text) on holes and shafts measured from the B-rep, so that nominal values are never typed twice |
| P1 | US-GDT-03 | see PMI in 3D on annotation planes and switch between saved views, so that reviewers read the requirement in context |
| P1 | US-GDT-04 | have the drawing sheet show the PMI whose annotation plane faces each view, so that MBD and the drawing never diverge (model + drawing method of Y14.41 / ISO 16792 [R2][R4]) |
| Tolerance analyst (P2) | US-GDT-05 | build a 1D stack from PMI or typed contributors and get worst-case, RSS and seeded Monte Carlo results with % out of spec, so that I can justify tolerances |
| Supplier quality / inspector (P3) | US-GDT-06 | open a customer's AP242 file offline and list every semantic PMI item with the face it controls, so that I can plan CMM inspection (D6-51991 §7.5 duty [R23]) |
| P3 | US-GDT-07 | run a PMI check that flags malformed or incomplete callouts (undefined datum, modifier on a non-size feature, unreferenced feature), so that I can query the customer early |
| Data/PLM engineer (P4) | US-GDT-08 | export semantic PMI in STEP AP242 and verify it with NIST SFA, so that downstream CAx tools receive the same requirements |
| AI agent (P5, MCP/CLI) | US-GDT-09 | call the same commands (`add_geometric_tolerance`, `analyze_stackup`, `list_pmi` …) through MCP or `llull`, so that an agent can tolerance a part or audit a supplier model |
| Programme manager (P6) | US-GDT-10 | export a TDP-style package (AP242 + SVG/PDF sheets + manifest) with revision data, so that deliveries follow the MIL-STD-31000B structure (V2) [R22] |

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
| FR-GDT-13 | MUST | 3D presentation: each PMI item has an annotation plane (auto-chosen from the feature normal/axis, overridable) and a position; the viewport renders FCF frames, datum symbols, leaders on that plane | Y14.41 / ISO 16792 annotation planes [R2][R4] | [R2][R4] |
| FR-GDT-14 | MUST | Saved views: named camera + set of visible PMI (+ optional section and entity filter); `create_saved_view`, `update_saved_view`, `delete_saved_view`, `activate_saved_view` | Y14.41 / ISO 16792 saved views; NIST files carry `CAMERA_MODEL_D3` views | census, [R2][R4] |
| FR-GDT-15 | MUST | Drawing integration: a sheet view shows PMI whose annotation plane is parallel to the view plane (`pmiMode: auto`), or an explicit list; `export_sheet_svg` renders FCFs, datum feature symbols, size/location callouts and surface texture symbols in paper mm at the view scale; `data` reports which PMI were placed and which were skipped (and why) | model + drawing method; existing drawings feature | `packages/core/src/commands/drawings` |
| FR-GDT-16 | MUST | Tolerance stack-up query `analyze_stackup`: 1D linear (sensitivities ±1 or any real coefficient) and non-linear expression of named contributors; methods worst-case (arithmetic), RSS, Monte Carlo (normal or uniform per contributor, seed, sample count); outputs nominal, mean, min/max, half-tolerance, σ, probability outside spec limits, per-contributor % contribution | US-GDT-05 | validation `stackup_reference.json` |
| FR-GDT-17 | MUST | Monte Carlo is deterministic for a given seed and sample count (document-independent PRNG), and bounded (max samples) | replay/purity L3, testability | arch L3 |
| FR-GDT-18 | SHOULD | Stack-up contributors may reference PMI items (size dimension or location dimension with tolerance) so the stack updates when the PMI changes | single source of truth | arch L4 |
| FR-GDT-19 | SHOULD | Fastener-fit helper (query): floating and fixed fastener positional tolerance and MMC bonus / virtual condition from sizes | common aerospace bolted-joint check | `stackup_reference.json` FF-01..03 |
| FR-GDT-20 | SHOULD (V1) | Import STEP AP242 semantic PMI (desktop): datums, datum systems, geometric tolerances with modifiers, dimensional size/location with ± or limits, saved views; each imported item attached to the imported solid's faces; counts must match the NIST census for the 16 semantic files | US-GDT-06; interoperability | [R13], census |
| FR-GDT-21 | SHOULD (V1) | Export STEP AP242 with semantic PMI (desktop, OCP XCAF writer); the result is accepted by NIST SFA with its semantic PMI report listing every llull PMI item | US-GDT-08 | [R18][R11] |
| FR-GDT-22 | SHOULD (V1) | Composite FCF (pattern-locating / feature-relating segments), multiple single-segment FCFs, datum targets (point/line/area), all-around / all-over / between indicators | present in NIST FTC files (all-around, placed datum targets) | census |
| FR-GDT-23 | SHOULD (V1) | ISO 14405-1 size specification modifiers (envelope Ⓔ, two-point LP, Gaussian GG …) stored as data and rendered | ISO GPS default independency | [R6] (catalogue) |
| FR-GDT-24 | SHOULD | Units: PMI values in document units (mm/inch), surface texture in µm (or µin under ASME); conversions exact | aerospace mixed units | — |
| FR-GDT-25 | COULD (V2) | Graphical PMI (AP242 presentation: annotation planes, tessellated annotation occurrences) exported alongside semantic PMI | SFA viewer shows graphic PMI; OCC writer writes semantic only (forum report) [R27] | [R27] |
| FR-GDT-26 | COULD (V2) | TDP bundle export: AP242 + sheets (SVG/PDF) + JSON manifest (part number, revision, PMI standard, file hashes) | MIL-STD-31000B TDP structure [R22] | [R22] |
| FR-GDT-27 | COULD (V2) | Tolerance-zone visualisation in 3D (envelope of the zone around the feature) | review aid | — |
| FR-GDT-28 | MUST | Every PMI capability is a registered command reachable from UI, MCP and CLI (`llull --app` / `--doc`); read-only queries are side-effect-free MCP tools | L1, L5, KI6 | arch L1, KI6 |
| FR-GDT-29 | MUST | PMI is preserved by save/load (document JSON), undo/redo, live sync, `build_project` plans, and is dropped with a clear summary when its solid is deleted (dependents) | persistence/history contracts | arch L8 |
| FR-GDT-30 | SHOULD | PMI requires an exact-topology kernel (OCC) for feature resolution; under Manifold the commands no-op with an explicit summary ("requires the OCC kernel") | KI5: Manifold has no topology | KI5 |

## 6. Workflows

### 6.1 UI (desktop, OCC kernel)

1. Model the part (existing commands). Open the **PMI** panel (new; lists `listCommands()` entries of the `pmi` toolset).
2. Choose the standard (ASME Y14.5-2018 / ISO GPS) and type the general tolerance note → `set_pmi_standard`.
3. Pick a face → **Datum** → letter (next free proposed) → `add_datum_feature`.
4. Pick one or more cylindrical faces → **Size** → tolerance type → `add_size_dimension` (nominal shown from the B-rep, read-only).
5. Pick a face or a size dimension → **Tolerance** → characteristic, value, Ø, modifier, datums (dropdown of defined datums, ordered) → `add_geometric_tolerance`. Invalid combinations are greyed out client-side and rejected server-side.
6. Drag the annotation on its plane (→ `update_pmi` with a new position) or change its plane.
7. Save a view (camera + visible PMI) → `create_saved_view`; switch views from the panel → `activate_saved_view`.
8. Run **Check PMI** → `check_pmi`; errors list clickable PMI ids.
9. Sheet: `create_sheet` with views, toggle "show PMI" → `update_sheet { pmiMode: 'auto' }`; export SVG.
10. File > Export > STEP AP242 with PMI (V1) → `export_step_ap242`.

### 6.2 CLI (`llull`, local agent — KI6)

```bash
llull search tolerance datum                                     # discover the new pmi toolset
llull describe add_geometric_tolerance                           # params schema (zod-derived)
llull --app run validation/draft_plan_gdt_plate.json --validate  # dry-run the plan
llull --app run validation/draft_plan_gdt_plate.json             # build part + PMI live in the window
llull --app check_pmi --json                                     # structured errors/warnings
llull --app list_pmi --json > pmi.json
llull --doc part.llull.json --kernel occt analyze_stackup @su01.json   # WC / RSS / MC numbers
llull --doc part.llull.json --kernel occt export_step_ap242 pmi=semantic --save part_ap242.stp
```
(Sub-commands and flags are the existing ones of `server/src/cli/usage.ts`: `search`, `describe`,
`run <plan> [--validate]`, `<command> [params]`, `--app`, `--doc`, `--kernel`, `--save`, `--json`.
Only the command names are new.)

### 6.3 MCP agent (cloud)

1. `describe_scene` → find the solid. 2. `inspect_topology` → faces with surface type, centroid/axis (TR-GDT-03 extension).
3. `add_datum_feature` ×3 → `add_size_dimension` → `add_geometric_tolerance` … 4. `check_pmi` until no errors.
5. `analyze_stackup` for the critical clearance. 6. `create_sheet` + `update_sheet {pmiMode:'auto'}` → `export_sheet_svg`.
All tools are views of the same registry (L5); hidden tools remain callable via `execute`.

### 6.4 Supplier import (V1)

`import_step_pmi` (desktop) → solids + PMI in one transaction → `list_pmi` → inspection plan table;
`check_pmi` → questions to the customer.

## 7. Acceptance criteria

| AC | Given | When | Then | VC |
| --- | --- | --- | --- | --- |
| AC-GDT-01 | the plate of `draft_plan_gdt_plate.json` on OCC | the plan is applied | 3 datums A/B/C, 2 size dimensions (4X Ø6.6–6.9 measured nominal 6.6 ±1e-6; Ø20 +0.021/0), 4 FCFs, 1 surface texture, 1 saved view exist; `check_pmi` returns 0 errors | VC-GDT-01 |
| AC-GDT-02 | the same document | the plate thickness parameter is changed and history replays | all PMI items still resolve to the same logical faces (bottom face, hole walls) and `check_pmi` returns 0 errors | VC-GDT-02 |
| AC-GDT-03 | `draft_plan_gdt_rejections.json` | each action executes | each invalid PMI action is a no-op whose summary names the reason (duplicate label, undefined datum D, MMC on plane, zero tolerance, point not on any face) | VC-GDT-03 |
| AC-GDT-04 | any PMI command | run twice from the same input | input document deep-equal before/after (is pure); same output | VC-GDT-04 |
| AC-GDT-05 | the plate sheet with `pmiMode:'auto'` | `export_sheet_svg` | the TOP view contains the hole-pattern FCF ("⌖ Ø0.3 Ⓜ A B C" rendered as frame + glyph paths) and the FRONT view contains the flatness FCF; `data.pmi.placed` lists them per view; nothing overflows | VC-GDT-10/11 |
| AC-GDT-06 | NIST CTC/FTC/STC AP242 files (pinned) | `import_step_pmi` (V1) | per file, counts of geometric tolerances by characteristic, dimensional size/location, datums and datum systems equal `nist_pmi_census.json` | VC-GDT-20 |
| AC-GDT-07 | the plate | `export_step_ap242` then NIST SFA (CLI) | SFA semantic PMI report lists 4 geometric tolerances, 2 size dimensions, 3 datums with the same values and modifiers; zero "missing reference" errors | VC-GDT-22 |
| AC-GDT-08 | SU-01..SU-05 contributors | `analyze_stackup` | WC / RSS / σ / exact-corner values equal `stackup_reference.json` within 1e-9 mm; MC mean/std/p within the stated acceptance tolerances | VC-GDT-30..34 |
| AC-GDT-09 | FF-01..03 | fastener helper | T = H − F (floating), (H − F)/2 (fixed, equal split), bonus/virtual condition values as in the reference | VC-GDT-35 |
| AC-GDT-10 | PMI on a document | save/load, undo/redo, live-sync, `build_project` replay | PMI identical (id-normalised) | VC-GDT-50 |
| AC-GDT-11 | Manifold kernel | any feature-attaching PMI command | no-op, summary contains "requires the OCC kernel" | VC-GDT-51 |
| AC-GDT-12 | ideal sine/triangle/square profiles | surface-texture evaluator (V2, optional) | Ra, Rq, Rsk, Rku, Rz equal `surface_texture_reference.json` within 1e-4 | VC-GDT-40 |

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
| A-1 Desktop (Electron + bundled CPython/CadQuery/OCP) is the primary product (KI6) | — | — |
| A-2 OCC is the desktop kernel; PMI attaches to OCC topology (KI5) | — | — |

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
