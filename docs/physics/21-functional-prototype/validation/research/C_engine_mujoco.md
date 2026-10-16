# Research C: gas-driven piston, closed loops, crankshaft, gear and propeller in MuJoCo (llull)

Date of research: 2026-10-16. Every claim is tagged [Rn]. Each Rn is a URL that was actually fetched during this research (see the
reference list at the end). Values marked **UNCONFIRMED** were not found in a fetched source. Values marked **DERIVED** are
my own arithmetic from cited inputs. They are not quoted from a source.

Note on MuJoCo sources: I fetched the readthedocs XML reference page [R1]. The other MuJoCo documentation chapters were read from
the documentation's own reStructuredText source on GitHub `main` (`doc/*.rst`). That source is what builds
mujoco.readthedocs.io, and the readthedocs URL of each chapter is listed next to its source. Because `main` can be ahead of a
release, I checked version-sensitive items against the changelog [R7]. llull pins `@mujoco/mujoco` **3.14.0**
(`packages/physics-mujoco/package.json`). The latest npm version is 3.16.0, published 2026-10-14 [R11].

---

## 1. MuJoCo: closed loops, reactions, contacts, integrators, WASM

### 1.1 Equality constraints (loop closure)

Shared attributes are `name`, `class`, `active` (default `"true"`), `solref` and `solimp`. `active` initialises
`mjModel.eq_active0`, and that initialises `mjData.eq_active`, which can be changed at runtime [R1][R6].

| Type | Residual dim | Semantics | Use in this engine |
|---|---|---|---|
| `connect` (body1+anchor[+body2], or site1+site2) | 3 | Ball joint outside the tree; the residual is the difference of the global 3D positions of the two anchor points. Two connects on the same pair give a hinge outside the tree [R2]. The site form lets the sites "snap together" when they do not overlap at qpos0, and it follows runtime `site_pos` changes [R1]. | Closes the wrist-pin loop between the rod small end and the piston pin. |
| `weld` | 6 | Removes all relative DOFs. The orientation residual is sin(θ/2)·axis, which becomes weak near 180° [R2]. `relpose` default is `"0 1 0 0 0 0 0"`, `torquescale` default is 1 [R1]. | Not needed (rigid sub-assemblies should be single bodies). |
| `joint` | 1 | y − y0 = a0 + a1(x−x0) + a2(x−x0)² + a3(x−x0)³ + a4(x−x0)⁴. `polycoef` default is `"0 1 0 0 0"`; slide and hinge joints only [R1]. The docs name "mechanical coupling" as a use [R2]. | **Reduction gear**: `joint1=prop_hinge`, `joint2=crank_hinge`, `polycoef="0 k 0 0 0"` with k = ±1/ratio (for example 1/2.43 for Rotax 912 iS, sign = rotation sense). |
| `tendon` | 1 | Same polynomial applied to tendon lengths [R1]. | Not needed. |

The enum `mjtEq` is `mjEQ_CONNECT=0, mjEQ_WELD, mjEQ_JOINT, mjEQ_TENDON, mjEQ_FLEX, mjEQ_FLEXVERT, mjEQ_FLEXSTRAIN, mjEQ_DISTANCE` (DISTANCE is
unsupported) [R5].

**Official caveats (important for the spec):**
- The docs say loop joints via equality constraints are "not recommended -- because it leads to both slower and less accurate
  simulation" [R2]. The only reason given to represent tree joints that way is softness. A closed linkage cannot be a tree,
  so equality constraints are the only way to close it with real bodies.
- For slider-cranks specifically, MuJoCo has a **built-in `slider-crank` actuator transmission** (`cranksite`, `slidersite`,
  `cranklength`). The docs say: "Slider-cranks can also be modeled explicitly by creating MuJoCo bodies and coupling them with
  equality constraints, but that is both less efficient and less stable" [R2]. In that transmission the connecting rod is
  implicit: it is "not a separate model element" and has only a length [R1]. The slider moves along the slidersite z-axis [R1].
  The pedagogical model is `model/slider_crank/slider_crank.xml` [R10]. **Consequence**: the transmission gives exact
  force-to-torque geometry but has **no rod or piston mass**, so it carries no reciprocating inertia, no wall side thrust and no
  pin reactions.

