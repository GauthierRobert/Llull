# PHY-14 — Moisture, outgassing & space environment — Functional spec

Gap id **ENV** · Status: specification (no implementation) · Written 2026-10-15
Companion: [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Sources: [validation/sources.md](validation/sources.md) · Gap list: [../README.md](../README.md) (PHY-14, P3)

---

## 1. Summary

Spacecraft and many aircraft parts are chosen as much for how they behave in their environment as for their
strength. In vacuum, polymers, adhesives and composites lose mass (water and volatiles) and the condensable
part can deposit on optics and radiators; NASA and ESA screen every such material with a 24 h, 125 °C vacuum
test (ASTM E595 / ECSS-Q-ST-70-02) against limits of about 1 % mass loss and 0.1 % condensables [R1][R3][R5].
On the ground, the same materials absorb moisture, swell, and lose matrix-dominated properties; moisture uptake
follows Fickian diffusion (Shen & Springer 1976) [R8]. In low Earth orbit, atomic oxygen erodes polymers such
as Kapton at about 3.0 × 10⁻²⁴ cm³ per incident atom [R9][R10].

After the aerospace packs, llull has none of this: 08 MAT records carry no outgassing data, and 06 CMP only
plans hygrothermal (CTE/CME) loads for laminates in V2. This gap adds the **properties** (TML, CVCM, WVR,
moisture diffusivity, saturation, moisture expansion, atomic-oxygen erosion yield) as additions to the 08
record; **mission environment** data (outgassing profile, humidity exposure, atomic-oxygen fluence); three
read-only **calculations** (`moisture_uptake`, `hygro_strain`, `ao_erosion`); and the check command
`check_space_environment` that screens every material in use. Moisture *loads* stay with 06 CMP (laminates)
and PHY-04 (thermo-mechanical): PHY-14 hands them a moisture state and never applies loads itself.

## 2. Aerospace context & value

- **Outgassing screening.** ASTM E595 measures total mass loss (TML) and collected volatile condensable
  materials (CVCM) at 125 °C, < 7 × 10⁻³ Pa, 24 h, with condensables collected at 25 °C; water vapour regained
  (WVR) is optional [R1]. The 1.0 % TML / 0.10 % CVCM screening limits come from NASA GSFC and are used by the
  NASA outgassing database (thousands of materials) [R2][R3]; a GSFC preferred practice approves only materials
  below these limits "unless application considerations dictate otherwise" [R4]. ECSS-Q-ST-70-02C adds 24 h
  preconditioning at 22 °C / 55 % RH and judges on **recovered** mass loss RML (TML minus regained water):
  RML < 1.00 %, CVCM < 0.10 % [R5][R6]. The two profiles can disagree on the same material (a wet but clean
  material fails NASA TML and passes ECSS RML, VC-ENV-06.2).
- **Data.** NASA's outgassing compilation is published on data.nasa.gov as a public dataset (mirror licence
  tag `us-pd`) with TML, CVCM and WVR per tested sample [R3]. llull can import it as a library (08 storage),
  keeping the sample identity as provenance.
- **Moisture.** Moisture changes dimensions (hygroscopic strain = β × ΔM) and matrix properties; uptake time
  constants scale with thickness² / diffusivity, so a thin skin saturates in days and a thick fitting in years
  [R8][R12]. Today this is spreadsheet work.
- **Atomic oxygen.** Kapton H's erosion yield (3.0 × 10⁻²⁴ cm³/atom, first measured on STS-8) is the reference
  used to express fluence in flight experiments; recession = Ey × fluence [R9][R10]. MISSE 2 flew 41 polymers
  for nearly four years to measure yields [R11].
- **Who does it today.** Contamination and materials engineers with the NASA database website, ECSS lists and
  spreadsheets; nothing links the materials list to the CAD model's parts and masses.

## 3. Personas & user stories

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent (`llull` CLI; MCP) | `set_mission_environment`, `check_space_environment`, `moisture_uptake`, `hygro_strain`, `ao_erosion` | JSON verdicts per material and part with sources and codes |
| **Owner** | Not assumed to be an engineer (e.g. a cubesat team) | Natural language | "Will these materials pass outgassing? How long until this part is saturated?" |
| **Qualified reviewer** | Spacecraft materials & processes / contamination engineer | Desktop review; materials approval | Approves materials list and deviations (human gate) |

- **US-1.** The agent sets `outgassingProfile=nasa_gsfc_screening` and runs `check_space_environment`: one
  material lacks data (`ENV_OUTGASSING_DATA_MISSING`), one fails CVCM, the rest pass; the panel's screening
  mass-loss budget is 1.9 g on a 200 g part.
