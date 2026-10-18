# Physics & material behaviour: gap list

Status: **specifications written for all 21 gaps** (no implementation). Written 2026-10-15.
Each pack follows [`../aerospace/TEMPLATE.md`](../aerospace/TEMPLATE.md) and
[`../aerospace/AGENT_FIRST.md`](../aerospace/AGENT_FIRST.md) (the agent drives the `llull` CLI, the owner is
not assumed to be an engineer, and qualified reviewers sign off). Index: §7. Cross-pack findings: §8.

## 1. Baseline: what llull has once the aerospace packs are built

The aerospace packs are implemented **before** these gaps, so this list assumes they are done and only covers
what they leave out.

| Already covered by | Capability this list builds on |
| ------------------ | ------------------------------ |
| today's core | `Material { density, color, metalness, roughness, finish }` (`packages/core/src/model/types.ts`), `mass_properties`, kinematic joints and `motion_study` (`commands/motion/`, no forces), steel / purlin / runway code checks in `domain-aec` (beam theory, Eurocode) |
| 08 MAT | Rich material record: E, Ec, G, ν, Ftu/Fty/Fcy/Fsu/Fbru/Fbry, elongation, CTE, k, cp, with basis, direction (L/LT/ST), thickness range, provenance, **temperature tables** (V1), unit grammar (`lib/quantity.ts`), private licensed libraries |
| 05 FEA | Analysis cases (linear static, modal, linear buckling), Gmsh meshing + Verdict quality, bundled CalculiX, Nastran BDF, FRD/OP2 import, results as data, margins of safety, staleness, human disposition. **V2 hooks only**: linear tied contact, fatigue spectra export, beam idealization |
| 06 CMP | Lamina properties, CLT ABD, first-ply failure (max stress, Tsai-Hill, Tsai-Wu), drape. **V2**: hygrothermal CTE/CME loads, LaRC03, progressive failure |
| 01 KRN / 07 FTR | Exact faces for loads and BCs, sheet-metal flat patterns (no springback) |

Explicitly **out of scope** in the aerospace packs, so open here: nonlinear plasticity, explicit dynamics,
thermal analysis, real fatigue / damage tolerance, nonlinear contact, creep, CFD / aeroelasticity, process
simulation (cure, springback), computing statistical allowables from test data, corrosion rules.

## 2. Gap list

Ids `PHY-nn`. Priority (P1 = do first after aerospace, P3 = later). "Validation candidates" were found in the
2026-10-15 search (§4). Grades: **A** = the value is quoted by ≥ 2 independent sources, **B** = 1 secondary
source, **C** = the source exists but the value is not yet confirmed (paid report, or not reached from this
session). Each pack will pin A-grade values and mark the rest `TBD`.

### P1: foundations

| Id | Gap | What is missing after aerospace | Why it matters | Engine / method | Validation candidates |
| -- | --- | ------------------------------- | -------------- | --------------- | --------------------- |
| **PHY-00** | **Physics V&V harness** | No shared way to run a benchmark corpus, check mesh convergence, or report discretization error. 05 FEA has its own cases only | Every gap below needs it. The agent must *prove* a result (AF-20/23). This is the analysis equivalent of `npm run quality` | Read-only `check_convergence` (h-refinement, Richardson extrapolation, Roache GCI); benchmark runner that compares `--json` output to `expected_results.json`; ASME V&V 10 / V&V 20 vocabulary | Closed-form problems with known convergence order (patch tests, cantilever); NAFEMS LE / T / FV / NL sets below |
| **PHY-01** | **Property models (multi-variable and fitted)** | 08 MAT stores scalars and temperature tables. It has no fitted law forms (polynomial in log T, Arrhenius), no strain-rate or environment dependence, no extrapolation guard, and no cryogenic or high-temperature range metadata | Spacecraft and cryogenic tanks run at 4–300 K; engines and brakes run hot. Properties at the operating point drive every analysis | `PropertyModel = table \| fit(form, coeffs, validRange)`, evaluated as `f(T, rate, …)`. Refuses outside the valid range (stable code), never extrapolates silently | NIST cryogenic database: 6061-T6 k(T), cp(T) as a degree-8 polynomial in log10 T, 4–300 K, fit error 0.5 % (k) / 5 % (cp) **[A: NIST page + 2000 DB paper]** |
| **PHY-02** | **Constitutive model library + material-point driver** | The material only has linear-elastic, isotropic constants. No orthotropic solid elasticity, plasticity curve, hardening law, hyperelastic, viscoelastic, creep or rate law. No way to fit a model from test curves, and no way to check a model without a full FE run | Deformation beyond yield, elastomers (seals, mounts), polymers, hot parts: none of it can be described today. A non-engineer owner needs llull to fit and check the law itself | `MaterialModel` attached to the 08 record: elastic (iso / ortho / aniso), Ramberg-Osgood, bilinear / multilinear J2 with isotropic, kinematic or combined (Chaboche) hardening, hyperelastic (Neo-Hooke, Mooney-Rivlin, Yeoh, Ogden, Arruda-Boyce), Prony viscoelastic + WLF, Norton / Garofalo creep, Johnson-Cook. Query commands `fit_material_model` (least squares, stability checks such as Drucker) and `material_point_response` (strain/stress path → response, like MFront MTest). Export to CalculiX `*PLASTIC`, `*HYPERELASTIC`, `*CREEP` and Nastran MATS1 | NAFEMS NL1 target effective stresses (perfect plasticity, yield 5 MPa; isotropic hardening H = 62.5 GPa) **[A: Abaqus + Colorado benchmark guides]**; Treloar 1944 rubber, uniaxial + equibiaxial + pure shear, Ogden fit **[B: Abaqus / Altair verification, raw table TBD]**; Code_Aster SSNV133 mixed hardening, analytic **[B]**; Ramberg-Osgood, NACA TN 902 (1943) **[A: NTRS record]** |
| **PHY-03** | **Thermal analysis** | No heat transfer at all (05 lists it as "possible later") | Avionics boxes, brakes, engine mounts, spacecraft radiators, cure tools. Also the input to PHY-04 | CalculiX `*HEAT TRANSFER` (already bundled by 05): steady and transient conduction, film convection, radiation to ambient and cavity radiation (view factors), heat flux and heat generation, contact conductance, latent heat. Results as data: max/min T with location, probes, heat balance | NAFEMS **T3** 1D transient: 36.60 °C at x = 0.08 m, t = 32 s **[A: Abaqus, Altair, MOOSE]**; NAFEMS **T4** 2D convection: 18.3 °C at (0.6, 0.2) m (COMSOL 18.25) **[A, rounding open]**; Howell catalogue of view factors (> 300 analytic configurations) **[A]**; analytic slab, fin and lumped capacitance |
| **PHY-04** | **Thermo-mechanical coupling & thermal fits** | No thermal strain in FEA, and no check of assembly fits at temperature | Mixed-material joints (Al / Ti / CFRP) open or bind between −55 °C and +85 °C, and thermal stresses often dominate | Sequential T → static (CalculiX `*TEMPERATURE` read-back or `*COUPLED TEMPERATURE-DISPLACEMENT`). Query `fit_at_temperature`: hole/shaft clearance from CTE(T), linked to 03 GDT fits | NAFEMS **LE11**: σzz = −105 MPa at point A (E 210 GPa, ν 0.3, α 2.3e-4 /°C) **[A: Abaqus, Altair, Cast3M]**; Timoshenko bimetal strip (analytic); Code_Aster SSNL111 three-bar thermo-plastic **[B]** |

