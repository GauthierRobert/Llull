# PHY-07: Fatigue (crack initiation) — functional specification

Gap id **FAT** · status: specification · written 2026-10-15 · technical spec: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

Citations `[Rn]` in this pack use the same numbers as the register ids `Sn` in `validation/sources.md` (R5 ≡ S5).

## 1. Summary

After the aerospace packs, llull can compute a static stress field and a margin of safety (aerospace 05 FEA), but it
cannot say **how long** a part lasts under repeated loads. There are no S-N or strain-life (ε-N) curves on the
material, no way to turn a load history into cycles (rainflow), no notch or mean-stress correction and no damage sum.
05 FEA only lists a V2 hook, "fatigue and damage tolerance hooks (stress spectra export)", which this pack replaces.
The only fatigue code in the repository is the EN 1993-1-9 crane-runway check in the AEC plugin
(`packages/domain-aec/src/industrial/runway/runwayBeamCheck.ts`, detail category 71 / 160 / 36, `FATIGUE_PHI = 1.05`):
steel-building specific, nominal-stress only, not reusable for airframe parts.

Fatigue is a certification item. 14 CFR 25.571 requires an evaluation showing that catastrophic failure due to fatigue
(among other threats) is avoided throughout the operational life of the airplane [R12], and its advisory material
AC 25.571-1D gives the acceptable means of compliance [R13]. Most in-service structural failures start as fatigue cracks.
A design tool that cannot give a first fatigue life for a lug, a fitting or a skin cut-out, with the inputs traced, does
not support an aerospace design loop.

This pack closes the **crack-initiation** half of durability (PHY-08 covers crack growth and damage tolerance):

1. **Material fatigue data as material models** (S-N, ε-N, cyclic stress-strain), owned by PHY-02 and stored in the
   08 MAT record, licensed data kept in 08's private libraries.
2. **Load histories and cycle counting** (ASTM E1049 rainflow [R1]) as document data and read-only queries.
3. **Life prediction** at FE hot spots from 05 results or at a hand-defined notch: stress-life with mean-stress
   correction, strain-life with Neuber's rule, Palmgren-Miner damage, and a **fatigue margin** that uses an explicit,
   named scatter factor, flags every result `reviewRequired`, and leaves negative or marginal results to a human.

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Transport-category certification | 14 CFR 25.571 requires a damage-tolerance and fatigue evaluation for structure whose failure could be catastrophic (wing, empennage, fuselage, landing gear …). AC 25.571-1D (13 Jan 2011) is the FAA guidance, covering also widespread fatigue damage (WFD) and the limit of validity | A first fatigue life per hot spot inside the design loop, with every input and factor traced, ready for the stress office | [R12], [R13], [R22] |
| Safe-life parts | CS 25.571 requires "appropriate safe-life scatter factors" and limits replacement times to test life divided by the applicable scatter factor until testing is complete | The scatter factor is an explicit, named input of every fatigue margin; llull never defaults it silently | [R14] |
| Spaceflight hardware | NASA fracture control (NASA-STD-5019) uses a life factor on service life; a value of 4 is quoted by secondary sources (not confirmed in the standard text from this session) | Programme profile `nasa_std_5019` with the factor marked unconfirmed until a human checks the standard | [R21] |
| Durability toolchains | Commercial tools (nCode DesignLife, FEMFAT, fe-safe) post-process FE results with S-N / ε-N, Morrow / SWT / Walker corrections and rainflow; open libraries (pyLife, ffpack, rainflow, py-fatigue, reliability) implement the same methods | The same methods as registry commands the CLI agent can run, checked against the open libraries' published results | [R2]–[R8] |
| Machine-building guidance | The FKM guideline (VDMA, 7th ed. 2020) covers static and fatigue assessment of base material and welds from FE stresses | Scope reference only (paid). FKM-style checks are a V2 option | [R15] |
| Standard load spectra | TWIST / Mini-TWIST (transport wing) and FALSTAFF (fighter) are standardised sequences (FALSTAFF: LBF, NLR, IABG, 1976); ESDU 97018 includes them | Import of a user-supplied spectrum file. llull ships no sequence (not freely available from this session) | [R16] |

**Value statements** (sourced only):

