# XCH — Aerospace data exchange: STEP AP242 (PMI, assemblies, validation properties), IGES, JT, QIF, LOTAR — Functional specification

Gap id: **XCH** · Status: specification (no implementation) · Written 2026-10-15 · Depends on: 01 KRN (owner of `import_step_exact`, STEP → exact
B-rep import), 03 GDT (semantic PMI model) · Feeds: 09 PLM (LOTAR archive, release packages).

## 1. Summary

llull writes STEP **AP214** only: `export_step` (CadQuery, through the Python bridge) and `export_step_ap242` (OCC
`STEPControl_Writer`, one product per solid, names and colours stamped afterwards by text rewriting). It reads STEP
**as meshes** (`import_step` → `import_mesh`), plus DXF, STL/OBJ/glTF. It has no **AP242** output, no **assembly
structure** in STEP (instances are skipped), no **geometric validation properties** (volume / area / centroid) written
or checked, no **semantic PMI** exchange, no **AP242 tessellated** geometry, no **IGES**, no **JT**, no **QIF**, and no
**long-term archive** (LOTAR) package.

That blocks aerospace use. An aerospace supplier receives the OEM's definition as STEP AP242 (geometry + assembly +
3D PMI), must prove the received model is the sent model (validation properties), and must return parts in the same
format. The OEM must keep type-design data retrievable for the life of the product, which can exceed 50 years
[R20]; the EN/NAS 9300 (LOTAR) standards define how, and they are built on STEP AP242 [R16][R17]. Legacy fleets still
carry IGES data, visualization and digital-mock-up chains still use JT (ISO 14306), and metrology uses QIF
(ISO 23952). Without these, llull cannot sit in an Airbus- or Boeing-type supply chain.

## 2. Aerospace context & value

### 2.1 The standards stack

| Standard | What it is | Status (public catalogue facts) | Why aerospace needs it |
| -------- | ---------- | ------------------------------- | ---------------------- |
| ISO 10303-242 (STEP AP242) "Managed model-based 3D engineering" | Application protocol merging aerospace AP203 and automotive AP214 [R1][R18] | Ed. 1 2014, ed. 2 2020, ed. 3 2022 (ISO 10303-242:2022, 2022-12), ed. 4 ISO 10303-242:2025 (2025-08); ed. 5 at CD stage (2026) [R1][R2][R3][R4] | The neutral format of OEM–supplier exchange and of LOTAR archives; carries B-rep, assembly structure, semantic + graphic PMI, tessellated geometry, validation properties, composites, kinematics |
| CAx-IF Recommended Practices (now hosted by MBx-IF) | Implementation agreements the CAD vendors test in CAx-IF rounds | PMI Representation & Presentation (AP242) v4.1, 2024-06-20 [R12]; Geometric & Assembly Validation Properties v4.5 (2019), later 4.6 (2023-04-21) per archive [R11]; 3D Tessellated Geometry v1.1 (2019) [R13]; Composite Materials v4.4 (2025-12-03), AP242 XML Kinematics v1.3, AP242 XML Product & Assembly Structure v4.0 (2025-10-20) [R15]; Model Styling & Organization v1.10 [R15] | A STEP file that is schema-valid but ignores the RPs is not readable by CATIA/NX/Creo the way the OEM expects |
| EN 9300 / NAS 9300 (LOTAR) | Long-term archiving & retrieval of digital product data | 9300-001 (structure, 2024), -002 (requirements, 2018), -100 (common concepts 3D CAD, 2026), -110 (explicit 3D geometry, 2018), -115 (explicit assembly structure), -120/-121/-125 (PMI and semantic structures), -210 (PDM, 2026) [R16] | Certification-driven retention for the life of the type design [R20]; verification by validation properties (volume, centroid, area for level 1 of -110) [R17] |
| IGES 5.3 | Legacy neutral format (ANS US PRO/IPO-100-1996) [R7] | Last published version; NIST FIPS 177-1 adopted the earlier 5.2 [R21] | Legacy programme data (1980s–2000s aircraft still in service), tooling, some suppliers |
| ISO 14306 (JT) | Lightweight 3D visualization format with facets, PMI, optional B-rep [R5] | ISO 14306:2017 withdrawn; replaced by ISO 14306-1:2024 (overview), -2:2024 (vocabulary), -3:2025 (Version 2) [R5] | Digital mock-up / visualization in Siemens-centred chains |
| ISO 23952 (QIF 3.0) | XML information model for metrology: plans, resources, part geometry with PMI, rules, results, statistics [R6] | ANSI/DMSC QIF 3.0 (2018) → ISO 23952:2020 (July 2020) [R6] | First-article inspection and CMM programming driven from the MBD model |
| 3D PDF / PRC (ISO 14739-1) | Interactive 3D in PDF | Not verified in this session (see `validation/sources.md`) | Optional review deliverable; out of MVP scope |

### 2.2 Real programmes and workflows (sourced)

- **Airbus — AP242 in European A&D.** Airbus presentations at GPDIS 2018/2019 describe using AP242 ed. 1 to support
  model-based definition, to reduce customization, and for the sustainability of long-term digital assets; the
  "Real Time Supplier Data" approach is meant to significantly reduce supplier effort to prepare 3D CAD data and is
  deployed for cabin equipment on most Airbus programmes [R18].