### P2: deformation, durability, dynamics

| Id | Gap | What is missing after aerospace | Why it matters | Engine / method | Validation candidates |
| -- | --- | ------------------------------- | -------------- | --------------- | --------------- |
| **PHY-05** | **Nonlinear structural analysis** | Linear only: no plasticity in FE, no large displacement, no post-buckling | Plastic reserve, collapse load, crippling, thin-panel post-buckling, permanent set after overload | CalculiX `*STATIC, NLGEOM` with PHY-02 laws; Riks arc-length for snap-through; result: load-displacement curve as data plus limit load | NAFEMS **NL7** Lee frame (Riks; points such as 18.55 / 0.407 and 31.89 / 0.784) **[B: Abaqus, Colorado]** (caution: NL7B target is mesh dependent and about 17 % high); **NL2** thick cylinder under pressure, elastic-plastic **[B]**; NAFEMS R0030 (10 material-nonlinear tests) **[C: paid]** |
| **PHY-06** | **Nonlinear contact, friction, bolt preload** | 05 V2 has only linear tied contact | Lugs, pins, bearings, clamped joints, Hertzian stress in rollers and gears, preload loss | CalculiX surface-to-surface contact with friction; bolt pretension; analytic Hertz checks (sphere, cylinder) as read-only quick checks; VDI 2230-style joint check later | NAFEMS cylinder-roller contact (Konter 2006): contact half-length 6.21 mm, p_max = 3585 MPa **[A: COMSOL 2009 + 6.4; load unit 35 kN vs 35 kN/mm to confirm]**; Code_Aster SSNP154 **[B]**; Hertz closed forms |
| **PHY-07** | **Fatigue (initiation)** | Only "export stress spectra" (05 V2). No S-N or ε-N data, no cycle counting, no damage sum | Durability is a certification item (damage tolerance and fatigue rules). Most in-service failures are fatigue | Material S-N (Basquin), ε-N (Coffin-Manson-Basquin), Kt / Kf, Neuber, mean-stress corrections (Goodman, Gerber, Morrow, SWT), rainflow (ASTM E1049), Miner sum, FKM-style plain checks. Query `fatigue_life` on FE results or on load histories | ASTM E1049 worked rainflow example **[C: standard paid; to reproduce]**; closed-form Basquin / Coffin-Manson cases; `reliability` Python library strain-life fit as a cross-check **[B]**. No open aerospace S-N dataset was found: values come from user or licensed libraries (08 private storage) |
| **PHY-08** | **Fracture mechanics & damage tolerance** | Nothing | Damage-tolerance substantiation: crack growth from a detectable flaw to critical, inspection intervals | K solutions library (handbook geometries), J-integral / interaction integral from FE (CalculiX or post-processing), crack growth Paris / Walker / NASGRO equation with spectrum, residual strength | NAFEMS R0020 test 2.1, single-edge cracked plate (E 207 GPa, ν 0.3, 100 MPa, a/b = 0.5): Ansys VM gives K ≈ 2.966 vs ref (ratio ≈ 0.99) **[B: Ansys + Abaqus, exact target TBD]**; angle crack at 90 / 67.5 / 22.5° **[B: COMSOL]**; center crack √sec(πa/2b) closed form **[A: textbook]**; AFGROW / NASGRO comparisons **[C]** |
| **PHY-09** | **Structural dynamics beyond modal** | Modal only. No frequency response, random vibration, shock or transient | Equipment qualification (random vibration, shock), launch loads, rotating machinery | Modal superposition in CalculiX (`*STEADY STATE DYNAMICS`, `*MODAL DYNAMIC`); damping models (modal, Rayleigh, structural); PSD input → RMS response and Miles' equation quick check; shock response spectrum; transient | NAFEMS **FV32** tapered membrane, modes 1–6: 44.623, 130.03, 162.70, 246.05, 379.90, 391.44 Hz **[B: Altair, cites TNSB Rev. 3]**; **FV52** (mode 7 disputed: 167.89 vs 265.81 Hz in different Altair releases, do not use) **[C]**; Miles' equation (NASA NTRS 19900015329) **[A]**; NASA-STD-7001A workmanship levels **[A: catalogue]** |
| **PHY-10** | **Rigid-body dynamics with forces** | Motion is kinematic only (`motion_study`, joints and drives); there are no masses in motion, forces, springs, dampers, friction or joint reactions | Mechanisms (landing gear, flaps, doors), actuator sizing, and joint reaction loads that feed FEA (PHY-05/09) | Index-3 DAE / constraint dynamics using the existing joints plus mass properties; read-only `dynamics_study` returning trajectories and joint reactions as data; export of joint loads to 05 load cases | Andrews' squeezing mechanism (7 bodies, 10 joints; Bari IVP Test Set reference solution) **[A: Bari report, SciML, COMSOL]**; pendulum and slider-crank closed forms |
| **PHY-11** | **Creep, relaxation, viscoelastic time response** | Nothing | Hot structures, polymer and composite parts under sustained load, bolt preload relaxation, seals | PHY-02 laws (Norton, time / strain hardening, Prony) in CalculiX `*VISCO` / `*CREEP`; Larson-Miller rupture check | NAFEMS creep set R0027 / Linkens vol. 2 (Norton thick cylinder) **[C: paid]**; COMSOL elastoplastic + creep hollow cylinder (r 0.16 / 0.25 m) **[B]**; NIMS creep data sheets (free with registration, **no redistribution, no bulk download**) |

