# PHY-21: Functional digital prototype — functional specification

Gap id **PHY-21** · prefix **FPR** · status: specification · written 2026-10-16 · technical spec:
[`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md) · validation: [`validation/README.md`](validation/README.md) · sources:
[`validation/sources.md`](validation/sources.md) · research notes: [`validation/research/`](validation/research/)

## 1. Summary

The owner wants to push a piston and see the whole engine (connecting rod, crankshaft, reduction gear and propeller)
move the way the real machine would. The result must be good enough to decide whether the design can go to a
workshop. Today llull cannot do that. It cannot even tell you that the model is wrong:

1. **The geometry is not checked for physical sense.** Parts can overlap, have zero thickness, or float in the air
   with no connection, and `check_model` (`packages/core/src/commands/inspect/checkModel.ts`) reports none of it. Its
   checks are about tidiness: non-positive sizes, open profiles, dangling references.
2. **The physics cannot close a loop.** In `doc.dynamics` each body is the child of at most one joint
   (`packages/core/src/model/dynamics.ts`, `DynamicJoint` invariant). A connecting rod is attached at both ends, so a
   piston cannot drive a crank. `docs/DYNAMICS.md` states the limits: "no slider-crank pistons yet" and "no closed
   loops yet".
3. **The engine is a mean torque curve on the crank**, not gas pressure on pistons. There is no firing order, no
   torque ripple, no rod or wall loads.
4. **Motion is not checked against the geometry.** `motion_study` interference is an axis-aligned bounding-box (AABB)
   test on instances only. Two bounding boxes that overlap is not the same as two parts that collide.
5. **An engineer cannot review what an agent built.** There is no single place that says "this moves, nothing
   collides, every wall is thick enough, every part is held by something, and here is the evidence".

PHY-21 adds three capabilities and one review surface:

- **A. Buildability gate** (`check_assembly`). Checks the geometry of each part (valid solid, no zero-thickness
  sheets, no detached lumps). Checks every pair of parts (hard interference, containment, touch, clearance, each with
  volume or distance). Builds a connection graph and reports floating parts and parts that only rest on others.
  Reports wall thickness against a named, sourced manufacturing threshold. Checks that each joint has a pin and a
  bore on its axis (**joint realisation**).
- **B. Physically connected mechanism.** Closed kinematic loops in the MuJoCo model, through equality constraints on
  an automatically chosen spanning tree. A **piston gas-pressure drive**: a crank-angle pressure table, or a Wiebe
  single-zone model calibrated to a target mean effective pressure. **Joint reactions**: main bearing, crank pin,
  wrist pin, cylinder side thrust, gear mesh. A loop-closure residual as a quality metric.
- **C. Motion clearance** (`check_motion_clearance`). Exact mesh collision and minimum clearance through the full
  cycle, from the simulated poses or a kinematic sweep. Reports the first contact time and crank angle, the parts
  involved, and the penetration.
- **D. Prototype review workspace** (UI). A readiness checklist, a findings list that drives the 3D view, a mechanism
  graph, and a timeline shared by playback and every chart (crank-angle axis 0–720°). Overlays show joint glyphs,
  forces, trace paths and a thickness map. An "Explain" drawer gives the method and inputs behind every number. The
  agent builds and proves; the engineer reviews, dispositions and signs.

- **E. Realism and accuracy contract** (§5.6). The owner's goal is a model that *reflects reality accurately, not one
  that is mathematically exact* (decision of 2026-10-16). So the simulation includes the effects that make a real
  engine differ from an ideal one:
  - friction and mechanical losses (FMEP, mechanical efficiency, brake torque);
  - wall heat loss in the cylinder;
  - real part masses from assigned materials;
  - gear-mesh losses;
  - propeller coefficients that vary with forward speed, and real propeller inertia.

  Every output also carries an **accuracy statement**: best estimate, expected accuracy band and its basis, whether
  the number is *calibrated* (it matches by construction) or *predicted* (an actual test of the model), and the
  validation level. Results are compared with **measured manufacturer data** (Rotax 912 curves, propeller rpm
  windows), not only with textbook formulas.

`check_prototype` ties it together. It is a single read-only query that runs A + B + C + E and returns one readiness
verdict with evidence, which is the last call of every agent job (AF-20).

**Two kinds of evidence, never mixed** (NASA-STD-7009B definitions [E-R34]):

- **Verification** answers "does the solver compute the model correctly?". It uses the exact slider-crank formulas,
  the loop residual, cycle-energy closure and timestep halving. These are automatic self-checks. They are kept
  cheap, and they are never presented as accuracy against reality.
- **Validation** answers "does the model behave like the real machine?". It compares with measured or datasheet
  data, with an error E = S − D and its uncertainty (ASME V&V 20 [F-R33][E-R36]). This is what "accurate" means
  in this pack.

**What PHY-21 does not claim.** A clean PHY-21 report means the design is *kinematically and dynamically coherent,
geometrically buildable as modelled, and behaves like the reference machine within the stated bands at the validated
operating points*. It does not mean:

- that the parts are strong enough (PHY-05 / aerospace 05 FEA);
- that they will survive fatigue (PHY-07);
- that the results hold outside the validated range (this is flagged);
- that the design is certified.

Every verdict carries `reviewRequired: true` (AF-33).

## 2. Context & value

### 2.1 What mature CAD does (research notes A, B, D)

| Concern | Mature practice | Source |
| ------- | --------------- | ------ |
| Mechanism from the assembly | Motion reuses assembly mates or constraints as joints (SOLIDWORKS, Simcenter, CATIA, Fusion) | [A-R18][A-R43][A-R32][A-R50] |
| Closed loops | Every dynamics solver removes redundant constraints automatically, then warns. Reactions in the removed directions become zero or non-unique. A four-bar with concentric mates has 3 redundant mates in SOLIDWORKS | [A-R3][A-R5][A-R59][A-R60][A-R64][A-R66] |
| Pre-run checks | Adams: Gruebler count (DOF = 6·movable bodies − constraints) plus Model Verify. CATIA: "The mechanism can be simulated" when commands = DOF. Simscape: cut joints and a count of non-redundant constraint equations | [A-R59][A-R60][A-R21][A-R22][A-R66] |
| Piston drive | RecurDyn/Crank has a dedicated gas-force element between block and piston, with firing angle, cycles, scale, auto area and a pressure profile. Other tools use a generic action–reaction force with a tabulated profile | [A-R62] |
| Drivers | Servo motors (position, velocity, acceleration) vs force/torque motors. Creo sizes a force motor by driving the ideal motion with a servo and measuring its load | [A-R6][A-R41] |
| Outputs | Joint reactions as plots and 3D vectors; trace paths; swept volume; interference over time (frame, time, parts, volume); loads handed to FEA | [A-R8][A-R9][A-R11][A-R12][A-R28][A-R42][A-R48] |
| Static interference | Hard / touch / soft / containment classes (NX, PTC). Clash / contact / clearance plus "authorised penetration" for press fits (CATIA). Interference volume per pair (SOLIDWORKS) | [B-R1]–[B-R6] |
| Thickness | Thickness analysis with thin and thick regions, "treat corners as zero thickness", a colour map against a target, and a ranked list of regions | [B-R9][D-R6] |
| Review UX | Clash results with a reviewer-editable status and comment, red/orange/green roll-up, preview of only the conflicting parts (CATIA). Plots and animation on one page with a shared cursor (Adams PostProcessor) | [D-R4][D-R5][D-R7] |

No tool found offers these together: an agent-operable gate, a gas-driven closed-loop engine, and a review page that
links every number to its evidence. Fusion and Onshape stop at kinematic preview [A-R52][A-R56][A-R58].

### 2.2 Who does it today

A design engineer in SOLIDWORKS Motion, Creo Mechanism, Adams or RecurDyn sets up the mechanism by hand, runs
interference detection and a thickness analysis, and writes a design-review pack. llull's operator is an AI agent
driving the `llull` CLI. The owner is not assumed to be an engineer (AGENT_FIRST §1). PHY-21 makes the agent produce
that design-review pack, and makes the reviewer's job reading evidence rather than redoing the analysis.

## 3. Personas & user stories

| Persona | Role |
| ------- | ---- |
| **Agent** (primary operator) | Builds parts and the mechanism through the CLI or MCP. Must prove its own work (AF-20…23). |
| **Owner** | Wants to know "does it work, can it be built", in plain words (AF-36). |
| **Reviewer** (qualified engineer) | Inspects findings, dispositions them, and signs the review (human gate, AF-34). |

User stories:

- **US-01 (agent).** After building an assembly, I call `check_assembly --json`. I get every overlapping pair with
  its volume and the parts with no connection, each with a stable code and a remediation. I can fix them without
  looking at the screen.
- **US-02 (agent).** I declare the crank, rod and piston joints in any order. llull closes the loop itself and tells
  me the mobility (1 DOF), and whether any constraint is redundant and which one.
- **US-03 (agent).** I add a cylinder-pressure drive on each piston with bore, compression ratio, firing phase and a
  pressure model. I simulate and read the torque at each crank angle, the mean torque, the speed ripple, and the peak
  wrist-pin, crank-pin and main-bearing loads.
- **US-04 (agent).** I run `check_motion_clearance` over two crank revolutions (one 4-stroke cycle). I learn that
  the rod big end hits the cylinder skirt at 92° crank, with 0.8 mm penetration.
- **US-05 (agent).** I run `check_prototype` and get one verdict (`ready_for_review` / `blocked`) with the list of
  what passed, what failed and what needs a human.
- **US-06 (owner).** I read: "The engine turns at 5800 rpm with the propeller at 2388 rpm, nothing collides, all
  walls are at least 2.1 mm thick for CNC aluminium (rule: 0.794 mm minimum, Xometry). Two items need an engineer."
- **US-07 (reviewer).** I open the Review tab and see the checklist. I click a finding and the 3D view isolates the
  two parts with the overlap volume in red. I scrub the timeline and the torque chart cursor follows. I open
  "Explain" on the 18.4 kN wrist-pin load and see the method, inputs, solver settings and loop residual. I mark a
  press fit "accepted: intended H7/p6" and sign the review.
- **US-08 (reviewer).** After the agent changes the crank pin, every check whose inputs changed shows **stale**, and
  my earlier disposition is kept but flagged for re-review.
- **US-09 (owner).** I read (the values are illustrative): "Brake torque at 5800 rpm is 121 N·m (calibrated to the Rotax datasheet). Predicted:
  mechanical efficiency 0.87, wrist-pin peak 21 kN (±15 %, not validated: no measured data exists), static rpm with
  the 1.75 m propeller 5420 rpm, inside the 5100–5800 rpm window the propeller maker requires." In plain words: I
  can see what is known, what is estimated, and how far to trust each number.
- **US-10 (reviewer).** The checklist row "Matches reality" lists each comparison with the reference data: the
  value, the reference, the error E, the band and the source. Calibrated points are greyed with a "calibrated"
  badge, so I don't mistake a match by construction for evidence. I open Explain on the torque curve and see which
  points were used to calibrate and which are hold-out predictions.

## 4. Scope / out of scope

| Phase | Content |
| ----- | ------- |
| **MVP** | A: `check_assembly` (part validity, pairwise classes, connection graph, ray-method thickness, joint realisation on OCC). B: closed loops (revolute and spherical loop joints), cylinder-pressure drive (table, Wiebe, and single-zone with Woschni heat loss; calibration to a brake target), joint reactions, loop residual, `inspect_dynamics` mobility and redundancy. C: `check_motion_clearance` on simulated poses. **E: realism — friction (FMEP) and brake outputs, materials-based masses, gear-mesh efficiency, propeller C_T(J)/C_P(J) with real inertia, plausibility checks, accuracy statement on every output, `compare_to_reference` against stored manufacturer data.** D: Review tab (checklist incl. "Matches reality", findings, mechanism graph, shared timeline with crank-angle axis, force and trace overlays, Explain drawer with accuracy block, dispositions). `check_prototype`. Reference engine (single-cylinder demonstrator) green end-to-end. |
| **V1** | Inscribed-sphere thickness; declared fits (ISO 286 symbols) on joints, so a press fit is authorised penetration; four-cylinder opposed reference engine with gearbox (Rotax 912-class geometry, firing order 1-4-2-3 [E-R2]) validated against the full-throttle curve; swept volume as geometry; continuous collision refinement; reaction export to aerospace 05 / PHY-10 load cases; load-dependent joint friction μ·\|F\|·r [F-R16][F-R17]; cycle-to-cycle combustion variation [E-R14]; fuel flow and bsfc as a predicted output [E-R2]. |
| **V2** | Blade-element propeller [F-R26]; torsional flexibility of crank, gear and propeller with the Rotax dog-hub damper and backlash [E-R2][E-R23] (PHY-09); pin play as soft joints [F-R3]; contact-driven parts (valve train cam–follower via PHY-06); breathing (volumetric efficiency) for a *predicted* torque curve; DFM rule packs per process (draft, hole depth/diameter). |
| **Out of scope** | Combustion chemistry and detailed wall heat transfer (PHY-03; MVP uses a lumped Woschni loss only), strength and fatigue (05/PHY-05/PHY-07), certification acts, CFD. |

## 5. Functional requirements

`Pri` = priority. `AF` = agent-first ids (`../../aerospace/AGENT_FIRST.md`).

### 5.1 A — Buildability gate

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-FPR-01 | MUST | `check_assembly` is read-only. It checks every 3D solid entity and every assembly instance (scope: `all`, `ids`, a rigid-body set, or a component). It returns `pass / warn / fail` items with stable codes, ids, measured values with units, thresholds with sources, and a remediation. | AF-11, AF-20 | — |
| FR-FPR-02 | MUST | **Part validity**: the kernel shape is a valid closed solid (`FPR_PART_INVALID` with the kernel status); non-empty (`FPR_PART_EMPTY`); one connected lump (`FPR_PART_DISCONNECTED`, with the lump count and each lump's volume); no zero-thickness sheet or open shell (`FPR_PART_SHEET`, with area and mean-thickness proxy 2V/A). | The owner's "elements without thickness or no continuity" | [B-R19][B-R20][B-R25][B-R29] |
| FR-FPR-03 | MUST | **Pairwise classes** for every pair of parts after an AABB broad phase: `hard` (overlap volume > ε_vol, error), `containment` (one part ≥ 99 % inside the other, error), `touch` (zero volume, min distance ≤ ε_touch, info), `clearance` (0 < distance < required clearance, warn). Each item gives the overlap volume (mm³ or document units³), penetration-depth estimate, min distance and witness points. | Mature taxonomy (NX, CATIA, PTC) | [B-R2]–[B-R6] |
| FR-FPR-04 | MUST | Named tolerances: ε_vol (default 1e-6 × the smaller part's volume), ε_touch (default 1e-3 document units, or the kernel tolerance if larger), and required clearance (default 0, no clearance check). Each default is named and stated as defaulted. | AF-31 | — |
| FR-FPR-05 | MUST | **Declared intent**: `allow_interference { a, b, reason, kind: 'press_fit' \| 'thread' \| 'weld' \| 'overlap_by_design' }` is a document item. It turns the pair's `hard` result into `allowed` with the reason shown. It never applies silently and is reported in every result. | CATIA "authorised penetration"; SOLIDWORKS fasteners and threads | [B-R2][B-R1] |
| FR-FPR-06 | MUST | **Connection graph**: nodes are parts. Edges are joints (kinematic `doc.joints` and dynamic `doc.dynamics.joints`), rigid-body membership (entities welded into one body), declared fasteners or welds (`allow_interference` kind `weld`/`thread`), and `touch`/allowed-overlap contact. Components without a grounded node (fixed body, `ground` joint parent, or a part marked `grounded`) give `FPR_PART_FLOATING` (error). Parts held only by `touch` give `FPR_PART_RESTING_ONLY` (warn). | Liaison graph; fixed/floating states | [B-R33][B-R32] |
| FR-FPR-07 | MUST | **Wall thickness (ray method)**: sampled minimum and 1st percentile of local thickness per part, the location of the thinnest sample, and a ranked list of the thinnest regions. Compared to a threshold given explicitly or taken from a sourced **process table** (`cnc_metal`, `injection_<polymer>`, `dmls`, `sls`, `mjf`, `sla`, `sand_cast_al`, …) that names its source. Corner samples are excluded within a named radius (SOLIDWORKS "treat corners as zero thickness" is the opposite choice, offered as an option). | Thickness analysis | [B-R9][B-R11][B-R12][B-R14][B-R15][B-R16] |
| FR-FPR-08 | MUST (OCC) / COULD (Manifold) | **Joint realisation**: for each revolute joint, both connected parts have a cylindrical face coaxial with the joint axis within an angle tolerance and axis-offset tolerance (pin on one side, bore on the other). Report the diametral clearance (bore Ø − pin Ø) and the axial engagement length. `FPR_JOINT_NOT_REALISED` (warn in MVP, error in V1) when either side has no such surface. Prismatic joints: matching planar or cylindrical guide faces parallel to the axis. On Manifold (no exact faces) the check runs on the tessellation by fitting a cylinder to faces near the axis, and is marked `approximate`. | "Physically connected", not just a joint in the data | inference; fits [B-R36] |
| FR-FPR-09 | SHOULD (V1) | Declared fits on revolute joints (`fit: 'H7/g6'` etc.). A clearance fit requires `touch` or `clearance` (never `hard`) at nominal size. An interference fit authorises penetration. Only fit symbols and IT grades with fetched values are tabled. Fundamental deviations are not hard-coded until sourced. | ISO 286 | [B-R36][B-R37] |

### 5.2 B — Physically connected mechanism

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-FPR-10 | MUST | **Closed loops**: `add_body_joint` accepts a child that already has a joint. llull picks a deterministic spanning tree of the body–joint graph rooted at `ground`, preferring prismatic joints as tree joints. Every non-tree joint becomes a loop closure. Revolute: two point constraints on the axis. Spherical (new kind): one point constraint. The tree is reported. | Every slider-crank, four-bar and multi-cylinder engine | [A-R3][A-R66][C-R2] |
| FR-FPR-11 | MUST | **Mobility and redundancy** in `inspect_dynamics`: Gruebler count, rank-based mobility from the constraint Jacobian at the initial pose, redundant rows with the joint and direction they belong to (Adams-style wording: "joint `wrist_j` repeats the out-of-plane rotation already fixed by `crank_j`"), and the suggested fix (use `spherical` for one loop joint of a planar loop). | Mature pre-run checks | [A-R59][A-R60][A-R66] |
| FR-FPR-12 | MUST | **Initial assembly**: before integrating, the pose is checked against every loop. If a loop is open by more than the named tolerance (default 1e-6 m), the run refuses with `FPR_LOOP_OPEN`, giving the gap per loop and the bodies involved. It never snaps parts silently. | CATIA "can be simulated"; AF-31 | [A-R21] |
| FR-FPR-13 | MUST | **Cylinder pressure drive** `add_cylinder_pressure`: on a prismatic piston joint, with the crank joint giving the crank angle, bore (mm), compression ratio, cycle (`four_stroke` / `two_stroke`), firing offset (deg crank), TDC reference (computed from geometry by default and reported), and pressure model: `table` (gauge pressure vs crank angle over 0–720° or 0–360°) or `wiebe` (start of combustion θ₀, duration Δθ, a, m, polytropic indices n_c and n_e, intake pressure, and heat release per cycle **or** a target IMEP to calibrate to), or `single_zone` (Wiebe burn with Woschni wall heat loss instead of fixed polytropic indices, calibrated to a **brake** target after friction; FR-FPR-72, the realistic default). Force = (p − p_ambient)·A on the piston along the cylinder axis, with the reaction on the cylinder's body. | The owner's "move the piston realistically" | [A-R62][C-R12][C-R15][C-R16][C-R18][C-R19] |
| FR-FPR-14 | MUST | **Joint reactions**: for each joint and loop closure, force and moment on the child (world axes and joint frame), with peak magnitude, time and crank angle at peak. Derived engine quantities: wrist-pin force, rod force, cylinder side thrust, crank-pin force, main-bearing force, gear-mesh tangential force. Series on request. | Bearing and pin sizing | [A-R8][A-R42][C-R4][C-R5] |
| FR-FPR-15 | MUST | **Loop residual**: max loop-closure error (m) over the run is always reported. The gate is sized against the physical pin clearance, not against zero. **Pass** ≤ 1 µm (5 % of the smallest published rod-pin diametral clearance, 0.020 mm [F-R19]). **Warn** 1–10 µm (`FPR_LOOP_DRIFT` warn; reactions flagged `approximate`). **Fail** > 10 µm (`FPR_LOOP_DRIFT` fail; reactions `unreliable`). Both limits are named and adjustable. Solver settings (timestep, solref, solimp, integrator) are in `provenance`. | MuJoCo constraints are soft. An error well inside the real clearance is physically invisible | [C-R2][C-R3][F-R19] |
| FR-FPR-16 | MUST | **Engine outputs**: torque vs crank angle per cylinder and summed, mean torque, indicated power, IMEP from ∮p dV, speed ripple and coefficient of fluctuation, cycle-energy closure (∮T dθ vs Σ∮p dV, named gate 0.5 %), peak cylinder pressure, and the crank angle of each peak. With losses (FR-FPR-71): FMEP and its breakdown, BMEP, brake torque and power, mechanical efficiency η_m = BMEP/IMEP [E-R11]. | Validation identities; brake values are what datasheets publish | [C-R18][C-R25][E-R11] |
| FR-FPR-17 | MUST | **Quick check without simulation** `engine_quick_check`: analytic slider-crank kinematics, torque, rod and side-thrust forces at chosen crank angles; mean torque ↔ MEP ↔ power. The agent sanity-checks its model in milliseconds. | AF-21; PHY-10 FR-RBD-15 | [C-R12][C-R18] |
| FR-FPR-18 | MUST | Propeller with forward speed: moved to MVP as FR-FPR-75. | — | — |
| FR-FPR-19 | MUST | Existing commands keep their behaviour. A model without loops or pressure drives gives byte-identical `simulate_motion` data. | L1, AF-13 | — |

### 5.3 C — Motion clearance

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-FPR-20 | MUST | `check_motion_clearance` runs over a simulated run (poses from `simulate_motion`) or a kinematic sweep (`motion_study` source). For every pair of moving parts, and every moving part against every fixed part, it reports min clearance over the cycle and when it occurs (time, crank angle), and every interval of collision (start/end time and crank angle, max penetration estimate, volume at the worst pose). Pairs joined by a joint are checked too: a pin rubbing its bore is `touch`, not an error. Declared intents (FR-FPR-05) apply. | SOLIDWORKS interference over time; CATIA stop-on-clash | [A-R10][A-R11][A-R28][B-R38] |
| FR-FPR-21 | MUST | **No tunnelling**: the sampling step is refined until the maximum vertex displacement between samples is below the required clearance (or ε_touch), up to a budget. Hits are refined by bisection in time. The achieved resolution is reported. | Conservative advancement | [B-R41] (inference) |
| FR-FPR-22 | SHOULD (V1) | Swept volume of a chosen part as a derived, read-only mesh entity (envelope), for clash against the rest. | CATIA swept volume | [A-R32][B-R38] |

### 5.4 Prototype verdict and review

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-FPR-30 | MUST | `check_prototype` is read-only. It runs `check_assembly`, `inspect_dynamics` (mobility, loops), `simulate_motion` (named duration: two cycles at the governed or settled speed), `check_motion_clearance`, the realism checks (FR-FPR-73, 76, 79) and, when the document holds reference data, `compare_to_reference`, and returns `verdict: 'blocked' \| 'ready_for_review'`. It returns the per-check results, an `inputsHash` per check, a plain-language owner summary (AF-36), and `reviewRequired: true`. | One last call for the agent | AF-20, AF-33, AF-36 |
| FR-FPR-31 | MUST | **Dispositions** `set_review_disposition { checkId, findingKey, status: 'not_reviewed' \| 'relevant' \| 'irrelevant' \| 'accepted', comment }` are stored in the document (`doc.review`). `accepted` on a `fail` item is a **human gate** (AF-34/AF-34a): an agent caller is refused with `FPR_HUMAN_GATE`. The agent can only declare intent (FR-FPR-05), which stays visible as a declaration. | CATIA status column; human gates | [D-R4][D-R5] |
| FR-FPR-32 | MUST | **Staleness**: each disposition records the check's `inputsHash`. When the hash changes, the disposition is kept, flagged `stale` and listed for re-review. | Re-verify after change | [D-R36] |
| FR-FPR-33 | MUST | **Sign-off** `sign_prototype_review`: a human-only command (09 PLM signature path) that records the reviewer's name, time, verdict and the hashes of all checks. It refuses while any `fail` item lacks an `accepted` disposition or any disposition is stale. | Onshape release gate pattern | [D-R35] |
| FR-FPR-34 | MUST | **Provenance on every number** (`Explain`): method, formula or algorithm id, inputs with units, solver settings, engine and kernel versions, the producing command and its feature step. | AF-35; Leo-style cited answers | [D-R28][D-R32] |

### 5.5 Agent-first and robustness

| Id | Pri | Requirement | AF |
| -- | --- | ----------- | -- |
| FR-FPR-40 | MUST | Every capability is a registry command reachable from CLI, MCP and UI, with descriptions written for an agent (units of every param, refusals, next call). | AF-01, AF-02 |
| FR-FPR-41 | MUST | Stable codes `FPR_*` (TECHNICAL_SPEC §7.1) with ids and a one-line remediation. | AF-11 |
| FR-FPR-42 | MUST | Deterministic results: same plan, kernel and engine ⇒ byte-identical `data`. | AF-13 |
| FR-FPR-43 | MUST | Outputs bounded: summaries by default, series and pose tables on request or `--save`. | AF-12 |
| FR-FPR-44 | MUST | Unit-suffixed fields; SI for forces, pressures, torques; document units and SI for lengths. | AF-04, AF-10 |
| FR-FPR-45 | MUST | `unverified` propagates. A pressure table without a cited source, masses from default densities, and process thresholds graded B or C all mark every derived result. | AF-32 |
| FR-FPR-46 | MUST | `render_view` can show the findings (overlap volumes, thinnest regions, collision pose), so a multimodal agent can look at what it built. | AF-22 |
| FR-FPR-47 | MUST | Budgets on pairs, samples, rays and simulation steps, checked before work starts. Exceeding one gives `FPR_BUDGET_EXCEEDED` naming the limit and how to narrow the request. Progress is reported on the CLI. | AF-40 |

### 5.6 E — Realism and accuracy to reality

**Principle.** The model must behave like the real machine within a stated, sourced accuracy. It need not be
mathematically exact. Two consequences follow:

- **Spend effort on physics, not on solver precision.** A real engine loses 10–15 % of its indicated work to
  friction (DERIVED η_m ≈ 0.85–0.90 at rated power, from an assumed FMEP range [E §1.3]), and that loss matters more than nanometres of loop
  error. Its pistons' inertia forces are of the same order as the gas force at rated rpm [E §3.1].
- **Honesty about evidence.** A number that matches the datasheet because we calibrated to it is not evidence. Only
  predicted numbers, compared with independent data, show that the model is realistic.

What rigid bodies can and cannot represent. They are acceptable for:

- mean torque and power;
- rpm equilibrium;
- cyclic speed ripple;
- pin and bearing load waveforms away from resonance.

They cannot predict gearbox or propeller vibratory loads, dog-hub impacts, or resonances [E §3.2]. The result says
so (FR-FPR-70 warnings), and torsional compliance is V2.

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-FPR-70 | MUST | **Accuracy statement on every reported quantity** of `simulate_motion`, `engine_quick_check`, `compare_to_reference` and `check_prototype`. Fields: `estimate`; `band` (relative or absolute, or `null`); `basis` (the source or method of the band); `origin`; `validationLevel` (0–4 on the NASA-STD-7009 validation scale: 0 none, 1 conceptual / referent agreement, 2 key outputs agree with a similar referent system, … 4 full operating range of the real system); `warnings[]`. `origin` takes one of four values: `input` (given), `calibrated` (matched to a referent by construction), `predicted` (computed, independent of the referent) or `verification` (a solver self-check). When no band is known, the field says so explicitly ("no quantitative uncertainty estimate available"). It never stays silent. | Mature practice for stating credibility | [F-R32][E-R34][F-R33] |
| FR-FPR-71 | MUST | **Friction and mechanical losses** `set_engine_losses` on a crank joint. Three models are available. **`component`** (default when engine geometry is known, once its equations are verified against the primary source, TECHNICAL_SPEC §11 Q8) is the Patton–Nitschke–Heywood / Sandoval–Heywood component model: crankshaft, reciprocating with gas-load term, valvetrain by type, auxiliaries and pumping, from bore, stroke, bearing sizes, valve count and valvetrain type. Its stated accuracy is ±15 % on the total [E-R9]. **`chen_flynn`**: A + B·p_max + C·n + D·n² with fitted constants and their source; its stated accuracy is 13 % mean and 35 % max error [E-R10]. **`fmep_table`**: FMEP against rpm, with a source. The loss acts as a torque on the crank, opposite to its rotation, smoothed near zero speed. Outputs: the FMEP breakdown, BMEP, brake torque and power, and η_m. An oil-temperature factor is optional (cold about 2.1 × hot [E-R9]). | Datasheets publish brake values. Without friction, indicated torque was compared with brake torque (the old VC-15) | [E-R9][E-R10][E-R11] |
| FR-FPR-72 | MUST | **Realistic combustion** `single_zone` pressure model: single zone, first law, Wiebe heat release, and Woschni wall heat transfer. Woschni constants: C1 = 3.26, C2 = 2.28 with valves closed (6.18 during gas exchange), C3 = 0.00324, all named; wall temperature is a named default of 450 K [E-R8][E-R17][E-R18]. The heat release is calibrated so that **brake** torque (IMEP − FMEP) meets the target at the named calibration point(s). Burn phasing has defaults suggested in the descriptions, never applied silently: MBT phasing with CA50 at 8–10° ATDC and peak pressure near 15° ATDC [E-R16]; 0–90 % burn ≈ 35° CA at medium speed, scaling ∝ rpm^0.2 [E-R12]. A fixed spark angle is also possible (O-320: 25° BTC [E-R6]). The Woschni temperature exponent differs between sources (−0.53 [E-R17], −0.55 [E-R8]); it is a named setting with −0.53 as default. | A fixed polytropic model needs n_c and n_e, which have no measured source; heat loss derives them physically [E-R19] | [E-R8][E-R12][E-R16][E-R17][E-R18] |
| FR-FPR-73 | MUST | **Real masses from materials**. Each rigid body's mass and inertia come from its entities' assigned materials (`assign_material`, `doc.materials`). `Material` gains an optional `source` and `grade`. A body that falls back to the default density gives `FPR_MASS_DEFAULTED` (warn), and its derived results are `unverified`. Shipped sourced materials: aluminium 4032 piston alloy, SG 2.68 [E-R32]; AISI 4340 steel, 7.85 g/cm³ [E-R31]. Per cylinder, the report gives the reciprocating mass and the primary and secondary inertia-force amplitudes, so the reviewer sees how inertia compares with the gas load. | Inertia is of the same order as the gas force at rated rpm [E §3.1]. Default steel density silently makes an aluminium piston three times too heavy | [E-R31][E-R32] |
| FR-FPR-74 | MUST | **Gear losses**: gear pairs gain `efficiency`, with a named default of 0.99 per mesh at rated load ("generally greater than 98 percent", peaks 99.3–99.9 % [E-R21]). It is applied as a loss in the direction of power flow, with an optional speed-dependent tare torque. Tooth counts can be given instead of a ratio (Rotax 912: 51/21 = 2.4286 or 50/22 = 2.2727 [E-R4]). | Measured mesh efficiency | [E-R4][E-R21] |
| FR-FPR-75 | MUST | **Propeller realism**: tabulated C_T(J), C_P(J) per propeller, each with a source, replacing the static coefficients when J > 0. A generic two-blade fixed-pitch table of NACA TR-640 class is shipped, tagged "repeatability about 1 % [C-R26], applicability to this propeller not validated". Propeller inertia comes from its body or is declared. For Rotax-912-class installs it is checked against the allowed 0.15–0.60 kg·m² [F-R20][E-R4]. A J outside the table gives `FPR_OUTSIDE_VALIDATED_RANGE`. | Realistic rpm matching and ripple | [C-R26][F-R20][F-R21][E-R4] |
| FR-FPR-76 | MUST | **Plausibility checks** (`FPR_UNREALISTIC`, warn), each with its value, the expected band and the band's source or "named default". They cover: CA50 and peak-pressure angle against the MBT targets [E-R16]; η_m outside a named default band; propeller inertia or torque outside the engine maker's limits (315 N·m at the propeller for the 912 S/ULS [E-R4]); fixed-pitch static rpm below 5200 rpm at full throttle for Rotax installs [E-R5]; reciprocating mass on default density. | Catches models that run but are not like a real engine | [E-R4][E-R5][E-R16] |
| FR-FPR-77 | MUST | **Reference data and comparison**. `add_reference_data` stores curves or points: quantity, operating condition, value, unit, source, grade, and the reading uncertainty (digitised graphs ±1 N·m / ±1 kW [E §5]). `compare_to_reference` is a query. It runs each operating point: full throttle governed at the point's rpm, or free equilibrium with the propeller. Per point it returns S, D, E = S − D, E/D, U_val = √(U_num² + U_input² + U_D²) where the terms are known [E-R36], the band (named default ±5 % per point, after GT-Power calibration practice for IMEP [E-R20]), pass / fail, and `origin`. Shipped reference sets: Rotax 912 ULS full-throttle torque and power curve, 2500–5800 rpm, digitised [E-R2]; rated 73.5 kW / 121 N·m at 5800 rpm and peak 128 N·m at 5100 rpm [E-R1]; 912 iS power-setting table [E-R3]; O-320-A/B full-throttle curves [E-R6]; fixed-pitch static rpm window 5100–5800 rpm and level flight 5500 rpm [F-R22]. | Validation = comparison with the real machine | [E-R1][E-R2][E-R3][E-R6][E-R20][E-R36][F-R22] |
| FR-FPR-78 | MUST | **Calibration discipline**. Calibration uses only the named calibration point(s) (default: the rated point). Every other point is a hold-out prediction, and the result lists both groups. A model calibrated on every point reports `validationLevel` ≤ 1 and "no predictive evidence". MVP has no breathing model: away from the calibration point, the shape of the torque curve comes from FMEP(n), heat loss and burn scaling only. If a heat-release-vs-rpm table is given, the curve becomes `calibrated`, and the result says so. The independent, predicted quantities in MVP are η_m and the FMEP split, the loads, the speed ripple, the gear output and the propeller-matched rpm. | Prevents circular "validation" | [E-R34] |
| FR-FPR-79 | MUST | **Solution verification**. At the calibration point, `check_prototype` repeats the run once at half the timestep. It reports the change in mean brake torque and in peak wrist-pin force. A change > 1 % (named) gives `FPR_TIMESTEP_SENSITIVE` (warn). The integrator is `rk4` (existing) or `implicitfast` [F-R2]. A separate motored run without friction or gas force checks the inertia torque against the exact formula (VC-FPR-28). | Verification proves the numbers are converged, which keeps solver error well inside the validation band | [F-R2][E-R35] |

## 6. Workflows

### 6.1 CLI (`llull`, primary)

```bash
# 1. Build (design-model skill) — parts, components, instances
llull --doc engine.llull.json run build.plan.json

# 2. Is the geometry buildable?
llull --doc engine.llull.json check_assembly process=cnc_metal clearance=0.05 --json
#   → fail FPR_PAIR_HARD rod_1 × crank_1  overlapVolumeMm3=412.7  remediation: "move or resize; or allow_interference kind=press_fit"
#   → fail FPR_PART_SHEET  blade_2  area=31 200 mm²  meanThicknessMm=0.00
#   → fail FPR_PART_FLOATING spinner  "not jointed, fastened, welded or touching anything grounded"
#   → warn FPR_JOINT_NOT_REALISED crank_j "no cylindrical face on crankcase coaxial with the axis"

# 3. Mechanism: joints in any order; llull closes the loop
llull --doc engine.llull.json run mechanism.plan.json        # bodies, joints (crank, rod, wrist, slide), gear, propeller
llull --doc engine.llull.json inspect_dynamics --json        # mobility 1, tree [crank_j, rod_j, slide_j], loops [wrist_j], redundant: none

# 4. Realistic inputs: materials (real masses), losses, gas pressure calibrated to a BRAKE target
llull --doc engine.llull.json assign_material ids=[piston_1] material=al_4032          # sourced density
llull --doc engine.llull.json set_engine_losses crank=crank_j model=component valvetrain=ohv_rocker valvesPerCylinder=2
llull --doc engine.llull.json add_cylinder_pressure piston=slide_j crank=crank_j boreMm=84 compressionRatio=10.8 \
      model=single_zone ca50Deg=9 burnDurationDeg=35 calibrate.brakeTorqueNm=121 calibrate.rpm=5800
llull --doc engine.llull.json engine_quick_check crank=crank_j angles=[30,90,120] --json   # analytic sanity check

# 5. Run, then check clearance through the cycle
llull --doc engine.llull.json simulate_motion duration=2 detail=summary --json   # every value has accuracy{}
llull --doc engine.llull.json check_motion_clearance source=simulation cycles=1 --json

# 5b. Does it behave like the real engine? (validation against stored manufacturer data)
llull --doc engine.llull.json compare_to_reference reference=rotax_912uls_full_throttle --json
#   → 5800 rpm  S=121.0 D=121 N·m  calibrated
#   → 5100 rpm  S=…     D=128 N·m  E=… %  band ±5 %  predicted   (values filled by the run)

# 6. One verdict, the last call of every job
llull --doc engine.llull.json check_prototype --json --save review.json
```

### 6.2 MCP (cloud)

The same commands through `/mcp`. `check_prototype` is in the `analysis` toolset and in the `assembly` toolset's
"next call" hints, so an agent that only loaded `assembly` finds it (AF-02).

### 6.3 UI — the Prototype review workspace (review and approval surface)

The UI is where the reviewer understands **how the machine works** and **why llull says it does**. Every view is
read-only except dispositions and sign-off, which are commands (L1). Patterns come from research note D. Colour is
never the only signal (WCAG 1.4.1 [D-R44]); every status has an icon shape and a word.

**Placement.** A new rail tab **Review** (icon `checklist`) next to **Mechanisms**. It opens a three-zone layout:
left panel (checklist and findings), 3D viewport (centre), and a bottom **timeline dock** (charts), which can
collapse and resize. The existing Mechanisms › Physics section and Loads & forces list stay. Review links to them.

```
┌ Review ─────────────────────┐┌───────────────────── 3D viewport ─────────────────────┐
│ Prototype readiness  ◐ 2 open││                                                       │
│ ✔ Parts are solid      12/12 ││          [joint glyphs]   [force arrows]              │
│ ✖ No interference   2 fails ▸││     ░░ overlap volume shown in red, rest ghosted ░░    │
│ ✔ Wall ≥ 0.794 mm  min 2.1   ││                                                       │
│ ▲ Connected     1 resting ▸  ││  ┌ Mechanism graph (toggle) ───────────┐               │
│ ✔ Moves          1 DOF       ││  │ ground ─⟲crank_j─ crank ─⟲rod_j─ rod │               │
│ ✔ Loops closed   2.1e-8 m    ││  │   └─⇕slide_j─ piston ···⟲wrist_j··┘  │               │
│ ✔ Cycle energy   0.08 %      ││  └──────────────────────────────────────┘               │
│ ○ Clearance in motion stale  ││                                                       │
│ ▲ Realistic inputs   1 warn ▸││                                                       │
│ ✔ Matches reality  5/5 ±5 % ▸││                                                       │
│─────────────────────────────││                                                       │
│ Findings  [type▾][status▾]   │└───────────────────────────────────────────────────────┘
│ ✖ hard  rod_1×crank_1 412 mm³│┌ Timeline ── ▶ ⏸ 1/10× ── angle ○ time ● ── 0°…720° TDC ──┐
│    status [Not reviewed ▾] 💬 ││ torque N·m ─╱╲──╱╲── ┊cursor                               │
│ ▲ rest  spinner on hub       ││ pressure bar ──▲───── ┊  ✖ collision 88°–96°               │
│─────────────────────────────││ wrist-pin kN ─╱╲──── ┊                                     │
│ [Sign review] (disabled: 1 fail open)│ rpm ───────────── ┊                                 │
└─────────────────────────────┘└──────────────────────────────────────────────────────────┘
```

UI requirements:

| Id | Pri | Requirement | Pattern source |
| -- | --- | ----------- | -------------- |
| FR-FPR-50 | MUST | **Readiness checklist**: one row per check (Parts are solid, No interference, Wall thickness, Connected, Joints realised, Moves (DOF), Loops closed, Cycle energy, Clearance in motion, **Realistic inputs** (materials, losses, sources), **Matches reality** (reference comparison)). Verification rows (Loops closed, Cycle energy, Timestep) are grouped under a "Solver self-checks" sub-header, apart from "Matches reality", so the two kinds of evidence are never read as one. Each row shows a status icon and word (pass ✔ / warn ▲ / fail ✖ / not run ○ / stale ◌), the key value with its unit, the threshold with its source, and a roll-up light. Expanding a row shows its findings and an **Explain** link. | [D-R4][D-R33] |
| FR-FPR-51 | MUST | **Findings list**: type glyph, parts, value with unit, reviewer status, comment. Filter by type and status; sort by value; group by part. Click → highlight and zoom. Double-click → isolate the pair with the rest ghosted, the overlap volume shown red, and witness points or minimum-distance segment drawn with their value. | [D-R1][D-R2][D-R4][D-R5] |
| FR-FPR-52 | MUST | **Mechanism graph**: bodies as nodes (ground at the root), joints as edges with type glyphs (⟲ revolute, ⇕ prismatic, ● spherical), loop-closure joints dashed, gear couplings dotted with the ratio, DOF badge. Problems in red with a text reason (floating, redundant, loop open). Selection syncs both ways with the 3D view and the Mechanisms panel. | [D-R14][D-R15][D-R16][D-R37] |
| FR-FPR-53 | MUST | **Shared timeline**: one cursor drives the 3D playback (existing DynamicsPlayer) and every chart. Clicking a chart seeks the playback. The x-axis switches between time and crank angle (0–720° four-stroke, TDC of cylinder 1 firing marked, the reference stated on the axis). Collision intervals and peak events are marked on the axis and are clickable. | [D-R7][D-R9][D-R41] |
| FR-FPR-54 | MUST | **Charts**: torque per cylinder and total, cylinder pressure, rpm, reactions (choose a joint), gear-mesh force, clearance vs time for a selected pair. Each chart has units on its axes, a legend, values under the cursor, and CSV export through a query command (`--save`). | [A-R8][A-R9] |
| FR-FPR-55 | MUST | **3D overlays** (toggles in a legend): joint glyphs at their anchors with axis lines; reaction and gas-force arrows scaled per layer with value labels (curved arrows for moments); trace path of a chosen point (crank pin, piston pin); a section plane through the cylinder axis (existing ClippingPlane), so the inside of the crankcase is visible. Arrows reuse the Loads & forces overlay (`DynamicsLoadsOverlay`). | [D-R10-s][D-R11-s][D-R38][D-R40] |
| FR-FPR-56 | MUST | **Thickness map**: per-part colour map on the tessellation. Cividis-type sequential, or diverging around the threshold when one is set. A hover readout shows "3.2 mm (min 0.794, cnc_metal, Xometry)". A ranked list of the thinnest regions, click to zoom. | [D-R6][D-R42] |
| FR-FPR-57 | MUST | **Explain drawer**: for any number in the Review tab, it shows method, formula, inputs (with units and their source or `unverified` flag), solver settings, versions, producing command and feature step, the **accuracy block** (FR-FPR-70: band, basis, origin, validation level, warnings; for a compared value, also S, D, E and U_val), with a "copy as CLI" button that reproduces the query. | [D-R28][D-R32] |
| FR-FPR-58 | MUST | **Dispositions and sign-off**: the status dropdown and comment per finding dispatch `set_review_disposition`. "Sign review" is enabled only when FR-FPR-33 allows it, and the reason it is disabled is written next to it. Agent-made declarations (`allow_interference`) carry an "agent" badge and their reason. | [D-R4][D-R35] |
| FR-FPR-59 | SHOULD | **Agent activity**: feature steps grouped per plan run, each with command, summary and affected ids. Clicking one highlights its affected parts. The agent's own checks are labelled "agent self-check", separately from reviewer actions ("not an independent engineering check" [D-R21]). | [D-R19][D-R21][D-R29][D-R30][D-R31] |
| FR-FPR-60 | MUST | **Accessibility**: Okabe-Ito categorical colours, cividis/viridis sequential maps (no jet or red–green), status by icon shape and text, keyboard navigation of the checklist, findings and timeline, value labels at ≥ 12 px. | [D-R42][D-R43][D-R44] |
| FR-FPR-62 | MUST | **Accuracy on screen**: every displayed number carries a compact badge, "± 5 %" or "± ?" when no band is known, and an origin tag: `input`, `calibrated` (hatched, greyed), `predicted` or `self-check`. Hovering shows the basis and the validation level. Calibrated values never get a green "pass" colour of their own. | [F-R32][E-R34] |
| FR-FPR-63 | MUST | **Reference overlay on charts**: reference points or curves are drawn on the matching chart (torque and power vs rpm; the rpm window for the propeller) as markers with error bars (U_D), with the simulated curve and its band as a shaded strip. Calibration points use a distinct marker shape. Hovering a point shows S, D, E, U_val and the source. "Show only hold-out points" is a toggle. | [E-R36][D-R7] |
| FR-FPR-61 | MUST | **Performance**: the Review tab opens from a saved `check_prototype` result instantly. Running checks shows progress and can be cancelled. Playback stays at ≥ 30 fps with overlays on, for the reference engine. | — |

### 6.4 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| Kernel shape fails to build | `FPR_PART_INVALID` with the kernel status; pairwise checks skip that part and say so | 02 |
| Two parts overlap by design (press-fit bush) | `hard` until `allow_interference kind=press_fit` is declared, then `allowed` with the reason | 03, 05 |
| A loop cannot close at the start pose | `FPR_LOOP_OPEN` with the gap per loop; no simulation | 12 |
| Planar loop modelled with all revolute joints | Mobility correct; `FPR_REDUNDANT_CONSTRAINT` warns with the joint and direction, and suggests `kind: spherical` for the wrist joint; reactions in that direction are marked `indeterminate` | 11, 14 |
| Pressure table without a source | Accepted; every derived result is `unverified`, shown in the checklist as a warning that cannot be hidden | 45 |
| Simulation drifts (loop residual 1–10 µm / > 10 µm) | `FPR_LOOP_DRIFT` warn (reactions `approximate`) / fail (reactions `unreliable`); remediation names the timestep / solref to try | 15 |
| A body with no material | `FPR_MASS_DEFAULTED` warn; mass shown with "± ?" and `unverified` | 73 |
| Operating point outside the propeller table or the reference data | `FPR_OUTSIDE_VALIDATED_RANGE` warn; the value is shown, with validation level 0 | 75, 77 |
| Simulated value outside its reference band at a hold-out point | `FPR_REFERENCE_MISMATCH` (fail when the reference is grade A or B, otherwise warn) with S, D, E and U_val | 77 |
| Sampling budget hit before the no-tunnelling criterion | `FPR_SAMPLING_COARSE` warn with the achieved resolution | 21 |
| Agent tries to accept a fail | `FPR_HUMAN_GATE` | 31 |

### 6.5 Glossary

- **TDC / BDC**: top / bottom dead centre (piston at its extreme positions).
- **IMEP / BMEP**: indicated / brake mean effective pressure. Mean torque = MEP·V_D / (4π) for a four-stroke
  [C-R18].
- **λ = r / l**: crank radius over rod length.
- **Loop closure**: a joint that is not part of the spanning tree, enforced as an equality constraint.
- **Hard / containment / touch / clearance**: pairwise classes (FR-FPR-03).
- **Joint realisation**: a joint with matching pin and bore surfaces on its axis (FR-FPR-08).

## 7. Acceptance criteria

| Given | When | Then | VC |
| ----- | ---- | ---- | -- |
| Two 20 mm cubes overlapping by 10 mm on one axis | `check_assembly` | `hard`, overlap volume 4000 mm³ ± 0.1 % | VC-FPR-01 |
| Two cubes sharing a face | `check_assembly` | `touch`, volume 0, distance 0 | VC-FPR-02 |
| Cubes 0.5 mm apart, required clearance 1 mm | `check_assembly clearance=1` | `clearance` warn, 0.5 mm ± 1e-6 | VC-FPR-03 |
| A 10 mm cube inside a 30 mm cube | `check_assembly` | `containment`, volume 1000 mm³ | VC-FPR-04 |
| One part made of two disjoint boxes | `check_assembly` | `FPR_PART_DISCONNECTED`, 2 lumps | VC-FPR-05 |
| A part not in any body, joint, fastener, nor touching anything grounded | `check_assembly` | `FPR_PART_FLOATING` | VC-FPR-06 |
| A 2 mm plate, process `cnc_metal` | `check_assembly` | min thickness 2.00 ± 0.02 mm, pass vs 0.794 mm [B-R14] | VC-FPR-07 |
| A 0.5 mm plate, process `cnc_metal` | `check_assembly` | `FPR_WALL_THIN` fail, 0.50 mm | VC-FPR-08 |
| Pin Ø10.00 in bore Ø10.02 coaxial with a revolute joint (OCC) | `check_assembly` | joint realised, diametral clearance 0.020 mm | VC-FPR-09 |
| Slider-crank r = 49.2125 mm, l = 150 mm, governed at 2700 rpm | `simulate_motion` | piston displacement matches the exact formula within 1e-6 m at θ = 30°, 60°, 90°, 120°, 150° | VC-FPR-10 |
| Same, crank held at θ by a servo, constant 1000 N gas force | `simulate_motion` | servo torque = F·dx/dθ (31.6936 / 49.9111 / 49.2125 / 35.3274 / 17.5189 N·m) within 0.5 % | VC-FPR-11 |
| Same static case | reactions | rod force F/cos β and side thrust F·tan β (e.g. 1058.594 N and 347.307 N at 90°) within 0.5 % | VC-FPR-12 |
| Loops with the named solver settings | any run in this pack | loop residual ≤ 1e-6 m | VC-FPR-13 |
| A pressure table over 720°, governed speed | `simulate_motion` | mean governor torque = −Σ∮p dV / (4π) within 0.5 %; cycle-energy closure reported | VC-FPR-14 |
| 1352 cm³ four-stroke with losses, calibrated to BMEP 11.2477 bar at 5800 rpm | `engine_quick_check` and `simulate_motion` | mean **brake** torque 121.01 N·m within 0.5 %, tagged `calibrated` (datasheet 121 N·m [C-R23]); IMEP = BMEP + FMEP reported | VC-FPR-15 |
| Gear 51/21 at 5800 rpm crank | `simulate_motion` | propeller 2388.24 rpm within 0.1 % | VC-FPR-16 |
| Gear 51/21, efficiency 0.99, 121 N·m on the crank | `simulate_motion` | propeller-shaft torque 290.92 N·m within 0.1 % | VC-FPR-27 |
| 0.40 kg piston, r 30.5 mm, l 130 mm, motored at 5800 rpm, no gas, no friction | `simulate_motion` | governor torque = m·ω²·x′·x″ (81.571 / 50.955 / −33.130 / −64.584 / −40.695 N·m at 30…150°) within 1 % | VC-FPR-28 |
| Rotax 912 geometry at 5800 rpm, `component` losses | `simulate_motion` | PNH terms skirt / rings / gas load / auxiliaries = 41.28 / 6.75 / 21.78 / 30.48 kPa (grade C until the equations are checked against the SAE originals) | VC-FPR-29 |
| 50 mm cube assigned `al_4032` | `inspect_dynamics` | mass 0.335 kg; with no material, `FPR_MASS_DEFAULTED` | VC-FPR-30, 36 |
| Rotax 912 ULS reference set | `compare_to_reference` (unit test with a synthetic S) | per point S, D, E, U_val, band ±5 %, origin; calibration points never counted as pass evidence | VC-FPR-31, 34 |
| Rotax 912 four-cylinder + 1.75 m fixed-pitch propeller (V1) | `compare_to_reference` | static full-throttle rpm inside 5100–5800 rpm | VC-FPR-32 |
| Reference engine | `check_prototype` | timestep halving changes mean brake torque and peak wrist-pin force by ≤ 1 % | VC-FPR-33 |
| Synthetic residuals 0.5 / 5 / 20 µm | report | pass / warn / fail tiers | VC-FPR-35 |
| Known flywheel inertia, single cylinder, constant load = mean torque | `simulate_motion` | speed ripple coefficient = ΔE/(I·ω₀²) from the torque curve within 5 % | VC-FPR-17 |
| A bar rotating past a block (known geometry) | `check_motion_clearance` | min clearance and crank angle of closest approach equal the analytic values; colliding variant reports the analytic contact interval within the reported resolution | VC-FPR-18/19 |
| Planar slider-crank with four revolute/prismatic joints | `inspect_dynamics` | mobility 1; one redundant direction named at the loop joint | VC-FPR-20 |
| Loop opened by 1 mm at the start | `simulate_motion` | `FPR_LOOP_OPEN`, gap 1 mm | VC-FPR-21 |
| Agent caller | `set_review_disposition status=accepted` on a fail | `FPR_HUMAN_GATE` | VC-FPR-22 |
| Same plan twice | every query of this pack | byte-identical `data` | VC-FPR-23 |
| Reference single-cylinder engine (validation/README §4) | `check_prototype` | `ready_for_review`; every checklist row pass; owner summary present | VC-FPR-24 |
| Review tab with a saved result | reviewer clicks a finding / scrubs | 3D isolates the pair; chart cursor and playback stay in sync (component + e2e tests) | VC-FPR-25/26 |

## 8. Standards & regulatory alignment

- **ISO 286-1/-2** (limits and fits): only public catalogue content (fit names, IT grade values) is used [B-R36][B-R37].
- **ISO/ASTM 52910** (design for additive manufacturing): catalogue page only, no clause content [B-R18].
- **Engine certification** (e.g. 14 CFR Part 33, CS-E): out of scope. PHY-21 results support design review only and
  say so (AF-33).
- Engine data used in validation (bore, stroke, displacement, power, gear ratio) comes from type certificate data
  sheets and maker datasheets [C-R20][C-R21][C-R22][C-R23].

## 9. KPIs / success metrics

| KPI | Target |
| --- | ------ |
| Reference engine: agent goes from empty document to `ready_for_review` using only the CLI | ≤ 1 plan file + ≤ 5 fix iterations, scripted in the production gate |
| Seeded defects found by `check_assembly` (overlap, sheet, lump, floating, thin, unrealised joint) | 100 % of the seeded corpus |
| False `hard` results on touching or coincident faces | 0 in the corpus |
| Analytic VCs (VC-FPR-10…17, 27, 28, 30) | all within tolerance in CI |
| Every number in `check_prototype` and the Review tab carries an accuracy statement and an origin | 100 % (contract test) |
| Hold-out (predicted) reference points within their band, four-cylinder reference (V1) | ≥ 80 % of points, with every miss listed with its E. A target, not a CI gate: a miss is information |
| Reviewer time to locate the cause of a fail from the Review tab | ≤ 2 clicks (finding → isolate) |
| Review tab playback with overlays | ≥ 30 fps on the reference engine |

## 10. Risks & assumptions

| Risk | Mitigation |
| ---- | ---------- |
| MuJoCo equality constraints are soft, and the docs call loop joints "slower and less accurate" [C-R2] | Accepted, per the decision on accuracy over exactness. Named stiff settings (TECHNICAL_SPEC §5.3); the loop residual is gated against the physical pin clearance (FR-FPR-15); timestep halving (FR-FPR-79); cross-check against the analytic slider-crank. No MuJoCo closed-chain benchmark against Adams was found [F-R5], so our own verification VCs are the evidence. |
| Real engine data (rod length, masses, cylinder pressure, FMEP) is not public [C §3][E §5.4] | The reference engine uses stated test values for what is missing. Calibration is to datasheet brake values. Validation uses only published curves and rpm windows. Every uncited input is `unverified`. The 130 mm Rotax rod length comes from one low-quality paper [E-R8] and is labelled so. |
| A model that matches the datasheet only because it was calibrated to it | `origin: calibrated` on those values, hold-out points (FR-FPR-78), validation level ≤ 1 when nothing is predicted. |
| No breathing model: the torque-curve shape away from the calibration point is not predicted | Stated in the result (FR-FPR-78). An optional heat-release-vs-rpm table, calibrated on named points only. Breathing is V2. |
| The friction equations come from an OCR-scanned thesis [E-R9] | Implementation is blocked until the equations are checked against SAE 890836 / 2003-01-0725 or Heywood ch. 13 (TECHNICAL_SPEC §11 Q8). VC-FPR-29 stays grade C until then. |
| Digitised manufacturer curves carry a reading error | U_D includes ±1 N·m / ±1 kW [E §5] and table inconsistencies (≥ 1.5 % on the 912 iS table [E §5.2]). |
| Exact interference on Manifold vs OCC can differ at touching faces | Classification uses tolerances and a distance query, not just the boolean; the corpus includes coincident-face cases on both kernels. |
| Pairwise checks are O(n²) | AABB broad phase, budgets, `ids`/`scope` narrowing, caching by recipe hash. |
| Two motion models (`doc.joints` kinematic vs `doc.dynamics`) confuse agents | `check_assembly` reads both. Review shows one mechanism graph, with the source of each joint labelled. A unification decision is listed (open question 2). |
| Reviewers trust a green checklist too much | Explicit "what this does not prove" line in the summary and on the checklist header; `reviewRequired` always. |

## 11. References

Research notes (full citations, every page fetched 2026-10): [A] `validation/research/A_mature_cad_motion.md`,
[B] `validation/research/B_assembly_validity.md`, [C] `validation/research/C_engine_mujoco.md`,
[D] `validation/research/D_review_ux.md`, [E] `validation/research/E_engine_realism.md` (losses, combustion,
inertia, gearbox, Rotax/Lycoming data, V&V), [F] `validation/research/F_prop_solver_realism.md` (propeller, MuJoCo
accuracy, joint friction and clearance, accuracy wording). `[A-R3]` = reference R3 of note A. The consolidated list of the references
used in this pack is in [`validation/sources.md`](validation/sources.md).