- **Airbus A380 wiring.** German and Spanish engineering sites ran CATIA V4 while French and British sites ran V5;
  the German teams could not feed their wiring changes back into the common digital mock-up. A STEP AP242 validation
  check was later built for such cross-system data [R19]. The lesson for llull: exchange must be verifiable, not
  just possible.
- **Boeing — model-based enterprise and suppliers.** Boeing presents its transition to a model-based enterprise as
  impacting its suppliers; Boeing and Airbus both took part in LOTAR / interoperability test rounds (2019 round on
  electrical wire harness) [R18][R20].
- **LOTAR retention.** LOTAR overviews by Boeing and Airbus state that product data must stay retrievable for the
  life of the product, which can exceed 50 years, and that the product definition is the source of the type design
  as the FAA defines it; FAA Order 8000.79 governs electronic data use and storage [R20].
- **NIST MBE PMI project.** NIST published CTC/FTC/STC test models and their STEP AP203/AP242 files; CAx-IF uses them
  to test AP242 implementations in commercial CAD [R4][R23]. They are the public, pinnable reference corpus of this
  gap (`validation/xch_corpus.json`).

### 2.3 Who does it today, with which tools

| Actor | Tool chain today | Pain llull can address |
| ----- | ---------------- | ---------------------- |
| OEM design office | CATIA V5 / 3DEXPERIENCE, NX, Creo with certified AP242 translators; validation via CAx-IF-tested GVP | None for OEM; llull is a supplier/consumer tool |
| Tier-2/3 supplier, MRO, tooling shop | A seat of the OEM's CAD or a translator (e.g. CoreTechnologie, Datakit) to read AP242 + PMI; manual GVP comparison | Free, offline, scriptable reader/writer with automatic GVP check and PMI view |
| Archive / quality team | LOTAR ingest/retrieval tools, NIST SFA as independent checker [R10] | Agent-driven verification reports, deterministic re-verification |
| Metrology / FAI | QIF-aware CMM software | Export characteristics from llull PMI (V2) |

## 3. Personas & user stories

Operator model: [`../AGENT_FIRST.md`](../AGENT_FIRST.md) (authoritative).

| Id | Persona | Surface | In this gap |
| -- | ------- | ------- | ----------- |
| P1 | **Operator (primary)** — AI agent (Claude Code or similar) | `llull` CLI (`--doc` headless / `--app` on the desktop window); MCP for cloud agents | imports, verifies, exports and archives exchange files; ends every job with `verify_exchange_file` |
| P2 | **Owner** — the person who asked (supplier owner, MRO planner, small design office); **not assumed to be an engineer** | natural language to the agent | wants "read the OEM file, add my part, send it back in the format they asked for"; reads a plain-language result: what was done, what passed, what needs a human |
| P3 | **Qualified reviewer** — only where a delivery, archive or certification record is involved (design engineer of the supplier, quality / archive authority, OEM interface) | desktop review surfaces, the agent's JSON report | decides on red / unverified GVP, accepts a delivery or archive package, signs releases (09 PLM) |

| Id | Persona | Story |
| -- | ------- | ----- |
| US-1 | P1 | I run `import_step_exact` on the OEM AP242 file and get exact solids, the assembly tree, names, colours (and PMI in V1) as entities and components I can address by id. |
| US-2 | P1 | The import returns, per solid, sender GVP vs recomputed GVP with deltas, units and a green / yellow / red band in `data`, so I can decide without engineering judgement whether to continue or stop and ask. |
| US-3 | P1 | I export AP242 with validation properties (`export_step_ap242 … --save`) and immediately run `verify_exchange_file` on my own file; a red self-check stops the export with a code. |
| US-4 | P1 | I run one `verify_exchange_file --json` per received file in a loop and get a machine-readable report (schema, units, GVP deltas, PMI census, unsupported items, codes); exit code 1 on red. |
| US-5 | P1 → P3 | I prepare a LOTAR-style archive package (AP242 + manifest + checksums + GVP + report) and re-verify it years later with the same command; **accepting** it into an archive or release is the reviewer's act, not mine. |
| US-6 | P1 | I import a 1990s IGES surface model, sew it into a solid when possible, and get the open shells and untranslated entity types as counts and codes. |
| US-7 | P1 | I export a part as IGES 5.3 for a shop whose CAM only reads IGES, with a round-trip GVP self-check. |
| US-8 | P1 | I load a JT file (via a converter port) next to the part to check clearances numerically (COULD, V2). |
| US-9 | P1 | I export toleranced characteristics to QIF for the CMM (COULD, V2). |
| US-10 | P2 | I get one sentence per delivery: "imported 3 solids, GVP green; exported AP242 with validation properties; nothing needs a human" — or the exact item that needs a qualified engineer. |
| US-11 | P1 | When the sender's GVP is missing, zero or disagrees, every result computed from that geometry says `unverified` and `reviewRequired`, so I never present it as checked. |
| US-12 | P3 | Only I can accept a delivery that contains red / unverified bodies or accept an archive package as the record; the agent prepares and I decide. |

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | AP242 exact B-rep export (one file, multiple solids, names, colours, units); geometric validation properties computed (new query) and written per solid; assembly structure export (components → products, instances → NAUO with placements); AP242/AP214/AP203 import as exact B-rep with assembly tree, names, colours (relies on 01 KRN); recompute-and-compare GVP on import with green/yellow/red report; IGES 5.3 import (surfaces, solids, sewing) and export (BRep mode); CLI/MCP verification report; NIST corpus gate |
| **V1** | Semantic PMI import (AP242 → gap-03 PMI model) with graphic-presentation fallback; semantic PMI export; AP242 tessellated geometry import/export; layers and materials/density; LOTAR archive package + re-verification; AP242 ed. 3/4 schema identifiers; NIST SFA in the gate |
| **V2** | QIF 3.0 export of characteristics; JT import (visualization) through an external converter; AP242 composites and kinematics mapping (with gaps 06 CMP and assembly joints); AP242 XML (.stpx) read; 3D PDF/PRC export |
| **Out of scope** | Native CATIA/NX/Creo formats; a llull-owned STEP/JT parser (OCC does STEP/IGES); certification of llull translators by CAx-IF (organizational, later); PDM data exchange (EN 9300-2xx → gap 09); electrical harness domain of AP242 |