**Recommended topology (DERIVED design, built from the cited semantics):**
```
world
 ├─ crank (hinge, axis = crankshaft)          ← flywheel/prop inertia here or on prop body
 │   └─ rod (hinge at crank pin, parallel axis)   (parent–child contacts auto-filtered)
 ├─ piston_k (slide along cylinder axis)       ← gas force actuator on this slide joint
 ├─ prop (hinge)                               ← only if geared; else make prop part of crank
equality:
  connect site1=rod_k_smallend site2=piston_k_pin        (3 rows; 1 is redundant in a planar mechanism)
  joint   joint1=prop_hinge joint2=crank_hinge polycoef="0 k 0 0 0"
```
In a planar slider-crank the out-of-plane component of the connect is already satisfied by the tree, so that row is
redundant. MuJoCo's soft constraints are regularised (R > 0, see 1.2), and this is what lets the solver accept redundant rows.
The regularisation itself is stated in [R2]; the handling of redundancy is an inference from it and is UNCONFIRMED by a direct
statement in the docs. For an O-320 class engine, use 4 rods and 4 pistons with one loop per cylinder. The throw phases follow
the firing order 1-3-2-4 [R20] with 180° crank spacing between firings in a 4-stroke four-cylinder engine. That spacing is
DERIVED as 720°/4.

### 1.2 Soft-constraint model (`solref`, `solimp`) and loop-closure error

- Constraint-space dynamics: a₁ + d·(b·v + k·r) = (1 − d)·a₀, with a_ref = −b·v − k·r [R3]. Here r is the residual and a₀
  the unconstrained acceleration. d → 1 gives a hard constraint; d → 0 gives no constraint [R2].
- `solimp` default is `"0.9 0.95 0.001 0.5 2"` = (d0, d_width, width, midpoint, power). For equality constraints r is the
  violation itself. d is clamped to [mjMINIMP, mjMAXIMP] = [0.0001, 0.9999] [R3].
- `solref` default is `"0.02 1"` = (timeconst, dampratio). Then b = 2/(d_w·timeconst) and
  k = d(r)/(d_w²·timeconst²·dampratio²). The direct format (−stiffness, −damping) is also accepted [R3].
- **timeconst should be at least 2× the timestep**. With `refsafe` enabled (the default), the solver uses
  max(solref[0], 2·timestep) [R1][R3].
- **Steady violation under constant load** (constant impedance): r = a₀·(1 − d)·timeconst²·dampratio² [R3]. This is the
  loop-closure error formula.
- The regulariser is R_ii = (1−d_i)/d_i · Â_ii, where Â is a diagonal approximation of A = J M⁻¹ Jᵀ frozen at `qpos0`. It can
  be badly wrong for long chains far from qpos0. The `diagexact` flag computes the exact diagonal [R2]. That flag was added in
  3.9.0 [R7], so it is available in 3.14.0.

**DERIVED estimate for the wrist pin:** take an O-320 piston area of 0.01331 m² (bore 5.125 in [R20]). At an assumed 50 bar
peak, F ≈ 66.5 kN. The 50 bar figure is the Simscape default table peak [R14], not engine data. With an assumed effective
constraint mass of about 1 kg (UNCONFIRMED), a₀ ≈ 6.6·10⁴ m/s².
- Default `solref 0.02 1` and `solimp d≈0.9`: r ≈ 6.6e4 × 0.1 × 4e-4 ≈ **2.6 m**. The defaults are useless for engine loads.
- `timestep = 2e-5`, `solref = "4e-5 1"`, `solimp = "0.9999 0.9999 0.001 0.5 2"`: r ≈ 6.6e4 × 1e-4 × 1.6e-9 ≈ **1e-8 m**.

The spec must override `solref` and `solimp` on every engine equality. It should also log max |efc_pos| over the equality rows
as a quality metric (`efc_pos` = "constraint position (equality, contact)" [R5]).

### 1.3 Reading constraint and reaction forces

All the fields and functions below exist in the WASM bindings (grep of the generated `bindings.cc` [R9]): `efc_force`, `efc_type`,
`efc_id`, `efc_pos`, `nefc`, `ne`, `eq_active`, `eq_data`, `eq_solref`, `eq_solimp`, `qfrc_constraint`, `cfrc_int`, `cfrc_ext`,
`sensordata`, and `mj_rnePostConstraint`, `mj_contactForce`, `mj_step1`, `mj_step2`, `mj_forward`, `mj_inverse`, `mj_name2id`,
`mj_jac`, `mj_jacSite`, `mj_objectVelocity`, `mj_setConst`, `mj_constraintUpdate`.

- `efc_type[i]` (mjtConstraint: `mjCNSTR_EQUALITY=0`, FRICTION_DOF, FRICTION_TENDON, LIMIT_JOINT, LIMIT_TENDON, CONTACT_*) and
  `efc_id[i]` ("id of object of specified type") identify each row. `efc_force[i]` is the "constraint force in constraint
  space" [R5]. **Wrist-pin force** = the 3 rows with type EQUALITY and id = connect eq id. These are in world axes because the
  residual is a global position difference [R2]. The **sign convention is UNCONFIRMED**: verify with a static test.
  **Gear tooth load** = the 1 row of the `joint` equality, in generalized-force units.
