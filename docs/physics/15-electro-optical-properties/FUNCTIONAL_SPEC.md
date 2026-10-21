# PHY-15: Electrical, magnetic, optical & radiative properties — functional specification

Gap id **EOP** · status: specification · written 2026-10-15 · technical spec: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)
· gap list: [`../README.md`](../README.md) row PHY-15

## 1. Summary

After the aerospace packs, an llull material record (08 MAT) carries mechanical and thermal properties only (`E`, `G`, `ν`,
allowables, `cte`, `k`, `cp`, density). It has no electrical resistivity or conductivity, no magnetic permeability, and no
surface optical properties: thermal infrared emissivity, solar absorptivity, refractive index. llull therefore cannot say
whether an equipment box is electrically bonded to structure, how much resistance a CFRP part adds to a current path, how
deep a high-frequency current flows, or how hot a white-painted radiator runs in the sun — and PHY-03's radiation boundary
conditions have nowhere to take an emissivity from except a typed number.

This gap adds those properties **as property records through PHY-01's property models** (with units, conditions such as
temperature, wavelength, direction or beginning/end of life, basis and provenance), face-level **surface coatings** that
carry optical properties, and a small set of read-only checks: conductor resistance and skin depth, electrical bonding path
resistance against a rule value, absorption loss of a conducting sheet, the α/ε radiative balance of a surface, and normal
reflectance of a window. Lightning-strike zoning is recorded as user-supplied annotations only. llull ships **no property
values and no bonding limit tables**: values come from the customer's or a human-checked library (08 rules), and every
limit is a sourced rule entry.

## 2. Aerospace context & value

| Context | Today | What llull adds | Source |
| ------- | ----- | --------------- | ------ |
| Electrical bonding | Equipment-to-structure bonds are checked against classic values; 2.5 mΩ is the widely used class R/L figure, recognised by MIL-STD-464C as "an indication of a good bond across a metallic interface" while stating it need not be met strictly | Bond paths as data (joints, straps, parts), total resistance against a sourced rule value, flagged `unverified` until a human confirms the rule | [R6], [R7], [R8] |
| CFRP structure | CFRP conducts far less than aluminium and anisotropically, so it cannot replace metallic bond and return paths | Anisotropic conductivity on the record; warning when a CFRP part is in a bond path | [R3] (derivation), VC-EOP-07 |
| Lightning | Zones (ARP5414) define where lightning attaches; environment and waveforms in ARP5412 | Zone labels on faces as annotations with their source; no zone definitions shipped | [R10] |
| Thermal control coatings | α_solar and ε_IR of coatings drive spacecraft temperatures; NASA RP-1121 tabulates many coatings | Coating records on faces; PHY-03 radiation uses them; `optical_balance` gives the sun-facing equilibrium temperature | [R11], [R4] |
| Electromagnetics in FE | CalculiX has `*ELECTRICAL CONDUCTIVITY`, `*MAGNETIC PERMEABILITY`, `*ELECTROMAGNETICS` | V2 hook (Joule / induction heating with PHY-03) | [R12] |

**Value statements**: only the facts above, as sourced; no programme ROI is claimed.

## 3. Personas & user stories

| Role | Who | Main need |
| ---- | --- | --------- |
| **Operator (primary)** | AI agent via `llull` CLI / MCP | Property records with units and conditions; checks with codes and formulas |
| **Owner** | Asks "is the box bonded?", "will this radiator stay cool?" — **not assumed to be an engineer** | A plain answer with numbers and what needs an engineer |
| **Qualified reviewer** | EMC / lightning / thermal engineer, signatory | Confirms rule values, coating data, dispositions failed bond checks |

- **US-EOP-1.** "Is the avionics box bonded well enough?" The agent defines the bond path (two faying-surface joints and
  a strap), runs `check_bonding`, and reports 1.72 mΩ against a 2.5 mΩ rule entry, with the rule's source and `unverified`
  flag and "needs a qualified engineer".
- **US-EOP-2.** A second box's path is 3.12 mΩ: `EOP_BOND_RESISTANCE_EXCEEDED`; only a reviewer can accept it (human gate).
- **US-EOP-3.** The agent assigns a white-paint coating record to a radiator face; PHY-03 radiation BCs on that face use
  `emissivity: 'material'`; `optical_balance` gives a first equilibrium temperature with a solar flux the owner supplied.