## 5. Functional requirements

| Id | Prio | Requirement | Rationale | Source |
| -- | ---- | ----------- | --------- | ------ |
| FR-XCH-01 | MUST | Export the document's 3D solids to STEP **AP242** (Part 21) as exact B-rep, selectable schema AP242 / AP214 / AP203, AP242 default once VC-XCH-03 passes. | AP242 is the aerospace exchange and archive format | [R1][R8][R16] |
| FR-XCH-02 | MUST | The exported model, re-imported by llull, reproduces each solid's volume, surface area, centroid and bounding box within the same-kernel tolerance. | Exchange must be lossless for our own data | [R11] |
| FR-XCH-03 | MUST | Every exported solid (and assembly node) carries CAx-IF geometric validation properties: volume, surface area, centroid; assembly GVP for assembly nodes; bounding box SHOULD. | Receivers verify transfers with GVP; LOTAR level-1 validation uses volume, centroid, area | [R11][R17] |
| FR-XCH-04 | MUST | Export and import the assembly structure: components ↔ products, instances ↔ occurrences with placements; product names and colours preserved; instances no longer skipped. | Aircraft parts are delivered in assemblies; `export_step_ap242` skips instances today | [R15][R16] |
| FR-XCH-05 | MUST | Import STEP AP242/AP214/AP203 as exact B-rep (from 01 KRN) with assembly tree, names, colours, units, and the file's embedded validation properties stored as provenance. | Supplier must work on exact geometry | [R8] |
| FR-XCH-06 | MUST | On import, recompute GVP from the imported B-rep and compare with the embedded GVP; report per solid green / yellow / red with deltas; never block the import on a yellow/red. | CAx-IF three-tier result practice; vendor default thresholds | [R13][R14] |
| FR-XCH-07 | SHOULD (V1) | Import AP242 **semantic PMI** (dimensions, tolerances, datums, datum systems, datum targets) into the gap-03 PMI model, linked to the B-rep faces/edges; fall back to graphic presentation (tessellated annotation curves) when semantics are absent; list every unmapped item. | MBD: the PMI is the authority, not a drawing | [R12][R4] |
| FR-XCH-08 | SHOULD (V1) | Export llull semantic PMI (gap 03) as AP242 semantic PMI with graphic presentation and saved views per the PMI RP v4.1. | Suppliers return MBD to the OEM | [R12] |
| FR-XCH-09 | SHOULD (V1) | Import AP242 tessellated part geometry (tessellated solids/shells) as mesh entities; export tessellated geometry optionally alongside or instead of B-rep. | NIST FTC-08 `-tg` file; lightweight exchange; OCC supports both | [R4][R8][R13] |
| FR-XCH-10 | MUST | Import IGES (≤ 5.3): trimmed surfaces, B-rep solids, groups; optionally sew into closed solids; report open shells and untranslated entity types. | Legacy aerospace data | [R7] |
| FR-XCH-11 | SHOULD | Export solids to IGES 5.3 (B-rep mode), with names and colours where the format allows. | Legacy CAM / suppliers | [R7] |
| FR-XCH-12 | MUST | Units are converted exactly on import and export (mm, cm, m, in, ft); embedded GVP of an inch file is compared after conversion. | NIST CTC-03/05, FTC-06/09 AP203 files are in inches | [R4] |
| FR-XCH-13 | SHOULD (V1) | Create an archive package: AP242 file, manifest (sha256, schema, units, GVP per solid, PMI counts, originating system, llull version, recipe hash), verification report. | LOTAR ingest needs verification evidence | [R16][R17] |
| FR-XCH-14 | SHOULD (V1) | Re-verify an archive package: checksums, re-import, GVP recompute, compare to manifest; pass/fail report. | LOTAR retrieval re-validation | [R16][R20] |
| FR-XCH-15 | MUST | Hostile, truncated or oversize files never crash the app or corrupt the document; a failed import is a no-op with a summary. | Files come from outside the trust boundary; llull L1 | — |
| FR-XCH-16 | COULD (V2) | Import JT (ISO 14306) for visualization (facets, product structure, PMI when present) through a pluggable converter. | DMU chains | [R5] |
| FR-XCH-17 | COULD (V2) | Export characteristics (from gap-03 PMI) and part reference to QIF 3.0 (ISO 23952). | Metrology / FAI | [R6] |
| FR-XCH-18 | SHOULD | Every llull-written AP242 file of the gate is analysed by an independent checker (NIST SFA) with zero syntax errors. | Avoid self-confirming tests | [R10] |
| FR-XCH-19 | SHOULD (V1) | Export and import layers, material name and density (CAx-IF material RP via OCC XCAF). | Mass properties at the receiver | [R8] |
| FR-XCH-20 | COULD (V2) | Map AP242 composite ply data (gap 06) and kinematic joints (llull joints) on import/export. | AP242 ed. 2+ domains; CAx-IF composites RP v4.4 | [R15] |
| FR-XCH-21 | MUST | All capabilities are commands reachable identically from UI, `llull` CLI and MCP; read-only checks are query commands. | llull L1/L5 | `.claude/rules/architecture.md` |
| FR-XCH-22 | MUST | Works offline on the desktop app (bundled OCC/CPython); no network call. | KI6 product direction | KI6 |
| FR-XCH-23 | MUST | Every refusal and check finding of an XCH command carries a stable code (`XCH_*`, and `KRN_*` for the import core owned by 01), the offending ids / file / product / property and a one-line remediation naming the next command; exit code 1 on refusal or red. | AF-11 | AGENT_FIRST AF-11 |
| FR-XCH-24 | MUST | `verify_exchange_file` (file-level) and `geometric_validation_properties` (document-level) are the read-only check commands of this gap and return pass / warn / fail lists with codes; every XCH workflow ends with `verify_exchange_file` on the file just read or written. | AF-20 | AGENT_FIRST AF-20 |
| FR-XCH-25 | MUST | Units: every numeric param states its unit; every GVP number in `data` carries its unit (`volumeUnit`, `areaUnit`, `lengthUnit`, or suffix); the file's length unit and the conversion factor applied are reported. | AF-04, AF-10 | AGENT_FIRST AF-04/AF-10 |
| FR-XCH-26 | MUST | Named defaults and provenance: the GVP band policy (green 1e-3, yellow 1e-2 / 1 mm), schema (AP242), tessellation (off) and IGES sewing tolerance are returned as `{ value, unit, source, defaulted }`; import provenance (file sha256, schema, originating system, sender GVP) and export provenance (llull version, kernel, timestamp param) are in `data`. | AF-31, AF-35 | AGENT_FIRST AF-31/AF-35 |
| FR-XCH-27 | MUST | Geometry whose GVP check is red or not checkable (no / placeholder sender GVP, `verify: false`) is marked `unverified` in `doc.exchange.provenance`; the flag propagates into 01 `mass_properties` (`import_gvp_red`, `import_gvp_not_checkable`), into `export_step_ap242` / archive manifests, and `verify_exchange_file` reports it as a warning that cannot be hidden. | AF-32 | AGENT_FIRST AF-32 |
| FR-XCH-28 | MUST | Import reports with a yellow / red / not-checkable band, exports that contain unverified bodies, and every archive package carry `reviewRequired: { value: true, reasons }`, and the summary says "computed by llull, not approved — needs a qualified engineer". | AF-33, AF-36 | AGENT_FIRST AF-33/AF-36 |
| FR-XCH-29 | MUST (V1) | Human gates: delivering a file that contains red / unverified bodies (`export_step_ap242 { acceptUnverified: true }`) and accepting an archive package as the record (09 PLM `release_item`, `humanSignatureRequired`) cannot be completed by an agent caller (`XCH_HUMAN_GATE`). | AF-34 | AGENT_FIRST AF-34; 09 PLM |
| FR-XCH-30 | SHOULD | Large imports report progress (`--progress`), respect `--timeout`, re-use content-hash caches; `import_step_exact` / `import_iges` work under `--dry-run`; a missing external converter (JT) is reported with `XCH_CONVERTER_MISSING` and an install hint. | AF-40, AF-41, AF-42 | AGENT_FIRST AF-40/41/42 |

