# Research F: propeller realism, MuJoCo engineering accuracy, joint clearance/friction, and how to state accuracy (llull)

Date of research: 2026-10-16. Every claim is tagged [Rn]. Each Rn is a URL that was actually fetched during this research (see the
reference list at the end). Values marked **UNCONFIRMED** were not found in a fetched source. Values marked **DERIVED** are
my own arithmetic from cited inputs. They are not quoted from a source.

This note builds on research note C (`C_engine_mujoco.md`). References of note C are cited as **[C-Rn]** and are not repeated.
Note C already covers: the J, C_T, C_P, C_Q definitions, the BEM element equations, the TR-640 and ACR 4B04 pointers, the
`connect` soft-constraint error formula r = a₀(1−d)τ²ζ², the integrator list, and the contact filtering rules. This note adds what
is needed to make the simulation *realistic* and to state its accuracy honestly.

Note on MuJoCo sources: as in note C, the chapters were read from the documentation's reStructuredText source on GitHub `main`
[R1][R2][R3]. Each feature used below was checked against the changelog [R4] to confirm that it exists in 3.14.0, the version llull pins.

Note on one source: the Adams Solver statements quoted in §2.5 come from a PDF of the *Adams 2021.0.2 Adams Solver User's Guide*
(MSC Software) that was in the research scratchpad. Its download URL was not recorded, so its **provenance is UNCONFIRMED**.
The fetched MotionSolve documentation [R7] and an Adams forum thread [R8] corroborate it. It is listed as [R9].

---

## 1. Propeller realism

### 1.1 What "beyond static coefficients" means

- Today llull applies only the J = 0 point: T = C_T0·ρn²D⁴ [C-§5]. A real fixed-pitch propeller loses thrust as airspeed rises.
  C_T(J) falls to zero at the windmill J, and C_P(J) also falls, so the engine speeds up in flight. Propeller efficiency is
  η = J·C_T/C_P [C-§5]. The FAA calls the fixed-pitch case a compromise: "a fixed-pitch propeller achieves the best efficiency
  only at a given combination of airspeed and rpm, the pitch setting is ideal for neither cruise nor climb" [R25].
- **Constant-speed**: "a controllable-pitch propeller whose pitch is automatically varied in flight by a governor maintaining
  constant rpm despite varying air loads". It "converts a high percentage of brake horsepower (BHP) into thrust horsepower (THP)
  over a wide range of rpm and airspeed combinations" [R25]. Modelling one needs a family C_T(J, β), C_P(J, β) plus a governor law
  for β. TR-640 covers blade angles up to 45° [C-R26].
- **Ground-adjustable** (the Rotax 912 case, see 1.4) is fixed-pitch in flight, with β set on the ground [R25][R22].

### 1.2 Measured data and how good it is

| Source | What it gives | Stated precision / agreement |
|---|---|---|
| NACA TR-640, Hartman & Biermann (full-scale, 10-ft, 2/3/4 blades, NACA 20-ft tunnel) [C-R26] | C_T, C_P, η vs V/nD for several blade angles, plus take-off thrust methods. The OCR text adds: about 2 % difference in peak efficiency between the 2-blade and 4-blade propellers. | "repeat tests usually checked first tests within about 1 percent". The authors say exact accuracy values cannot be given [C-R26]. |
| NACA ACR 4B04, Crigler (calculated vs experimental, 4/6/8 blades, β = 25–65°) [C-R27] | Strip theory with Goldstein factors vs test | Agreement "very good in all cases except for the eight-blade propeller" at 55° and 65°. Efficiency differences are "considered to be within the accuracy of the tests" [C-R27]. No % figure. |
| UIUC Propeller Data Site [C-R29] | Measured C_T(J), C_P(J) for small or UAV propellers | Low Reynolds number. The bot check blocked a re-fetch (§6). |
| APC performance files [R30] | C_T, C_P per J for every APC model | **Computed, not measured**: "a specialized computational method that is based on Vortex theory" [R30]. |
| SimScale CFD validation, APC 11×5.5E vs UIUC Vol. 1 [R28] | CFD (not BEMT) vs tunnel | C_T error 0.43 % / 7.08 % / 10.60 % and C_P error 6.59 % / 4.64 % / 7.87 % at 1868 / 4043 / 6473 rpm [R28]. |

**BEMT accuracy.** No fetched source gives a single "BEMT vs tunnel = ±x %" figure for full-scale propellers. The fetched evidence:
- Whitmore & Merrill (USU) say the standard BEMT simplifications (small angle of attack, induced drag neglected in thrust) "are
  inaccurate at high advance ratios and along the inner half-span". Their nonlinear solution matched RC-propeller tunnel data
  better [R29]. The page says the paper has been withdrawn, so use it only as a qualitative statement.
- Crigler's strip theory with Goldstein correction agreed with full-scale test data within test accuracy [C-R27].
- Search snippets only, **UNCONFIRMED** because the full texts could not be fetched (403 / bot check): a Master Airscrew 10×7 BEMT
  study reported thrust about 20 % high and torque up to 30 % low. A wind-turbine study reported BEM power within about 3 % and
  thrust within about 13 %.