- **US-EOP-4.** The agent computes the skin depth of a strap at 1 MHz and the absorption loss of a 0.1 mm copper shield.
- **US-EOP-5.** The owner's library lacks emissivity for a face that radiates: `check_surface_properties` reports
  `EOP_SURFACE_PROPERTY_MISSING` instead of a guessed value.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | Property names `electricalResistivity` (or `electricalConductivity` / `percentIacs` with conversion), `temperatureCoefficientOfResistivity`, `relativePermeability`, `emissivityIr`, `absorptivitySolar`, `refractiveIndex` as PHY-01 `PropertyModel`s (catalogue rows in `model/propertyCatalog.ts`) with variables `T` / `wavelength` / `frequency`, direction, and conditions (hemispherical vs normal, BOL/EOL) and validation ranges. Coating records (08 records with `productForm: 'coating'`) and face assignment. Queries: `electrical_resistance` (DC, temperature, skin depth, AC approximation), `check_bonding` over bond paths with sourced limits, `shield_absorption`, `optical_balance`, `normal_reflectance`, `check_surface_properties`. PHY-03 link (`emissivity: 'material'`). |
| **V1** | Bond paths through modelled parts (resistance from part geometry along a straight path: length / cross-section from the kernel), CFRP-in-path warnings, lightning-zone annotations with a "CFRP face in zone without path" warning, BOL/EOL selection for α, temperature-dependent ε in PHY-03. Seed library import (human-checked) of public-domain coating data. |
| **V2** | Joule heating coupling (PHY-03 + resistivity), induction (CalculiX electromagnetics), permittivity / loss tangent for radomes, full shielding effectiveness (reflection + apertures) as hand-off. |
| **Out of scope** | Lightning strike simulation or certification, EMC test prediction, antenna / RF design, optical ray tracing. |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-EOP-01 | MUST | **Electrical property records**: `electricalResistivity` (Ω·m), accepted also as `electricalConductivity` (S/m) or `percentIacs` (converted with 100 % IACS = 1.7241 × 10⁻⁸ Ω·m at 20 °C, conversion recorded); direction (L, T, through-thickness) for anisotropic materials; temperature dependence through PHY-01 models; `temperatureCoefficientOfResistivity` (1/K) as an alternative linear model. | Bonding and conductor checks need ρ | [R1], [R2], PHY-01 |
| FR-EOP-02 | MUST | **Conductor resistance** query: R = ρL/A at a temperature, with the temperature model named; units explicit. | Straps, braids, returns | [R3] |
| FR-EOP-03 | MUST | **Skin depth and AC resistance**: δ = √(ρ/(π f μ0 μr)); round-wire R_ac/R_dc ≈ r/(2δ) flagged as an approximation unless r/δ ≥ 5. μ0 named. | HF currents, lightning | [R3], [R5] |
| FR-EOP-04 | SHOULD | **Absorption loss** of a conducting sheet: A = 8.686 t/δ dB (absorption term only, stated). | First shield sizing | [R3] |
| FR-EOP-05 | SHOULD | **Magnetic permeability** `relativePermeability` (≥ 1 unless a `diamagnetic` flag; field / frequency condition optional) used by FR-EOP-03. | Steels, magnetic shields | [R3] |
| FR-EOP-06 | MUST | **Bond paths as data**: named path from a point on one part to a point on another, as an ordered list of joints (resistance with source), straps / braids (material record, length, cross-section) and, in V1, modelled parts; `check_bonding` returns the total and each element's share. | "Is it bonded?" | [R6], [R7] |
| FR-EOP-07 | MUST | **Bond limits are sourced rule entries** (value, unit, rule id, citation, `unverified` until confirmed); never defaulted. A path above its limit is FAIL with `reviewRequired` and `disposition: "pending_human"`; acceptance only by `dispose_bond_check` (human gate). | Limits are programme rules | [R6]–[R9], AF-31, AF-34 |
| FR-EOP-08 | MUST | **Optical surface properties**: `absorptivitySolar` (BOL / EOL condition) and `emissivityIr` (hemispherical total or normal; temperature) on coating records; `optical_balance` returns α/ε and the equilibrium temperature of a sun-facing surface for a caller-given solar flux (never defaulted) with 1 or 2 radiating faces. | Thermal-control coatings | [R4], [R11] |
| FR-EOP-09 | COULD | **Refractive index** with wavelength; `normal_reflectance` (Fresnel) and lossless slab transmittance. | Windows, sensors | [R3] |
| FR-EOP-10 | MUST | **Validation of values**: 0 ≤ ε, α, reflectance ≤ 1; ρ > 0; μr > 0 (< 1 only with `diamagnetic`); n ≥ 1; required conditions present (wavelength for n; kind for ε); wrong dimensions refused. | Impossible values are a classic data error | AF-11 |
| FR-EOP-11 | MUST | **PHY-03 link**: a radiation BC or cavity face with `emissivity: 'material'` takes the face's coating `emissivityIr` (or the bulk record's when no coating), with provenance and `unverified` flag; missing value ⇒ `EOP_SURFACE_PROPERTY_MISSING`, never a default. | Radiation needs ε | PHY-03 FR-THM-05 |
| FR-EOP-12 | MUST | **Surface coatings**: assign a coating record to faces (`facesNear`, re-resolved on replay like 05 targets); a face has at most one coating per side. | ε and α are surface properties | 05 TR-FEA-03 |
| FR-EOP-13 | SHOULD (V1) | **Lightning zone annotations** on faces (free-text zone label + source); `check_bonding` warns when a CFRP face in a labelled zone has no bond path. llull ships no zone definitions. | Zones are defined by the programme per ARP5414 | [R10] |
| FR-EOP-14 | MUST | **Readiness check** `check_surface_properties` (AF-20) and stable codes (AF-11) per TECHNICAL_SPEC §7.1. | Agents act on codes | AF-11, AF-20 |
| FR-EOP-15 | MUST | **Agent-first contract**: units on every param and result; formula, inputs and constants in `data` (AF-35); `unverified` propagation (AF-32); `reviewRequired` on bond rows and on any result used for a release decision (AF-33). | AGENT_FIRST | AF-10, AF-32–35 |
| FR-EOP-16 | MUST | No shipped property values or limits; library import follows 08 MAT licence rules (public-domain US-government data allowed after human check). | Data policy | 08 MAT, sources.md |