## 6. Workflows

The CLI is the product surface (AGENT_FIRST §1): one plan file, validated, run, checked, rendered and exported with
real `llull` syntax. MCP calls the same commands. The desktop UI is where the owner watches and the qualified
reviewer approves.

### 6.1 CLI — receive, modify, deliver (operator, complete)

```bash
llull status                                                        # --app if the desktop app is open, else --doc
llull verify_exchange_file file=in/oem_ap242.stp --json             # read-only: schema, unit, census, sender GVP; no document change
llull import_step_exact file=in/oem_ap242.stp verify=true --dry-run --json --doc part.llull   # try first (AF-42)
llull import_step_exact file=in/oem_ap242.stp verify=true --progress --json --doc part.llull
# → data.gvpCheck.band "green" | "yellow" | "red" | "not-checkable", per-product comparisons with units,
#   data.reviewRequired, codes XCH_GVP_* ; red/unverified → stop and tell the owner (US-10)
llull run plans/my-bracket.json --validate --doc part.llull          # the supplier's own part as a plan (aliases, =expr)
llull run plans/my-bracket.json --progress --doc part.llull
llull geometric_validation_properties --json --doc part.llull        # volume / area / centroid / bbox per solid, with units
llull render_view view=iso --save out/part.png --doc part.llull      # look at the result (AF-22)
llull export_step_ap242 '{"includeValidationProperties":true}' --save out/part_ap242.stp --doc part.llull
llull verify_exchange_file file=out/part_ap242.stp --json            # self-check of the delivered file: band green, exit 0
llull export_iges --save out/part.igs --doc part.llull               # legacy CAM, optional
```