- **US-2.** "How long until this 2 mm laminate is half saturated?" `moisture_uptake` returns τ₅₀ =
  0.0491827 and, for the given D, 2.28 days (synthetic D, VC-ENV-04).
- **US-3.** The agent hands the moisture state to 06 V2 / PHY-04 through `hygro_strain` (strain and equivalent
  ΔT for an isotropic adhesive); for an orthotropic lamina with different β/α ratios it gets
  `ENV_EQUIVALENT_TEMPERATURE_INVALID` and uses the 06 V2 laminate path instead.
- **US-4.** For a LEO mission with a fluence from the mission analysis, `ao_erosion` gives the Kapton recession
  depth (30 µm at 10²¹ atoms/cm²).
- **US-5 (reviewer).** The M&P engineer reviews the check output and approves deviations (human gate).

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | Properties TML, CVCM, WVR, RML (derived) on 08 records with test method; limit profiles (NASA GSFC, ECSS, custom); `set_mission_environment`; `check_space_environment` outgassing section; mass-loss budget; codes |
| **V1** | `moisture_uptake` (Fick plane sheet, one or two faces, absorption and desorption); D(T) and Mm(RH) through PHY-01 property models; `hygro_strain` and moisture-state hand-off to PHY-04 / 06 V2; `ao_erosion` with fluence input; NASA outgassing CSV import into a library |
| **V2** | UV / ionising-dose property limits and checks; moisture in 2D/3D (FE diffusion through CalculiX heat-transfer analogy, PHY-03); contamination view-factor budgets (out of scope until PHY-03) |

**Out of scope.** Computing atomic-oxygen fluence from an orbit (mission analysis input), molecular
contamination transport, moisture-dependent strength knock-downs (they are property models of PHY-01 / 06
allowables), laminate hygrothermal loads (06 V2).

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-ENV-01 | MUST | New 08 property names `TML`, `CVCM`, `WVR` (%, with `testMethod: 'ASTM_E595' \| 'ECSS_Q_ST_70_02'`, optional sample id and test date in provenance) and optional measured `RML`; when `RML` is absent it is derived as TML − WVR and labelled derived. | Outgassing data belongs on the material | R1, R5; VC-ENV-06 |
| FR-ENV-02 | MUST | Outgassing limit profiles are data (quantity, operator, value, source): `nasa_gsfc_screening` (TML ≤ 1.0 %, CVCM ≤ 0.10 %), `ecss_q_st_70_02` (RML < 1.00 %, CVCM < 0.10 %), and custom program profiles. | AF-30; programs tailor limits | R3, R4, R6; VC-ENV-06 |
| FR-ENV-03 | MUST | `check_space_environment` screens every material assigned to the selected parts against the mission profile and reports pass / fail per limit with the values used; data measured with a different test method than the profile assumes gives `ENV_TEST_METHOD_MISMATCH` (warning). | Agent proves its work | VC-ENV-06 |
| FR-ENV-04 | SHOULD | Screening mass-loss budget per part and in total: TML × part mass and CVCM × part mass (mass from `mass_properties`), labelled "screening quantity, not a contamination prediction". | Owners ask "how much will it lose?" | VC-ENV-07 |
| FR-ENV-05 | MUST | A material in use without the data a profile needs ⇒ `ENV_OUTGASSING_DATA_MISSING`, status unknown, never pass. | Silence ≠ pass | VC-ENV-11 |
| FR-ENV-06 | MUST | `moisture_uptake` (read-only) computes the Fickian fractional uptake G(t) for a plate of thickness h exposed on both faces (or one face, the other sealed), absorption or desorption, the moisture content M(t) = Mi + G (Mm − Mi), and the times to requested fractions (e.g. 50 %, 90 %, 99 %). | Time to saturation drives test conditioning and design | R8; VC-ENV-01…04, VC-ENV-16 |
| FR-ENV-07 | SHOULD | Diffusivity D(T) and saturation Mm(RH, T) are 08 properties, evaluated through PHY-01 property models (e.g. Arrhenius D, power law Mm = a·RH^b); out-of-range evaluation refused with PHY-01 `PROP_OUT_OF_RANGE`. | Properties at the operating point | R8; VC-ENV-04 |
| FR-ENV-08 | SHOULD | `hygro_strain` returns ε = β ΔM and, for an isotropic material (or orthotropic with equal βᵢ/αᵢ), the equivalent temperature change ΔT_eq = ε/α so PHY-04 can apply it as a thermal strain; otherwise `ENV_EQUIVALENT_TEMPERATURE_INVALID`. Laminate hygrothermal loads are 06 V2's; PHY-14 provides only the moisture state and β. | No duplicate of 06 V2 | R12, R13; VC-ENV-05, 13 |
| FR-ENV-09 | MUST | The mission environment (outgassing profile, humidity exposure, AO fluence) is explicit (`set_mission_environment`); no profile ⇒ `ENV_PROFILE_UNSET`. | AF-31 | VC-ENV-12 |
| FR-ENV-10 | SHOULD | `ao_erosion` returns recession depth Ey × F and, with density and exposed area, mass loss ρ A Ey F; Ey is an 08 property (`aoErosionYield`, cm³/atom) with source; the fluence is an input with its source (mission analysis), never computed by llull. | LEO polymers | R9, R10; VC-ENV-08…10 |
| FR-ENV-11 | COULD | UV and ionising-dose limits per material (`radiationDoseLimit`, `uvExposureLimit`) checked against mission totals. | Thermal-control coatings, optics | V2 |
| FR-ENV-12 | MUST | `check_space_environment` (AF-20) returns items for outgassing, moisture state (when exposure given), AO (when fluence given), with code, values, rule source, `unverified`, `reviewRequired: true`. | AF-20, AF-33 | VC-ENV-06, 11, 12 |
| FR-ENV-13 | MUST | `unverified` propagates (synthetic, typical or secondary values); approving a material that fails a profile, or a deviation, is a human gate (09 signature). | AF-32/34 | VC-ENV-14 |
| FR-ENV-14 | MUST | Stable `ENV_*` codes with ids and remediation (TECHNICAL_SPEC §7.1). | AF-11 | VC-ENV-11…13 |
| FR-ENV-15 | SHOULD | Import of the NASA outgassing CSV (user-provided file) as an 08 library: one record per sample with TML/CVCM/WVR, sample id, and the dataset version as provenance; licence flag from the dataset metadata (`us-pd` per mirror, confirm, OQ-ENV-03). | Thousands of materials | R3; VC-ENV-15 |
| FR-ENV-16 | MUST | Named defaults only for numerics (series truncation 1e-17 per term), never for limits or environment data. | AF-31 | VC-ENV-03 |