## 6. Workflows

### 6.1 CLI (operator)

```bash
llull search bonding emissivity resistivity
llull run box_bonding.plan.json --doc b.llull.json --json                 # records, bond paths, check_bonding step
llull check_bonding --doc b.llull.json --json                             # rows: path, total mOhm, limit + source, status
llull electrical_resistance material=strap_61iacs 'length={"value":150,"unit":"mm"}' 'crossSection={"value":10,"unit":"mm^2"}' \
  'frequency={"value":1,"unit":"MHz"}' --doc b.llull.json --json          # R_dc, skin depth, R_ac approx + validity
llull assign_surface_coating entityId=$panel 'facesNear=[[0.25,0.25,0.002]]' coating=white_paint_test --doc r.llull.json
llull optical_balance entityId=$panel 'facesNear=[[0.25,0.25,0.002]]' 'solarFlux={"value":1361,"unit":"W/m^2"}' radiatingFaces=1 --doc r.llull.json --json
llull check_surface_properties --doc r.llull.json --json
```

The agent reports the numbers, every rule and property source, every `unverified` flag, and "needs a qualified engineer"
for any bond row (AF-36).

### 6.2 MCP and UI

MCP: same commands (toolset `analysis`). UI (review only): bond paths drawn as polylines with a mΩ badge per element,
coating colours with α/ε labels, zone labels, disposition dialog.

### 6.3 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| ε = 1.05 | `set_material_property` refused, `EOP_PROPERTY_RANGE` | FR-EOP-10 |
| Refractive index without wavelength | refused, `EOP_CONDITION_MISSING` | FR-EOP-10 |
| Bond path without a limit | `check_bonding` reports the total and `EOP_BOND_LIMIT_MISSING` (warning), no status | FR-EOP-07 |
| CFRP part in a bond path | warning `EOP_CFRP_IN_PATH` | FR-EOP-06 |
| Radiating face without ε | `EOP_SURFACE_PROPERTY_MISSING` (PHY-03 check fails) | FR-EOP-11 |
| `optical_balance` without solar flux | refused, `EOP_SOLAR_FLUX_MISSING` | FR-EOP-08 |

## 7. Acceptance criteria