### P3: useful extensions

| Id | Gap | What is missing after aerospace | Why it matters | Engine / method | Validation candidates |
| -- | --- | ------------------------------- | -------------- | --------------- | --------------- |
| **PHY-12** | **Material selection & substitution** | No way to compare or swap materials by performance | Owners ask "lighter, cheaper, stiffer?", and agents need a sourced answer | Ashby performance indices (E/ρ, E^½/ρ, E^⅓/ρ, σ^⅔/ρ …) as read-only queries over the material library; `compare_materials` and a `substitute_material` what-if (mass, stiffness, margins re-run) | Index derivations (Ashby, ASM Handbook vol. 20) **[B: paywalled, derivations analytic]**. No open property dataset found: use the library |
| **PHY-13** | **Corrosion & environmental compatibility** | 08 records the finish code only | Galvanic couples (Al–CFRP, Al–steel) are a classic aerospace defect; also stress-corrosion susceptibility by alloy and grain direction | Read-only `check_material_compatibility` over contacting parts (contact from interference / assembly): galvanic matrix, sealant / isolation required, SCC flags | MIL-STD-889 (889C 2016; 889D moves to galvanic current) matrix **[B: NATO STO AVT-373 slides; standard via DoD ASSIST]**; NIMS corrosion data sheets **[C]** |
| **PHY-14** | **Moisture, outgassing & space environment** | 06 V2 has CME loads only | Spacecraft materials need low outgassing (TML / CVCM); moisture swells composites and polymers | Properties TML, CVCM, WVR, CME on the material record; check against mission limits (common screening: TML < 1 %, CVCM < 0.1 %) | NASA outgassing database (ASTM E595) **[C: not reached this session]** |
| **PHY-15** | **Electrical, magnetic, optical & radiative properties** | None on the material | Lightning strike and electrical bonding paths (CFRP), EMI shielding, thermal control coatings (absorptivity / emissivity feed PHY-03) | Properties: σ_el, μr, ε_IR, α_solar, refractive index. Simple checks: bonding path resistance, α/ε ratio | Analytic resistance of conductors; sourced property values via library **[TBD]** |
| **PHY-16** | **Manufacturing process physics** | 07 gives flat patterns without springback; no weld, heat-treatment, machining or AM distortion | First-time-right parts: springback compensation for brake forming, distortion of thin machined parts, AM overhang and thermal distortion | Analytic springback (elastic-plastic bending), later FE springback with PHY-05; AM inherent-strain method | Analytic bending springback **[TBD source]**; NIST AM-Bench **[C: to search]** |
| **PHY-17** | **Topology & shape optimization** | Nothing | Lightweight brackets and fittings, a strong agent use case ("make it 30 % lighter") | SIMP density method on the 05 mesh, result as **derived, read-only** geometry (L8 derivation guard) the agent rebuilds as a parametric part | MBB beam half domain 300×100, volume fraction 0.5 (Andreassen et al. 2011, 88-line code) **[B: reproduce and pin]** |
| **PHY-18** | **Probabilistic analysis & sensitivity** | Single deterministic runs only | Basis A / B allowables are statistical. The owner needs "how sure are we?" and which parameter matters | Seeded Monte Carlo / LHS on parameters and material scatter (reuses 03 GDT seeded MC), FORM reliability index, parameter sensitivities via feature history | Analytic reliability index for linear limit state with normal variables **[A: textbook]** |
| **PHY-19** | **High strain rate, impact & explicit dynamics** | Nothing (explicit dynamics out of scope in 05) | Bird strike, fan-blade-out, drop tests, crash | External explicit solver hand-off (candidate OpenRadioss, licence and binaries to verify); Johnson-Cook strength + failure | FAA DOT/FAA/AR-00/25 (Lesuer, LLNL 2000): J-C constants for Ti-6Al-4V and 2024-T3 **[B: report located, constants to extract]**; AR-03/57 failure parameters **[B]** |
| **PHY-20** | **Vibro-acoustics** | Nothing | Acoustic qualification of spacecraft and cabin noise | Hand-off only (acoustic FE / SEA is a separate product); keep to PSD and SPL data on loads | NASA-STD-7001A **[A: catalogue]** |