- **DERIVED summary**: treat a well-implemented BEMT with tip loss and good airfoil polars as a ±10–20 % model for C_T, C_P off-design.
  Treat measured tables (TR-640 class) as about ±1–2 % repeatability. This range is my synthesis of the evidence above, not a
  quoted figure.

### 1.3 Minimum realistic BEMT (if tables are not available)

- **Prandtl tip-loss factor (QPROP form)** [R26]: F = (2/π)·arccos(e^(−f)), with f = (B/2)(1 − r/R)/λ_w and λ_w = (r/R)·tan φ, where
  φ is the local inflow angle. QPROP uses the local wake advance ratio λ_w instead of the global V/ΩR, which "is more
  realistic for heavy disk loadings". QPROP adds a hub term √(1 + (4λ_wR/Br)²) [R26].
- Larrabee: the factor F "was taken by analogy from the known solution for the flow about the edges of an infinite array of semi
  infinite plates". "Goldstein, in 1929, was to confirm Prandtl's approximate calculation for the practically important case of
  small tip helix angles" [R27]. Off-design analysis uses "radially graded momentum theory" with Prandtl's F [R27].
- Inputs per station: chord c(r), twist β(r), and section C_l(α, Re), C_d(α, Re). MIT's HELICE uses a "seven parameter analytic
  airfoil section property specification" from α = −90° to +90° [R27]. **DERIVED minimum**: about 10–20 stations, a polar per
  section, an iterative solve for a and a′ with F (note C equations), then integrate T and Q. Cache C_T(J), C_P(J) once per
  geometry, because a per-step BEMT solve is not needed for quasi-steady loads.

### 1.4 The Rotax 912 propeller: sizes, rpm, inertia (sourced)

| Item | Value | Ref |
|---|---|---|
| Gear ratio | i = 2.2727 (50/22 T) or 2.4286 (51/21 T), by configuration | [R20] |
| Prop flange rotation | "left, counter clockwise, looking towards face of flange" | [R20] |
| Max torque on propeller | 912 A/F/UL: 238 N·m (i = 2.2727) or 255 N·m (i = 2.4286). 912 S/ULS: 315 N·m (i = 2.4286) | [R20] |
| **Propeller moment of inertia, system limit** | **between 1500 kg·cm² (3.559 lb·ft²) and 6000 kg·cm² (14.238 lb·ft²)** | [R20] |
| Prop shaft extension | max 120 mm | [R20] |
| Vibration | if no other limit is available, max 0.5 IPS at 5000 rpm can be assumed | [R20] |
| Measured inertias (E-Props/Duc, 912 series) | Duc Swirl 2-blade 2100, Duc Flash 2-blade 2500, E-Props 3-blade 2300 (units not printed; the page compares them with the 6000 kg·cm² limit) | [R21] |
| Real 912S fixed-pitch, ground-adjustable installations | Durandal 100 L **Ø 180 cm** (Savannah), Durandal 100 M **Ø 170 cm** (VL3), Excalibur-6 Ø 172 cm (914 gyro), all with reducer 2.43 | [R22] |
| Pitch-setting targets (E-Props, 912–915) | **static ground full-throttle 5100–5800 rpm**; level flight full throttle 5500 rpm ± 50; **+0.6° pitch ≈ −100 rpm** | [R22] |

No published C_T(J), C_P(J) table for a 1.7 m two-blade Rotax propeller was found (**UNCONFIRMED / not found**). The E-Props
rpm targets [R22] are the best *system-level* validation numbers available. Example: "full throttle, standing still, 1.72 m prop,
912S → static rpm in 5100–5800."

**DERIVED checks for the spec (ISA sea-level ρ = 1.225 kg/m³, a standard value not fetched here):**
- Prop speed at 5800 engine rpm with i = 2.43: 2387 rpm = 39.8 rev/s. The tip speed for D = 1.72 m is π·1.72·39.8 ≈ 215 m/s.
- A static C_P0 that absorbs 73.5 kW [C-R23] at 5800 rpm with D = 1.72 m: C_P0 = P/(ρn³D⁵) ≈ 73 500/(1.225·39.8³·1.72⁵) ≈ **0.063**.
  This is a sanity target for any table or BEMT result used for the static case.
- Prop inertia reflected to the crank: I_prop/i². For the 6000 kg·cm² maximum: 0.6/2.43² ≈ 0.10 kg·m². For the measured 2-blade
  values of 2100–2500 kg·cm²: 0.036–0.042 kg·m².

### 1.5 Gyroscopic effects

- The gyroscopic couple is C = I·ω·ω_P, with spin ω and precession rate ω_P (ω_P = v/R in a turn) [R24].
  The reaction is "about an axis rotated 90˚ in the direction of the prop rotation" [R23]. Magnitude is "proportional to the
  propeller inertia, the prop rpm" (and the pitch or yaw rate) [R23]. "To the first order, the moment of inertia is
  proportional to the diameter of the propeller cubed (D3)" [R23].
- **DERIVED magnitude**: with I = 0.6 kg·m² (Rotax maximum [R20]), Ω = 250 rad/s (2387 rpm) and an assumed pitch rate of 0.5 rad/s
  (UNCONFIRMED manoeuvre value), M ≈ 75 N·m on the mount. With 0.23 kg·m² [R21], M ≈ 29 N·m.
