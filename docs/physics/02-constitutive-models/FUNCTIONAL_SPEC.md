# PHY-02 — Constitutive model library + material-point driver — Functional spec

Gap id **MATL** · Status: specification (no implementation) · Written 2026-10-15
Companion: [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Sources: [validation/sources.md](validation/sources.md) · Gap list: [../README.md](../README.md) (row PHY-02) ·
Depends on: [PHY-01 property models](../01-property-models/FUNCTIONAL_SPEC.md)

---

## 1. Summary

After the aerospace packs a llull material can describe **linear isotropic elasticity only**: 05 FEA reads E, ν,
G and ρ from the 08 MAT record and writes `*ELASTIC` / `MAT1`. Orthotropic solid elasticity exists only for
plies inside 06 CMP (`LaminaMaterial`, plane stress). There is no way to say how a material behaves past yield,
how a rubber seal stiffens at large stretch, how a polymer relaxes, how a hot part creeps, or how flow stress
rises with strain rate. There is also no way to **fit** such a law from test curves or to **check** it without a
full FE run.

This gap adds a **`MaterialModel`** to the 08 record (`MaterialRecord.materialModels?`), grouped into named
**constitutive sets** (elastic + plastic + creep …) that analyses pick. The library covers: linear elasticity
(isotropic, orthotropic engineering constants, transversely isotropic, fully anisotropic) with stability checks;
Ramberg-Osgood; J2 plasticity with perfect, linear, multilinear, Voce or Johnson-Cook isotropic hardening and
linear or Chaboche kinematic hardening; hyperelasticity (Neo-Hooke, Mooney-Rivlin, polynomial, Yeoh, Ogden,
Arruda-Boyce) with a Drucker stability scan; Prony-series viscoelasticity with WLF or Arrhenius shift; Norton
and Garofalo creep; Johnson-Cook and Cowper-Symonds rate laws. Parameters can depend on temperature through
PHY-01 property models.

Two query commands make the laws usable by an agent and a non-engineer owner: **`fit_material_model`** (least
squares from test curves, with residuals and stability) and **`material_point_response`** (a single material
point driven along a strain, stress or mixed path, like MFront MTest [R10]), which proves a law behaves before any
mesh exists. Writers export the laws to CalculiX (`*ELASTIC TYPE=ORTHO / ENGINEERING CONSTANTS / ANISO`,
`*PLASTIC`, `*CYCLIC HARDENING`, `*DEFORMATION PLASTICITY`, `*HYPERELASTIC`, `*CREEP`, `*RATE DEPENDENT`) and
Nastran (`MAT1`/`MAT9` + `MATS1`, `MATHE`). Analysis (nonlinear FE, creep runs, explicit) stays in PHY-05,
PHY-11 and PHY-19.

## 2. Aerospace context & value

### 2.1 Where constitutive laws decide the answer

| Workflow | Law needed | Why linear elastic is not enough |
| -------- | ---------- | -------------------------------- |
| Ultimate strength of fittings and lugs, plastic reserve, permanent set after overload | J2 plasticity, multilinear or Ramberg-Osgood | Design to ultimate load goes past yield; 14 CFR 25.305 limit vs ultimate |
| Elastomeric mounts, seals, bumpers, dampers | Hyperelastic + viscoelastic | Large stretch, strong non-linearity, rate and temperature dependence |
| Hot structure, engine mounts, bolted joints at temperature | Creep (Norton / Garofalo) | Relaxation of preload; strain accumulation over hours |
| Bird strike, crash, fan-blade-out | Johnson-Cook or Cowper-Symonds rate law | Flow stress rises with strain rate |
| Thick composite or forged parts, single-crystal blades | Orthotropic / anisotropic solid elasticity | Directional stiffness in 3D solids (06 CMP covers thin plies only) |
| Cyclic loading near yield (ratchetting, shakedown) | Kinematic / Chaboche hardening | Bauschinger effect; isotropic hardening over-predicts reversed yield |

### 2.2 Who does it today, with which tools

| Tool | Public capability |
| ---- | ----------------- |
| Abaqus / CAE material evaluation | Fits hyperelastic models to uniaxial, biaxial and planar test data and runs a **Drucker stability** check on the fitted constants over the primary deformation modes, reporting the strain at which the tangent stiffness stops being positive definite [R5] |
| MFront / MTest (CEA, EDF) | Code generator for behaviours plus `MTest`, a point-wise driver that imposes strain or stress per component; "from ten to several hundred times" faster than a full FE run (TFEL README) [R10] |
| CalculiX (bundled by 05) | Native `*ELASTIC` (ISO, ORTHO, ENGINEERING CONSTANTS, ANISO), `*PLASTIC` (isotropic, kinematic, combined, Johnson-Cook), `*CYCLIC HARDENING`, `*DEFORMATION PLASTICITY` (Ramberg-Osgood), `*HYPERELASTIC` (Arruda-Boyce, Mooney-Rivlin, Neo-Hooke, Ogden, polynomial, reduced polynomial, Yeoh), `*CREEP` (Norton), `*RATE DEPENDENT` [R3][R4]. No native Prony-series viscoelasticity was found in the manual or the source (TECHNICAL_SPEC §6.1) |
| Nastran | `MAT1`/`MAT2`/`MAT9` elasticity; `MATS1` stress-dependent properties (type `PLASTIC`/`NLELAST`, hardening slope H or a `TABLES1` curve, yield function, isotropic / kinematic / combined); `MATHE` hyperelastic (Mooney / polynomial, Ogden, Arruda-Boyce) [R7] |
| Spreadsheets, Python scripts | Where most fitting is done; units, stability and provenance are usually lost |

**llull's value.** The law lives with the material record, has units and provenance, is checked for stability,
can be fitted and exercised from the CLI in milliseconds, and is written to the solver deck the same way every
time. A non-engineer owner can be told "this rubber model is stable up to a biaxial stretch of 8.86 and fits the
test within 0.18 MPa RMS" instead of "here are some Mooney constants".

## 3. Personas & user stories

Roles follow [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) §1.

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent driving the `llull` CLI (cloud: MCP) | `add_material_model`, `fit_material_model`, `material_point_response`, `check_material_models`, `export_material_cards` | Laws with units and stability results as data; stable codes; deterministic driver output it can compare |
| **Owner** | Person who asks "will this seal survive 50 % squeeze?" or "how much margin past yield?" | Natural language | Plain statements: which law, fitted to what, stable where, unverified or not |
| **Qualified reviewer** | Stress or M&P engineer, only where the law feeds a certification or safety decision | Desktop review surface | Accepts a fitted law for design use (human gate) |

User stories:

- **US-1 (operator).** The owner provides uniaxial, equibiaxial and planar rubber test curves. The agent runs
  `fit_material_model` for Mooney-Rivlin and Yeoh, compares RMS per mode and the Drucker scan, and reports:
  on the Treloar set, Mooney-Rivlin (C01 < 0) becomes unstable in equibiaxial tension at λ = 8.86 and
  compression at λ = 0.28, while Yeoh is stable everywhere in the scan and fits uniaxial 5.7× better
  (VC-MATL-08). It records Yeoh with `add_material_model`.
- **US-2 (operator).** Before a nonlinear FE run (PHY-05) the agent drives the plasticity model through the
  NAFEMS NL1 strain path with `material_point_response` and checks the effective stresses against the pack's
  reference values (VC-MATL-01/02). Any mismatch is found in milliseconds, not after a mesh and a solve.
- **US-3 (operator).** The owner gives "E = 72 GPa, σ0.2 = 400 MPa, n = 15" for an aluminium alloy. The agent
  defines a Ramberg-Osgood model; llull converts the engineering form to the CalculiX form (α = 0.36) and states
  the conversion in the result (VC-MATL-04).
- **US-4 (operator).** The agent enters "hardening modulus 62.5 GPa" without saying whether it is the plastic or
  the tangent modulus. llull refuses with `MATL_HARDENING_MODULUS_KIND_MISSING`; the two readings differ by
  3.8 % at the second NL1 point (VC-MATL-02).
- **US-5 (operator).** Exporting a Prony-series model to CalculiX returns `MATL_EXPORT_UNSUPPORTED` with the
  remediation (use the V2 MFront/UMAT route or a different solver), never a silently dropped law.
- **US-6 (reviewer).** The M&P engineer reviews the fit (data hash, residuals, stability range) and accepts it
  for design use (09 signing). Until then every result built on it carries `reviewRequired: true`.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | `MaterialModel` + constitutive sets on the 08 record; elastic iso / ortho / transversely isotropic / aniso with stability; J2 plasticity (perfect, linear with explicit modulus kind, multilinear, Voce) + linear kinematic; Ramberg-Osgood (deformation theory); hyperelastic Neo-Hooke, Mooney-Rivlin, polynomial N ≤ 3, reduced polynomial / Yeoh, Ogden N ≤ 3, Arruda-Boyce with Drucker scan; `check_material_models`; `material_point_response` (small-strain J2 strain / stress / mixed control; hyperelastic incompressible homogeneous modes); CalculiX writers for these |
| **V1** | Chaboche (multi-backstress Armstrong-Frederick), combined hardening; Prony viscoelasticity + WLF / Arrhenius shift (driver + Nastran where supported); Norton / Garofalo creep in the driver (constant stress, relaxation); Johnson-Cook and Cowper-Symonds definitions + driver; `fit_material_model` (linear forms: polynomial hyperelastic, Prony with fixed τ, multilinear from curves, Ramberg-Osgood); Nastran writers (`MAT1`, `MAT9`, `MATS1`/`TABLES1`, `MATHE`) |
| **V2 (built, M7)** | Non-linear fits (Ogden, Arruda-Boyce, Chaboche, Voce, Garofalo) by Levenberg-Marquardt; compressible hyperelastic general deformation in the driver; Hill-48 anisotropic yield; optional MFront/MTest backend for laws outside the built-in set (host transport, licence §8) |

**Out of scope.** FE analyses with these laws (PHY-05 nonlinear, PHY-11 creep, PHY-19 explicit own the
`AnalysisType`s and solver runs); damage and failure laws (J-C failure, fatigue, fracture: PHY-07, 08, 19 add them
as new behaviours in the same file); laminate-level composite models (06 CMP; this gap adds solid orthotropic
elasticity and references 06 for plies); statistical allowables (08 V3).

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-MATL-01 | MUST | A material record carries zero or more **material models**, each with behaviour (elastic, plastic, hyperelastic, viscoelastic, creep, rate), law and parameters with units, validity ranges (temperature, strain or stretch, strain rate, time), basis, provenance and optional fit record; and named **constitutive sets** that combine compatible models. Analyses reference a set, never loose parameters. | One provenance system (08), one place for laws (README §6.2) | 08 TR-MAT-11 |
| FR-MATL-02 | MUST | Linear elasticity: isotropic (E, ν), orthotropic engineering constants (E1, E2, E3, ν12, ν13, ν23, G12, G13, G23), transversely isotropic, fully anisotropic (21 constants, documented Voigt order). Conversions between engineering constants and stiffness are exact. | 3D directional parts; 06 covers plane-stress plies only | R3 *ELASTIC; VC-MATL-03 |
| FR-MATL-03 | MUST | Elastic stability: the stiffness matrix must be positive definite (refuse `MATL_ELASTIC_NOT_POSITIVE_DEFINITE`); isotropic −1 < ν < 0.5; orthotropic E, G > 0 and |ν_ij| < √(E_i/E_j) (Lempriere bound), which follow from positive definiteness. | A non-PD law makes an FE model meaningless | R6; VC-MATL-03 |
| FR-MATL-04 | MUST | Ramberg-Osgood in the CalculiX form `E ε = σ + α (|σ|/σ0)^(n−1) σ` [R3], with input also accepted in the engineering form `ε = σ/E + 0.002 (σ/σ0.2)^n` (then α = 0.002 E/σ0.2, σ0 = σ0.2); the conversion is reported. Deformation theory, monotonic loading only (stated in the result). | NACA TN 902 three-parameter description [R8]; widely used in aerospace hand analysis | VC-MATL-04 |
| FR-MATL-05 | MUST | J2 (von Mises) incremental plasticity with isotropic hardening: perfect, linear (yield stress + modulus **with explicit kind `plastic` or `tangent`**, never defaulted), multilinear (true stress vs equivalent plastic strain, first point at zero plastic strain, per temperature), Voce. Engineering stress-strain input is converted to true stress / plastic strain with the conversion recorded. | Over-yield analysis; the NL1 example shows the modulus kind changes results | R3 *PLASTIC; R7 MATS1 H "slope of stress versus plastic strain"; VC-MATL-02, 13 |
| FR-MATL-06 | MUST (linear) / SHOULD (Chaboche) | Kinematic hardening: linear (Prager) and Chaboche (sum of Armstrong-Frederick back stresses `C_i, γ_i`); combined isotropic + kinematic. | Bauschinger effect, cyclic loads | VC-MATL-05 |
| FR-MATL-07 | MUST | Hyperelastic laws: Neo-Hooke, Mooney-Rivlin, polynomial (N ≤ 3), reduced polynomial / Yeoh, Ogden (N ≤ 3 for CalculiX), Arruda-Boyce (5-term series), with volumetric terms `D_i` (D = 0 ⇒ incompressible, named). Ogden parameters are stored in the CalculiX/Abaqus convention `W = Σ 2μ_i/α_i² (…)`; input in the Ogden 1972 convention `Σ μ_p/α_p (…)` is converted (μ_i = μ_p α_p/2) and the conversion recorded. Initial shear modulus is reported. | Seals, mounts | R3 *HYPERELASTIC; VC-MATL-06, 07 |
| FR-MATL-08 | SHOULD (linear) / COULD (non-linear) | `fit_material_model` fits a law to test curves (hyperelastic: uniaxial, equibiaxial, planar; plasticity: uniaxial curve; viscoelastic: relaxation; creep: rate vs stress) by least squares, returns the model, residuals per test, the data hash and the stability result. Fits linear in their parameters are exact (QR); non-linear fits (V2) are deterministic (fixed start, named stopping rules). The fit never attaches itself. | A non-engineer owner needs llull to do the fitting | Treloar data [R11]; VC-MATL-08 |
| FR-MATL-09 | MUST | Hyperelastic **Drucker stability** scan: for uniaxial, equibiaxial and planar modes, in tension and compression, over stretch 0.10…10.00, report the first stretch where the incompressible tangent (Hessian of W in principal log strains) stops being positive definite. Unstable inside the model's declared validity range ⇒ error; outside ⇒ warning with the limits. | Abaqus practice: fitted models are often unstable at some strain [R5] | VC-MATL-09 |
| FR-MATL-10 | MUST | `material_point_response` drives one material point along a path of steps, each step imposing strain or stress per component (mixed control), with N increments, at a temperature (constant or per step). It returns, per increment or per step, strain, stress, equivalent plastic strain, back stress and energy, all with units. Presets: uniaxial stress, uniaxial strain, plane strain, equibiaxial, pure shear, simple shear. | Prove a law without a mesh (MTest idea) [R10] | VC-MATL-01, 02, 05 |
| FR-MATL-11 | SHOULD | Linear viscoelasticity: Prony series on shear (and optionally bulk) relaxation, normalised on the instantaneous modulus, with time-temperature shift (WLF `log10 aT = −C1 (T − Tr)/(C2 + T − Tr)` or Arrhenius); WLF refused below Tr when Tr is declared as Tg. | Polymers, adhesives, seals | R13; VC-MATL-10 |
| FR-MATL-12 | SHOULD | Creep definitions: Norton in the CalculiX form `ε̇ = A σ^n t^m` (time hardening; strain hardening as an option) and Garofalo `ε̇ = A [sinh(ασ)]^n exp(−Q/(RT))`. Analysis of structures under creep belongs to PHY-11. | Hot structures, preload relaxation | R3 *CREEP; VC-MATL-11 |
| FR-MATL-13 | SHOULD | Rate laws: Johnson-Cook strength `(A + B ε_p^n)(1 + C ln(ε̇/ε̇0))(1 − T*^m)` and Cowper-Symonds factor. Explicit analysis belongs to PHY-19. | Impact, crash | R3 *PLASTIC JOHNSON COOK, *RATE DEPENDENT; VC-MATL-12 |
| FR-MATL-14 | MUST | Temperature dependence: any scalar law parameter may reference a PHY-01 property model of the same record; curves may be given per temperature. Evaluation outside a referenced model's range refuses with the PHY-01 code. | One temperature mechanism | PHY-01 FR-PROP-17 |
| FR-MATL-15 | MUST | **Writers** produce CalculiX cards (and Nastran cards in V1) from a constitutive set, exactly and deterministically (TECHNICAL_SPEC §6). A law or combination the target cannot represent is refused with `MATL_EXPORT_UNSUPPORTED` naming the law; nothing is dropped silently. Linear laws are written as tables only over the model's declared validity range. | Solver decks are the end product (05) | R3, R4, R7; VC-MATL-13, 14 |
| FR-MATL-16 | MUST | **Readiness check** (AF-20) `check_material_models`: stability (elastic PD, Drucker), curve validity, parameter bounds, unit consistency, combination validity, validity ranges present, export support for the chosen solver, unverified / unreviewed fits. 08 `check_materials` includes these items. | The agent proves its own work | VC-MATL-03, 09, 15 |
| FR-MATL-17 | MUST | **Unverified propagation** (AF-32): a model is `unverified` if its basis is typical / unstated / unspecified, its source is not verified, a referenced property model is unverified, it came from a fit without a cited data source or reviewer acceptance, or the driver ran it outside its validity range. Every driver result, export header and downstream analysis carries the flag and reasons. | Owner cannot tell a typical law from a substantiated one | VC-MATL-15 |
| FR-MATL-18 | MUST | **Stable error codes** (AF-11) from TECHNICAL_SPEC §7.1, with ids or param paths and a remediation. | Agents act on codes | VC-MATL-15 |
| FR-MATL-19 | MUST | **Named defaults** (AF-31): increments per step, local Newton tolerance, Drucker scan range and grid, incompressibility treatment, fit objective and stopping rules, linear-law extension range for writers — each named in `data.defaults[]` with source and `defaulted: true`. The hardening modulus kind and curve measures (true / engineering, plastic / total) are never defaulted. | No silent engineering choice | VC-MATL-02, 15 |
| FR-MATL-20 | MUST | `reviewRequired: true` (AF-33) on every result used `forCertification`, every export of an unreviewed fitted model, and every driver result built on one; reviewer acceptance is a human gate (09 signing). | Laws feed ultimate-load and safety decisions | VC-MATL-15 |
| FR-MATL-21 | MUST | Composite plies stay in 06 CMP (`LaminaMaterial`); a solid orthotropic model may reference the 06 lamina it was derived from, but neither pack copies the other's data. | No duplicate material systems | 06 TECHNICAL_SPEC Q2 |
| FR-MATL-22 | MUST | Material-model edits are pure commands in feature history; fits and driver runs are read-only queries; private-library models never serialize (08 TR-MAT-31). | L1, L3, L8 | — |
| FR-MATL-24 | MUST | The same `MaterialModel` union hosts the **durability variants** whose fields are specified by their consumer packs: PHY-07 fatigue `sn_basquin`, `sn_power_law`, `sn_table`, `sn_equivalent_stress`, `en_coffin_manson`, `cyclic_ramberg_osgood`, `haigh_table`; PHY-08 fracture `da_dn_paris`, `da_dn_walker`, `da_dn_forman`, `da_dn_nasgro`, `da_dn_table`, `fracture_toughness`. They are attached with the same `add_material_model` command, share basis / provenance / private-library / unverified rules, and are not members of constitutive sets (fatigue and fracture analyses reference them by model id). | One material-data system for every pack (README §6.2) | PHY-07 / PHY-08 TECHNICAL_SPEC §3.1 |
| FR-MATL-23 | COULD | Optional MFront/MTest backend (V2) for laws outside the built-in set, as a host transport (`mtest_run`) over a **user-installed**, never bundled executable (OQ-MATL-05), reported missing with a stable code (`MFRONT_TOOL_MISSING`) when absent. **Built (M7).** | Extensibility without writing integrators | R10; licence §8 |

## 6. Workflows

### 6.1 CLI (operator)

```bash
llull search hyperelastic ; llull describe fit_material_model material_point_response   # discover; units (AF-01..04)

# 1. fit, compare, choose (read-only)
llull fit_material_model --params plans/fit_treloar_params.json --json > yeoh.json      # law yeoh, 3 tests
jq '.data.residuals, .data.stability' yeoh.json

# 2. record the chosen law in a constitutive set (one plan, AF-05)
llull run plans/nl1_material_point_proposed.json --validate --doc part.llull.json
llull run plans/nl1_material_point_proposed.json --doc part.llull.json --json

# 3. exercise the law without a mesh
llull material_point_response '{"material":"nl1_steel","set":"iso_hardening","preset":"plane_strain","path":{"steps":[…]},"increments":1000}' --doc part.llull.json --json

# 4. check and export
llull check_material_models --doc part.llull.json --json                              # pass/warn/fail with codes (AF-20)
llull export_material_cards '{"material":"nl1_steel","set":"iso_hardening","target":"calculix"}' --doc part.llull.json --save out/nl1.inp
```

`--dry-run` works for every mutating command (AF-42). The report to the owner states: the law and why, the data it
was fitted to (hash, source), the fit quality per test, the stability range, `unverified` reasons, and what needs a
reviewer.

### 6.2 MCP (cloud)

Toolset `materials` (08) gains `add_material_model`, `delete_material_model`, `define_constitutive_set`,
`check_material_models`. The `@phys` plugin toolset `material-lab` exposes `fit_material_model`,
`material_point_response`, `export_material_cards` (read-only).

### 6.3 Desktop UI (review surface only)

Material inspector "Behaviour" tab: constitutive sets, law parameters with units, validity, stability summary,
fit residuals; charts drawn from `material_point_response` data (stress-strain, test vs model per mode). Reviewer
acceptance of a fitted law is a human gate.

## 7. Acceptance criteria

`D` = `--doc case.llull.json --json`; expected values in `validation/expected_results.json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | E 250 GPa, ν 0.25, σy 5 MPa, perfect plasticity | `material_point_response preset=plane_strain` NL1 path, 10 increments per segment | effective stress at point 7 = 3.82350455285 MPa (rel 1e-9; Abaqus CPE4R 3.824 [R1]); converged (1000 increments) 3.91511459035 | VC-MATL-01 |
| AC-2 | same, linear isotropic hardening 62.5 GPa `modulusKind: plastic` | NL1 path | points 3 / 6 / 7 converged 5.48210796393 / 7.31313231086 / 4.18963116268 MPa (NAFEMS targets 5.482 / 7.322 / 4.230, grade B) | VC-MATL-02 |
| AC-3 | the same model without `modulusKind` | `add_material_model` | exit 1, `MATL_HARDENING_MODULUS_KIND_MISSING` | VC-MATL-02, 15 |
| AC-4 | orthotropic set with ν12 = 3.8, E1/E2 = 13.5 | `add_material_model` | exit 1, `MATL_ELASTIC_NOT_POSITIVE_DEFINITE`, bound √13.5 = 3.674 | VC-MATL-03 |
| AC-5 | engineering-form Ramberg-Osgood E 72 GPa, σ0.2 400 MPa, n 15 | `add_material_model`; `material_point_response preset=uniaxial_stress` to ε = 0.01 | stored α = 0.36 (conversion reported); stress at ε = 0.01: 420.054211273 MPa | VC-MATL-04 |
| AC-6 | Treloar table (3 modes) | `fit_material_model law=mooneyRivlin`; `law=yeoh` | MR C10 0.265829838273, C01 −0.00169590877646 MPa, Drucker: ET tension unstable at λ 8.86, compression at 0.28; Yeoh C10 0.183027183347, C20 −0.00141844935972, C30 3.93471468735e-5 MPa, stable in the whole scan | VC-MATL-08 |
| AC-7 | Ogden 1972 set (μ 0.63, 0.0012, −0.01 MPa; α 1.3, 5, −2) entered with `convention: ogden1972` | `add_material_model`; `export_material_cards target=calculix` | stored μ_i = 0.4095, 0.003, 0.01 MPa; μ0 = 0.4225 MPa; deck line `0.4095,1.3,0.003,5.,0.01,-2.,0.,0.` / `0.`; warning `MATL_INCOMPRESSIBLE_DEFAULT` | VC-MATL-07, 13 |
| AC-8 | Prony shear series g (0.3, 0.2), τ (0.1, 10) s | `material_point_response` step strain relaxation | G(t)/G0 at t = 1 s = 0.680981103586 | VC-MATL-10 |
| AC-9 | a Prony model | `export_material_cards target=calculix` | exit 1, `MATL_EXPORT_UNSUPPORTED` (law `prony`, remediation names V2 MFront/UMAT route) | VC-MATL-15 |
| AC-10 | NL1 linear hardening model | `export_material_cards target=nastran` | `MAT1    1       250000.         0.25` and `MATS1   1               PLASTIC 62500.  1       1       5.` | VC-MATL-14 |
| AC-11 | the wrong inputs of VC-MATL-15 | each command | exit 1, listed code, remediation | VC-MATL-15 |

## 8. Standards & regulatory alignment

- **No regulation prescribes constitutive laws.** Design-to-ultimate rules (14 CFR 25.303/25.305, used by 05) make
  plasticity relevant; 08 basis rules apply to any strength value inside a law (yield stress, hardening curve from
  allowables): typical curves are `unverified`.
- **MMPDS** publishes typical stress-strain curves and Ramberg-Osgood parameters in licensed volumes; llull ships
  none and accepts them through 08 private libraries.
- **NAFEMS** non-linear benchmarks (NNB 1989, R0030 plasticity tests) are paid; values here are quoted from the
  Abaqus Benchmarks Guide and reproduced analytically where possible (VC-MATL-01/02) [R1][R2].
- **Solver documentation** (CalculiX manual 2.23, Nastran card definitions via pyNastran) defines the export
  targets [R3][R4][R7].
- **Licences of optional backends.** TFEL/MFront: GPL (since 2023 with a linking exception allowing proprietary
  applications to link the TFEL and MFront-generated libraries) or CeCILL-A [R10]. CalculiX: GPL v2 (bundled by 05
  as a separate executable). llull does NOT ship MFront (decision 2026-10-19, OQ-MATL-05): it is a separate executable the user installs; llull only detects and runs it.

## 9. KPIs / success metrics

| KPI | Target |
| --- | ------ |
| Driver reproduces the generator's NL1 increments (N = 10 and N = 1000) | rel ≤ 1e-9 at all 16 points |
| Fits linear in parameters reproduce the generator's exact least-squares coefficients | rel ≤ 1e-6 |
| Unstable laws accepted without an error inside their validity range | 0 |
| Laws silently dropped or approximated by a writer | 0 |
| `material_point_response`, 8 steps × 1000 increments, J2 linear hardening | ≤ 50 ms |
| Agent completes the "seal fit + check + export" scenario unattended | ≥ 9 of 10 runs (AF-23) |

## 10. Risks & assumptions

| Risk | Mitigation |
| ---- | ---------- |
| Parameter conventions differ between sources (Ogden μ, hardening modulus kind, true vs engineering curves) | Canonical storage + explicit input convention + recorded conversion; refusal when the kind is missing |
| A fitted hyperelastic law is unstable at strains the analysis reaches | Drucker scan; validity range; PHY-05 checks reached strains against it |
| NAFEMS targets disagree with exact integration (NL1 point 7 with hardening: 1.0 %) | Converged generator values are the gate; NAFEMS values are reported, grade B (OQ-MATL-01) |
| CalculiX lacks a law (Prony) | `MATL_EXPORT_UNSUPPORTED`; V2 MFront route; PHY-11 informed (OQ-MATL-04) |
| Non-linear fits depend on start values | Deterministic start rules, multi-start grid with fixed order (V2) |
| Assumption | 08 MAT, PHY-01 evaluator, 05 deck writer extension point exist before M5 |

## 11. References

Direct fetches of vendor documentation hosts were blocked from the authoring sandbox; facts come from search
extracts, GitHub-hosted mirrors and source files. Grades are in [validation/sources.md](validation/sources.md).

- [R1] Abaqus Benchmarks Guide 4.6.1 "NL1: Prescribed biaxial strain history, plane strain" (NAFEMS NNB Rev. 1, 1989) — Colorado mirror https://ceae-server.colorado.edu/v2016/books/bmk/ch04s06anf38.html and http://dsk.ippt.pan.pl/docs/abaqus/v6.13/books/bmk/ch04s06anf38.html (accessed 2026-10; search extracts)
- [R2] NAFEMS non-linear benchmarks catalogue — https://www.nafems.org/publications/pubguide/benchmarks/page6/ (accessed 2026-10; search listing)
- [R3] CalculiX ccx 2.23 manual, keyword pages *ELASTIC, *PLASTIC, *CYCLIC HARDENING, *DEFORMATION PLASTICITY, *HYPERELASTIC, *CREEP, *RATE DEPENDENT, *VISCO — GitHub mirror https://raw.githubusercontent.com/WonhoLee1/WHT_Calculixent/HEAD/wht_calculixent_doc/CalculiX/ccx_2.23/doc/ccx/ (node256, 257, 262, 274, 301, 333, 336, 370) (accessed 2026-10-15, downloaded)
- [R4] CalculiX source (input parsers `elastics.f`, `plastics.f`, `hyperelastics.f`, `creeps.f`, `deformationplasticitys.f`, `cyclichardenings.f`, `viscos.f`) at the commit pinned by 05 — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c/src (accessed 2026-10-15, downloaded)
- [R5] Abaqus documentation, hyperelastic material evaluation / Drucker stability and "Fitting of rubber test data" benchmark — https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-rubberfit.htm (accessed 2026-10; search extract)
- [R6] B. M. Lempriere, "Poisson's ratio in orthotropic materials", AIAA J. 6:2226–2227 (1968) — citation via Norris (2006) https://coewww.rutgers.edu/~norris/papers/2006_RSPA_462_3385-3405.pdf (accessed 2026-10; search extract; bound re-derived analytically in the generator)
- [R7] pyNastran card definitions (`MAT1`, `MAT2`, `MAT8`, `MAT9`, `MATS1`, `MATHE`) — https://raw.githubusercontent.com/SteveDoyle2/pyNastran/main/pyNastran/bdf/cards/materials.py and material_deps.py (accessed 2026-10-15, downloaded)
- [R8] W. Ramberg, W. R. Osgood, "Description of stress-strain curves by three parameters", NACA TN 902 (1943) — https://ntrs.nasa.gov/citations/19930081614 (accessed 2026-10; search extract of the NTRS record)
- [R9] CalculiX forum, *DEFORMATION PLASTICITY uses true stress / logarithmic strain — https://calculix.discourse.group/t/deformation-plasticity-strain-output/3836 (accessed 2026-10; search extract)
- [R10] TFEL/MFront README and licence (GPL-3 with linking exception since 2023, or CeCILL-A; MTest) — https://raw.githubusercontent.com/thelfer/tfel/master/README.md and LICENCE-GNU-GPL (accessed 2026-10-15, downloaded)
- [R11] Treloar (1944) rubber data as tabulated by Steinmann, Hossain, Possart, Arch. Appl. Mech. 82:1183–1217 (2012), doi:10.1007/s00419-012-0610-z — transcriptions https://raw.githubusercontent.com/llamm-de/thermalCANN/HEAD/data/Treloar/ and https://raw.githubusercontent.com/3MAH/simcoon/HEAD/examples/hyperelasticity/comparison/Treloar.txt (accessed 2026-10-15, downloaded; paper metadata via search)
- [R12] Arruda-Boyce 5-term series coefficients — CalculiX manual (R3) and FElupe source https://felupe.readthedocs.io/en/v8.6.0/_modules/felupe/constitution/hyperelasticity/models/_arruda_boyce.html (accessed 2026-10; search extract)
- [R13] Williams-Landel-Ferry equation, "universal" C1 = 17.44, C2 = 51.6 K at Tr = Tg; valid at or above Tg — secondary summaries via https://en.wikipedia.org/wiki/Williams%E2%80%93Landel%E2%80%93Ferry_equation and TA Instruments APN001 https://www.tainstruments.com/pdf/literature/APN001_Guidelines_for_using_TTS.pdf (accessed 2026-10; search extracts)
- [R14] Ogden three-term parameters for Treloar (μ 0.63, 0.0012, −0.01 MPa; α 1.3, 5, −2), quoted by the solids4foam rubber-sealing benchmark — https://github.com/solids4foam/solid-benchmarks (hyperElasticity/rubberSealing/README.md) (accessed 2026-10-15, code search); attribution to Ogden (1972) not verified
- [R15] PHY-01 property models — llull — `docs/physics/01-property-models/`; 08 MAT, 05 FEA, 06 CMP packs — `docs/aerospace/`