### Not in this list

- **CFD, aerodynamics, aeroelasticity / flutter, fluid-structure interaction.** These are a separate product
  line (fluid solvers), not material behaviour. Engineering-level aerodynamics and compressible flow / rocket
  propulsion now live in the aerospace packs [10 AER](../aerospace/10-aerodynamics/FUNCTIONAL_SPEC.md) and
  [11 FLD](../aerospace/11-fluid-dynamics-propulsion/FUNCTIONAL_SPEC.md); CFD hand-off and aeroelasticity remain open.
- **Computing A / B-basis allowables from raw test data.** That is a CMH-17 / MMPDS statistical process; it
  goes to a later 08 MAT V3 item, not here.
- **Cure simulation, resin flow** (06 out of scope), **atomistic or micromechanical material design.**

## 3. Order and dependencies

```
aerospace 08 MAT + 05 FEA + 06 CMP (done first)
        │
PHY-00 V&V harness ── used by every gap
        │
PHY-01 property models ─> PHY-02 constitutive library ─┬─> PHY-05 nonlinear ─> PHY-06 contact ─> PHY-16 process
                                                       ├─> PHY-11 creep / viscoelastic
                                                       └─> PHY-19 explicit
PHY-03 thermal ─> PHY-04 thermo-mechanical      (PHY-15 emissivity feeds PHY-03)
PHY-09 dynamics <── PHY-10 rigid-body (joint loads)
PHY-07 fatigue ─> PHY-08 fracture / damage tolerance   (need 05 results, PHY-09 spectra)
PHY-12 selection, PHY-13 corrosion, PHY-14 outgassing: data + checks, can run in parallel any time after PHY-01
PHY-17 topology, PHY-18 probabilistic: after PHY-00 and 05
```

Recommended waves:

1. **PHY-00, 01, 02, 03, 04.** Foundations. Thermal is cheap because CalculiX is already bundled.
2. **PHY-07, 09, 10, 05.** Durability and dynamics, the most-requested engineering checks.
3. **PHY-06, 08, 11, 12, 13.**
4. **PHY-14 to 20.**

## 4. Sources found (2026-10-15 search, to re-check when writing each pack)

All entries are **search extracts** unless noted; none of the hosts were fetched directly from this session.
NAFEMS originals (TNSB Rev. 3 1990, NNB 1989, R0015, R0020, R0027, R0030, Konter 2006) are **paid**: values
above come from solver verification manuals that quote them, so each pack must state that and, where possible,
reproduce the value analytically.

