# PHY-06: Nonlinear contact, friction and bolt preload — functional specification

Gap id **PHY-06** · prefix **CNT** · status: specification · written 2026-10-15 · technical spec:
[`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md) · validation: [`validation/README.md`](validation/README.md) · sources:
[`validation/sources.md`](validation/sources.md)

## 1. Summary

After the aerospace packs, parts in an llull analysis can only be glued together: aerospace 05 FEA lists "contact and
bolted joints (linear, tied)" as a V2 hook (`../../aerospace/05-fea-cae-handoff/FUNCTIONAL_SPEC.md` §4). Real joints
are not glued. Bolted flanges open under tension, clamped plates slip when friction is too low, pins bear on one side of
their hole, rollers and gears carry load through a contact patch a few millimetres wide, and preload is lost to
embedment and temperature. None of this can be analysed today, and neither can the hand checks that stress engineers
run first (Hertz contact, bolt separation and slip margins).

This pack adds, on top of PHY-05's `nonlinear_static` analysis:

1. **Contact pairs** between faces of different parts (or the same part), frictionless or with Coulomb friction, with
   the three CalculiX formulations (node-to-surface, surface-to-surface penalty, mortar) and tied contact as the linear
   special case that supersedes 05's V2 hook [R1].
2. **Bolt pretension** through CalculiX `*PRE-TENSION SECTION`, with preload as a force or derived from torque with an
   explicit nut factor, then locked so later steps see the clamped joint [R1].
3. **Read-only joint and contact checks** an agent can run without a mesh: Hertz contact (sphere, cylinder),
   interference fits, and a NASA-STD-5020 bolted-joint check (preload range, separation margin, slip margin, linear
   separation-before-rupture test) with the standard's own defaults named [R2].
4. **Results as data**: contact status, open / closed / slipping area, peak pressure, penetration, bolt forces per step,
   and a joint-separation flag.

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Threaded fastening systems in spaceflight hardware | NASA-STD-5020 requires analysis of maximum and minimum preload, separation (with a separation factor of safety) and joint slip when friction is a shear path; done in spreadsheets or vendor tools | `bolted_joint_check` reproduces the standard's equations with every input named, and links to llull's fastener stacks (08) | [R2] |
| Preload uncertainty from torque control | NASA-STD-5020 default Γ = 25 % (lubricated) / 35 % (dry) without test data; separation-critical joints need test-derived Γ (90 % probability, 95 % confidence) | The defaults are applied only with `defaulted: true` and a warning; separation-critical joints refuse defaults | [R2] |
| Friction as a shear load path | Friction coefficient capped at 0.2 (clean uncoated metal) and 0.1 (all other surfaces) unless test-substantiated | `CNT_FRICTION_ABOVE_CAP` when a higher μ has no test record | [R2] |
| Rollers, bearings, gears, cam followers | Hertz formulas by hand; FE contact in Abaqus / Ansys / code_aster | `hertz_contact` query and FE contact validated on code_aster SSNP154 (cylinder roller, the NAFEMS case) and SSNV104 (two spheres) | [R3], [R4] |
| Shrink fits, bushings, interference-fit pins | Lamé hand calculations | `interference_fit` query and FE check | — (derived) |
| Bolt preload in FE | Abaqus bolt load / CalculiX `*PRE-TENSION SECTION` | Pretension from a cut plane through a bolt part, force or torque-derived, locked in later steps | [R1] |
| Lugs and pin-loaded holes | Air Force stress manual / ESDU methods (not verified here); FE with pin contact | V1: pin-in-hole FE contact template; analytic lug method is an open item | §11 TS |

Value statements (sourced only): NASA-STD-5020 states that joints using threaded fasteners in structures under cyclic
loads are most dependable when shear is carried by friction or close-fit shear pins, and lists the effects of slip (load
redistribution, shock on hole contact, misalignment, preload loss, fatigue of threads in the shear plane) [R2]. A slip
check computed from the standard's own equations, with its friction caps enforced, removes a common hand-calculation
error and records its inputs with the design revision.

## 3. Personas & user stories

Roles follow [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) §1. Joint and contact results support
structural substantiation, so every result is `reviewRequired` (AF-33), defaults from the standard are named and flagged
(AF-31), and accepting a negative margin is a human act (05 `dispose_margin`, AF-34).

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent with the `llull` CLI (MCP in cloud) | `bolted_joint_check`, `hertz_contact`, `interference_fit`, `add_contact_pair`, `add_bolt_pretension`, `contact_report`, `check_contact` | Explicit inputs, the standard's defaults named, codes for every refusal |
| **Owner** | Person asking "will this bolted flange open?" or "is this roller overloaded?" — not assumed to be an engineer | Natural language | Plain answer: margins, what was assumed, what a qualified engineer must check |
| **Qualified reviewer** | Stress engineer / fastener specialist / DOA signatory | Desktop: contact pressure and status overlay, joint check table, disposition | Approves Γ, μ, φ and n choices; dispositions negative margins |

User stories:

- **US-1 (owner → operator).** "Check the four-bolt bracket joint for separation and slip." The agent calls
  `bolted_joint_check` with the torque spec, nut factor (from the owner or a test record), bolt count, stiffness factor
  and limit loads. It reports Pp-min, Pp-max, MS_sep, MS_slip, the Γ used (with `defaulted` and its source) and "computed
  by llull, not approved".
- **US-2 (operator).** The owner says the joint is separation-critical but has no torque-tension test data. The check
  refuses with `CNT_GAMMA_TEST_DATA_REQUIRED` (the standard requires test-derived Γ for separation-critical joints) instead of
  applying 25 %.
- **US-3 (operator).** For a flange where the stiffness factor φ is unknown, the agent builds the FE model: two plates and a
  bolt part, contact pairs between plate faces and under the head and nut, a bolt pretension of Pp-min, then the external
  load step. `contact_report` gives bolt force vs applied load and the load at which the flange contact area under the bolt
  reaches zero (separation); the agent derives φ·n from the bolt-force slope and feeds it back into `bolted_joint_check`.
- **US-4 (operator).** For a cam roller the agent runs `hertz_contact` (cylinder on flat) and an FE contact model; both
  values go into one JSON with their ratio.
- **US-5 (reviewer).** The reviewer opens the joint table, sees Γ = 0.25 `defaulted: true`, μ = 0.2 with the cap's source,
  and accepts or rejects a marginal slip margin through the 05 disposition dialog.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | Read-only checks: `hertz_contact` (sphere-sphere, sphere-plane, cylinder-cylinder, cylinder-plane), `interference_fit` (Lamé, plane stress / plane strain), `bolted_joint_check` (NASA-STD-5020 equations, torque-control preload, Table 1 adjustments, separation, slip, separation-before-rupture by linear theory). FE: contact pairs (node-to-surface, surface-to-surface, mortar), hard / linear / tied behaviour, Coulomb friction, `adjust`, bolt pretension (force or torque-derived), lock step; `contact_report`, `check_contact`; codes; VC-CNT-10…63. |
| **V1** | `joint_from_fastener_stack` (08 stacks → bolt part, pretension and contact pairs); pin-in-hole template (clearance pin, contact, bearing pressure); contact output on the 05 review overlay; joint stiffness factor extraction from FE (`joint_stiffness_from_fe`); temperature change of preload through PHY-04 thermal strain. |
| **V2** | Contact with plasticity at the contact (PHY-05 + PHY-06 together on lugs); cyclic slip and preload loss; gasket / seal behaviour (NASA-STD-5020 §6.5b requires seal-specific analysis); analytic lug method once a verified source is available. |
| **Out of scope** | Explicit-dynamics impact contact (PHY-19), wear, fretting fatigue (PHY-07 consumes contact results later), thread-level modelling, VDI 2230 clause content (paywalled: catalogue citation only), certification sign-off. |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-CNT-01 | MUST | **Contact pairs** on a `nonlinear_static` case between two 05 targets (slave, master) with formulation `node_to_surface` \| `surface_to_surface` \| `mortar` and behaviour `hard` \| `linear { slope }` \| `exponential { c0, p0 }` \| `tied { slope }`. All pairs in one analysis use one formulation (CalculiX rule) — mixing is refused. | Joints are not glued | [R1] |
| FR-CNT-02 | MUST | **Coulomb friction** per pair: μ and stick slope λ. λ, when not given, is CalculiX's default (first elastic constant of the first material / 2) and is returned named with `defaulted: true`. | Slip and stick | [R1] |
| FR-CNT-03 | MUST | **Bolt pretension** on a bolt part: section defined by a point and normal (the section is imprinted on the mesh), preload `{ force }` or `{ torque, nutFactor, diameter }` (nut factor required, never defaulted), applied in its own step, then **locked** (the pretension reference DOF held) for later steps. | Preloaded joints | [R1], [R2] |
| FR-CNT-04 | MUST | **Contact results as data** (`contact_report`): per pair and step — closed / open / sliding area and fraction, max and mean contact pressure with location, max penetration and max slip, per-bolt axial force; joint separation flag when the closed area under a bolt reaches zero. | AF-10/21 | [R1] |
| FR-CNT-05 | MUST | **Preload range** per NASA-STD-5020 for torque control: Ppi-nom = T/(K D); Ppi-max = (1 + Γ) Tmax/(K D); Ppi-min = (1 − Γ) Tmin/(K D) for separation-critical and fatigue analysis; (1 − Γ/n_f) Tmin/(K D) for slip and non-critical separation; Pp-max/min with relaxation, creep and thermal terms (Table 1: 5 % short-term relaxation for all-metallic joints, test-derived otherwise). Effective torque ranges from the specification and running torque (A.2-4…7). | Spaceflight fastener standard | [R2] |
| FR-CNT-06 | MUST | **Joint margins**: MS_sep = Pp-min/(FF · FS_sep · PtL) − 1; MS_slip = n_f μ Pp-min/(FS · (PsL-joint + μ PtL-joint)) − 1 (concentric) or per fastener (A.10-6); linear theory P′sep = Pp-max/(1 − nφ), P′tu = (Ptu-allow − Pp-max)/(nφ), separation-before-rupture test and MS_u by eq. 6-11 when rupture precedes separation. Factors of safety and fitting factor are explicit inputs. | Separation and slip criteria | [R2] |
| FR-CNT-07 | SHOULD (V1) | **Joint stiffness factor from FE**: bolt-force increment / applied-load increment over a preloaded, unseparated range = nφ; returned with the range used. | φ and n are design-dependent | [R2] (definitions) |
| FR-CNT-08 | MUST | **Hertz checks** (`hertz_contact`): contact half-width or radius, peak pressure, approach, for force- or displacement-driven sphere / cylinder pairs; subsurface max shear and depth flagged `unverified` until the formula source is fetched. | Rollers, balls, gears | [R3], [R4] |
| FR-CNT-09 | MUST | **Interference fit** (`interference_fit`): contact pressure from Lamé compatibility for shaft / hub (solid or hollow), radial stresses and hoop stresses at both bores, plane stress or plane strain explicit. | Bushings, shrink fits | derived |
| FR-CNT-10 | SHOULD (V1) | **Fastener-stack link**: `joint_from_fastener_stack` builds the bolt part, pretension and contact pairs from an 08 `FastenerStack` and its catalogue dimensions. | No re-entry of fastener data | 08 |
| FR-CNT-11 | SHOULD (V1) | **Pin-in-hole template**: clearance (explicit) pin bearing on a lug hole with contact; bearing pressure distribution and max hoop stress as data. | Lugs and pins | [R1] |
| FR-CNT-12 | MUST | **Margins integration**: joint margins (separation, slip, ultimate) appear as 05 margin rows with `criterion: 'joint_separation' \| 'joint_slip' \| 'fastener_ultimate'`, `reviewRequired`, and 05 disposition rules. | One margin table | 05 |
| FR-CNT-13 | MUST | **Stable codes** for mixed formulations, unresolved surfaces, missing friction data, overclosure at start, non-convergent contact, separation, slip, missing nut factor, Γ policy, friction cap. | AF-11 | AF-11 |
| FR-CNT-14 | MUST | **Named defaults** (AF-31): Γ defaults (25 % / 35 % / 10 % by control method), 5 % relaxation, friction caps, ccx penalty and stick-slope defaults are returned as `{ value, source, defaulted }`; nut factor, factors of safety, fitting factor, μ and preload have **no** default. | AF-31 | [R1], [R2] |
| FR-CNT-15 | MUST | **Review flag** (AF-33): every joint, contact and Hertz result carries `reviewRequired: true` and the "not approved" sentence. | Substantiation | AF-33 |
| FR-CNT-16 | MUST | **Unverified propagation** (AF-32): nut factors, friction coefficients and preload variations without a test record are `unverified` and propagate to margins. | AF-32 | AF-32 |
| FR-CNT-17 | MUST | **Check command** `check_contact`: set-up (pairs, surfaces, formulations, initial overclosure, rigid-body modes held only by friction), results (non-convergence, penetration > tolerance, separation, slip) and joint checks (Γ policy, μ cap, missing inputs). | AF-20 | AF-20 |
| FR-CNT-18 | MUST | **Supersede 05 V2 tied contact**: tied behaviour is offered through this pack (surface-to-surface `tied`, or CalculiX `*TIE` when meshes are compatible); 05's V2 hook points here. | One contact implementation | [R1], 05 |

## 6. Workflows

### 6.1 CLI

```bash
llull search bolt separation slip                        # AF-01
llull describe bolted_joint_check add_bolt_pretension add_contact_pair

# 1. hand checks first (no mesh, no solver)
llull bolted_joint_check --json "$(cat plans/cnt_bolted_joint_check.query.json)"
llull hertz_contact 'inputs={"pair":"cylinder_plane","R1_mm":50,"E1_MPa":210000,"nu1":0.3,"E2_MPa":70000,"nu2":0.3,"loadPerLength_N_per_mm":35000}' --json

# 2. FE when a hand check is not enough (needs PHY-05 nonlinear_static)
llull run plans/cnt_ssnp154_cylinder_block.plan.json --validate --doc roller.llull.json
llull run plans/cnt_ssnp154_cylinder_block.plan.json --doc roller.llull.json --kernel occt --json
llull fea_mesh analysisId=$an --doc roller.llull.json --kernel occt --json
llull check_contact analysisId=$an --doc roller.llull.json --json
llull fea_solve analysisId=$an --doc roller.llull.json --progress --timeout 1800 --json
llull contact_report analysisId=$an pair=roller_block --doc roller.llull.json --json     # p_max, half-width, status areas
llull check_contact analysisId=$an --doc roller.llull.json --json                        # end of every job
```

The agent reports (AF-36): what was checked, the margins, every defaulted or unverified input (Γ, μ, nut factor), what
needs a human, and "computed by llull, not approved — needs a qualified engineer".

### 6.2 MCP

Same tools in toolset `analysis`; the read-only checks work on every host; FE needs `ccx` (05 `FEA_TOOL_MISSING`).

### 6.3 Desktop UI (review only)

Contact status and pressure overlay per step (05 overlay fields `cstatus`, `cpress`), joint table with named inputs and
flags, bolt-force vs load plot from `contact_report`, 05 disposition dialog.

### 6.4 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| Pairs with different formulations in one analysis | Refused, `CNT_MIXED_CONTACT_TYPES` | FR-CNT-01 |
| Slave and master surfaces overlap at start beyond `adjust` | Warning `CNT_INITIAL_OVERCLOSURE`; remediation: set `adjust` or fix the geometry | FR-CNT-01, 17 |
| A part held only by contact / friction | Warning `CNT_RIGID_BODY_BY_CONTACT_ONLY` (start-up instability); remediation: weak spring or a first step with prescribed displacement | FR-CNT-17 |
| Separation-critical joint without test-derived Γ | Refused, `CNT_GAMMA_TEST_DATA_REQUIRED` | FR-CNT-05 |
| μ above the 5020 cap without a test record | Check result `fail`, `CNT_FRICTION_ABOVE_CAP` | FR-CNT-06 |
| Torque-derived preload without a nut factor | Refused, `CNT_NUT_FACTOR_MISSING` | FR-CNT-03 |
| Contact iteration does not converge | `CNT_CONTACT_NOT_CONVERGED` with the step and increment (PHY-05 incrementation applies) | FR-CNT-13 |

## 7. Acceptance criteria

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | — | `hertz_contact` cylinder on block, R 50 mm, 35 000 N/mm, E 210/70 GPa, ν 0.3 | half-width 6.2146 mm (SSNP154: 6.21), p0 3585.36 MPa (SSNP154: 3585.37) at 1e-9 vs generator | VC-CNT-10 |
| AC-2 | `plans/cnt_ssnp154_cylinder_block.plan.json` | run, mesh, solve, `contact_report` | p_max within 2 % of 3585.37 MPa, half-width within 2 % of 6.21 mm | VC-CNT-10 |
| AC-3 | — | `hertz_contact` two spheres R 50, E 20 GPa, approach 4 mm | p0 = 2798.33 MPa (SSNV104: 2798.3), a = 10 mm | VC-CNT-11 |
| AC-4 | `plans/cnt_bolted_joint_check.query.json` | `bolted_joint_check` | MS_sep = 1.22071850394, MS_slip = 0.168799212598, Pp-min(slip) = 6662.15551181 N, Γ `{value: 0.25, defaulted: true, source: "NASA-STD-5020 6.1.d(1)A"}` | VC-CNT-40 |
| AC-5 | same with `mu: 0.3`, `surface: "uncoated_clean_metal"`, no test record | `bolted_joint_check` | `status: fail`, `CNT_FRICTION_ABOVE_CAP` | VC-CNT-40.g |
| AC-6 | same with `separationCritical: true` and no Γ test record | `bolted_joint_check` | exit 1, `CNT_GAMMA_TEST_DATA_REQUIRED` | VC-CNT-40 |
| AC-7 | a bolt part with `add_bolt_pretension force=10000 N` | run, solve, `contact_report` | bolt section force 10 000 N ± 0.5 % after the preload step | VC-CNT-51 |
| AC-8 | two pairs with `node_to_surface` and `mortar` | second `add_contact_pair` | exit 1, `CNT_MIXED_CONTACT_TYPES` | VC-CNT-60 |
| AC-9 | any result | all queries | `reviewRequired: true`, summary "not approved" | VC-CNT-62 |

## 8. Standards & regulatory alignment

| Reference | Use | Status |
| --------- | --- | ------ |
| NASA-STD-5020 (2012 baseline) [R2] | Preload range, separation, slip equations; Γ defaults; friction caps; locking-feature requirement noted in the guide | Fetched (public, "approved for public release"); revisions 5020A and 5020B exist (5020B 2021, revalidated 2026 per search) — the equations and defaults must be re-checked against 5020B before release (§11 TS) |
| VDI 2230 Part 1 | Catalogue citation only (systematic calculation of highly stressed bolted joints) | Paywalled; no clause content used |
| CalculiX manual [R1] | Contact, friction, pretension keywords and defaults | Read at a pinned commit |
| NAFEMS cylinder-roller contact benchmark (Konter 2006) | Reproduced by code_aster SSNP154 (same values) | Paid original; values via code_aster |

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Benchmarks | 100 % of A-grade VC-CNT cases pass | PHY-00 `run_benchmarks` |
| Silent joint inputs | 0 results with a Γ, μ cap or relaxation value not named | VC-CNT-40.h, 61 |
| Policy enforcement | 0 separation-critical checks run on default Γ | VC-CNT-40 (AC-6) |
| Agent completion | US-1 end to end unattended in ≥ 9 of 10 scripted runs | agent driver |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| 2012 baseline of NASA-STD-5020 fetched; 5020B text not reachable from this session | Equations or defaults may have changed | Pin edition in every result (`standard: "NASA-STD-5020 (2012)"`); re-check against 5020B (open question) |
| Penalty contact accuracy depends on stiffness and mesh | Wrong peak pressure | Validation on SSNP154 / SSNV104; `check_contact` penetration tolerance; PHY-00 convergence study |
| Contact convergence failures are common for agents | Stalled jobs | Codes with remediations (adjust, first-step displacement, smaller increments) |
| Subsurface Hertz formulas not fetched | Unverified shear depth | Reported `unverified` (grade B) |
| Analytic lug method source not verified | No lug check in MVP | FE pin-in-hole template (V1); open question |
| Assumption: PHY-05 delivers steps, controls and increment parsing | Dependency | §3 TS reuses PHY-05 types |

## 11. References

- [R1] CalculiX User's Manual (`*CONTACT PAIR`, `*SURFACE INTERACTION`, `*SURFACE BEHAVIOR`, `*FRICTION`, `*PRE-TENSION SECTION`, `*MODEL CHANGE`, `*TIE`) and test suite — G. Dhondt, GPL-2.0 — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10, git)
- [R2] NASA-STD-5020 Requirements for Threaded Fastening Systems in Spaceflight Hardware (approved 2012-03-12) — NASA — copy at https://imlive.s3.amazonaws.com/Federal%20Government/ID22733872581604231767905658536785766455/NASA-STD-5020.pdf (sha256 ea1b5b03…100a; accessed 2026-10); current revision page https://standards.nasa.gov/sites/default/files/standards/NASA/B/0/2021-08-06-nasa-std-5020b_final.pdf (search only)
- [R3] code_aster test SSNP154 (cylinder on block, analytic Hertz a = 6.21, p0 = 3585.37) — EDF, GPL-3.0 — https://gitlab.com/codeaster/src/-/blob/94bf28a308de5a77587675a598aacdddb722f84e/astest/ssnp154a.comm (accessed 2026-10, raw)
- [R4] code_aster test SSNV104 (two spheres, analytic p0 = 2798.3) — EDF — https://gitlab.com/codeaster/src/-/blob/94bf28a308de5a77587675a598aacdddb722f84e/astest/ssnv104a.comm (accessed 2026-10, raw)
- [R5] VDI 2230 Blatt 1 (catalogue only) — VDI — https://www.vdi.de/richtlinien (accessed 2026-10, not fetched; title only)
- [R6] K. L. Johnson, Contact Mechanics, Cambridge University Press 1985 (subsurface stress formulas; not fetched)
- Aerospace 05 FEA, 08 MAT (fastener stacks); PHY-05 (nonlinear_static); PHY-00 (harness).