- `qfrc_constraint` (nv) = Jᵀ·f, the constraint force in joint space [R5]. Its value on the crank hinge is the torque that the
  loops transmit.
- `mj_rnePostConstraint` computes `cacc`, `cfrc_int` (interaction force with the parent body) and `cfrc_ext` (external force on
  the body). These are 6D `[rotation(3), translation(3)]` in the **subtree-COM-based c-frame**, so a transform is needed to get a
  bearing point [R4]. `cfrc_ext` collects "applied Cartesian forces (xfrc_applied), contacts, connect and weld constraints, and
  spatial tendons". `cfrc_int` is "the wrench transmitted through the joint, and its projection on the joint axes is the total
  joint-space force". **Limitation**: forces of actuators with **site, slider-crank and body transmissions**, gravity
  compensation and fluid forces "are not yet collected and are attributed to the joints" [R4]. So with the explicit-loop
  topology, **main-bearing reaction** = `cfrc_int[crank]`.
- The function runs automatically when `force`, `torque`, `accelerometer`, `framelinacc` or `frameangacc` sensors are present
  [R4]. Otherwise call it after `mj_step` or `mj_forward`. It is bound in WASM [R9].
- The `force` and `torque` sensors (attribute `site`) report the 3-axis interaction between the site's body and its **parent**,
  in the site frame, pointing child→parent. The docs say this "often requires creating a dummy body welded to its parent" [R1].
  In a loop, use it for tree joints only (crank↔world bearing, rod↔crank pin). Use `efc_force` for the loop-closure pin.
- `jointactuatorfrc` sensor (attribute `joint`) = the generalized force from all actuators on one scalar joint [R1]. Use it to
  log the gas force on each piston slide.
- Version note: a 3.14.0 fix corrected the weld torque in `mj_rnePostConstraint` (scaling by 0.5·torquescale and rotation into
  the world frame). The same release made `rnePostConstraint` account for spatial tendon forces [R7]. llull is on 3.14.0, so both
  fixes are included.

### 1.4 Applying the gas force

DERIVED recommendation: use a `<general>` (or `<motor>`) actuator on each piston `slide` joint with gain 1, `ctrllimited=false`
and `ctrl[k] = F_gas(θ, ω)`, written every step before `mj_step`. A joint transmission is collected correctly (only site,
slider-crank and body transmissions are excluded from `cfrc_*` [R4]), and `jointactuatorfrc` reads it back [R1]. Alternatives:
`qfrc_applied`, or `xfrc_applied` on the piston body (counted in `cfrc_ext` [R4]).
`mj_step1`/`mj_step2` are bound [R9], which allows computing F after the position stage of the same step.

### 1.5 Contacts

- The default `contype`/`conaffinity` are `"1"`/`"1"`. Two geoms collide if one's contype shares a bit with the other's
  conaffinity [R1].
- `<contact><exclude body1 body2>` excludes all geom pairs between two **bodies** [R1].
- Parent–child pairs are filtered automatically **unless the parent is the world body**. Bodies welded with no joints count as
  one body for this test [R2]. The `filterparent` flag controls this [R1].
- **Consequence**: piston (child of world) vs a cylinder or crankcase geom on world will collide, and so will rod vs piston
  (loop, not parent–child). Give mechanism geoms `contype=0 conaffinity=0`, or add `<exclude>` for piston–world-geom,
  rod–piston and crank–rod pairs. The `contact` flag disables all collision [R1].

### 1.6 Integrators and timestep

- `integrator` ∈ {Euler (default), RK4, implicit, implicitfast, discrete} [R1]. `mjtIntegrator` = EULER=0, RK4, IMPLICIT,
  IMPLICITFAST, DISCRETE [R5].
- Euler is semi-implicit with implicit **joint damping** only. `implicit` includes all force derivatives except constraint
  forces. `implicitfast` drops the RNE (Coriolis/centripetal) derivatives and symmetrizes D, which allows a Cholesky factorization
  [R2]. RK4: "for energy-conserving systems ... RK4 is qualitatively better than the single-step methods ... even when the
  timestep is decreased by a factor of 4" [R2]. `discrete` was added in 3.13.0 [R7] and is new and experimental in character.
- `timestep` default is 0.002 s, described as "the single most important parameter" for the speed/accuracy trade-off. Softer
  constraints allow larger steps. RK4 costs about 4 single steps [R1].
- **DERIVED timestep guidance:** 1° of crank takes 61.7 µs at 2700 rpm (O-320) and 28.7 µs at 5800 rpm (Rotax 912 iS).
  Resolving a Wiebe burn of about 40–60° (UNCONFIRMED typical) at ≤0.5° per step needs **dt ≈ 10–30 µs**. The equality
  timeconst is then ≥ 2·dt = 20–60 µs.