| Ref | Source | Used for |
| --- | ------ | -------- |
| S1 | Abaqus Benchmarks Guide NL1, NL2, NL7, LE11, T3, T4, rubber fitting — docs.software.vt.edu/abaqusv2024/English/SIMACAEBMKRefMap/ | PHY-02, 03, 04, 05 |
| S2 | Colorado mirror of Abaqus benchmarks — ceae-server.colorado.edu/v2016/books/bmk/ | PHY-02, 05, 08 |
| S3 | NAFEMS resource centre R0049 (plasticity), R0030 (10 material NL tests), R0027 (creep), R0015 (free vibration), R0020 (2D LEFM) — nafems.org/publications/resource_center/ | catalogue only |
| S4 | Altair OptiStruct verification: FV32, FV52, LE11, T3, T4, hyperelastic 0800 — help.altair.com/hwsolvers/os/ | PHY-02, 03, 04, 09 |
| S5 | COMSOL Application Library: heat_convection_2d (T4), cylinder_roller_contact, elastoplastic_creep, angle_crack_plate, andrews_mechanism — doc.comsol.com/6.4/ | PHY-03, 06, 08, 10, 11 |
| S6 | MOOSE NAFEMS T3 verification — mooseframework.inl.gov/modules/heat_transfer/nafems_t3_verif.html | PHY-03 |
| S7 | FEATool T3 / T4 examples — featool.com/doc/ | PHY-03 |
| S8 | Cast3M test sheet LE11 — www-cast3m.cea.fr/html/CasTestsCastem/node9.html | PHY-04 |
| S9 | Code_Aster validation manual: SSNV133, SSNV148, SSNL111, HSNV101/104/105, SSNV301, SSNP154, MFRON01 — ericca.uqtr.ca/…/man_v/, www-mdp.eng.cam.ac.uk/web/CD/engapps/aster_docs/ | PHY-02, 04, 05, 06 |
| S10 | MFront / TFEL, MTest, MFrontGallery (JOSS 07742) — theoj.org/joss-papers/joss.07742/ | PHY-02 |
| S11 | NIST cryogenic material properties, 6061-T6 page and 2000 / 2006 database papers — trc.nist.gov/cryogenics/materials/ | PHY-01 |
| S12 | Cryogenic Materials Repository (arXiv 2509.23422) — independent check of NIST 6061-T6 k(T) | PHY-01 |
| S13 | Howell, Catalog of radiation configuration factors (web edition) — thermalradiation.net/indexCat.html | PHY-03 |
| S14 | Ansys fracture benchmarks (CCT, surface crack) and VMR020-t2a — ansyshelp.ansys.com | PHY-08 |
| S15 | Ramberg & Osgood, NACA TN 902 (1943) — ntrs.nasa.gov/citations/19930081614 | PHY-02 |
| S16 | Lesuer, DOT/FAA/AR-00/25 (LLNL 2000), Johnson-Cook for Ti-6Al-4V, 2024-T3; follow-on AR-03/57 | PHY-19 |
| S17 | Bari IVP Test Set, Andrews' squeezing mechanism — archimede.uniba.it/~testset/report/andrews.pdf; SciML benchmark | PHY-10 |
| S18 | Thampi & Vidyasagar, Miles' equation, NTRS 19900015329; NASA-STD-7001A — standards.nasa.gov | PHY-09, 20 |
| S19 | NIMS MatNavi creep / fatigue / corrosion data sheets — cds / fds / cods.nims.go.jp (registration, no redistribution) | PHY-07, 11, 13 |
| S20 | MIL-STD-889 galvanic compatibility, NATO STO-MP-AVT-373-09P — sto.nato.int | PHY-13 |
| S21 | Andreassen et al. 2011, 88-line topology optimization; Sigmund 2001 99-line — via arXiv 2005.05436 references | PHY-17 |
| S22 | `reliability` Python library, strain-life fitting — reliability.readthedocs.io | PHY-07 |
| S23 | CalculiX source with `test` directory (dhondt.de), Debian `calculix-ccx-test` package; mkraska/CalculiX-Examples | all solver gaps |

**Not found or not reachable (to search again when writing the packs):** NAFEMS T1 / T2 values, original
Treloar table, open aerospace S-N / ε-N datasets, NASA outgassing database, NIST AM-Bench, OpenRadioss
licence and binaries, Elmer test-suite layout, ASTM E1049 example values, IFToMM multibody benchmark library.

## 5. Decisions needed before writing the packs (superseded by §8.3)

1. **Package.** One `domain-physics` plugin (or `cae` disciplines inside the proposed `packages/domain-aero`)
   that extends 05 FEA instead of a parallel stack. Material models live in **core model** next to the 08
   record (06 CMP set the precedent that core must not reference plugin types).
2. **Solver scope.** Keep CalculiX as the single bundled solver (thermal, nonlinear, contact, creep, dynamics)
   and add MFront only if a law CalculiX lacks is needed. Explicit (PHY-19) stays a hand-off.
3. **Data policy.** Fatigue, creep and fracture data are mostly licensed (MMPDS, NIMS, NASGRO): reuse 08's
   private-library storage and ship no tables.
4. **Scope of this list.** Confirm the P1/P2/P3 split and whether PHY-12 to PHY-20 should get full packs or
   stay as backlog items.

## 6. Pack conventions (shared by every `NN-*` folder)

Layout, sections and authoring rules: [`../aerospace/TEMPLATE.md`](../aerospace/TEMPLATE.md) and
[`../aerospace/AGENT_FIRST.md`](../aerospace/AGENT_FIRST.md) apply unchanged (specs only, verified sources, no
fabricated numbers, FR → VC mapping, AF-nn mapping). The additions below keep 21 packs consistent.

### 6.1 Folders and requirement ids

| Gap | Folder | Req. prefix / error-code prefix |
| --- | ------ | -------------------------------- |
| PHY-00 | `00-vv-harness` | `VNV` |
| PHY-01 | `01-property-models` | `PROP` |
| PHY-02 | `02-constitutive-models` | `MATL` |
| PHY-03 | `03-thermal-analysis` | `THM` |
| PHY-04 | `04-thermo-mechanical` | `TMC` |
| PHY-05 | `05-nonlinear-structural` | `NLS` |
| PHY-06 | `06-contact-joints` | `CNT` |
| PHY-07 | `07-fatigue` | `FAT` |
| PHY-08 | `08-fracture-damage-tolerance` | `FRC` |
| PHY-09 | `09-structural-dynamics` | `DYN` |
| PHY-10 | `10-rigid-body-dynamics` | `RBD` |
| PHY-11 | `11-creep-viscoelasticity` | `CRP` |
| PHY-12 | `12-material-selection` | `SEL` |
| PHY-13 | `13-corrosion-compatibility` | `COR` |
| PHY-14 | `14-moisture-outgassing` | `ENV` |
| PHY-15 | `15-electro-optical-properties` | `EOP` |
| PHY-16 | `16-process-physics` | `PRC` |
| PHY-17 | `17-topology-optimization` | `TOP` |
| PHY-18 | `18-probabilistic-sensitivity` | `PRB` |
| PHY-19 | `19-explicit-impact` | `EXP` |
| PHY-20 | `20-vibroacoustics` | `VAC` |
| PHY-21 | `21-functional-prototype` | `FPR` |