- Fatigue evaluation is a regulatory requirement [R12]; doing a first evaluation where the geometry is designed removes the
  hand transcription of stresses into a separate durability tool for each design iteration. KPIs in §9 measure that.
- Rainflow counting is standardised (ASTM E1049 [R1]) and reproducible: two open implementations agree on the standard's
  worked example [R2], [R3], so llull can prove its counter on the same data.

## 3. Personas & user stories

Roles follow [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) §1. Fatigue results feed certification
and inspection decisions, so this is a **high-risk** area like 05 margins: every life and margin is
`reviewRequired`, every factor is named (AF-31), and accepting a short life is a human act (AF-34).

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent via the `llull` CLI (cloud agent via MCP) | `llull count_cycles`, `llull fatigue_life`, `llull compute_fatigue`, `llull check_fatigue --json` | Deterministic commands with units in every param, stable codes, JSON it can compare to `expected_results.json` |
| **Owner** | Person who asks for the result. **Not assumed to be an engineer** | Natural language | "Will this bracket last 60 000 flights?" answered plainly: what was computed, which inputs are unverified, what needs a qualified engineer |
| **Qualified reviewer** | Fatigue / damage-tolerance engineer, DOA signatory, DER | Desktop review surfaces, exported spectra and reports | Audits curves, spectra, factors; dispositions short-life results with a human-held signature |

User stories:

- **US-1 (owner → operator).** "How long will this lug last under this load history?" The agent assigns a material whose
  08 record carries an S-N model (PHY-02), runs the 05 static unit-load case, defines the load history, runs
  `compute_fatigue`, and reports life, damage and margin per hot spot with the curve source, mean-stress model, notch
  factor and scatter factor, each with `source` and `defaulted`, plus "computed by llull, not approved".
- **US-2 (operator).** The agent counts a measured strain-gauge history with `count_cycles` and gets the same counts as
  ASTM E1049's example on the standard's sequence (VC-FAT-01), so it can trust the counter before using it.
- **US-3 (operator).** For a notch without FE, the agent calls `fatigue_life` with Kt, a notch-sensitivity model and a
  strain-life model, and gets the Neuber local stress and strain and the life (VC-FAT-20…22).
- **US-4 (operator).** When the scatter factor is not given and the programme profile has no confirmed value, the agent
  gets `FAT_SCATTER_FACTOR_UNSET` and must ask the owner; llull never picks one.
- **US-5 (operator).** A negative fatigue margin returns `FAT_LIFE_SHORT`; the agent proposes changes (radius, thickness,
  material) and re-runs; only the reviewer can accept the result (`dispose_fatigue_result`, human gate).
- **US-6 (operator → reviewer).** The agent exports the local stress spectrum per hot spot (`export_stress_spectrum
  --save`) for the stress office's own durability tool, the hook 05 V2 promised.
- **US-7 (all).** A parameter change after the run makes the fatigue results `stale`; `compute_fatigue` refuses until
  05 results are refreshed.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP (M1–M3)** | Fatigue material models on the 08 record (names and fields owned by PHY-02, §5): Basquin S-N, S-N power law with knee, tabulated S-N per R, Coffin-Manson-Basquin ε-N, cyclic Ramberg-Osgood. Load histories (time series, block spectra, rainflow matrices) as document data. Rainflow: E1049 three-point, four-point, repeating history; residue as half cycles. Stress-life with Goodman / Gerber / Soderberg / Morrow / SWT / Walker; strain-life with Morrow / SWT; Neuber rule with Masing; Kf from Kt and q (Peterson, Neuber forms with user constants). Palmgren-Miner damage. Uniaxial stress from 05 results: signed von Mises or max-principal per hot spot, linear superposition of unit load cases. Fatigue margin with explicit scatter factor, `reviewRequired`, human disposition, `check_fatigue`. Spectrum export (CSV). |