Legacy IGES: `llull import_iges file=fairing_1994.igs sew=true --json --doc legacy.llull` → `data.openShells`,
`data.untranslated` counts, codes `XCH_IGES_OPEN_SHELL` / `XCH_IGES_UNTRANSLATED`.

Archive (V1): `llull create_archive_package '{"partNumber":"PN-12345","revision":"A","timestamp":"2026-10-15T00:00:00Z"}'
--save archive/PN-12345-A --doc part.llull` (multi-file result → directory), later
`llull verify_archive_package dir=archive/PN-12345-A --json` → pass / fail with codes. Accepting the package as the
record is a human gate (FR-XCH-29, 09 PLM).

Exit code 1 when a verification report contains a red item or a refusal, so CI and agent loops can gate on it.

### 6.2 MCP agent (cloud)

1. `verify_exchange_file { stepBase64 | text }` → structured report (schema, units, products, GVP comparisons, PMI
   census, unsupported entities, codes).
2. On green: `import_step_exact` (undoable) and continue; on yellow: explain the deltas to the owner with the numbers;
   on red / not-checkable: stop and ask for a qualified reviewer (`reviewRequired`).
3. Delivery: `export_step_ap242` → `verify_exchange_file` on the result (self-check) → return the file.

### 6.3 UI — review and approval surface

The desktop app shows the assembly tree, a Validation badge per product (green / yellow / red) and the report table
(property, sender value, llull value, delta, band) computed by the same commands. Reviewer acts: accept a delivery that
contains red / unverified bodies, accept an archive package as the record (human gates, FR-XCH-29). File › Import /
Export / Archive dialogs are conveniences that dispatch the same commands; none is required for any XCH capability.

## 7. Acceptance criteria

Phrased as CLI invocations with JSON assertions (AF-23). `ER(VC)` = the case in `validation/expected_results.json`;
`≈` = within its tolerance; `$K` = `--kernel occt` for local `--doc` runs.