- Solver default is `Newton` (alternatives PGS, CG) [R1].

### 1.7 JS/WASM bindings facts [R8]

- `npm install @mujoco/mujoco`. The package is ESM and bundles the `.wasm`. The default build is single-threaded; `/mt` uses
  SharedArrayBuffer and needs COOP/COEP headers.
- The bindings are a work in progress. Windows support is called experimental (as of 2025-11-13). Main APIs (`mj_step`,
  `mj_loadXML`) are well tested; `mjspec` is less so.
- Named access: `model.geom('name')`, `data.jnt('name')`. Large arrays (`qpos` and so on) are **live views** into WASM memory.
  `data.contact` is a **copy**.
- Every embind object needs `.delete()`. Out-parameters use `mujoco.DoubleBuffer` and similar classes. Matrices are row-major
  flat TypedArrays. Enums are read with `.value`. The npm version equals the MuJoCo version.

---

## 2. Slider-crank: exact kinematics and dynamics [R12] (cross-check [R14])

Notation: crank radius r, rod length l, λ = r/l (the notes use n = l/r = 1/λ), crank angle θ from TDC/IDC, rod obliquity β,
ω = θ̇ and α = θ̈.

- Obliquity: sin β = λ sin θ [R12].
- Piston displacement from TDC (exact): x = r[(1 − cos θ) + n − √(n² − sin²θ)] [R12], which is the same as
  x = r(1−cos θ) + l(1 − √(1 − λ² sin²θ)).
- Velocity (exact): v = rω[sin θ + sin 2θ / (2√(n² − sin²θ))] [R12].
  Approximate form: v ≈ rω(sin θ + λ sin 2θ / 2) [R12].
- Acceleration: the notes give f ≈ rω²(cos θ + cos 2θ / n) and state that it comes from differentiating the *approximate*
  velocity [R12]. **Exact (DERIVED by differentiating the exact x):**
  a = rω²[cos θ + λ(cos 2θ·(1−λ²sin²θ) + λ² sin²2θ/4)/(1−λ²sin²θ)^{3/2}] + rα[sin θ + λ sin 2θ/(2√(1−λ²sin²θ))].
- Rod angular velocity: ω_c = ω cos θ / √(n² − sin²θ). The angular acceleration formula is also given in [R12].
- Forces (rod inertia neglected in the simple form) [R12]:
  - Piston effort F = F_gas − F_inertia (− friction) (+ m g for a vertical engine), with F_gas = p₁A₁ − p₂A₂ and
    F_inertia = m_rec·rω²(cos θ + cos 2θ/n).
  - Force along the rod: F_c = F / cos β.
  - **Side thrust on the cylinder wall: F_n = F tan β.**
  - Crank effort (tangential): F_t = F sin(θ+β)/cos β.
  - Radial bearing thrust: F_r = F cos(θ+β)/cos β.
  - **Crank torque: T = F_t·r = F·r·sin(θ+β)/cos β = F·r[sin θ + sin 2θ/(2√(n² − sin²θ))]** [R12]. This equals F·(dx/dθ),
    which is the virtual-work identity (DERIVED).
- Rod inertia: the notes treat it with a dynamically equivalent two-mass system (masses at the pin centres) plus a correction
  torque [R12]. In MuJoCo the rod is a real body, so no equivalence is needed. The analytic model needs it for validation.
- Cross-check: the Simscape Driveline "Piston" block uses the same torque/force ratio, T/F = −c(sin θ + sin 2θ / (2√((r/c)² −
  sin²θ))) with c = crank and r = rod. Its defaults are bore 0.10 m, stroke 0.06 m, rod 0.1 m, 4 strokes, and gauge pressure
  table [0, 3, 20, 50, 20, 10, 8, 0] bar versus crank angle [R14].

---

## 3. Cylinder pressure model (SI aviation piston engine)

- **Cylinder volume** (DERIVED from §2): V(θ) = V_c + A·x(θ), with V_c = V_d,cyl/(r_c − 1) and A = πB²/4.
- **Wiebe function** [R15]: x_b(θ) = 1 − exp[−a((θ − θ₀)/Δθ)^{m+1}], where a is the "efficiency parameter", m the "form
  factor", θ₀ the start of combustion and Δθ the duration.
  - "a" is tied to the end-of-burn convention: a = 2.3026 when Δθ is the 0–90 % duration, and a = 6.9078 for 0–99.9 % [R15].
  - "The frequently used values of a_w and m_w for petroleum gasoline are 5 and 2, respectively", citing Heywood 2nd ed. [R16].
  - DERIVED: a = 5 means 1 − e⁻⁵ = 99.33 % burned at θ₀ + Δθ.
  - Typical Δθ and θ₀ for aviation engines: **UNCONFIRMED**. The O-320 spark timing is fixed at **25° BTC** [R20], which gives
    the order of θ₀.