## 6. Workflows

### 6.1 CLI

```bash
llull search outgassing moisture ; llull describe check_space_environment moisture_uptake
llull set_material_property '{"material":"adhesive_x","property":"TML","value":0.95,"unit":"%","basis":"company","testMethod":"ASTM_E595","source":{"citation":"NASA outgassing data, sample …"}}' --doc sc.llull.json
llull set_mission_environment '{"outgassingProfile":"nasa_gsfc_screening","aoFluence":{"value":1e21,"unit":"atoms/cm^2","source":"mission analysis rev B"}}' --doc sc.llull.json
llull check_space_environment --doc sc.llull.json --json --save out/space_env.csv
llull moisture_uptake '{"thickness":{"value":2,"unit":"mm"},"diffusivity":{"value":1e-6,"unit":"mm^2/s"},"saturation":{"value":1.5,"unit":"%"},"exposure":{"value":7,"unit":"d"},"faces":"both","targets":[0.5,0.9]}' --json
llull ao_erosion '{"material":"kapton_h","fluence":{"value":1e21,"unit":"atoms/cm^2"}}' --doc sc.llull.json --json
```

### 6.2 MCP

Toolset `environment` (read-only queries plus `set_mission_environment`).

### 6.3 UI (review)

Materials table with outgassing status per profile, part mass-loss budget, uptake curve drawn from
`moisture_uptake` samples (AF-21: the numbers are in `data.curve`).

## 7. Acceptance criteria

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-1 | plate both faces | `llull moisture_uptake … targets=[0.5,0.9,0.99]` | τ = 0.0491826848809, 0.212021352012, 0.445321998467 | VC-ENV-01 |
| AC-2 | h 2 mm, D 1e-6 mm²/s, Mm 1.5 %, 7 d | same | M = 1.22660470969 %, t₅₀ = 2.27697615189 d | VC-ENV-04 |
| AC-3 | four synthetic materials | `check_space_environment` with each profile | syn_water fails NASA (TML) but passes ECSS; syn_edge passes NASA (≤) but fails ECSS (<) | VC-ENV-06 |
| AC-4 | 200 g part in syn_low | `check_space_environment D` | `maxMassLossG` 1.9, `maxCondensableG` 0.1 | VC-ENV-07 |
| AC-5 | Kapton H, F = 10²¹ | `ao_erosion` | recession 30.0 µm | VC-ENV-08 |
| AC-6 | material without TML | `check_space_environment D` | `ENV_OUTGASSING_DATA_MISSING` | VC-ENV-11 |
| AC-7 | no profile | same | `ENV_PROFILE_UNSET`, exit 1 | VC-ENV-12 |