- **In MuJoCo** the gyroscopic term comes out of rigid-body dynamics automatically, through the Coriolis and centripetal bias, as
  long as the prop hinge's parent body rotates. With the engine on `world` it is identically zero (DERIVED). For free bodies,
  3.11.0 replaced midpoint integration with gyroscopic derivatives [R4]. `implicitfast` and `implicit` are then identical for
  standalone free bodies. "Systems requiring long-horizon energy conservation of tumbling bodies should use the RK4 integrator" [R2].

---

## 2. MuJoCo accuracy for engineering

### 2.1 Physics available per joint (all present in 3.14.0)

| Attribute | Semantics | Use for realism | Ref |
|---|---|---|---|
| `damping` | Polynomial since 3.7.0 [R4]: f(v) = a·v + b·v·|v| + c·v³ + … (anti-symmetrised). The Euler integrator treats damping implicitly. | Viscous losses: oil shear in bearings, windage (v·|v|). | [R1][R2] |
| `frictionloss` | "Friction loss due to dry friction". It is a **constraint**: an upper limit on the friction force. It is **load-independent** ("in contrast with Coulomb friction which scales with normal force"). | A constant breakaway or rubbing torque. **Not** μ·N bearing friction. | [R1][R2] |
| `solreffriction`/`solimpfriction` | Friction-loss rows have r ≡ 0, first-order velocity decay and impedance d₀. Exact sticking is not guaranteed ("slow slippage"). NoSlip (`noslip_iterations` 1–3) reduces slippage. | Tune so the crank does not creep at stall. | [R1][R3] |
| `armature` | Added joint inertia = reflected rotor inertia × (gear ratio)². "positive armature significantly improves simulation stability, even for small values" | Represent the gearbox and prop inertia on the crank, or as a stabiliser. | [R1] |
| `stiffness` | Polynomial spring | Torsional compliance of the shaft (later) | [R1] |
| backlash recipe | Two coincident hinges, the second with a tiny range or a soft equality whose impedance is "weak near J2=0 and gets stronger away from 0" | **Pattern for gear backlash and for pin clearance (2.3)** | [R3] |
| `energy` flag | Fills `mjData.energy` with potential and kinetic energy. "Monitoring energy for a system that is supposed to be energy-conserving is one of the best ways to assess the accuracy". Energy stored in constraints is **not** counted. | Motoring-without-friction energy test | [R1] |

**Coulomb (load-dependent) joint friction is not native** (DERIVED from the semantics above). To get T_f = μ·|F_pin|·r_pin, compute it
each step from the previous step's `efc_force` of that joint's connect rows or from `cfrc_int` (note C §1.3). Apply it as a
`qfrc_applied` torque opposing ω, or as an actuator. The one-step lag is the same explicit approach MotionSolve and Adams avoid by
putting friction inside the solver. Those tools compute it from joint reaction, bending and torsion inputs and the pin radius
(`mu_static`, `mu_dynamic`, `stiction_trans_vel`, `pin_radius`, `friction_arm`, `bending_reaction_arm`, `inputs` bits) [R6].

### 2.2 Integrators and documented accuracy statements

- MuJoCo recommends `implicitfast` "for most models". RK4 "is best for systems which are energy conserving, or almost energy-conserving";
  a pendulum mechanism "diverges quickly using Euler or implicitfast yet conserves energy well under RK4" [R2].
- **Erez, Tassa, Todorov (ICRA 2015)** [R5]. The authors are the MuJoCo developers and say so [R5].
  - The accuracy measure is **self-consistency**: a reference run at h = 1/64 ms, then deviation at larger h over short intervals.
    Model error ("system identification") is explicitly out of scope [R5].
  - In energy-conserving systems (a 5-DOF planar chain, the floating "astronaut") "the RK integrator wins by orders of magnitude" [R5].
  - Models used only hinge joints, sphere and capsule geoms, no joint friction, and **no closed kinematic loops** [R5].
  - **There is therefore no published MuJoCo-vs-Adams or MuJoCo-vs-analytical benchmark for a closed-chain engineering mechanism
    in the fetched literature. Not found.**
- Tsounis, Grandia, Bächer (arXiv 2504.19771, 2025): MuJoCo-style constraint softening is "exceptionally effective" when mass
  ratios are near unity. "However, ... high mass-ratios make it effectively impossible to use such a relaxation, even with
  extraneous tuning". Combining it with Baumgarte-like stabilisation minimises configuration-level violation [R10].
  **DERIVED risk for llull**: a light piston and rod looped to a crank that carries prop inertia is a high mass-ratio loop. Check
  the residual explicitly instead of assuming it is small.

### 2.3 Can pin/bore clearance be modelled by MuJoCo contacts?

- MuJoCo collision is "limited to *convex* geoms". Mesh geoms are replaced by their convex hull, so a bore becomes a solid
  cylinder [R2]. A bore must be decomposed "into a union of convex geoms" (or use an SDF plugin) [R2].