Ids: `FR-THM-nn`, `TR-THM-nn`, `VC-THM-nn`; error codes `THM_<UPPER_SNAKE>` (AF-11).

### 6.2 Proposed placement (pending decision §5.1, every pack states it as a proposal)

- **Core model** (types core may reference): `packages/core/src/model/propertyModel.ts` (owned by PHY-01),
  `model/materialModel.ts` (owned by PHY-02). Both hang off the 08 MAT `MaterialRecord` as
  `propertyModels?` / `materialModels?`; no other pack defines material data.
- **Plugin** `packages/domain-physics` (alias `@phys`; see §8.1: it cannot import `@cae`), one `CadPlugin` per discipline (`thermal`, `nonlinear`,
  `fatigue`, …). It **extends** 05 FEA's `AnalysisModel` / `AnalysisCase` / deck writers / result readers
  (`@cae`) instead of creating a parallel analysis stack. Each pack owns the `AnalysisType` members it adds
  (e.g. PHY-03 `heat_steady`, `heat_transient`; PHY-05 `nonlinear_static`; PHY-09 `frequency_response`,
  `random_response`, `transient_dynamic`; PHY-11 `creep`) and lists them in its TECHNICAL_SPEC §3.
- **Solver:** bundled CalculiX (05) first; any other tool (MFront, external explicit solver, Python libs in
  the bundled CPython) is justified in the pack with its licence.
- **Document version:** slices ride the aerospace v3 envelope (01 KRN TECHNICAL_SPEC §3.1); a pack that needs
  a new slice lists it as an addition to `migrate2to3` or a v4 item, never its own migration.

### 6.3 `expected_results.json` schema (consumed by PHY-00's harness)

```json
{
  "pack": "03-thermal-analysis",
  "generatedBy": "generate_thermal_reference.py | quoted",
  "cases": [
    {
      "id": "VC-THM-03",
      "quantity": "temperature at x = 0.08 m, t = 32 s",
      "value": 36.6, "unit": "degC",
      "tolerance": { "rel": 0.01 },
      "source": "S1 (Abaqus T3) + S6 (MOOSE)", "grade": "A",
      "proves": ["FR-THM-02", "TR-THM-05"]
    }
  ]
}
```

`grade`: `A` (≥ 2 independent sources or exact analytic derivation in a generator), `B` (1 secondary source,
reported but not a pass/fail gate until confirmed), `C` / `TBD` (not used as a threshold). Generators are
**Python 3 standard library only**, run as `python3 -I <script>` from their `validation/` folder, and
re-run to byte-identical output; values are stored with 12 significant digits.

## 7. Packs