## 8. Standards & regulatory alignment

- ASTM E595 (test method) [R1]; NASA GSFC screening limits and outgassing database [R2][R3]; GSFC PD-1410 [R4];
  NASA-STD-6016 "thermal vacuum stability" wording (secondary) [R7].
- ECSS-Q-ST-70-02C (test and RML/CVCM acceptance) [R5][R6].
- Atomic oxygen erosion yield background per ECSS / SPENVIS [R10].
- 06 CMP V2 owns laminate hygrothermal loads [R13]; PHY-04 owns thermal-strain coupling.

## 9. KPIs

| KPI | Target |
| --- | ------ |
| Fick uptake vs analytic series | rel 1e-9 |
| Materials reported "pass" without data | 0 |
| Limits used without source | 0 |
| `check_space_environment` on 500 parts / 100 materials | ≤ 500 ms |

## 10. Risks & assumptions

| Risk | Mitigation |
| ---- | ---------- |
| Screening results read as a contamination analysis | Labels in data and summary; budget named "screening" |
| Operator `<` vs `≤` differs between sources | Operator stored per profile with its source (OQ-ENV-01) |
| Database rows are per sample/lot, not per generic material | Provenance keeps sample id and date; several rows per material allowed (08 multi-source) |
| Fick model misused for non-Fickian materials | Model named in data; `ENV_MODEL_ASSUMPTION` info item |
| Assumption | 08 records, PHY-01 property models, 06 V2 and PHY-04 for loads |

## 11. References

- [R1] ASTM E595 abstracts — ANSI webstore — https://webstore.ansi.org/standards/astm/astme59507 (accessed 2026-10)
- [R2] Outgassing database capability — NASA GSFC — https://etd.gsfc.nasa.gov/capabilities/outgassing-database (accessed 2026-10)
- [R3] Spacecraft Material Outgassing Data — NASA (data.nasa.gov; outgassing.nasa.gov) — https://data.nasa.gov/dataset/spacecraft-material-outgassing-data ; https://outgassing.nasa.gov/index.php/node/7 (accessed 2026-10)
- [R4] Preferred practice PD-1410 — NASA GSFC (KSC repository) — https://extapps.ksc.nasa.gov/Reliability/Documents/Preferred_Practices/1410.pdf (accessed 2026-10)
- [R5] ECSS-Q-ST-70-02C — ECSS — https://ecss.nl/standard/ecss-q-st-70-02c-thermal-vacuum-outgassing-test-for-the-screening-of-space-materials/ (accessed 2026-10)
- [R6] Micro-VCM test facility — DLR — https://www.dlr.de/en/irs/research-transfer/research-infrastructure/micro-vcm-test-facility ; test-lab report — https://www.terahertz.co.uk/images/tki/RAM/dmav17018.pdf (accessed 2026-10)
- [R7] Kapton tape and NASA outgassing (NASA-STD-6016C wording) — Dunmore — https://www.dunmore.com/resources/kapton-tape-nasa-outgassing (accessed 2026-10; secondary)
- [R8] Shen & Springer 1976 — Univ. Michigan Deep Blue — https://deepblue.lib.umich.edu/items/ef002329-b88d-4e97-a1bf-efd23ad2164f (accessed 2026-10)
- [R9] Kapton erosion yield history — JAXA repository — https://jaxa.repo.nii.ac.jp/record/2892/files/AA1830019009.pdf (accessed 2026-10)
- [R10] Atomic oxygen erosion — SPENVIS — https://spenvis.oma.be/help/background/atmosphere/erosion.html (accessed 2026-10)
- [R11] MISSE 2 PEACE polymers, NASA TM-2008-215490 — NASA NTRS — https://ntrs.nasa.gov/citations/20090011780 (accessed 2026-10)
- [R12] Hygrothermal strains in a lamina (Kaw, section 2.9) — https://composites.autarkaw.com/2025/11/14/quiz-section-2-9-hygrothermal-stresses-and-strains-in-a-lamina/ (accessed 2026-10)
- [R13] 06 CMP FUNCTIONAL_SPEC §4 (V2 hygrothermal loads) — llull — `../../aerospace/06-composites/FUNCTIONAL_SPEC.md`