`D` = `--doc case.llull.json --json`. Values: `validation/expected_results.json`.

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-1 | `plans/eop_bonding_paths.plan.json` | `llull run <plan> D` | `check_bonding` rows: p1 1.723959 mΩ `pass`; p2 3.123959 mΩ `fail` + `EOP_BOND_RESISTANCE_EXCEEDED`; both `reviewRequired: true`, limit `unverified: true` with source | VC-EOP-06 |
| AC-2 | — | `electrical_resistance` 1 m × 1 mm², 100 % IACS, 20 °C and 75 °C (αR test input) | 0.017241 Ω; 0.0209676 Ω | VC-EOP-02 |
| AC-3 | — | skin depth queries | 8.5315 mm (60 Hz), 66.085 µm (1 MHz), 0.79577 mm (μr 100) | VC-EOP-03 |
| AC-4 | `plans/eop_radiator_coating.plan.json` | `optical_balance` step | T = 270.245 K, α/ε = 0.2222 | VC-EOP-08 |
| AC-5 | the invalid values of VC-EOP-10 | `set_material_property` | each refused with its code | VC-EOP-10 |
| AC-6 | PHY-03 radiation BC with `emissivity: 'material'` | `fea_export` / `analysis_report` | deck uses the coating ε; flags propagate | VC-EOP-11 |
| AC-7 | failed path p2 | agent `dispose_bond_check` | `EOP_HUMAN_GATE`, doc unchanged | VC-EOP-12 |

## 8. Standards & regulatory alignment

| Reference | Use | Status |
| --------- | --- | ------ |
| MIL-STD-464C, NASA-STD-4003A, SAE ARP1870 [R6]–[R9] | bond classes and limits as customer rule entries | paywalled / blocked; 2.5 mΩ grade B |
| SAE ARP5414 / ARP5412 [R10] | zone labels only | catalogue; no content used |
| NASA RP-1121 [R11] | candidate public-domain coating data | values not extracted |

## 9. KPIs

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Analytic agreement | queries equal the generator to 1e-9 | unit tests |
| Silent values | 0 defaulted limits, fluxes or emissivities | VC-EOP-06, 08, 11 |
| Invalid data caught | 100 % of VC-EOP-10 refused | unit tests |

## 10. Risks & assumptions

| Risk | Impact | Mitigation |
| ---- | ------ | ---------- |
| Owners take the 2.5 mΩ figure as law | Over- or under-design | Rule entry with source and `unverified`; MIL-STD-464C's own caveat quoted in the rule note |
| Joint resistances are measured, not computed | Path total only as good as inputs | Each joint needs a source (measurement report or rule) |
| α degrades in orbit (EOL) | Hot radiators | BOL/EOL condition mandatory on α; V1 selection |
| New variables / condition fields need PHY-01 changes | Rework | Requested explicitly in TECHNICAL §3.1 (`wavelength`, `frequency`, `opticalKind`, `lifeState`) |

## 11. References

- [R1] Copper Development Association, Copper Design Guide (electrical) — https://copper.org/applications/industrial/DesignGuide/props/electrical.php (accessed 2026-10, search)
- [R2] IACS definitions (secondary) — https://viox.com/conductivity-vs-resistivity-iacs/ (accessed 2026-10, search)
- [R3] Classical electromagnetics / optics — derivations in `validation/generate_eop_reference.py`
- [R4] Lienhard & Lienhard, A Heat Transfer Textbook 6th ed. — https://ahtt.mit.edu/ (accessed 2026-10, search)
- [R5] BIPM SI Brochure — https://www.bipm.org/en/publications/si-brochure (accessed 2026-10, search)
- [R6] InCompliance, The Origin and Application of the 2.5 mΩ Requirement — https://incompliancemag.com/?p=35487 (accessed 2026-10, search)
- [R7] SAE ARP1870 — https://saemobilus.sae.org/content/arp1870 (accessed 2026-10, catalogue)
- [R8] Advanced Energy AN109 (MIL-STD-464C bond classes) — https://www.advancedenergy.com/getattachment/340ed036-3ded-432b-bc46-ef8dfe32d732/AN109.pdf (accessed 2026-10, search)
- [R9] NASA-STD-4003A — https://standards.nasa.gov/node/239 (accessed 2026-10, search)
- [R10] FAA AC 20-155 (ARP5414A reference); SAE ARP5412C — https://www.faa.gov/sites/faa.gov/files/AC20-155.pdf ; https://webstore.ansi.org/standards/sae/saearp5412c2024 (accessed 2026-10, search)
- [R11] Henninger, NASA RP-1121 (1984) — https://ntrs.nasa.gov/citations/19840015630 (accessed 2026-10, search)
- [R12] CalculiX — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10)
