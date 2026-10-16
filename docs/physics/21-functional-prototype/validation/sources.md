# PHY-21 sources

All sources were fetched in the 2026-10-16 research. The full citation of each `[X-Rn]`, with title, publisher, URL and
access note, is in the research note it comes from. Claims marked UNCONFIRMED or "(inference)" in a note are not used
as pass/fail thresholds in this pack.

| Note | File | Scope | Refs |
| ---- | ---- | ----- | ---- |
| A | [`research/A_mature_cad_motion.md`](research/A_mature_cad_motion.md) | SOLIDWORKS Motion, Simcenter/NX, CATIA DMU Kinematics, Creo Mechanism, Fusion, Onshape, MSC Adams, RecurDyn, Simscape Multibody, Altair: loops, redundancy, drivers, gas force, outputs, review UX | 71 |
| B | [`research/B_assembly_validity.md`](research/B_assembly_validity.md) | Interference classes, thickness analysis, OCCT and Manifold validity / distance APIs, connectivity, DFM, ISO 286 fits, swept interference, three-mesh-bvh, FCL | 41 |
| C | [`research/C_engine_mujoco.md`](research/C_engine_mujoco.md) | MuJoCo equality constraints, solref/solimp, reactions, WASM bindings; slider-crank kinematics; Wiebe and single-zone pressure; engine data (O-320, O-200, Rotax 912 iS); flywheel; propeller J, C_T, C_P | 29 |
| D | [`research/D_review_ux.md`](research/D_review_ux.md) | Review UX in CAD/CAE, AI-agent review patterns, sign-off, kinematic graphs, colour maps, accessibility | 44 |

## Sources that carry pass/fail values

| Ref | Used for | Value |
| --- | -------- | ----- |
| [C-R12] GCEK Patna, Kinematics and Dynamics of Machines, Module 3 — https://gcekbpatna.ac.in/assets/documents/lecturenotes/KDM_module_3.pdf | slider-crank formulas (VC-10…12) | formulas |
| [C-R18] MIT 2.61 (2017) Lecture 2 — https://ocw.mit.edu/courses/2-61-internal-combustion-engines-spring-2017/cf3aaf55ae71710c9bfd3056515b9b67_MIT2_61S17_lec2.pdf | MEP ↔ power (VC-15) | BMEP = P_b/(V_D·N/n_R) |
| [C-R23] BRP-Rotax, Datasheet 912 iS/iSc Sport (2021/01) — https://www.flyrotax.com/assets/files/products/Datasheet-Aircraft-Engine-912-iS-iSc-Sport.pdf | 1352 cm³, 73.5 kW at 5800 rpm, 121 N·m, i = 2.43, bore 84 / stroke 61 mm (VC-15, 16, §4) | quoted |
| [C-R20] Lycoming O-320 Operator's Manual 60297-30 — https://www.lycoming.com/sites/default/files/attachments/O-320%2520Operator%2520Manual%252060297-30.pdf | stroke 3.875 in (test geometry size) | quoted |
| [C-R25] CodeCogs, Turning moment diagrams and flywheels — https://www.codecogs.com/page/1245/v/3736 | ΔE/(I·ω₀²) (VC-17) | formula |
| [C-R2][C-R3] MuJoCo Computation and Modeling chapters — https://mujoco.readthedocs.io/en/stable/computation/index.html , https://mujoco.readthedocs.io/en/stable/modeling.html#csolver | loop constraints, steady violation formula (VC-13 derivation) | formula |
| [A-R59][A-R60] Hexagon Adams 2021.0.2 Solver / View user guides (URLs in note A) | Gruebler count, redundancy wording (VC-20) | formula |
| [B-R14] Xometry, CNC thin walls (URL in note B) | `cnc_metal` 0.794 mm (VC-07, grade B) | quoted |
| [B-R12][B-R15][B-R16] Protolabs, Engineers Edge (URLs in note B) | other process thresholds (grade B) | quoted |

## Not reached (from the notes)

- help.solidworks.com (rendered by JavaScript, partly read through a headless browser in note A, and empty in note B).
- Siemens NX / Simcenter help (login).
- 3DEXPERIENCE help (login).
- Adams Engine documentation.
- ISO/ANSI previews (403).
- PTC CS37579, Javelin and Autodesk Learn (403).

Nothing from these is used as a threshold.