| Id | Given | When (CLI) | Then (JSON assertion) | VC |
| -- | ----- | ---------- | --------------------- | -- |
| AC-1 | the nine analytic plans | `llull run validation/plans/<p>.json $K --doc t.llull`; `llull geometric_validation_properties --json`; `llull export_step_ap242 --save t.stp`; `llull import_step_exact file=t.stp --json --doc r.llull`; GVP again | `.data.items[*]` ≈ `analytic_gvp_reference.json` (1e-9 rel) and re-import ≈ pre-export (1e-9 rel) | VC-XCH-01 |
| AC-2 | the drilled plate with an offset hole | `llull export_step_ap242 '{"includeValidationProperties":true}' --save p.stp`; `python3 -I extract_validation_properties.py p.stp` | one 'geometric validation property' set with volume 113716.81469282041, area 19028.31853071796, centroid x −1.3813228334244487 (mm) ≈ `ER(VC-XCH-02)` | VC-XCH-02 |
| AC-3 | any llull-written AP242 file | `llull verify_exchange_file file=p.stp --json`; NIST SFA | `.data.schemaName` starts with `AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF`; SFA 0 syntax errors | VC-XCH-03, VC-XCH-17 |
| AC-4 | `plans/xch-assembly-2x.json` | export → `import_step_exact … --json` | `.data.products` length 1, occurrences 2; assembly volume 2000 mm³, centroid (50, 0, 0) | VC-XCH-04 |
| AC-5 | pinned NIST AP242 parts with GVP | `llull import_step_exact file=<f> verify=true --json $K` | `.data.gvpCheck.band == "green"` for every file whose GVP is real (measured at group scope, 2026-10-20: CTC-02 e2 and STC-08 e3 are green, the earlier red came from measuring only the first solid); STC-06 → `"not-checkable"`; a tampered file (CTC-01 e1, volume x1.5) → `"red"`, code `XCH_GVP_RED`, exit 0, geometry imported | VC-XCH-05 |
| AC-6 | NIST CTC-02 AP203 + AP242 | `verify_exchange_file --json` on both (no kernel) | sender-to-sender spread reproduces 1.12e-4 / −4.93e-4 / 0.0181 mm (1e-12 rel) | VC-XCH-06 |
| AC-7 | NIST CTC-01 AP242 (V1) | `import_step_exact … --json` with PMI | every census record of `ER(VC-XCH-07)` mapped or listed with `XCH_PMI_UNMAPPED` | VC-XCH-07 |
| AC-8 | toleranced llull part (V1) | export → import | PMI identical; SFA semantic PMI report clean | VC-XCH-08 |
| AC-9 | NIST FTC-08 tessellated file (V1) | `import_step_exact … tessellated=true --json` | one non-empty mesh body; never "zero geometry" | VC-XCH-09 |
| AC-10 | OCCT `bearing.iges` / `hammer.iges` | `llull import_iges file=<f> --json $K` | ≥ 213 / ≥ 45 faces; `.data.untranslated` counts | VC-XCH-10 |
| AC-11 | plate and L-bracket | `export_iges --save` → `import_iges --json` | GVP ≈ analytic (`igesRoundTrip`, 1e-6) | VC-XCH-11 |
| AC-12 | inch box; FTC-09 AP203 (inch) | export / `import_step_exact` into a mm document | values scale by 25.4^k: inch box ≈ `ER(VC-XCH-12)` (1e-9), FTC-09 band `green`; CTC-05 band `red` | VC-XCH-12 |
| AC-13 | archive package of the L-bracket (V1) | `create_archive_package … --save dir`; `verify_archive_package dir=… --json` | `.data.band == "pass"`; checksums match; GVP 56000 mm³ / 14800 mm² / (25, 20, 20) (1e-9) | VC-XCH-13 |
| AC-14 | truncated / garbage / oversize file | `llull import_step_exact file=<bad> --json` | exit 1, `affected: []`, document unchanged; code `KRN_STEP_UNREADABLE` / `XCH_FILE_TOO_LARGE` with remediation | VC-XCH-14 |
| AC-15 | deliberately wrong calls | each in `ER(VC-XCH-21)` | exit 1; `.data` code and remediation as listed | VC-XCH-21 |
| AC-16 | STC-06 (placeholder GVP) imported, then measured | `import_step_exact … --json`; `llull mass_properties entityId=<id> --json` | provenance `unverified: true` (`import_gvp_not_checkable`); `mass_properties` `.data.unverified.reasons` contains `import_gvp_not_checkable`; `verify_exchange_file` warning `XCH_GVP_NOT_CHECKABLE` | VC-XCH-22 |
| AC-17 | tampered CTC-01 e1 (volume x1.5) import; any archive package | `import_step_exact … --json`; `create_archive_package … --json` | `.data.reviewRequired.value == true` (reasons `import_gvp_red`, `archive_record`); summary contains "needs a qualified engineer" | VC-XCH-23 |
| AC-18 | a document with a red-band body, agent caller | `llull export_step_ap242 '{"acceptUnverified":true}' --save x.stp --json` | exit 1, `XCH_HUMAN_GATE`, `x.stp` not written | VC-XCH-24 |
| AC-19 | any export / import | `--json` | `.data.policy.greenRel == {value: 1e-3, source: …, defaulted: true}`; `.data.schema == {value: "ap242", defaulted: true}`; `.data.provenance` (sha256, originating system, kernel version) present | VC-XCH-25 |
| AC-20 | NIST CTC-02 AP242 (largest, 637 faces) | `import_step_exact … --dry-run --json`; `--progress` | dry run `.changed == false`, document untouched; progress lines per stage | VC-XCH-26 |

## 8. Standards & regulatory alignment

| Topic | Alignment |
| ----- | --------- |
| ISO 10303-242 | Write AP242 MIM long form; read ed. 1–4 files (schema identifiers seen in NIST files: `{ 1 0 10303 442 1 1 4 }`, `… 442 3 1 4 }`, `… 442 4 1 4 }`, `… 442 7 1 4 }`) [R4]. llull claims no conformance class until tested in a CAx-IF round. |
| CAx-IF RPs | GVP RP (v4.5/4.6) for validation properties; PMI RP v4.1 for semantic + graphic PMI; styling RP for colours/layers; tessellated RP v1.1 [R11][R12][R13][R15]. OCC implements GVP per the GVP RP section 4 (AP214) and GD&T per PMI RP v4.0 [R8]. |
| EN/NAS 9300 LOTAR | The archive package (FR-XCH-13/14) is designed for -110 (explicit geometry) and -115 (assembly) verification with validation properties [R16][R17]; -120 PMI once V1 PMI is in. llull does not claim LOTAR compliance: compliance is a property of the archiving organisation's process (EN 9300-002 requirements) [R16]. |
| IGES 5.3 | OCC reads ≤ 5.3, writes 5.3 [R7]. |
| ISO 14306 / ISO 23952 | Read-only (JT) / export-only (QIF) at COULD level [R5][R6]. |
| Certification (FAA/EASA) | Retention of type-design data is a regulatory driver (FAA Order 8000.79 cited by LOTAR) [R20]; llull provides evidence (reports, checksums), not compliance. |

## 9. KPIs / success metrics

