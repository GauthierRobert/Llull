# PHY-13 — Corrosion & environmental compatibility — Functional spec

Gap id **COR** · Status: specification (no implementation) · Written 2026-10-15
Companion: [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Sources: [validation/sources.md](validation/sources.md) · Gap list: [../README.md](../README.md) (PHY-13, P3)

---

## 1. Summary

After the aerospace packs, a llull material record carries alloy, temper, form, basis and provenance (08 MAT),
and fastener catalogues carry material and finish codes in their part-number grammar. Nothing uses that data
to ask the question every airframe designer asks at each joint: **"these two parts touch — will they corrode
each other, and is this alloy safe from stress-corrosion cracking in this direction?"** llull cannot even list
which parts touch: today's clash check (`check_clashes`) is building-specific and box-based, and
`motion_study` only flags AABB overlaps between instances.

This gap adds (1) a generic, read-only **contact finder** (`find_contacts`) over solids, instances and 08
fastener stacks; (2) **compatibility rules as sourced data** (AF-30): the MIL-STD-889D galvanic matrix (format
ready, cells to be transcribed from the public standard), an anodic-index screening clearly labelled as a
non-889 rule of thumb, the small-anode rule, the CFRP–aluminium rule, stress-corrosion susceptibility classes
(MSFC-STD-3029A structure) and a hydrogen-embrittlement flag; (3) **surface systems and isolation
declarations** as plugin data; and (4) the check command `check_material_compatibility`, which reports every
contacting pair with pass / warn / fail codes, the rule and source behind it, and remedy options. llull never
claims a joint is acceptable: every result carries `reviewRequired` (corrosion protection is a certification
item) and missing data is reported, never assumed compatible.

## 2. Aerospace context & value

- **Regulation.** 14 CFR 25.609 requires each part of the structure to be suitably protected against
  deterioration or loss of strength in service from any cause, including weathering, corrosion and abrasion,
  and to have ventilation and drainage where needed [R1].
- **Galvanic compatibility.** MIL-STD-889 is the DoD reference. Revision D (21 July 2021, superseding 889C of
  22 Aug 2016) replaced the galvanic-potential approach with the **corrosion rate of the anodic member**,
  computed from joint polarization curves at a 1:1 area ratio in artificial seawater [R2][R3][R4]. The standard
  itself says its table must not be used to rate the risk of a couple or to choose the protection level [R3];
  llull therefore reports the cell and leaves protection to the designer.
- **Anodic index.** Industry tables give each metal an "anodic index" and limit the difference to about 0.15 V
  (harsh), 0.25 V (normal) and 0.50 V (controlled environments) [R5][R6]. One source states these limits are
  not for critical applications such as aerospace flying parts [R6]. llull offers them only as a labelled
  screening rule for early design and non-flight hardware.
- **Classic aerospace defects.** Carbon fibre is noble to aluminium, so CFRP–aluminium contacts need an
  isolation (glass barrier ply, sealant, primer) [R7]; corrosion concentrates on a small anode coupled to a large
  cathode [R8]; high-strength aluminium in the short-transverse direction is prone to stress-corrosion
  cracking — a 1963 NASA test series found all tested alloys highly susceptible in ST except 7075-T73 and
  2219-T87 [R9], and 7079-T6, 7075-T6 and 2024-T3 account for most service SCC failures [R10]. NASA
  MSFC-STD-3029A classifies alloys into high / moderate / low SCC resistance (Tables I–III) and requires
  approval to use moderate or low resistance alloys [R11]. High-strength steels electroplated with cadmium
  risk hydrogen embrittlement; NAS672 covers cadmium plating of steel parts heat-treated to 180 ksi and higher
  [R12].
- **Who does it today.** Corrosion and M&P engineers with the 889 table, company finish specifications and the
  drawing notes; commercial tools such as Corrosion Djinn implement the 889D chart [R13]. None of them knows
  which parts of the CAD model touch.
- **llull's value.** The geometry knows the contacts; the 08 records know the materials; the fastener stacks
  know the fasteners. One check command joins them and leaves a reviewable list with sources.

## 3. Personas & user stories

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent (`llull` CLI; MCP in the cloud) | `find_contacts`, `check_material_compatibility`, `assign_surface_system`, `declare_isolation`, `set_service_environment` | Contact pairs and verdicts as JSON, stable codes, remedy options with sources |
| **Owner** | Not assumed to be an engineer | Natural language | "Which joints could corrode, and what must be done?" in plain words |
| **Qualified reviewer** | Corrosion / M&P engineer | Desktop review; accepts remedies and SCC usage (human gate) | Decides remedies; approves use of Table II/III alloys (materials usage agreement) |

- **US-1 (operator).** After assembling a bracket on a skin the agent runs `check_material_compatibility` and
  gets `COR_GALVANIC_INCOMPATIBLE` for the Ti fitting on the 7075 skin (anodic screening, normal environment,
  0.60 V > 0.25 V) with remedy options (faying-surface sealant MIL-PRF-81733 Type IV, primer MIL-PRF-23377).
- **US-2 (operator).** A CFRP panel touches an aluminium frame: `COR_CFRP_ALUMINIUM`. The agent records
  `declare_isolation method=glass_isolation_ply` and the item turns `pass (isolated)` with `reviewRequired`.
- **US-3 (operator).** A 4340 bolt heat-treated to 260 ksi with a cadmium-plate finish code: `COR_HE_RISK`
  (default threshold 180 ksi, NAS672, named as default).
- **US-4 (reviewer).** A 7075-T6 fitting loaded in ST: `COR_SCC_UNCLASSIFIED` until the MSFC-STD-3029A row is
  transcribed; once classified Table III, `COR_SCC_LOW_RESISTANCE` and a human approval is required.
- **US-5 (owner).** "Is my assembly OK for corrosion?" The agent answers with counts per code and the
  sentence "computed by llull from rules of thumb and catalogue data; not approved — a corrosion engineer must
  review".

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | `find_contacts` (closed form for boxes and axis-aligned primitives; AABB broad phase; interference via the existing `boolean intersect` recipe; 08 fastener stacks); galvanic groups on materials; anodic-index screening; CFRP–Al rule; small-anode rule; `set_service_environment`; `assign_surface_system`; `declare_isolation`; `check_material_compatibility`; codes |
| **V1** | Exact contacts through a kernel proximity port (OCC distance + face common area); MIL-STD-889D matrix lookup from a transcribed, hash-locked table; SCC classes (MSFC-STD-3029A transcription) with grain direction from 08 and sustained stress from 05; hydrogen-embrittlement flag; compatibility report CSV (`--save`) |
| **V2** | Environment zones (wet / dry areas of an airframe); ECSS-Q-ST-70-36 tables; fastener-finish mapping from 08 catalogue codes; contact through conductive sealant or shims; electrical bonding cross-check with PHY-15 |

**Out of scope.** Corrosion-rate prediction or life (electrochemical modelling, FE galvanic analysis), coating
thickness design, crevice/pitting/intergranular models beyond SCC classes, deciding a protection scheme.

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-COR-01 | MUST | `find_contacts` (read-only) returns every pair of solids whose gap ≤ `tolerance`: kind `interference` (with overlap volume), `face` (with contact area and normal), `edge` or `vertex`, and gap. | "Which parts touch" is the input of every check | VC-COR-01 |
| FR-COR-02 | MUST | Contacts cover plain solids and assembly instances (children expanded with their own materials, like `mass_properties`). Closed form for boxes / axis-aligned primitives; exact kernel when present; mesh fallback flagged `approximate`. | Assemblies are the normal case | VC-COR-01 |
| FR-COR-03 | MUST | Contacts of 08 fastener stacks come from stack data (fastener ↔ each layer, washer ↔ adjacent layer, nut ↔ washer, layer ↔ layer), without geometry. | Fasteners are the main galvanic couples | VC-COR-12 |
| FR-COR-04 | SHOULD | MIL-STD-889D lookup: anodic-member corrosion rate for an (anodic, cathodic) material pair from a transcribed matrix; compatible below 0.009 mil/yr (B); the result quotes the standard's scope limits (1:1 area, artificial seawater, not a risk or protection rating). Without a transcribed table: `COR_889_TABLE_MISSING`. | DoD reference | R2, R3; VC-COR-04, 10 |
| FR-COR-05 | MUST | Anodic-index screening: anode = larger index; verdict per environment against the limit table; labelled `rule: "anodic_index (non-889 rule of thumb)"`; group without value ⇒ `COR_GROUP_VALUE_MISSING`. | Early screening | R5, R6; VC-COR-02, 09 |
| FR-COR-06 | MUST | The service environment is explicit (`set_service_environment`), document-level in MVP; no environment ⇒ `COR_ENVIRONMENT_UNSET` (no default, AF-31). | The verdict depends on it | VC-COR-02 |
| FR-COR-07 | MUST | Area ratio: anode and cathode exposed areas and Aa/Ac in `data`; warning `COR_SMALL_ANODE` when the anodic member is the smaller one. | Small anode / large cathode | R8; VC-COR-03 |
| FR-COR-08 | MUST | A carbon-fibre composite (06 record or galvanic group `graphite`) in contact with aluminium ⇒ `COR_CFRP_ALUMINIUM` unless an isolation is declared for the pair. | Classic defect | R7; VC-COR-07 |
| FR-COR-09 | MUST | `declare_isolation` (mutating) records, for a pair or a part, the isolation method (from the remedy vocabulary) and optional spec; the check then reports the pair `pass (isolated)` with `reviewRequired: true`. | Remedies must be visible to the check | VC-COR-08 |
| FR-COR-10 | SHOULD | Hydrogen embrittlement: steel with Ftu ≥ threshold (named default 180 ksi, NAS672 scope) and an electroplated or acid-processed surface system ⇒ `COR_HE_RISK`. | Cd-plated high-strength steel | R12; VC-COR-05, 06 |
| FR-COR-11 | SHOULD | SCC: alloy + temper (+ form, direction) mapped to MSFC-STD-3029A Table I/II/III; Table II/III ⇒ `COR_SCC_MODERATE` / `COR_SCC_LOW_RESISTANCE`; unknown row ⇒ `COR_SCC_UNCLASSIFIED`; when 05 results exist, sustained ST tensile stress is reported. | SCC by alloy and direction | R9, R11; VC-COR-11 |
| FR-COR-12 | MUST | `check_material_compatibility` (AF-20) returns one item per contacting pair and per part rule (SCC, HE) with status, code, rule id, source, inputs, remedy options and `reviewRequired: true`. | The agent ends with it | VC-COR-07, 08 |
| FR-COR-13 | MUST | Missing data never passes: a part without material, a material without galvanic group, an untranscribed table ⇒ explicit codes (`COR_MATERIAL_MISSING`, `COR_GROUP_MISSING`, `COR_889_TABLE_MISSING`, `COR_SCC_UNCLASSIFIED`). | Silence ≠ compatible | VC-COR-09, 10, 11 |
| FR-COR-14 | MUST | Named defaults (AF-31): contact tolerance (default 0.0025 mm = 1e-4 in, reused from 08 stack contact tolerance), HE threshold 180 ksi; each reported with source and `defaulted: true`. | No silent rule values | VC-COR-05 |
| FR-COR-15 | MUST | `assign_surface_system` (mutating) attaches a surface system to parts (anodize, conversion coating, metallic plating, primer, paint, none) with spec ids; the galvanic group of a plated surface is the plating's group. Organic coatings count as isolation only when declared (`declare_isolation`). | Same alloy, different finish | R7, R14; VC-COR-13 |
| FR-COR-16 | MUST | New scalar properties on the 08 record: `galvanicGroup` (key into the rule table), `anodicIndex` (V, overrides the group value with its own source), `sccClass` (table, direction, environment, source) — additions to the 08 `MaterialPropertyName` list. | Material data lives in 08 | VC-COR-14 |
| FR-COR-17 | MUST | `unverified` propagates (B-grade rule values and typical material data); every compatibility item carries `reviewRequired: true` with reason "corrosion protection supports 14 CFR 25.609 compliance". Accepting a remedy or the use of a Table II/III alloy is a human gate (09 signature). | AF-32/33/34 | R1; VC-COR-15 |
| FR-COR-18 | MUST | Stable `COR_*` codes with ids and remediation (TECHNICAL_SPEC §7.1). | AF-11 | VC-COR-07…11 |
| FR-COR-19 | COULD | Compatibility report export (`--save report.csv`): pair, materials, surface systems, rule, verdict, remedy, reviewer status. | Hand-off to the corrosion engineer | VC-COR-16 |
| FR-COR-20 | COULD | Environment zones (wet / dry / bilge) as named regions overriding the document environment. | Real airframes are zoned | V2 |

## 6. Workflows

### 6.1 CLI

```bash
llull search corrosion galvanic ; llull describe check_material_compatibility find_contacts
llull set_service_environment scheme=anodic_index environment=normal --doc asm.llull.json
llull find_contacts '{"tolerance":{"value":0.1,"unit":"mm"}}' --doc asm.llull.json --json
llull check_material_compatibility --doc asm.llull.json --json --save out/corrosion.csv
llull declare_isolation '{"pair":["skin-3.1","fitting-7.1"],"method":"sealant_faying","spec":"MIL-PRF-81733 Type IV"}' --doc asm.llull.json
llull check_material_compatibility --doc asm.llull.json --json      # re-check; remaining items need a human
llull render_view view=iso --save out/contacts.png --doc asm.llull.json   # AF-22 (contacts overlay, V1)
```

### 6.2 MCP

Toolset `corrosion`: `find_contacts` (core, toolset `measure`), `check_material_compatibility`,
`list_compatibility_rules` (read-only) and `assign_surface_system`, `declare_isolation`,
`set_service_environment` (mutating).

### 6.3 UI (review)

Contact pairs coloured by status (same data as the check), rule popover with source, remedy acceptance dialog
(human gate, 09 signature).

## 7. Acceptance criteria

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-1 | plate 100×50×10 mm and a 60×30×5 block on top | `llull find_contacts tolerance=0.1mm D` | one `face` pair, area 1800 mm², normal z | VC-COR-01.1 |
| AC-2 | block lowered 0.5 mm | same | `interference`, volume 900 mm³ | VC-COR-01.2 |
| AC-3 | gap 0.2 mm, tolerance 0.1 mm | same | no pair | VC-COR-01.4 |
| AC-4 | 7075 plate + Ti block, environment normal | `check_material_compatibility D` | `COR_GALVANIC_INCOMPATIBLE`, ΔAI 0.60 V, anode 7075, `rule: anodic_index`, `reviewRequired` | VC-COR-02.2 |
| AC-5 | the block is cadmium-plated steel (anode, 0.95 V) on the 7075 plate (0.90 V) | same | pair compatible by ΔAI (0.05 V) but Aa/Ac = 0.346 ⇒ warning `COR_SMALL_ANODE` | VC-COR-02.1, 03 |
| AC-6 | no environment set | same | `COR_ENVIRONMENT_UNSET` (exit 1) | VC-COR-02 |
| AC-7 | CFRP on 7075 | same | `COR_CFRP_ALUMINIUM`; after `declare_isolation` → `pass (isolated)` | VC-COR-07, 08 |
| AC-8 | 4340 260 ksi, cadmium-plated | same | `COR_HE_RISK`, threshold `{value:180, unit:"ksi", defaulted:true, source:"NAS672 scope"}` | VC-COR-05, 06 |
| AC-9 | 889D lookup without a transcribed table | `check_material_compatibility scheme=mil_std_889d D` | `COR_889_TABLE_MISSING` | VC-COR-10 |

## 8. Standards & regulatory alignment

- 14 CFR 25.609 protection of structure [R1].
- MIL-STD-889D (2021) / 889C (2016) galvanic compatibility (public DoD standard, via ASSIST) [R2][R3][R4].
- MSFC-STD-3029A SCC selection (NASA, public) [R11]; ECSS-Q-ST-70-36C (ESA) [R15].
- NAS672 cadmium plating of high-strength steel (AIA, inactive) [R12]; ASTM F519 embrittlement test.
- Remedy specs as vocabulary only: MIL-PRF-81733 sealant (Types I–IV), MIL-PRF-23377 primer, MIL-DTL-81706
  conversion coating [R14].

## 9. KPIs / success metrics

| KPI | Target |
| --- | ------ |
| Contact classification on the closed-form set | 100 %, area/volume rel 1e-9 |
| Contacting pairs reported without a verdict or code | 0 |
| Pairs reported "compatible" while a datum is missing | 0 |
| `find_contacts` on 1,000 parts | ≤ 2 s closed form / ≤ 30 s exact (TECHNICAL_SPEC §8) |
| Rule values shipped without source and grade | 0 |

## 10. Risks & assumptions

| Risk | Mitigation |
| ---- | ---------- |
| Anodic index rule used for flight hardware | Label in every result; check warns `COR_SCREENING_RULE_ONLY` when the scheme is anodic_index; 889D preferred when transcribed |
| 889D matrix transcription errors | Hash-locked table file, double-entry test against two transcriptions, reviewer sign-off before shipping |
| Contact tolerance too small or too large | Named default; result lists near-misses (gap ≤ 10× tol) as info |
| Over-reporting (every bolt is a couple) | Group by (material pair, surface systems, isolation); counts in the summary |
| Assumption | 08 records and fastener stacks exist; 05 results optional; 09 signature port for human gates |

## 11. References

- [R1] 14 CFR 25.609 Protection of structure — eCFR / Cornell LII — https://www.law.cornell.edu/cfr/text/14/part-25/subpart-D (accessed 2026-10)
- [R2] MIL-STD-889D Galvanic compatibility of electrically conductive materials (2021) — Corrdesa public copy; Intertek / ANSI listings — https://corrdesa.com/wp-content/uploads/2024/04/MIL-STD-889D-2021-Release.pdf ; https://webstore.ansi.org/standards/dod/MILSTD889D (accessed 2026-10)
- [R3] NAWCAD, MIL-STD-889D paper and slides — NATO STO-MP-AVT-373-09 — https://www.sto.nato.int/publications/STO%20Meeting%20Proceedings/STO-MP-AVT-373/MP-AVT-373-09.pdf (accessed 2026-10)
- [R4] AFCPCO Newsletter May 2023 — US Air Force — https://www.aflcmc.af.mil/Portals/79/AFCPCO/AFCPCO%20Newsletter_May%2023.pdf (accessed 2026-10)
- [R5] Galvanic compatibility guide — Engineers Edge — https://www.engineersedge.com/galvanic_capatability.htm (accessed 2026-10)
- [R6] Practical guideline for the anodic index — Carr Lane — https://www.carrlane.com/engineering-resources/technical-information/galvanic-corrosion/practical-guideline-for-the-anodic-index-of-materials-in-different-environments (accessed 2026-10)
- [R7] Galvanic corrosion carbon fiber and aluminum — Composite Envisions — https://compositeenvisions.com/wp-content/uploads/2022/10/Galvanic-Corrosion-Carbon-Fiber-and-Aluminum.pdf (accessed 2026-10)
- [R8] Galvanized steel with aluminum parts — American Galvanizers Association — https://www.hotdipgalvanizing.com/technical-resources/galvanized-steel-with-aluminum-parts (accessed 2026-10)
- [R9] MTP-P&VE-M-63-8 stress corrosion of aluminium alloys — NASA MSFC (NTRS 19630013134) — https://ntrs.nasa.gov/api/citations/19630013134/downloads/19630013134.pdf (accessed 2026-10)
- [R10] Stress corrosion cracking of aluminum alloys — Total Materia — https://www.totalmateria.com/es/articles/stress-corrosion-cracking-aluminum-alloys/ (accessed 2026-10)
- [R11] MSFC-STD-3029 Rev. A — NASA — https://standards.nasa.gov/sites/default/files/standards/MSFC/A/0/MSFC-STD-3029.pdf (accessed 2026-10)
- [R12] NAS672 — AIA (GlobalSpec catalogue) — https://standards.globalspec.com/std/1495681/nas672 (accessed 2026-10)
- [R13] MIL-STD-889D chart — Corrosion Djinn — https://docs.corrosiondjinn.com/features/MIL-STD-889D-chart/ (accessed 2026-10)
- [R14] MIL-PRF-81733 types — NSL Aerospace — https://nslaerospace.com/mil-prf-81733-and-its-4-types/ ; MIL-PRF-23377 — Silmid — https://silmid.com/knowledge-centre/aerospace-specifications/mil-prf-23377/ (accessed 2026-10)
- [R15] ECSS-Q-ST-70-36C — ECSS — https://ecss.nl/standard/ecss-q-st-70-36c-material-selection-for-controlling-stress-corrosion-cracking/ (accessed 2026-10)