- **DERIVED cost**: a ring of N convex segments (N ≈ 16–32) around each pin produces 1–2 active contacts per pin per step, with a
  contact stiffness that must resolve a 10–25 µm gap. That needs dt well below the 10–30 µm-of-travel time step from note C, plus
  `margin` and `gap` tuning [R1]. Feasible but expensive, and it introduces impact noise. This is exactly what the clearance-joint
  literature studies (§3).
- **Cheaper DERIVED alternative**: a `connect` whose `solimp` makes the impedance low for |r| < radial clearance and high beyond it.
  This applies the documented backlash recipe [R3] to the pin, and `solimp` width/midpoint/power are documented in [C-R3].
  It gives a "soft inside, stiff at the wall" pin with no contact search. Its loads are smooth, so it is a play model rather than
  an impact model.

### 2.4 Equality `connect` vs `weld`

Note C covers this (connect = 3 rows, weld = 6 rows, with weld orientation weak near 180°). One addition: a 3.14.0 fix corrected the weld
torque in `mj_rnePostConstraint` [R4]. Use `connect` for pins and never weld a pin.

### 2.5 How mature tools state solver and constraint tolerances (so the gate can be phrased the same way)

| Tool | Parameter | Default and meaning | Ref |
|---|---|---|---|
| Adams Solver (C++) | `INTEGRATOR/ERROR` | Defaults "HHT and Newmark: 1E-5. All other integrators: 1E-3". "the value for ERROR is units-sensitive ... in mm-kg-s units ... setting ERROR=1E-3 implies that the integrator monitors all changes of the order of 1 micron" | [R9] (provenance UNCONFIRMED) |
| Adams Solver (C++) | `IC/ERROR` (assembly) | "maximum displacement error ... for the assembly process", default 1.0E-10. `IC/AERROR` default 1.0E-4. `IC/VERROR` default 1.0E-4 | [R9] |
| Adams (forum, NREL/NLR) | ERROR role | "The ERROR argument on the INTEGRATOR command determines the convergence criterion for the corrector" | [R8] |
| Altair MotionSolve (Adams-compatible) | `error` | "1.0E-3": maximum absolute error per step for displacement, velocity and differential states | [R7] |
| Altair MotionSolve | `dae_constr_tol` | **"1.0E-5"**: tolerance that all algebraic constraint equations must satisfy at convergence. Decrease only if reactions are noisy | [R7] |
| Simscape (Solver Configuration) | consistency tolerance | Uses the model AbsTol/RelTol, or local values 0.001/0.001, scaled by a tolerance factor of 0.001, for initial and transient initialisation | [R11] |

**DERIVED gate phrasing for llull**, in the same units-aware style as Adams:
- The Lycoming connecting-rod bushing to piston pin clearance is **0.0008–0.0021 in diametral (0.020–0.053 mm), with a service
  limit of 0.0025 in (0.064 mm)** [R19]. The smallest real radial play is therefore about 10 µm.
- Gate: **max over the run of |efc_pos| on the loop-closure rows ≤ 1 µm ("pass")**. This is 10 % of the smallest radial clearance
  and matches Adams' ERROR = 1e-3 mm "order of 1 micron" monitoring scale [R9]. **Warn at > 1 µm, fail at > 10 µm** (the residual
  then exceeds the real joint play, so rigid-joint results are not valid). Note C §1.2 shows that about 1e-8 m is achievable with
  tight `solref` and `solimp`, so 1 µm is not demanding.
- Also report the residual as a fraction of the stated clearance ("loop residual 0.03 µm = 0.3 % of radial clearance").

---

## 3. Joint clearance and friction in engine multibody models

### 3.1 What mature tools do

- **AVL EXCITE Power Unit**: "Outstanding elastohydrodynamic (EHD) contact models for slider bearings and piston/piston ring liner
  contact" used for "the calculation of friction and wear" [R14]. Search snippets (not fetched) describe a simplified tier with
  REVO revolute joints and an advanced tier with EHD2 bearings. That **two-tier practice** is UNCONFIRMED as fetched text but is
  consistent with [R14].
- **RecurDyn**: a FunctionBay-listed paper models a slider-crank "with an imperfect revolute joint". It compares contact, damping
  and friction models, and "only one damping model was capable of reproducing the experimental results" from the literature [R13].
- **COMSOL MBD** example: a slider-crank at 5000 rpm compares an ideal hinge with a **0.5 mm clearance** joint. Clearance produces a
  "step like velocity profile", "sudden variations in slider acceleration and reaction moment in the crank", and intermittent
  zero contact force [R12].
- **Literature practice** (Bai, Ning, Zhou, Micromachines 2022) [R15]: Lankarani–Nikravesh normal force, modified Coulomb
  friction, μ = 0.1, restitution 0.9, radial clearance 0.5 mm (sweep 0.1–1 mm). Contact forces are "much higher than that in
  ideal joints" [R15].
- Adams, MotionSolve and Simcenter friction-in-joint parameters: see 2.1 [R6]. Simcenter 3D Motion clearance documentation was not
  found (**UNCONFIRMED**).

### 3.2 Typical values (sourced)