| Id | Gap | Functional | Technical | Validation | VC cases (A / B / C·TBD) |
| -- | --- | ---------- | --------- | ---------- | ------------------------ |
| PHY-00 | V&V harness | [spec](00-vv-harness/FUNCTIONAL_SPEC.md) | [spec](00-vv-harness/TECHNICAL_SPEC.md) | [pack](00-vv-harness/validation/README.md) | 33 (31 / 0 / 2) |
| PHY-01 | Property models | [spec](01-property-models/FUNCTIONAL_SPEC.md) | [spec](01-property-models/TECHNICAL_SPEC.md) | [pack](01-property-models/validation/README.md) | 81 (75 / 6 / 0) |
| PHY-02 | Constitutive models + material-point driver | [spec](02-constitutive-models/FUNCTIONAL_SPEC.md) | [spec](02-constitutive-models/TECHNICAL_SPEC.md) | [pack](02-constitutive-models/validation/README.md) | 107 (103 / 4 / 0) |
| PHY-03 | Thermal analysis | [spec](03-thermal-analysis/FUNCTIONAL_SPEC.md) | [spec](03-thermal-analysis/TECHNICAL_SPEC.md) | [pack](03-thermal-analysis/validation/README.md) | 30 (30 / 0 / 0) |
| PHY-04 | Thermo-mechanical & fits at temperature | [spec](04-thermo-mechanical/FUNCTIONAL_SPEC.md) | [spec](04-thermo-mechanical/TECHNICAL_SPEC.md) | [pack](04-thermo-mechanical/validation/README.md) | 31 (30 / 1 / 0) |
| PHY-05 | Nonlinear structural | [spec](05-nonlinear-structural/FUNCTIONAL_SPEC.md) | [spec](05-nonlinear-structural/TECHNICAL_SPEC.md) | [pack](05-nonlinear-structural/validation/README.md) | 35 (30 / 1 / 4) |
| PHY-06 | Contact, friction, bolted joints | [spec](06-contact-joints/FUNCTIONAL_SPEC.md) | [spec](06-contact-joints/TECHNICAL_SPEC.md) | [pack](06-contact-joints/validation/README.md) | 29 (24 / 2 / 3) |
| PHY-07 | Fatigue | [spec](07-fatigue/FUNCTIONAL_SPEC.md) | [spec](07-fatigue/TECHNICAL_SPEC.md) | [pack](07-fatigue/validation/README.md) | 22 (19 / 3 / 0) |
| PHY-08 | Fracture & damage tolerance | [spec](08-fracture-damage-tolerance/FUNCTIONAL_SPEC.md) | [spec](08-fracture-damage-tolerance/TECHNICAL_SPEC.md) | [pack](08-fracture-damage-tolerance/validation/README.md) | 18 (13 / 3 / 2) |
| PHY-09 | Structural dynamics | [spec](09-structural-dynamics/FUNCTIONAL_SPEC.md) | [spec](09-structural-dynamics/TECHNICAL_SPEC.md) | [pack](09-structural-dynamics/validation/README.md) | 31 (25 / 2 / 4) |
| PHY-10 | Rigid-body dynamics | [spec](10-rigid-body-dynamics/FUNCTIONAL_SPEC.md) | [spec](10-rigid-body-dynamics/TECHNICAL_SPEC.md) | [pack](10-rigid-body-dynamics/validation/README.md) | 22 (22 / 0 / 0) |
| PHY-11 | Creep & viscoelasticity | [spec](11-creep-viscoelasticity/FUNCTIONAL_SPEC.md) | [spec](11-creep-viscoelasticity/TECHNICAL_SPEC.md) | [pack](11-creep-viscoelasticity/validation/README.md) | 26 (22 / 4 / 0) |
| PHY-12 | Material selection | [spec](12-material-selection/FUNCTIONAL_SPEC.md) | [spec](12-material-selection/TECHNICAL_SPEC.md) | [pack](12-material-selection/validation/README.md) | 39 (34 / 5 / 0) |
| PHY-13 | Corrosion compatibility | [spec](13-corrosion-compatibility/FUNCTIONAL_SPEC.md) | [spec](13-corrosion-compatibility/TECHNICAL_SPEC.md) | [pack](13-corrosion-compatibility/validation/README.md) | 26 (17 / 9 / 0) |
| PHY-14 | Moisture, outgassing, space environment | [spec](14-moisture-outgassing/FUNCTIONAL_SPEC.md) | [spec](14-moisture-outgassing/TECHNICAL_SPEC.md) | [pack](14-moisture-outgassing/validation/README.md) | 21 (19 / 2 / 0) |
| PHY-15 | Electrical, magnetic, optical, radiative properties | [spec](15-electro-optical-properties/FUNCTIONAL_SPEC.md) | [spec](15-electro-optical-properties/TECHNICAL_SPEC.md) | [pack](15-electro-optical-properties/validation/README.md) | 22 (20 / 2 / 0) |
| PHY-16 | Process physics (springback, AM, distortion) | [spec](16-process-physics/FUNCTIONAL_SPEC.md) | [spec](16-process-physics/TECHNICAL_SPEC.md) | [pack](16-process-physics/validation/README.md) | 21 (17 / 1 / 3) |
| PHY-17 | Topology optimization | [spec](17-topology-optimization/FUNCTIONAL_SPEC.md) | [spec](17-topology-optimization/TECHNICAL_SPEC.md) | [pack](17-topology-optimization/validation/README.md) | 30 (21 / 7 / 2) |
| PHY-18 | Probabilistic & sensitivity | [spec](18-probabilistic-sensitivity/FUNCTIONAL_SPEC.md) | [spec](18-probabilistic-sensitivity/TECHNICAL_SPEC.md) | [pack](18-probabilistic-sensitivity/validation/README.md) | 41 (39 / 1 / 1) |
| PHY-19 | Explicit impact (hand-off) | [spec](19-explicit-impact/FUNCTIONAL_SPEC.md) | [spec](19-explicit-impact/TECHNICAL_SPEC.md) | [pack](19-explicit-impact/validation/README.md) | 25 (21 / 4 / 0) |
| PHY-20 | Vibro-acoustics (hand-off) | [spec](20-vibroacoustics/FUNCTIONAL_SPEC.md) | [spec](20-vibroacoustics/TECHNICAL_SPEC.md) | [pack](20-vibroacoustics/validation/README.md) | 19 (18 / 0 / 1) |
| PHY-21 | Functional digital prototype (buildability gate, closed-loop piston engine, motion clearance, review UX; on the merged MuJoCo engine) | [spec](21-functional-prototype/FUNCTIONAL_SPEC.md) | [spec](21-functional-prototype/TECHNICAL_SPEC.md) | [pack](21-functional-prototype/validation/README.md) | 25 (25 / 0 / 0) + 4 behaviour cases |

Total: 709 validation cases (630 A, 57 B, 22 C / TBD). Every generator is Python standard library
only and re-runs byte-identical (`python3 -I <script>` from its `validation/` folder; re-checked by the coordinator).
PHY-00's harness schema accepts every pack's `expected_results.json` (survey in PHY-00 TECHNICAL_SPEC §6.2).

## 8. Cross-pack findings and decisions (2026-10-15)

### 8.1 Findings that change §5 / §6.2