- **Single-zone model**: the first-law energy balance is chemical release = dU_s + p dV + heat loss + crevice flow
  [R17][R19]. With heat transfer and crevices neglected, net heat release is
  **dQ_net/dθ = γ/(γ−1)·p·dV/dθ + 1/(γ−1)·V·dp/dθ** [R19]. Inverted for the forward simulation (DERIVED):
  **dp/dθ = [(γ−1)·dQ/dθ − γ·p·dV/dθ] / V**, with dQ/dθ = Q_total·dx_b/dθ. Q_total = m_fuel·Q_LHV·η_comb and needs
  air-flow and AFR inputs (UNCONFIRMED values). [R19] takes γ as the polytropic index of compression before ignition,
  γ = log(p₀/p₁)/log(V₁/V₀).
- **Polytropic compression and expansion**: pVⁿ = const. Rassweiler–Withrow mass-fraction-burned analysis uses polytropic n
  for back- and forward-tracking [R17]. **n ≈ 1.3 is a common modelling assumption, but no fetched primary source gives it.
  Mark as UNCONFIRMED.** A simple model: n_c for compression, n_e for expansion, and a Wiebe-shaped pressure rise in between.
- **Mean effective pressure ↔ power** [R18]: BMEP = P_b / (V_D·N / n_R), with N in rev/s and n_R = 2 for four-stroke.
  So **P = MEP·V_D·N/(2) with N in rev/s, which equals MEP·V_D·rpm/(2·60)**. The same relation holds for IMEP and indicated
  power.
- **Typical peak cylinder pressure for naturally aspirated aviation engines: UNCONFIRMED.** No fetched source gives a measured
  value. The 50 bar peak in the Simscape default table [R14] is a placeholder, not engine data. The best route is to calibrate
  Q_total so that the simulated mean torque matches the rated power (see the table below).
- Reference text: Heywood, *Internal Combustion Engine Fundamentals*, 2nd ed., McGraw Hill 2018, ISBN-13 9781260116106 [R24].
  The 1st edition is McGraw-Hill 1988 [R15 refs].

### Engine data table