| Quantity | Value | Ref |
|---|---|---|
| Hydrodynamic journal bearing μ | "of the order of 10-3". EHL about 10⁻². Boundary about 10⁻¹. Dry 0.7–1 | [R16] |
| Piston ring / liner μ, fluid film | "one would expect a value in the range 0.005–0.05" | [R17] |
| Ring / liner μ, measured mixed-boundary (tribometer, 11 N) | average μ = 0.225 | [R17] |
| Engine friction components | crankshaft (mains, seals), reciprocating (rod bearings, piston assembly), valvetrain, auxiliaries, pumping. tfmep = pmep + rfmep + amep. bmep = imep(g) − tfmep. η_m = bmep/imep | [R18] |
| Passenger-car energy split | 38 % of fuel energy becomes mechanical power. Engine friction = 11.5 % of fuel energy | [R31] |
| Lycoming main bearing / crankshaft diametral clearance | e.g. chart A: 0.0025–0.0055 in (0.064–0.140 mm), service 0.0060 in | [R19] |
| Lycoming piston pin / piston clearance | 0.0003–0.0014 in (0.008–0.036 mm), service 0.0018 in | [R19] |
| **Lycoming rod length between bearing centres** | **6.4985–6.5015 in (165.1 mm)** for charts A-B-D-G-J-BD. The O-320 family is under chart G per the application table, but text extraction misaligned the columns, so **applicability to O-320-A/E is UNCONFIRMED**. This would fill note C's UNCONFIRMED rod length. DERIVED λ = 49.2/165.1 ≈ 0.30 | [R19] |

**DERIVED magnitudes** (using note C's 66.5 kN peak pin force estimate and a 27 mm crank-pin radius, i.e. half of 2.125 in [R19]):
- Hydrodynamic: T_f = μFr ≈ 0.001·66 500·0.027 ≈ 1.8 N·m peak, about 0.5 % of the 396 N·m mean O-320 torque [C-§3].
- Boundary or mixed (μ = 0.1) would give about 180 N·m peak, a large effect. The regime matters more than the model.
- Car average from [R31]: 11.5/38 ≈ 30 % of indicated work lost to engine friction. This is a fleet and part-load figure. The
  value for aviation engines at full load is **UNCONFIRMED**.

### 3.3 When are rigid ideal joints acceptable?

No fetched source gives an explicit criterion (**not found**). What is supported:
- Ideal joints give smooth kinematics and loads. Clearance adds impacts and load peaks [R12][R15]. So ideal joints are acceptable for
  **mean torque, power, rpm equilibrium, kinematics and first-order reaction forces**. They are not acceptable for **impact
  loads, noise, wear or bearing film life**. This criterion is DERIVED from [R12][R15].
- Real clearances (10–70 µm [R19]) are small compared with the 0.5 mm test values in the literature [R12][R15]. Lubricated engine
  bearings are modelled with EHD rather than dry contact in the mature tool [R14].

---

## 4. Verification vs validation: how "accurate enough" is expressed

### 4.1 Standards

- **NASA-STD-7009A** (approved 2016-07-13) [R32]:
  - The Credibility Assessment Scale has 8 factors in 3 groups: Data Pedigree, Verification, Validation; Input Pedigree,
    Uncertainty Characterization, Results Robustness; M&S History, M&S Process/Product Management. Each is scored 0–4.
  - Level 4 Validation: "All M&S outputs agree with data from the RWS over the full range of operation in its real operating
    environment". Level 2: "Key M&S outputs agree with data from a sufficiently similar referent system". Level 1: "Conceptual
    model addresses problem statement and agrees with available referents".
  - The standard "levies no requirements with respect to what levels to achieve ... merely that the levels be determined and reported".
  - A results report includes "(1) the best estimate of the results, (2) a statement on the uncertainty in the results, (3) the
    assessment of the credibility of results ..., (4) any explicit caveats ..., and (5) the risks".
  - [M&S 33] requires one of: "(1) A quantitative estimate of the uncertainty ..., or (2) A qualitative description ..., or
    (3) A clear statement that no quantitative estimate or qualitative description of uncertainty is available".
  - [M&S 32] requires explicit warnings for unachieved acceptance criteria, violated model assumptions, violated limits of operation,
    and execution warnings [R32].
  - 7009B (2024) supersedes 7009A (search snippet; not fetched, UNCONFIRMED).
- **ASME V&V 20** (CFD and heat transfer; the concept is general) [R33][R34]:
  - Comparison error E = S − D.
  - U_val = √(U_num² + U_input² + U_D²) for independent sources.
  - "(E ± U_val) defines an interval within which δ_model falls", with about 95 % confidence when U is at 95 %.
  - If |E| ≫ U_val, then δ_model ≈ E, and the information can be used to improve the model. If |E| ≲ U_val, "the modeling error
    is within the 'noise level'" [R33].
  - The approach "quantifies the degree of accuracy inferred from the comparison of solution and data" at a validation point [R34].
- **ASME V&V 10-2019** (computational solid mechanics): a "common language", "conceptual framework, and general guidance". Its
  companions are V&V 10.1 (example), 10.2 (uncertainty) and 10.3 (validation metrics) [R35]. FAA practice built on V&V 10 asks
  "What are the accuracy requirements for the model in the validation domain? ... in the application domain?" [R36]. It reports
  per-channel metrics: relative error on the peak, plus the Sprague–Geers magnitude and shape error. Example: lumbar Fz peak error
  0.57 % with shape error 8.8 % [R36].
- The Sprague–Geers combined metric exists in commercial post-processors [R37]. The page shows the formula only as an image. The
  form C = √(M² + P²) is **UNCONFIRMED** from fetched text. [R37] also states "C=1 is a perfect match", which conflicts with
  the usual convention that 0 = perfect. Check before use.

### 4.2 Wording patterns for llull results (DERIVED from [R32][R33][R36])

Show these per output quantity, not one global "accuracy" figure. All numbers in these templates are **illustrative placeholders**,
not results:

1. **Best estimate + uncertainty + basis**: "Static thrust 1 480 N (±10 %, model-form: tabulated C_T0 from TR-640 class data, not
   validated for this propeller)."