| **V1 (M4–M5)** | Multiple load cases combined per time step (superposition of n unit cases), surface finish / size / reliability factors as explicit named modifiers, MMPDS-style equivalent-stress S-N fits, constant-life (Haigh) diagram tables, nonlinear damage rules (Haibach / elementary Miner variants as named options), sequence import (CSV / ASCII) for TWIST/FALSTAFF-type spectra supplied by the user, PHY-09 random response → stress PSD → spectral fatigue (Dirlik, COULD). |
| **V2** | Multiaxial critical-plane (Findley, Brown-Miller, Fatemi-Socie) on proportional and non-proportional histories, FKM-guideline-style check sets (if licensed text is available), welded joints (hot-spot / notch stress, IIW), thermo-mechanical fatigue with PHY-03/04. |
| **Out of scope** | Crack growth, inspection intervals, residual strength (PHY-08). Computing S-N allowables from raw coupon data (08 MAT V3 / PHY-18). Composite fatigue. Certification sign-off. Shipping licensed curves (MMPDS, NIMS) or standard spectra. |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-FAT-01 | MUST | **S-N curves as material data.** The 08 record holds stress-life models through PHY-02 `materialModels`: `sn_basquin` (σ'f, b, optional endurance amplitude and knee), `sn_power_law` (k, N_D, S_D, optional k2), `sn_table` (S, N points, one table per stress ratio R or mean stress). Each carries test conditions (R, Kt of the specimen, surface, environment, temperature), the probability level (mean / P90 / design), runout handling and provenance. PHY-07 defines no material storage of its own. | Life must use traceable data; one material model for the document | [R5], [R8], 08 MAT, README §6.2 |
| FR-FAT-02 | MUST | **Strain-life models** `en_coffin_manson` (σ'f, b, ε'f, c, E) plus `cyclic_ramberg_osgood` (K', n'), owned by PHY-02. Life solve: εa = σ'f/E (2N)^b + ε'f (2N)^c by Newton on log(2N), returning the transition life. | Low-cycle fatigue at notches and lugs | [R6], [R7] |
| FR-FAT-03 | MUST | **Notch effects**: Kf = 1 + q(Kt − 1) with q from Peterson 1/(1 + a/r) or Neuber 1/(1 + √(ρ'/r)); the material constant a or ρ' is an explicit input with source (no built-in constants). Local stress-strain by Neuber's rule σε = (Kf S)²/E on the cyclic Ramberg-Osgood curve, hysteresis by Masing (doubled curve). FE hot-spot stresses are used as local elastic stresses (Kt already in the FE result) unless the user states otherwise. | Notches dominate initiation; the constants are material- and source-specific | [R5], [R8], [R9] |
| FR-FAT-04 | MUST | **Mean-stress correction** selectable per case: Goodman, Gerber, Soderberg (stress-life), Morrow, SWT, Walker (γ explicit). Compressive mean stress gives no benefit by named default (`compressiveMean: "no_benefit"`, source: llull conservative rule) unless the user selects the raw formula. | Mean stress changes life strongly in HCF | [R6], [R7], [R10] |
| FR-FAT-05 | MUST | **Cycle counting** as a read-only query: rainflow three-point (E1049 §5.4.4), four-point, repeating history (§5.4.5); peak-valley extraction with optional hysteresis gate; residue as half cycles (E1049) or closed by repetition; output cycles (from, to, range, mean, count) and aggregated or binned totals. | ASTM E1049 is the reference practice | [R1]–[R4] |
| FR-FAT-06 | MUST | **Damage accumulation**: Palmgren-Miner D = Σ nᵢ/Nᵢ with the damage limit as an explicit, named input (no default other than D = 1 with `defaulted: true` and the source "Miner rule"); cycles below an endurance limit are counted as zero damage only if the curve declares one. | Spectrum loading | [R11], [R8] |
| FR-FAT-07 | MUST | **Stress from 05 FEA**: a fatigue case maps 05 load cases (unit or limit) to load histories with scale factors; the local stress history at each node is the linear superposition. Stress measure per case: signed von Mises (sign of the largest-magnitude principal), max principal, or a component; the measure is named in every row. | Fatigue uses the static FE field the agent already has | aerospace 05 FR-FEA-13/17 |
| FR-FAT-08 | MUST | **Fatigue margin**: life margin = N_pred / (SF × N_required) − 1, where SF is the scatter (life) factor and N_required is the required life with its unit (cycles, blocks, flights). Rows give hot spot, location, stress measure, cycles, damage, life, margin, status `PASS` / `MARGINAL` / `FAIL`, provenance. | Certification practice divides life by a scatter factor | [R14], [R13] |
| FR-FAT-09 | MUST | **Named safety values (AF-31)**: scatter factor, damage limit, curve probability level, mean-stress model, notch constants and modifiers are explicit or taken from a sourced default named in the result. **There is no built-in aviation scatter factor** (AC 25.571-1D values not confirmed from this session, OQ-FAT-01): unset → `FAT_SCATTER_FACTOR_UNSET` (error). A programme profile may supply one (e.g. `nasa_std_5019`, value 4, `sourceStatus: "unconfirmed"`), which marks the result `unverified`. | No silent safety value | AF-31, [R21] |
| FR-FAT-10 | MUST | **Review flag (AF-33)**: every fatigue result row and summary carries `reviewRequired: true` with a reason and the sentence "computed by llull, not approved — needs a qualified engineer". | Fatigue lives feed certification | AF-33 |
| FR-FAT-11 | MUST | **Human disposition (AF-34)**: `FAIL` and `MARGINAL` rows stay `pending_human`; only `dispose_fatigue_result` with a human-held signature (09 PLM `humanSignatureRequired`, AF-34a) records acceptance; an agent gets `FAT_HUMAN_GATE` and the document is unchanged. | Accepting a short life is an approval act | AF-34, 09 PLM |
| FR-FAT-12 | MUST | **Unverified propagation (AF-32)**: a curve with basis `typical`, `supplier_unstated`, `unspecified` or legacy provenance, an unconfirmed profile factor, or an `unverified` 05 input marks every derived row `unverified` with reasons; `check_fatigue` warns `FAT_CURVE_UNVERIFIED` (not suppressible). | Typical curves are not design curves | AF-32, 08 TR-MAT-50 |
| FR-FAT-13 | MUST | **Staleness**: fatigue results record the 05 `resultsHash`, the history hashes and the material model ids; any change makes them `stale` and `compute_fatigue` refuses (`FAT_RESULTS_STALE`). | Results must match the revision | 05 FR-FEA-22 |
| FR-FAT-14 | MUST | **Readiness check (AF-20)**: `check_fatigue` returns pass / warn / fail items with stable codes over curves (missing, out of range, wrong R, unverified), histories (empty, units), mapping to 05 load cases, extrapolation beyond the curve's tested life range, factors, results (stale, short life, pending disposition). | The agent proves its own work | AF-20 |
| FR-FAT-15 | MUST | **Extrapolation guard**: a life outside the curve's tested range (below the lowest or above the highest N of the data, or a stress above the static strength) is reported with `extrapolated: true` and `FAT_CURVE_EXTRAPOLATED`; stress amplitudes above Ftu return `FAT_STATIC_FAILURE` instead of a life. | Fits are not valid outside their data | PHY-01 extrapolation rule |
| FR-FAT-16 | MUST | **Stable error codes (AF-11)** and **units (AF-04, AF-10)**: every param with a quantity states its unit; every number in `data` carries a unit suffix; codes from TECHNICAL_SPEC §7.1. | Agents act on codes | AF-04/10/11 |
| FR-FAT-17 | SHOULD | **Spectrum export** (replaces 05 V2 hook): local stress history or rainflow matrix per hot spot as CSV / JSON with units, written only with `--save`. | Hand-off to the stress office's tool | 05 §4 V2 |
| FR-FAT-18 | SHOULD | **Numeric equivalents of plots (AF-21)**: S-N / ε-N curve samples, Haigh diagram points, rainflow matrix and damage per bin returned as data; UI plots are optional views. | Agents read numbers | AF-21 |
| FR-FAT-19 | SHOULD | **Load-history import** from CSV (time, value) and from block tables (Smax, Smin, count) with units; user-supplied standard spectra (TWIST, FALSTAFF) are imported, never shipped. | Spectra are customer data | [R16] |
| FR-FAT-20 | SHOULD | **Modifiers**: surface finish, size, reliability, environment factors as explicit multiplicative factors on the endurance strength / curve with mandatory justification. | Coupon curves differ from parts | [R15] |
| FR-FAT-21 | COULD | **Spectral fatigue** from PHY-09 stress PSD (Dirlik or narrow-band). | Random vibration qualification | PHY-09 |
| FR-FAT-22 | COULD | **Multiaxial critical plane** (V2) with the plane search returned as data. | Non-proportional loading at lugs | — |
| FR-FAT-23 | MUST | Every capability is reachable from CLI, MCP and UI through the registry (AF-01), and a whole job fits one `build_project` plan (AF-05). | L1/L5 | AF-01, AF-05 |
| FR-FAT-24 | MUST | **Licensed data**: curves from licensed sources (MMPDS, NIMS, company data) live in 08 private libraries and are never serialised or sent to cloud MCP clients (08 TR-MAT-31/32). | NIMS data sheets forbid redistribution | 08 MAT, README §5.3, [R18] |

## 6. Workflows

### 6.1 CLI (operator's primary path)

```bash
llull search fatigue rainflow                   # discover (AF-01)
llull describe count_cycles fatigue_life compute_fatigue check_fatigue
llull guide                                     # fatigue section: units, factors, minimal plan (AF-03)

# 0. prove the counter on the E1049 example (VC-FAT-01)
llull count_cycles 'history=[-2,1,-3,5,-1,3,-4,4,-2]' method=rainflow_3pt --json

# 1. one plan: geometry + 08 record with fatigue model (PHY-02) + 05 analysis + history + fatigue case
llull run lug.plan.json --validate --doc lug.llull.json
llull run lug.plan.json --doc lug.llull.json --kernel occt --json
llull fea_mesh analysisId=$an --doc lug.llull.json --timeout 300 --json      # aerospace 05 transports
llull fea_solve analysisId=$an --doc lug.llull.json --timeout 900 --json

# 2. fatigue: numbers first (AF-21)
llull compute_fatigue caseId=$fc --doc lug.llull.json --json   # rows[]: hot spot, life, damage, margin, factors, provenance
llull check_fatigue caseId=$fc --doc lug.llull.json --json     # pass/warn/fail with codes (AF-20)

# 3. quick notch check without FE (VC-FAT-20..22)
llull fatigue_life method=strain_life material=mat_test 'notch={"kt":2.41,"q":0.9857}' \
  'nominal={"amplitude":{"value":375,"unit":"MPa"},"mean":{"value":0,"unit":"MPa"}}' meanStress=swt --json

# 4. hand-off and review
llull export_stress_spectrum caseId=$fc hotspot=h1 format=csv --save out/h1_spectrum.csv --doc lug.llull.json
```

`--app` acts on the open desktop window; `--dry-run` works on every mutating command (AF-42). The agent ends every job
with `check_fatigue` and reports, in order (AF-36): what was computed, min life and margin per hot spot, every
`unverified` input and defaulted factor, every row that needs a human, and "computed by llull, not approved".

### 6.2 MCP agent (cloud)

Same registry tools in toolset `durability`. `compute_fatigue` needs 05 result artifacts, so on hosts without them it
returns `FAT_RESULTS_MISSING`; `count_cycles` and `fatigue_life` work everywhere. Private licensed curves are redacted
for cloud clients (FR-FAT-24); the result then says `FAT_CURVE_UNAVAILABLE`.

### 6.3 Desktop UI (review and approval only)

Fatigue table (life, damage, margin, badges `unverified` / `reviewRequired`), hot-spot glyphs on the model, optional
damage contour (from the same data), curve and rainflow-matrix plots, and the **disposition dialog** (human signature).

### 6.4 Surface matrix (FR-FAT-23)

| Capability | CLI | MCP | UI | Notes |
| ---------- | --- | --- | -- | ----- |
| Define histories, cases, factors | `llull run plan.json`, `llull <command>` | registry tools | case tree | pure commands |
| Count cycles / quick life | `llull count_cycles`, `llull fatigue_life` | same | plots | read-only, no FE needed |
| Fatigue at FE hot spots | `llull compute_fatigue` | same (if artifacts) | table, contour | refuses stale 05 results |
| Readiness | `llull check_fatigue` | same | checklist | codes |
| Disposition of short life | prepare only (`FAT_HUMAN_GATE`) | prepare only | **complete** (signature) | human gate |
| Spectrum export | `llull export_stress_spectrum --save` | exchange dir | Export menu | heavy output only via `--save` |

### 6.5 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| Material has no fatigue model of the requested kind | Refused, `FAT_CURVE_MISSING`, names the record | 01, 02 |
| Curve tested at R = −1 used with a mean stress and no mean-stress model selected | Refused, `FAT_MEAN_MODEL_REQUIRED` | 04 |
| Amplitude above Ftu or Neuber stress above the cyclic curve range | `FAT_STATIC_FAILURE` row, no life | 15 |
| Predicted life beyond the curve's tested range | Life reported with `extrapolated: true` and a warning | 15 |
| History with fewer than 2 reversals | `FAT_HISTORY_EMPTY` | 05 |
| 05 results stale or missing | `FAT_RESULTS_STALE` / `FAT_RESULTS_MISSING` | 13 |
| Scatter factor not given and no confirmed profile | `FAT_SCATTER_FACTOR_UNSET` | 09 |

### 6.6 Glossary

| Term | Meaning |
| ---- | ------- |
| Reversal | Half cycle; 2N reversals = N cycles |
| Kt / Kf / q | Elastic stress concentration / fatigue notch factor / notch sensitivity |
| R | Stress ratio Smin / Smax |
| Rainflow | Cycle counting that pairs reversals into closed hysteresis loops (E1049 [R1]) |
| Scatter (life) factor | Divisor on predicted or tested life that covers scatter (CS 25.571 [R14]) |
| Damage D | Miner sum Σ n/N; failure assumed at the damage limit (1 by default, named) |

## 7. Acceptance criteria

`D` = `--doc case.llull.json --json`. Expected values: `validation/expected_results.json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | the E1049 history | `llull count_cycles history=[…] method=rainflow_3pt --json` | `data.totals` = [[3,0.5],[4,1.5],[6,0.5],[8,1],[9,0.5]] | VC-FAT-01 |
| AC-2 | same, `method=rainflow_4pt` / `rainflow_repeating` | same | VC-FAT-02 / VC-FAT-03 values exactly | VC-FAT-02, 03 |
| AC-3 | test S-N model (σ'f 1160 MPa, b −0.081) | `llull fatigue_life method=stress_life amplitude=400MPa` | `data.reversals` = 511 231.091 ± 1e-9 rel | VC-FAT-10 |
| AC-4 | test ε-N model | `fatigue_life method=strain_life strainAmplitude=0.0075` | `data.reversals` = 4414.932 ± 1e-6 rel; `data.transitionReversals` = 10 982.28 | VC-FAT-12, 13 |
| AC-5 | notch Kt 2.41, q 0.9857, S = 375 MPa, SWT | `fatigue_life …` | `data.localStressMaxMPa` = 506.729; `data.cycles` = 2919.91 ± 1e-4 rel | VC-FAT-20…22 |
| AC-6 | σa 200, σm 100 MPa | `fatigue_life … meanStress=<model>` for the six models | `data.equivalentAmplitudeMPa` = VC-FAT-30 per model | VC-FAT-30 |
| AC-7 | E1049 history × 100 MPa, test S-N | `compute_fatigue` on a history-only case | `data.rows[0].damage` = 1.23426e-5; life 81 020 blocks | VC-FAT-40, 41 |
| AC-8 | `plans/fat_plate_hole_spectrum.plan.json` solved | `compute_fatigue` | hot spot at the hole edge; local history = VC-FAT-42 | VC-FAT-42 |
| AC-9 | required 1000 blocks, SF 3 | `compute_fatigue` | `rows[0].margin` = 26.0067; `factors.scatter` = `{value: 3, source: "case input", defaulted: false}` | VC-FAT-50 |
| AC-10 | no scatter factor, no profile | `compute_fatigue` | exit 1, `data.code: "FAT_SCATTER_FACTOR_UNSET"` | VC-FAT-60 |
| AC-11 | a FAIL row | agent `dispose_fatigue_result … decision=accepted` | exit 1, `FAT_HUMAN_GATE`, document hash unchanged | VC-FAT-60 |
| AC-12 | S-N model with basis `typical` | `compute_fatigue`, `check_fatigue` | rows `unverified: true`; warning `FAT_CURVE_UNVERIFIED` | VC-FAT-60 |
| AC-13 | solved case, then `set_parameter` | `compute_fatigue` | exit 1, `FAT_RESULTS_STALE` | VC-FAT-60 |
| AC-14 | any result | `compute_fatigue` | every row `reviewRequired: true`; summary contains "not approved" | VC-FAT-60 |

## 8. Standards & regulatory alignment

| Reference | Use in llull | Status of what is claimed |
| --------- | ------------ | ------------------------- |
| 14 CFR 25.571 [R12] | Context: fatigue / damage-tolerance evaluation is required; llull results are inputs to it | Search-verified (LII / FAA amendment PDF). Paragraph details beyond (a) and (b) not seen |
| FAA AC 25.571-1D (2011) [R13] | Context; scatter-factor guidance location | Catalogue + search; **values not seen** (OQ-FAT-01) |
| EASA CS 25.571 [R14] | Scatter factor concept ("test life divided by the applicable scatter factor") | Search extract of the CS text |
| ASTM E1049-85 (R2017) [R1] | Rainflow, range-pair and simple-range definitions; worked example reproduced | Paid standard. Example values via two open implementations [R2], [R3] |
| FKM guideline 7th ed. [R15] | Scope reference for V2 check sets | Catalogue only |
| NASA-STD-5019 [R21] | Profile `nasa_std_5019` life factor | Standard page seen; factor 4 only from secondary sources (grade C) |
| MMPDS, NIMS fatigue data sheets [R17], [R18] | Licensed curve sources, private libraries only | Catalogue / licence terms |

llull claims no certification credit. Reports carry "pre-sizing; not a certified fatigue analysis".

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Reference cases passing | 100 % of grade-A VC-FAT cases | `npm run quality:physics` (PHY-00 harness) |
| Counter agreement | Identical counts to [R2] and [R3] on their published cases | VC-FAT-01…04 |
| Time to first fatigue table after a solved 05 case | ≤ 2 min agent wall time | agent driver |
| Silent safety values | 0 factors without explicit value or named source | VC-FAT-60 |
| Unflagged results | 0 rows without `reviewRequired`; 0 agent-completed dispositions | VC-FAT-60 |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| No open aerospace S-N / ε-N dataset (README §4) | Users run with typical or unsourced curves | `unverified` propagation, `check_fatigue` warning, private licensed libraries |
| Peterson constant formulas disagree between sources (e.g. [R5] writes a = 0.025 × 2070/Su without exponent) | Wrong Kf | No built-in constant; a or ρ' must be supplied with a source (OQ-FAT-04) |
| Signed von Mises and uniaxial methods are wrong for non-proportional multiaxial loading | Non-conservative life | Proportionality check per hot spot (principal-direction rotation) → `FAT_NONPROPORTIONAL` warning; critical plane in V2 |
| Scatter-factor values unconfirmed | Users want a default | Explicit value required; profiles marked unconfirmed until a human verifies [R13], [R21] |
| Nodal-averaged FE stresses at singularities | Spurious short lives | Reuse 05 singularity exclusion; singular hot spots listed separately |
| Standard spectra not available | Users cannot test with TWIST | Import path only; validation uses E1049 and synthetic histories |

## 11. References

- [R1] ASTM E1049-85(2017) Standard Practices for Cycle Counting in Fatigue Analysis — ASTM — https://doi.org/10.1520/E1049-85R17 (catalogue; accessed 2026-10)
- [R2] rainflow 3.2.0 (Python, MIT) — P. Janiszewski — https://github.com/iamlikeme/rainflow (commit 5fc6822f; accessed 2026-10)
- [R3] FFPACK (Python, GPL-3.0) — D. Zhu — https://github.com/dpzhuX/ffpack (commit b90bdeca; accessed 2026-10)
- [R4] py-fatigue 2.1.1 (GPL-3.0) — https://pypi.org/project/py-fatigue/2.1.1/ (accessed 2026-10)
- [R5] reliability 0.9.0 (LGPL-3.0), PoF module and "Fracture mechanics" docs — M. Reid — https://github.com/MatthewReid854/reliability (commit 86c93307; accessed 2026-10)
- [R6] Strain-life criteria (Coffin-Manson-Basquin, Morrow, SWT) — FunctionBay RecurDyn help — https://dev.functionbay.com/RecurDynOnlineHelp/2023/Durability/Durability_ch03_s04_00_index.html (search; accessed 2026-10)
- [R7] Strain-life equation and mean-stress forms — Vibrationdata blog https://blog.vibrationdata.com/?p=150300 ; Siemens "The Strain Life Approach" https://community.sw.siemens.com/articles/en_US/Knowledge/The-Strain-Life-Approach (search; accessed 2026-10)
- [R8] pyLife 2.x (Apache-2.0): Wöhler curve, Miner, rainflow, Neuber/Ramberg-Osgood, FKM modules — Bosch Research — https://github.com/boschresearch/pylife (commit 2bcf718f; accessed 2026-10)
- [R9] Notch sensitivity q (Peterson form) as used in [R5] docs; Pilkey & Pilkey, Peterson's Stress Concentration Factors (Wiley, catalogue)
- [R10] Walker mean-stress model as offered by nCode DesignLife — HBK — https://www.hbkworld.com/en/products/software/analysis-simulation-software/ncode-signal-processing-and-durability-analysis/cae-simulation/designlife-modules/strain-life (search; accessed 2026-10)
- [R11] Palmgren-Miner linear damage rule as implemented in [R8] `strength/miner.py` and [R5] `palmgren_miner_linear_damage` (git; accessed 2026-10)
- [R12] 14 CFR 25.571 Damage-tolerance and fatigue evaluation of structure — LII — https://www.law.cornell.edu/cfr/text/14/25.571 ; FAA Amdt 25-54 text https://www.faa.gov/sites/faa.gov/files/2022-11/25.571amdt54.pdf (search; accessed 2026-10)
- [R13] FAA AC 25.571-1D Damage Tolerance and Fatigue Evaluation of Structure (13 Jan 2011) — FAA — https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_25_571-1D_.pdf (search, fetch blocked; accessed 2026-10)
- [R14] EASA CS-25 Easy Access Rules, CS 25.571 — EASA — https://www.easa.europa.eu/en/document-library/easy-access-rules/online-publications/easy-access-rules-large-aeroplanes-cs-25 (search extract; accessed 2026-10)
- [R15] FKM Guideline Analytical Strength Assessment of Components, 7th ed. 2020 — VDMA — https://vdmashop.de/en/fkm-guidelines/6/analytical-strength-assessment-for-engineering-components-7th-edition-2020 (catalogue; accessed 2026-10)
- [R16] FALSTAFF fighter loading standard (1976) — NTRL record N7712430 — https://ntrl.ntis.gov/NTRL/dashboard/searchResults/titleDetail/N7712430.xhtml ; ESDU 97018 (search; accessed 2026-10)
- [R17] MMPDS — Battelle — https://www.mmpds.org (catalogue, see aerospace 08 [T5])
- [R18] NIMS fatigue data sheets — https://fds.nims.go.jp (registration, no redistribution; README S19)
- [R19] CalculiX User's Manual (`*CRACK PROPAGATION`, `*HCF`) — G. Dhondt — https://github.com/Dhondtguido/CalculiX (commit fd588701; accessed 2026-10)
- [R20] llull aerospace 05 FEA pack (VC-FEA-14 Kirsch, margins, staleness) — `docs/aerospace/05-fea-cae-handoff/`
- [R21] NASA-STD-5019 Fracture Control Requirements for Spaceflight Hardware — NASA — https://standards.nasa.gov/standard/NASA/NASA-STD-5019 (page via search; factor from secondary sources)
- [R22] FAA final rule, Aging Airplane Program: Widespread Fatigue Damage (75 FR, 15 Nov 2010) — https://www.govinfo.gov/content/pkg/FR-2010-11-15/pdf/2010-28363.pdf ; 1998 NPRM https://www.govinfo.gov/content/pkg/FR-1998-03-31/html/98-8379.htm (search; accessed 2026-10)
- L1 llull laws — `.claude/rules/architecture.md`; agent-first rules — `docs/aerospace/AGENT_FIRST.md`