- **Placement (blocking).** `.dependency-cruiser.cjs` rule `plugins-and-kernels-depend-on-core-only` forbids
  `packages/domain-physics` importing 05's `@cae`, so §6.2's "extends `@cae`" is not buildable. Proposal: a **core
  analysis extension port** (plugins register `AnalysisType` members, deck fragments, result readers; PHY-03
  TECHNICAL_SPEC §2, Proposal A). Fallback: physics disciplines live inside the 05 FEA package. Packs 07, 08, 09, 11
  and 19 carry an erratum note pointing here.
- **CalculiX limits** found while writing the packs (all workarounds specified):
  no Riks / arc-length (PHY-05 refuses it on CalculiX and adds a native corotational beam solver for frames); no
  Prony viscoelastic material (`*VISCO` is a step; PHY-02 refuses export with `MATL_EXPORT_UNSUPPORTED`, MFront
  user material in V2); no `*LATENT HEAT` (equivalent cp table); `*EXPANSION` is a secant CTE from a reference
  temperature (PHY-01 needs a `cteBasis` condition); no random-vibration or shock-spectrum procedure (PHY-09 computes
  them in llull); `*STATIC` switches creep off (PHY-11 deck rules).
- **Explicit solver.** The PHY-19 author reports the OpenRadioss repository was deleted on 2026-10-01 and targets the
  AGPL-3.0 fork OpenCourant, which depends on a closed `hm_reader` binary and has no macOS build. Not confirmed by the
  coordinator; re-check before deciding.
- **Today's code.** The motion evaluator pivots every joint on the anchor instance origin, ignores the joint `frame`,
  adds Euler angles and does not close loops (PHY-10 §1) — a real defect independent of these specs. There is no
  general contact query (only building `check_clashes` and `motion_study` box overlaps); PHY-13 proposes
  `find_contacts` plus a kernel `proximity` port.
- **Corrections to §2/§4.** NAFEMS T1 / T2 were found (FeenoX repository). T4 = 18.2538 °C (settles 18.3 vs 18.25).
  The cylinder-roller load is 35 kN per mm (plane strain), confirmed via code_aster SSNP154. 14 CFR 25.631 is the
  **8 lb** bird; the 4 lb bird is 25.571(e)(1). The Treloar table is pinned from Steinmann et al. 2012.

### 8.2 Requests between packs (to apply when implementing)

| From | To | Request |
| ---- | -- | ------- |
| 04, 15 | PHY-01 | Variables `wavelength`, `frequency`; condition fields `cteBasis`, `opticalKind`, `lifeState` |
| 11 | PHY-01 | `larson_miller` property form |
| 19 | PHY-02 | Equation-of-state law kind |
| 12, 13, 14, 15, 09 | 08 MAT / PHY-01 `propertyCatalog.ts` | New property names (price, embodied carbon, galvanic group, anodic index, SCC class, TML, CVCM, WVR, RML, moisture diffusivity / saturation, CME, AO erosion yield, resistivity, emissivity, absorptivity, structural loss factor) |
| PHY-02 | 08 MAT | Unit grammar accepting scale factors (`1e-5`) |
| 14 | 06 CMP | Lamina β1 / β2 (moisture swelling) |
| 13 | 01 KRN | `proximity` kernel port; core `find_contacts` |
| 06 | 08 MAT | Query listing fastener stacks |
| 04 | core `lib/` | Expression evaluator usable by plugins (spatial temperature fields) |
| 09 | 05 FEA | `AnalysisType` extensible by plugins (same as the placement port) |
| 10 | core motion | `pivot` field, `fixed` / `spherical` joints, fix the evaluator defects above |

### 8.3 Decisions needed (supersedes §5)

1. **Placement**: core analysis extension port (recommended) or disciplines inside the 05 package.
2. **Licences**: MFront (GPL-3 with linking exception / CeCILL-A), OpenCourant (AGPL + closed binary), mmapy (GPL)
   for MMA, shipping numpy / scipy in the desktop bundle, bundling the NASA outgassing dataset (public-domain tag seen
   only on a mirror), ICE embodied-carbon data (licence required ⇒ user-imported only).
3. **Named safety defaults with no verified source yet**: fatigue / damage-tolerance scatter factors (AC 25.571-1D,
   NASA-STD-5019 not read), hydrogen-embrittlement threshold (180 vs 220 ksi), explicit damage and hourglass limits,
   GCI / reliability targets, limit-point and permanent-set thresholds, imperfection amplitude. Until decided, the
   packs require these values explicitly (AF-31).
4. **Paid references to buy** (would upgrade B/C cases to A): NAFEMS TNSB Rev. 3, NNB, R0020, R0027, R0030, Konter
   2006; ASTM E1049, E595; MIL-STD-889D matrix and MSFC-STD-3029A tables transcription (public but not yet read).
5. **Release policy**: whether a pack whose remaining cases are only B-grade can gate a release.

### 8.4 Verification limits

Most standards and agency hosts (nist.gov, nasa.gov, faa.gov, ecfr.gov, nafems.org, astm.org…) were blocked or
DNS-refused from this session; GitHub, PyPI and search extracts were the main channels. Each pack's
`validation/sources.md` grades every source and lists what was not verified. Values not confirmed are `B`, `C` or
`TBD` and are not pass/fail thresholds.