2. **Verification evidence (numerical)**: "Loop residual max 0.02 µm (gate ≤ 1 µm = 10 % of 10 µm radial pin clearance): PASS.
   Cycle energy closure ∮T dθ vs IMEP·V_D: 0.3 % (gate ≤ 1 %): PASS. Timestep halving changes mean torque by 0.1 %."
3. **Validation evidence (vs referent)**: "Mean torque at 5800 rpm vs Rotax datasheet 121 N·m: E = +1.8 %. No test uncertainty published
   (U_D unknown) → validation level 1–2 (NASA-STD-7009A scale)."
4. **Explicit warnings ([M&S 32] style)**: "Outside validated range: J > 0.6 not covered by the propeller table." "Ideal joints:
   impact and clearance loads not represented." "Friction modeled as constant FMEP."
5. **If unknown, say so ([M&S 33] (3))**: "No quantitative uncertainty estimate is available for gyroscopic mount loads."

---

## Recommendations for the spec

**Model in MVP**
1. **Propeller C_T(J), C_P(J) tables** per propeller instead of static C_T0. Q = C_P ρn²D⁵/(2π) acts as the reaction torque on the prop
   hinge, with J from airspeed and the prop hinge `qvel` [C-§5]. Ship one generic two-blade fixed-pitch table digitised from TR-640
   [C-R26]. Tag it "repeatability about 1 % [C-R26], applicability to this propeller unvalidated". Sanity-check the static point
   against C_P0 ≈ 0.063 (DERIVED, §1.4).
2. **Prop inertia** as a real body or as `armature` on the prop hinge [R1]. Default 0.25 kg·m² (within the measured 2100–2500
   kg·cm² [R21]), clamped to the Rotax limit 0.15–0.60 kg·m² [R20]. Refuse or warn outside that range.
3. **Engine friction lumped**: a constant `frictionloss` (breakaway) plus `damping` with a v and v·|v| polynomial on the crank
   [R1][R2], calibrated to an FMEP. Report bmep = imep − fmep and η_m [R18]. Mark the FMEP value **UNCONFIRMED until engine data is
   provided**.
4. **Rigid ideal joints** (connect loops) with the **loop residual gate**: pass ≤ 1 µm, warn > 1 µm, fail > 10 µm [R19][R9].
5. **Integrator**: `implicitfast` for production runs [R2]. **RK4 for the verification run** (motoring, no friction, energy flag on,
   energy drift gate) [R2][R5].
6. **System validation targets**: Rotax 912S + 1.70–1.80 m ground-adjustable propeller. Static full-throttle rpm 5100–5800, level
   flight 5500 ± 50, pitch sensitivity 0.6° ≈ 100 rpm [R22]. Also mean torque vs datasheet [C-R23].
7. **Per-output accuracy block** as in §4.2: best estimate, uncertainty, basis, verification checks, validation level and warnings
   [R32][R33].

**Later**
- BEMT with QPROP-form Prandtl tip loss [R26] to generate tables from blade geometry. Expect about ±10–20 % (DERIVED §1.2).
- Constant-speed propeller: a C_T, C_P(J, β) family plus a governor [R25].
- Load-dependent Coulomb pin friction μ·|F|·r from `efc_force`, with μ ≈ 1e-3 (hydrodynamic) [R16] and ring/liner 0.005–0.05 [R17].
- Pin play via soft-impedance `connect` (backlash pattern [R3]). Contact-based clearance only for impact studies (convex decomposition,
  expensive) [R2][R12][R15].
- Moving airframe base for gyroscopic mount loads M = IΩq [R23][R24]. Torsional crank and shaft compliance via `stiffness` [R1].

**Could not find (UNCONFIRMED)**
- Measured C_T(J), C_P(J) for any ~1.7 m two-blade Rotax 912 propeller.
- A numeric full-scale "BEMT vs tunnel" error figure. The fetched evidence is qualitative [C-R27][R29], and CFD-only figures are in [R28].
- Any MuJoCo closed-loop accuracy benchmark vs Adams or an analytical solution [R5].
- Simcenter 3D Motion clearance documentation. AVL EXCITE theory details beyond the catalogue [R14].
- Aviation-engine FMEP and mechanical efficiency at full load.
- The ASME V&V 10/20 full texts (paywalled; secondary sources used [R33][R34][R35]). The Sprague–Geers formula text [R37].
- The public URL of the Adams 2021.0.2 Solver guide [R9].
- The UIUC site blocked automated re-fetch (bot check), so its content is taken from [C-R29] only.