| Item | Lycoming O-320-A/-E | Lycoming O-320-B/-D | Continental O-200-A/B/C | Rotax 912 iS Sport |
|---|---|---|---|---|
| Source | Operator's Manual 60297-30 [R20]; TCDS E-274 Rev 21 [R21] | [R20][R21] | EASA TCDS IM.E.101 Iss. 03 [R22] | BRP-Rotax datasheet 2021/01 [R23] |
| Type | 4-cyl horizontally opposed, direct drive, air-cooled [R20] | same | 4-cyl HO, 4-stroke, SI, air-cooled, carbureted [R22] | 4-cyl opposed, 4-stroke, liquid/air cooled [R23] |
| Bore × stroke | 5.125 × 3.875 in [R20][R21] | same | 103.2 × 98.4 mm (4.0625 × 3.875 in) [R22] | 84.0 × 61.0 mm [R23] |
| Displacement | 319.8 in³ [R20][R21] | same | 3.29 dm³ (201 in³) [R22] | 1352 cm³ [R23] |
| Compression ratio | 7.0:1 [R20] (TCDS lists 7.00 / 9.00 / 8.50 across models [R21]) | 8.5:1 [R20] | 7:1 (8.5:1 O-200-D) [R22] | **UNCONFIRMED** (not on datasheet) |
| Rated power | 150 hp @ 2700 rpm [R20][R21] | 160 hp @ 2700 rpm [R20][R21] | 74.6 kW (100 hp) @ 2750 rpm, takeoff and max continuous [R22] | 73.5 kW (100 hp) @ 5800 rpm (5 min); 72.0 kW max continuous @ 5500 [R23] |
| Torque (maker) | n/a | n/a | n/a | 121 N·m @ 5800, 125 @ 5500, 132 @ 5000 [R23] |
| Firing order | 1-3-2-4 [R20] | 1-3-2-4 [R20] | **UNCONFIRMED** | **UNCONFIRMED** |
| Spark timing | 25° BTC [R20] | 25° BTC [R20] | **UNCONFIRMED** | electronic [R23] |
| Prop drive | 1:1, clockwise viewed from rear [R20] | same | Gear ratio N/A (direct) [R22] | gearbox i = 2.43 with overload clutch [R23] |
| Dry weight | n/a | n/a | 86.2 kg (O-200-A/B/C) [R22] | 63.6 kg engine with gearbox [R23] |
| Rod length (λ) | **UNCONFIRMED** | **UNCONFIRMED** | **UNCONFIRMED** | **UNCONFIRMED** |
| Piston / rod mass | **UNCONFIRMED** | **UNCONFIRMED** | **UNCONFIRMED** | **UNCONFIRMED** |
| DERIVED crank radius r | 49.2 mm | 49.2 mm | 49.2 mm | 30.5 mm |
| DERIVED piston area | 0.01331 m² | 0.01331 m² | 0.00836 m² | 0.00554 m² |
| DERIVED BMEP at rating | 9.49 bar | 10.12 bar | 9.88 bar | 11.25 bar |
| DERIVED mean torque at rating | 395.6 N·m | 422.0 N·m | 259.0 N·m | 121.0 N·m (matches maker's 121 N·m [R23]) |
| DERIVED rω² | 3934 m/s² | 3934 m/s² | 4081 m/s² | 11252 m/s² |

The Rotax 912 iS is the only one of these with a reduction gear, so it is the natural target for the requested
"→ reduction gear → propeller" chain. Lycoming and Continental are direct drive [R20][R22].

---

## 4. Validation references for engine dynamics

- **Analytic torque per cylinder** (§2 [R12]): T(θ) = [p(θ)A − m_rec·a(θ)]·r·sin(θ+β)/cos β, plus the rod-inertia correction.
  Summing cylinders with the firing phase gives the crank-angle-resolved validation curve. Simscape's Piston block uses the same
  ratio [R14], and its Piston Engine block derives "instantaneous torque" for "vibrations in the drivetrain" from a crank-angle
  pressure table (search snippet of the same MathWorks page family).
- **Cycle-energy check** (DERIVED from [R18]): ∮T dθ over 720° = IMEP·V_D. Mean torque = MEP·V_D/(4π) for a 4-stroke.
  The DERIVED BMEP values above cross-check against rated power. The Rotax 121 N·m cross-check closes to rounding.
- **Flywheel / speed fluctuation** [R25]: ΔE = ∫(τ − τ_m)dθ over an excess loop, and ΔE = ½I(ω₁² − ω₂²). The coefficient of
  fluctuation of speed is (ω₁ − ω₂)/ω₀ = ΔE/(I·ω₀²), often expressed as ±ΔE/(2Iω₀²). [R25] gives no "permissible" values; its
  ±1 % and ±3 % are example targets. Sim test: hold a constant load torque = mean torque and compare the simulated ω ripple
  with ΔE/(Iω₀²).
- **MuJoCo reference model**: `model/slider_crank/slider_crank.xml` (forward, backward and "broken" crank examples) [R10].
  It can serve as a regression scene for the transmission variant.
- **Educational benchmark**: Nagchaudhuri (ASEE) derives the nonlinear EOM of a motor-driven crank-slider and shows that
  MATLAB and Working Model give similar results [R13]. It is qualitative only and has no published numeric tolerance.
- **Wiebe fit validation**: Yeliana et al. fit Wiebe parameters to single-zone MFB on a CFR engine at 330 kPa net IMEP. The
  fitted Wiebe reproduces combustion phasing to < 0.2° CA, and they re-compute pressure and IMEP from the fit [R15]. This is a
  good template for a "pressure → IMEP" closure test.
- **Not found**: a published crank-angle-resolved torque trace for an O-320, O-200 or Rotax 912, or an Adams/MuJoCo benchmark
  with numbers. **UNCONFIRMED.**

---

## 5. Propeller beyond static thrust

- Coefficients (NACA symbols) [R27]: J = V/(nD) "advance-diameter ratio", C_T = T/(ρn²D⁴), C_P = P/(ρn³D⁵),
  C_Q = Q/(ρn²D⁵), with n in **revolutions per second**. DERIVED: η = T·V/P = J·C_T/C_P, and C_P = 2π·C_Q because P = 2πnQ.
  The current static model T = Ct·ρ·n²·D⁴ is the J = 0 point, C_T0.
- Full-scale data: NACA TR-640, Hartman & Biermann, "The aerodynamic characteristics of full-scale propellers having 2, 3, and
  4 blades of Clark Y and R.A.F. 6 airfoil sections". It covers seven 10-ft propellers, blade angles up to 45°, design charts
  and take-off thrust methods [R26]. The OCR text is poor, so read the C_T(J) and C_P(J) charts from the scanned PDF.
  NACA ACR 4B04 (Crigler 1944) compares calculated and experimental characteristics using a Goldstein correction factor F and
  an axial interference factor a [R27].
- NACA Report 684: "Static Thrust and Power Characteristics of Six Full-Scale Propellers" (1940). This title comes from a
  library finding-aid search result only (wright.libraryhost.com). **I did not fetch an NTRS PDF, so this is UNCONFIRMED.**
- **Momentum (actuator disk)** [R28-29]: ṁ = ρAV₁, T = ṁ(V_e − V) = A(p₂ − p₁). Induced efficiency → 1 as induced velocity → 0
  (search snippet).
- **Blade element** [R28]: dT = q c dr (C_l cos φ − C_d sin φ)/sin²φ and dQ = q c r dr (C_l sin φ + C_d cos φ)/sin²φ, with
  V_R = V/sin φ and q = ½ρV². Integrate over the B blades. Blade-element efficiency =
  V·dT/(2πn·dQ) = (C_l cos φ − C_d sin φ)/(C_l sin φ + C_d cos φ)·tan φ. BEMT couples this with momentum through the
  interference factors a and a′ [R27 symbols]. DERIVED standard practice: iterate a and a′ per annulus.
- Low-Reynolds C_T(J), C_P(J) datasets (UIUC, Brandt & Selig, AIAA 2011-1255) use "standard definitions" and McCormick (1995)
  [R29]. They are useful for small or UAV props, less so for 6-ft aviation props.
- **Recommended model for llull (DERIVED):** tabulated C_T(J), C_P(J) per propeller, from TR-640 charts or UIUC files. Apply
  T = C_T(J)ρn²D⁴ along the prop axis and Q = C_P(J)ρn²D⁵/(2π) as a reaction torque on the prop hinge each step. J uses the
  airspeed and n from `qvel` of the prop hinge. Q closes the loop, so engine and propeller find their own equilibrium rpm.
  A BEMT upgrade can come later.

---

## References (all fetched 2026-10)

- [R1] MuJoCo XML Reference — Google DeepMind — https://mujoco.readthedocs.io/en/stable/XMLreference.html (fetched); full text read from https://raw.githubusercontent.com/google-deepmind/mujoco/main/doc/XMLreference.rst (accessed 2026-10)
- [R2] MuJoCo Computation chapter — Google DeepMind — https://mujoco.readthedocs.io/en/stable/computation/index.html ; source https://raw.githubusercontent.com/google-deepmind/mujoco/main/doc/computation/index.rst (accessed 2026-10)
- [R3] MuJoCo Modeling chapter, "Solver parameters" — Google DeepMind — https://mujoco.readthedocs.io/en/stable/modeling.html#csolver ; source https://raw.githubusercontent.com/google-deepmind/mujoco/main/doc/modeling.rst (accessed 2026-10)
- [R4] MuJoCo API Functions (mj_rnePostConstraint) — Google DeepMind — https://mujoco.readthedocs.io/en/stable/APIreference/APIfunctions.html#mj-rnepostconstraint ; source https://raw.githubusercontent.com/google-deepmind/mujoco/main/doc/APIreference/functions.rst (accessed 2026-10)
- [R5] MuJoCo API types (mjData/mjModel fields, enums) — Google DeepMind — https://mujoco.readthedocs.io/en/stable/APIreference/APItypes.html ; source https://raw.githubusercontent.com/google-deepmind/mujoco/main/doc/includes/references.h (accessed 2026-10)
- [R6] MuJoCo Programming / Simulation (eq_active, efc_address) — Google DeepMind — https://mujoco.readthedocs.io/en/stable/programming/simulation.html ; source https://raw.githubusercontent.com/google-deepmind/mujoco/main/doc/programming/simulation.rst (accessed 2026-10)
- [R7] MuJoCo Changelog — Google DeepMind — https://mujoco.readthedocs.io/en/stable/changelog.html ; source https://raw.githubusercontent.com/google-deepmind/mujoco/main/doc/changelog.rst (accessed 2026-10)
- [R8] MuJoCo JavaScript Bindings README — Google DeepMind — https://raw.githubusercontent.com/google-deepmind/mujoco/main/wasm/README.md (accessed 2026-10)
- [R9] Generated embind bindings — Google DeepMind — https://raw.githubusercontent.com/google-deepmind/mujoco/main/wasm/codegen/generated/bindings.cc (accessed 2026-10)
- [R10] slider_crank.xml example model — Google DeepMind — https://raw.githubusercontent.com/google-deepmind/mujoco/main/model/slider_crank/slider_crank.xml (accessed 2026-10)
- [R11] @mujoco/mujoco package metadata — npm registry — https://registry.npmjs.org/@mujoco/mujoco (accessed 2026-10)
- [R12] Kinematics and Dynamics of Machines, Module 3 (velocity/acceleration of piston, engine force analysis) — Government College of Engineering, Patna — https://gcekbpatna.ac.in/assets/documents/lecturenotes/KDM_module_3.pdf (accessed 2026-10)
- [R13] A. Nagchaudhuri, "Dynamic Modeling and Analysis of a Crank Slider Mechanism", ASEE Session 1566 — ASEE PEER — https://peer.asee.org/dynamic-modeling-and-analysis-of-a-crank-slider-mechanism.pdf (accessed 2026-10)
- [R14] Piston (Simscape Driveline block reference) — MathWorks — https://www.mathworks.com/help/sdl/ref/piston.html (accessed 2026-10)
- [R15] Yeliana, Cooney, Worm, Michalek, Naber, "Wiebe Function Parameter Determination for Mass Fraction Burn Calculation in an Ethanol-Gasoline Fuelled SI Engine", Journal of KONES 15(3) 2008 — https://bibliotekanauki.pl/articles/949481.pdf (accessed 2026-10)
- [R16] Alam, Rosa, Depcik, Burugupally, "Modification of the Wiebe function for methane-air and oxy-methane-based spark-ignition engines", Fuel 303 (2021) 121218 — https://depcik.ku.edu/sites/depcik/files/images/Alam2021.pdf (accessed 2026-10)
- [R17] MIT 2.61 Internal Combustion Engines, Lecture 09 "SI engine combustion I" — MIT — https://web.mit.edu/2.61/www/Lecture%20notes/Lec.%2009%20SI%20engine%20combustion%20I.pdf (accessed 2026-10)
- [R18] MIT 2.61 (Spring 2017) Lecture 2, engine operating characteristics (BMEP = P_b/(V_D N/n_R)) — MIT OCW — https://ocw.mit.edu/courses/2-61-internal-combustion-engines-spring-2017/cf3aaf55ae71710c9bfd3056515b9b67_MIT2_61S17_lec2.pdf (accessed 2026-10)
- [R19] M. Chwist, "Comparative analysis of heat release in a reciprocating engine powered by a regular fuel with pyrolysis oil addition", Combustion Engines 190(3) 2022, doi 10.19206/CE-146694 — https://www.combustion-engines.eu/pdf-146694-76940?filename=Comparative+analysis+of.pdf (accessed 2026-10)
- [R20] Lycoming O-320 Series Operator's Manual, 3rd ed., P/N 60297-30 (Oct 2006) — Lycoming — https://www.lycoming.com/sites/default/files/attachments/O-320%2520Operator%2520Manual%252060297-30.pdf (accessed 2026-10)
- [R21] FAA Type Certificate Data Sheet E-274 Rev 21 (Aug 10 2009), Lycoming O-320 series (NTSB docket copy) — FAA via NTSB — https://data.ntsb.gov/Docket/Document/docBLOB?ID=40381291&FileExtension=.PDF&FileName=Engine+Type+Certificate+Data+Sheet+for+Lycoming+O-320-E2D-Master.PDF (accessed 2026-10)
- [R22] EASA TCDS IM.E.101 Issue 03 (03 Sep 2020), Continental C90 & O-200 series — EASA — https://www.easa.europa.eu/en/downloads/7643/en (accessed 2026-10)
- [R23] Datasheet Aircraft Engine 912 iS / iSc Sport (Vers. 2021/01) — BRP-Rotax — https://www.flyrotax.com/assets/files/products/Datasheet-Aircraft-Engine-912-iS-iSc-Sport.pdf (accessed 2026-10)
- [R24] J. B. Heywood, Internal Combustion Engine Fundamentals 2E, McGraw Hill 2018, ISBN 9781260116106 (catalogue listing) — AbeBooks — https://www.abebooks.com/9781260116106/Internal-combustion-engine-fundamentals-Ingegneria-1260116107/plp (accessed 2026-10)
- [R25] Turning Moment Diagrams with particular reference to Engines and Flywheels — CodeCogs — https://www.codecogs.com/page/1245/v/3736 (accessed 2026-10)
- [R26] E. P. Hartman, D. Biermann, NACA TR-640 (1938) — NASA NTRS — https://ntrs.nasa.gov/api/citations/19930091715/downloads/19930091715.pdf (accessed 2026-10)
- [R27] J. L. Crigler, NACA ACR 4B04 (1944), "Comparison of calculated and experimental propeller characteristics for four-, six-, and eight-blade single-rotating propellers" (symbols: J, C_T, C_P, C_Q, F, a) — NASA NTRS — https://ntrs.nasa.gov/api/citations/19930093324/downloads/19930093324.pdf (accessed 2026-10)
- [R28] B. Roy, A. M. Pradeep, Introduction to Propulsion, Lecture 30 (blade element theory) — IIT Bombay / NPTEL — https://archive.nptel.ac.in/content/storage2/courses/101101001/downloads/Intro-Propulsion-Lect-30.pdf (accessed 2026-10)
- [R29] UIUC Propeller Data Site — M. Selig, UIUC — https://m-selig.ae.illinois.edu/props/propDB.html (accessed 2026-10). Also used: Lecture 29 (momentum theory) https://archive.nptel.ac.in/content/storage2/courses/101101001/downloads/Intro-Propulsion-Lect-29.pdf (accessed 2026-10)