| KPI | Target | Measured by |
| --- | ------ | ----------- |
| NIST AP242 parts imported as exact solids | 100 % of the pinned AP242 B-rep files | VC-XCH-05 gate |
| GVP agreement on import (NIST, files with GVP) | 100 % green (no pinned file disagrees with its own geometry at group scope; CTC-02 e2 and STC-08 e3 included); a sender that lies (tampered file) is reported red | VC-XCH-05 |
| Self round-trip GVP agreement | 100 % within 1e-9 relative | VC-XCH-01 |
| SFA syntax errors on llull-written AP242 | 0 | VC-XCH-17 |
| Semantic PMI mapped (NIST CTC/FTC/STC, V1) | ≥ 90 % of census records mapped, 100 % accounted for | VC-XCH-07 |
| IGES sample import | 100 % of root faces translated | VC-XCH-10 |
| Import time, 2 MB AP242 part on desktop | ≤ 5 s (TECHNICAL_SPEC §8) | perf test |
| Agent operability | 100 % of XCH VCs run unattended as CLI scripts (`--json`, exit codes, no UI); every refusal / finding carries an `XCH_*` / `KRN_*` code | VC-XCH-20, VC-XCH-21, production-gate agent driver |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| The browser/server OCC build (opencascade.js 1.1.1) may not expose XCAF/STEPCAF/IGES/GD&T classes | AP242 with assembly/GVP/PMI not possible in WASM | Custom opencascade.js build (supported by the project [R24]) or route through the bundled CPython/OCP bridge on desktop; feasibility shown by an OCCT 8.0.1 WASM STEPCAF reader [R26] |
| OCC's GD&T reader returns 0.0 for tolerance magnitudes inside complex entities in the NIST files (reported by a third-party project) [R25] | Wrong PMI values | VC-XCH-07 compares values with the text-level census; text-level fallback reader for magnitudes |
| GVP written by originating CAD can be placeholder zeros (NIST STC-06) | False red | Treat all-zero GVP as "not checkable" (VC-XCH-05) |
| Thresholds: CAx-IF does not publish one pass threshold in what we could verify; the 1 % / 1 mm figures are a CATIA default [R14] | Over/under-strict checks | Configurable bands; defaults justified by measured cross-CAD spread (VC-XCH-06) |
| JT has no open-source OCC reader (OCC's open DE wrapper lists STEP, IGES, OBJ, STL, PLY, glTF, VRML only) [R9] | JT stays COULD | External converter port, like DWG |
| CAx-IF/MBx-IF, ISO, NIST web pages could not be fetched from this session (DNS/proxy) | Some facts rest on search-engine extracts | Marked in `validation/sources.md`; re-verify before implementation |
| Operator and owner have no engineering judgement (AGENT_FIRST §1) | a red / unverified exchange could be delivered or archived as if checked | bands, `unverified`, `reviewRequired` in `data` (FR-XCH-26..28); human gates for delivery of unverified bodies and archive acceptance (FR-XCH-29); `verify_exchange_file` at the end of every workflow (FR-XCH-24) |
| Topological naming (KI5) | PMI links to faces lost after edit | PMI attaches through gap-03 references; re-import resolves by geometry |

## 11. References

- [R1] ISO 10303-242:2025 Industrial automation systems and integration — Product data representation and exchange — Part 242: Application protocol: Managed model-based 3D engineering (Edition 4, 2025-08) — ISO — https://www.iso.org/standard/84300.html (accessed 2026-10, search extract)
- [R2] ISO 10303-242:2022 (Edition 3, 2022-12, replaces :2020) — ISO — https://www.iso.org/es/contents/data/standard/08/46/84667.html (accessed 2026-10, search extract)
- [R3] ISO/CD 10303-242 (Edition 5, CD registered 2026-02) — ISO — https://www.iso.org/standard/93277.html (accessed 2026-10, search extract)
- [R4] NIST-PMI-STEP-Files README.txt (Feb 2026 update) in NIST STEP File Analyzer repository, Release/NIST-PMI-STEP-Files.zip — NIST — https://raw.githubusercontent.com/usnistgov/SFA/72375d17c09cf7072c30d9393b5c08b7aa272285/Release/NIST-PMI-STEP-Files.zip (accessed 2026-10-15, downloaded)
- [R5] ISO 14306:2017 JT file format specification for 3D visualization; ISO 14306-1:2024, ISO 14306-3:2025 — ISO — https://www.iso.org/standard/62770.html , https://www.iso.org/standard/89233.html (accessed 2026-10, search extract)
- [R6] DMSC: QIF standard elevated to ISO status (ISO 23952:2020) — DMSC — https://qifstandards.org/qif-to-iso-status/ (accessed 2026-10, search extract)
- [R7] OCCT IGES Translator user guide — Open Cascade — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/3d097a0328e71b826377d4814ab05ec3c3d23871/dox/user_guides/iges/iges.md (accessed 2026-10-15, fetched)
- [R8] OCCT STEP Translator user guide — Open Cascade — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/3d097a0328e71b826377d4814ab05ec3c3d23871/dox/user_guides/step/step.md (accessed 2026-10-15, fetched)
- [R9] OCCT Data Exchange Wrapper user guide — Open Cascade — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/3d097a0328e71b826377d4814ab05ec3c3d23871/dox/user_guides/de_wrapper/de_wrapper.md (accessed 2026-10-15, fetched)
- [R10] NIST STEP File Analyzer and Viewer (SFA) README — NIST — https://github.com/usnistgov/SFA (accessed 2026-10-15, fetched)
- [R11] CAx-IF Recommended Practices for Geometric and Assembly Validation Properties (v4.5; archive lists 4.6, 2023-04-21) — MBx-IF/CAx-IF — https://www.mbx-if.org/home/wp-content/uploads/2024/05/rec_prac_gvp_v45.pdf (accessed 2026-10, search extract)
- [R12] CAx-IF Recommended Practices for the Representation and Presentation of PMI (AP242) v4.1, 2024-06-20 — MBx-IF/CAx-IF — https://www.mbx-if.org/home/wp-content/uploads/2024/06/rec_pracs_pmi_v41.pdf (accessed 2026-10, search extract)
- [R13] CAx-IF Recommended Practices for 3D Tessellated Geometry v1.1, 2019-08-22; GVP RP (three-tier green/yellow result system) — MBx-IF — https://www.mbx-if.org/home/wp-content/uploads/2024/05/rec_prac_3dtess_geo_v11.pdf (accessed 2026-10, search extract)
- [R14] Dassault Systèmes CATIA documentation "About Validation Properties" (default pass: volume and area ratio < 1 %, centroid deviation < 1 mm) — mirrors: https://help-3dexperience.aesvietnam.com/English/SstUserMap/sst-c-ValidationProperties.htm , http://catiadoc.free.fr/online/bascuitf_C2/bascuitf0102.htm (accessed 2026-10, search extract; unofficial mirrors)
- [R15] CAx Recommended Practices Archive (Composite Materials v4.4 2025-12-03; AP242 XML Kinematics v1.3 and Product & Assembly Structure v4.0, 2025-10-20; Model Styling & Organization v1.10) — MBx-IF — https://www.mbx-if.org/home/cax/recpractices/archive/ (accessed 2026-10, search extract)
- [R16] EN 9300-001:2024, EN 9300-002:2018, EN 9300-100:2026, EN 9300-110:2018, EN 9300-210:2026 catalogue pages — CEN via iTeh — https://standards.iteh.ai/catalog/standards/cen/de6883a7-b124-4e12-a7f6-c041cb180913/en-9300-001-2024 , https://standards.iteh.ai/catalog/standards/cen/9466c1e6-4bcf-4880-b3ad-d097a9d1dabb/en-9300-100-2026 , https://standards.iteh.ai/catalog/standards/cen/bbb8a880-464c-4c0f-85e7-c28fc11bc32f/en-9300-110-2018 (accessed 2026-10, search extract)
- [R17] Overview of the LOTAR project and LOTAR standards (GIFAS, 2012) — LOTAR International — https://lotar-international.org/wp-content/uploads/2020/05/2012-05-29_GIFAS_LOTAR_Overview_Final_V5.pdf (accessed 2026-10, search extract)
- [R18] Airbus (Delaunay), Use of ISO 10303 AP242 in the European A&D industries (GPDIS 2018) and Use of STEP AP242 ed1 to support MBD (GPDIS 2019) — GPDIS — https://gpdisonline.com/wp-content/uploads/2018/09/Airbus-Delaunay-UseSTEPAP242inEuropeAandD-MBD-Open.pdf , https://gpdisonline.com/wp-content/uploads/2019/09/Airbus-Delaunay-UseOfStepAp242Ed1ToSuppor-MBD-Open.pdf (accessed 2026-10, search extract)
- [R19] A "STEP" Forward for Product Lifecycle Management — Mobility Engineering Technology (SAE) — https://www.mobilityengineeringtech.com/component/content/article/35365-a-step-forward-for-product-lifecycle-management (accessed 2026-10, search extract)
- [R20] Boeing/Airbus (Klein, Feldvoss) LOTAR Overview (2023) and LOTAR 101 (GPDIS 2025) — LOTAR International / GPDIS — https://lotar-international.org/wp-content/uploads/2023/10/Boeing-Airbus-JeffKleinBerndFeldvoss-LOTAR-Overview-STD-Open.pdf (accessed 2026-10, search extract)
- [R21] FIPS PUB 177-1 (adopts IGES 5.2, ANSI/US PRO/IPO-100-1993) — NIST — https://nvlpubs.nist.gov/nistpubs/Legacy/FIPS/fipspub177-1.pdf (accessed 2026-10, search extract)
- [R22] OCCT sample data `data/iges/bearing.iges`, `hammer.iges` — Open Cascade — https://github.com/Open-Cascade-SAS/OCCT/tree/3d097a0328e71b826377d4814ab05ec3c3d23871/data/iges (accessed 2026-10-15, downloaded)
- [R23] NIST MBE PMI Validation and Conformance Testing Project; data.gov "NIST CAD Models and STEP Files with PMI" — NIST — https://www.nist.gov/ctl/smart-connected-systems-division/smart-connected-manufacturing-systems-group/mbe-pmi-validation , https://catalog.data.gov/dataset/nist-cad-models-and-step-files-with-pmi (accessed 2026-10, search extract)
- [R24] OpenCascade.js custom builds — ocjs.org — https://ocjs.org/docs/app-dev-workflow/custom-builds (accessed 2026-10, search extract)
- [R25] pzfreo/step-pmi-viewer README (OCCT GD&T `GetValue()` returns 0.0 for NIST tolerances; text re-read workaround; Apache-2.0) — GitHub — https://github.com/pzfreo/step-pmi-viewer (accessed 2026-10-15, fetched)
- [R26] naanouff/occt-wasm (OCCT 8.0.1 STEPCAF reader compiled to WebAssembly; XCAFDoc_DimTolTool; LGPL-2.1) — GitHub — https://github.com/naanouff/occt-wasm (accessed 2026-10-15, fetched)