---

## References (all fetched 2026-10 unless stated)

- [R1] MuJoCo XML Reference (joint `damping`, `frictionloss`, `armature`, `stiffness`, `margin`/`gap`, `energy` flag) — Google DeepMind — https://raw.githubusercontent.com/google-deepmind/mujoco/main/doc/XMLreference.rst (rendered: https://mujoco.readthedocs.io/en/stable/XMLreference.html) (accessed 2026-10)
- [R2] MuJoCo Computation chapter (friction loss, polynomial forces, integrators, convex collision and decomposition, gyroscopic derivatives) — Google DeepMind — https://raw.githubusercontent.com/google-deepmind/mujoco/main/doc/computation/index.rst (accessed 2026-10)
- [R3] MuJoCo Modeling chapter (friction solver parameters, slow slippage, backlash) — Google DeepMind — https://raw.githubusercontent.com/google-deepmind/mujoco/main/doc/modeling.rst (accessed 2026-10)
- [R4] MuJoCo Changelog (3.7.0 polynomial damping, 3.11.0 gyroscopic derivatives, 3.14.0 weld/rnePostConstraint fixes) — Google DeepMind — https://raw.githubusercontent.com/google-deepmind/mujoco/main/doc/changelog.rst (accessed 2026-10)
- [R5] T. Erez, Y. Tassa, E. Todorov, "Simulation tools for model-based robotics: Comparison of Bullet, Havok, MuJoCo, ODE and PhysX", ICRA 2015, pp. 4397–4404 — https://roboti.us/lab/papers/ErezICRA15.pdf (accessed 2026-10)
- [R6] Force: Joint Friction (MotionSolve XML; mu_static, mu_dynamic, stiction_trans_vel, pin_radius, friction_arm, inputs) — Altair — https://help.altair.com/hwsolvers/ms/topics/solvers/ms/xml-format_11.htm (accessed 2026-10)
- [R7] Integrator (MotionSolve Python API; error 1.0E-3, dae_constr_tol 1.0E-5, hmax, maxit) — Altair — https://help.altair.com/2021/hwsolvers/ms/topics/solvers/ms/integrator_api.htm (accessed 2026-10)
- [R8] "ADAMS running error" forum thread (role of INTEGRATOR ERROR) — NREL/NLR forum — https://forums.nlr.gov/t/adams-running-error/560 (accessed 2026-10)
- [R9] Adams 2021.0.2 Adams Solver User's Guide (INTEGRATOR and IC statements) — MSC Software / Hexagon — local PDF copy; **public URL not recorded (provenance UNCONFIRMED)** (read 2026-10)
- [R10] V. Tsounis, R. Grandia, M. Bächer, "On Solving the Dynamics of Constrained Rigid Multi-Body Systems with Kinematic Loops", arXiv:2504.19771 (2025) — https://arxiv.org/pdf/2504.19771 (accessed 2026-10)
- [R11] Solver Configuration (Simscape block reference) — MathWorks — https://www.mathworks.com/help/simscape/ref/solverconfiguration.html (accessed 2026-10)
- [R12] Slider Crank Mechanism with Joint Clearance (application model, 0.5 mm clearance, 5000 rpm) — COMSOL — https://doc.comsol.com/6.4/doc/com.comsol.help.models.mbd.slider_crank_mechanism_with_clearance/models.mbd.slider_crank_mechanism_with_clearance.pdf (accessed 2026-10)
- [R13] "Modeling planar slider-crank mechanisms with clearance joints in RecurDyn" (paper listing) — FunctionBay — https://functionbay.com/en/paper/single/160/global-dynamic-theory-modeling-planar-slider-crank-mechanisms-clearance-joints-recurdyn (accessed 2026-10)
- [R14] AVL Solutions Catalogue 2016, EXCITE page (EHD slider bearing and piston/ring-liner contact models) — AVL — https://staticfiles.avl.com/staticwww/emag/Solutionskatalog2016_EN/pubData/SEO/Page_44.html (accessed 2026-10)
- [R15] Z. Bai, Z. Ning, J. Zhou, "Study on Wear Characteristics of Revolute Clearance Joints in Mechanical Systems", Micromachines 13(7):1018 (2022) — PMC — https://pmc.ncbi.nlm.nih.gov/articles/PMC9323239 (accessed 2026-10)
- [R16] NPTEL, Module 3 Bearing Systems, Lecture 2 "Hydrodynamic Oil-Lubricated Journal Bearings" — IIT / NPTEL — https://archive.nptel.ac.in/content/storage2/courses/112103024/module3/lec2/1.html (accessed 2026-10)
- [R17] M. Gore, N. Morris, R. Rahmani, H. Rahnejat, P. D. King, S. Howell-Smith, "A combined analytical-experimental investigation of friction in cylinder liner inserts under mixed and boundary regimes of lubrication", Lubrication Science 29:293–316 (2017), doi 10.1002/ls.1369 — UCLan repository — https://knowledge.lancashire.ac.uk/id/eprint/32143/1/32143%20ls.1369.pdf (accessed 2026-10)
- [R18] MIT 2.61 Internal Combustion Engines (Spring 2017), Lecture 19 "Engine Friction and Lubrication" — MIT OCW — https://ocw.mit.edu/courses/2-61-internal-combustion-engines-spring-2017/ad971a51c4a7f2db8a20f9570c870f0d_MIT2_61S17_lec19.pdf (accessed 2026-10)
- [R19] Lycoming SSP-1776-5 Service Table of Limits and Torque Value Recommendations (April 13, 2020) — Lycoming — https://www.lycoming.com/sites/default/files/attachments/SSP-1776-5%2520Table%2520of%2520Limits%2520-%2520Complete.pdf (accessed 2026-10)
- [R20] Installation Manual for Rotax engine type 912 Series, IM-912, Ed. 3 Rev. 0 (Jan 2021), ch. 61-00-00 propeller drive and system limitations — BRP-Rotax (rotax-owner.com copy) — https://www.rotax-owner.com/pdf/IM_912_Series_Ed3_R0.pdf (accessed 2026-10)
- [R21] "Measures of propellers' moments of inertia" — E-Props blog — https://blogen.e-props.fr/archives/10049/measures-of-propellers-moments-of-inertia/ (accessed 2026-10)
- [R22] E-Props propeller manual for Rotax 9 series, HEP-MANUAL-2020A-EN (pitch adjustment, examples) — E-Props — https://aircraft.e-props.fr/DOCS/HEP-ROTAX9-2020-02-15-EN.pdf (accessed 2026-10)
- [R23] B. Wainfan, "Wind Tunnel: Understanding gyroscopic effects", Kitplanes (2013) — https://www.kitplanes.com/wind-tunnel-21/ (accessed 2026-10)
- [R24] A. A. Nayeeif, "Gyroscopic Couple and Precessional Motion" (lecture, 2019–2020) — Mustansiriyah University — https://uomustansiriyah.edu.iq/media/lectures/5/5_2020_10_03%2109_30_44_PM.pdf (accessed 2026-10)
- [R25] Pilot's Handbook of Aeronautical Knowledge, Chapter 7 "Aircraft Systems" (propellers) — FAA — https://www.faa.gov/sites/faa.gov/files/09_phak_ch7.pdf (accessed 2026-10)
- [R26] M. Drela, "QPROP Formulation" (June 2006) — MIT — https://web.mit.edu/drela/Public/web/qprop/qprop_theory.pdf (accessed 2026-10)
- [R27] E. E. Larrabee, "A Pictorial Account of the Fundamentals of Propeller Theory ..." (MIT lecture) — humanpoweredflight.co.uk — https://www.humanpoweredflight.co.uk/hpfMedia/media/7/larrabee-prop-design-lecture.pdf (accessed 2026-10)
- [R28] "Drone Propeller Study" validation case (APC 11×5.5E vs UIUC) — SimScale — https://simscale.com/docs/validation-cases/drone-propeller-study/ (accessed 2026-10)
- [R29] S. Whitmore, S. R. Merrill, "Nonlinear Large Angle Solutions of the Blade Element Momentum Theory Propeller Equations" (abstract; marked withdrawn) — Utah State University DigitalCommons — https://digitalcommons.usu.edu/mae_facpub/33 (accessed 2026-10)
- [R30] Performance Data (technical information) — APC Propellers — https://www.apcprop.com/technical-information/performance-data/ (accessed 2026-10)
- [R31] K. Holmberg, A. Erdemir, "Global Impact of Friction on Energy Consumption, Economy and Environment", FME Transactions 43:181–185 (2015) — https://www.mas.bg.ac.rs/_media/istrazivanje/fme/vol43/3/01_kholmberg.pdf (accessed 2026-10)
- [R32] NASA-STD-7009A, Standard for Models and Simulations (approved 2016-07-13) — NASA NTRS — https://ntrs.nasa.gov/api/citations/20160011121/downloads/20160011121.pdf (accessed 2026-10)
- [R33] "Validation Procedure for 3rd Workshop on CFD Uncertainty Analysis" (adapted from ASME V&V 20), Lisbon 2008 — IST/MARETEC — https://maretec.tecnico.ulisboa.pt/~maretec.daemon/html_files/VV2010_files/ValidationProcedure.pdf (accessed 2026-10)
- [R34] R. G. Hills, "Overview of ASME V&V 20-2009 Standard for Verification and Validation in Computational Fluid Dynamics and Heat Transfer", SAND2010-1461C — Sandia — https://sandia.gov/research/publications/details/overview-of-asme-vv-20-2009-standard-for-verification-and-validation-in-com-2010-03-01 (accessed 2026-10)
- [R35] ASME V&V 10-2019 recognized-standard entry (scope, companion documents) — US FDA — https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfStandards/detail.cfm?standard__identification_no=43693 (accessed 2026-10)
- [R36] D. Moorcroft, "Model Verification and Validation Process" (FAA, 2012) — FAA / NIAR — https://faa.niar.wichita.edu/Portals/0/Model%20Validation%20Process2.pdf (accessed 2026-10)
- [R37] Sprague-Geers Combined Metric (sgcm) function reference — Altair HyperWorks — https://help.altair.com/2022/hwdesktop/hwd/topics/reference/math/sgcm.htm (accessed 2026-10)
