# PHY-21 sources

All sources were fetched in the 2026-10-16 research (notes A–F). The full citation of each `[X-Rn]`, with title, publisher, URL and
access note, is in the research note it comes from. Claims marked UNCONFIRMED or "(inference)" in a note are not used
as pass/fail thresholds in this pack.

| Note | File | Scope | Refs |
| ---- | ---- | ----- | ---- |
| A | [`research/A_mature_cad_motion.md`](research/A_mature_cad_motion.md) | SOLIDWORKS Motion, Simcenter/NX, CATIA DMU Kinematics, Creo Mechanism, Fusion, Onshape, MSC Adams, RecurDyn, Simscape Multibody, Altair: loops, redundancy, drivers, gas force, outputs, review UX | 71 |
| B | [`research/B_assembly_validity.md`](research/B_assembly_validity.md) | Interference classes, thickness analysis, OCCT and Manifold validity / distance APIs, connectivity, DFM, ISO 286 fits, swept interference, three-mesh-bvh, FCL | 41 |
| C | [`research/C_engine_mujoco.md`](research/C_engine_mujoco.md) | MuJoCo equality constraints, solref/solimp, reactions, WASM bindings; slider-crank kinematics; Wiebe and single-zone pressure; engine data (O-320, O-200, Rotax 912 iS); flywheel; propeller J, C_T, C_P | 29 |
| D | [`research/D_review_ux.md`](research/D_review_ux.md) | Review UX in CAD/CAE, AI-agent review patterns, sign-off, kinematic graphs, colour maps, accessibility | 44 |
| E | [`research/E_engine_realism.md`](research/E_engine_realism.md) | Friction (FMEP: Chen–Flynn, PNH/Sandoval–Heywood), single-zone + Woschni combustion, burn phasing, CCV, inertia and torsion, gear efficiency and backlash, Rotax 912 / O-320 / O-200 measured curves, accuracy of mature tools, NASA-STD-7009B and V&V 20 | 36 |
| F | [`research/F_prop_solver_realism.md`](research/F_prop_solver_realism.md) | Propeller C_T(J)/C_P(J), inertia, Rotax propeller limits and rpm windows; MuJoCo friction, contacts, integrators, accuracy; joint clearance and friction in engine MBS; how to state accuracy (NASA-STD-7009A, V&V 20) | 37 |

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
| [E-R1] BRP-Rotax, Datasheet 912 ULS/S (2021/01) — https://www.flyrotax.com/assets/files/products/Datasheet-Aircraft-Engine-Rotax-912ULS.pdf | 73.5 kW at 5800 rpm, peak 128 N·m at 5100 rpm (VC-31) | quoted |
| [E-R2] BRP-Rotax, OM-912 Ed.4 Rev.1 (2023) — https://www.rotax-owner.com/pdf/OM_912-Series_ED4_R1.pdf | CR 10.8, firing order 1-4-2-3, full-throttle torque curve Fig. 4 (VC-29, 31, §4) | quoted / digitised (B) |
| [E-R4] BRP-Rotax, IM-912 Ed.3 Rev.0 (2021) — https://www.rotax-owner.com/pdf/IM_912_Series_Ed3_R0.pdf | gear 51/21, 50/22; propeller inertia 0.15–0.60 kg·m²; 315 N·m at the propeller (VC-16, 27, FR-75, 76) | quoted |
| [E-R5] BRP, SL-912-016 (2009) — https://www.rotax-owner.com/pdf/SL-912-016.pdf | fixed-pitch take-off rpm above 5200 WOT (VC-32, FR-76) | quoted |
| [E-R9] D. Sandoval, MIT S.B. thesis (2002) — https://pdfs.semanticscholar.org/bfbf/1944c9a8d568a994082b40109ec8c3fe65ea.pdf | PNH / Sandoval–Heywood friction terms (VC-29, grade C, OCR) | reconstructed |
| [E-R21] Anderson & Loewenthal, NASA TM 81426 (1980) — https://ntrs.nasa.gov/api/citations/19800010132/downloads/19800010132.pdf | gear mesh efficiency default 0.99 (VC-27) | quoted range |
| [E-R20] Nagappa & Hebbur Rameshbabu, Chalmers MSc 2016:20 — https://publications.lib.chalmers.se/records/fulltext/255898/255898.pdf | ±5 % default reference band (FR-77) | quoted practice |
| [E-R31] AISI 4340 MatWeb sheet — https://quickparts.com/wp-content/uploads/2024/05/Steel-4340.pdf | 7.85 g/cm³ (`steel_4340`) | quoted |
| [E-R32] Smiths 4032 datasheet — https://www.smithshp.com/assets/pdf/aluminium/high-performance-aluminium/4032-aluminium-english.pdf | SG 2.68 (VC-30, `al_4032`) | quoted |
| [E-R8] Vinh & Quân, JAST 2025 — https://vjol.info.vn/vaajast/article/download/136718/111765 | 912 iS crank radius 30.5 mm × rod 130 mm (VC-28, §4; low confidence) | quoted (C) |
| [F-R19] Lycoming SSP-1776-5 (2020) — https://www.lycoming.com/sites/default/files/attachments/SSP-1776-5%2520Table%2520of%2520Limits%2520-%2520Complete.pdf | rod-bushing-to-pin clearance 0.020–0.053 mm → loop tiers (VC-35) | quoted |
| [F-R22] E-Props manual HEP-ROTAX9-2020 — https://aircraft.e-props.fr/DOCS/HEP-ROTAX9-2020-02-15-EN.pdf | static rpm window 5100–5800, level flight 5500 (VC-32) | quoted |

## Not reached (from the notes)

- help.solidworks.com (rendered by JavaScript, partly read through a headless browser in note A, and empty in note B).
- Siemens NX / Simcenter help (login).
- 3DEXPERIENCE help (login).
- Adams Engine documentation.
- ISO/ANSI previews (403).
- PTC CS37579, Javelin and Autodesk Learn (403).

Nothing from these is used as a threshold.
