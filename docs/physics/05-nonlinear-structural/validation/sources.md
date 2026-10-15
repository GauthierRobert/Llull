# PHY-05 NLS: external sources

All entries accessed **2026-10-15**. Access kinds:

- **git**: repository cloned through the session's git proxy; files read; commit pinned.
- **raw**: single files downloaded from gitlab.com (raw endpoint or API); sha256 recorded.
- **search**: only the text returned by a web search was seen; the page itself was not reachable (WebFetch DNS failure or
  egress proxy refusal for docs.software.vt.edu, ceae-server.colorado.edu, abaqus-docs.mit.edu, help.altair.com,
  readthedocs.io, standards.nasa.gov, ams.org, arxiv.org). Such values are re-checked by a human before release.

Grades follow physics README §6.3: **A** = ≥ 2 independent sources or exact derivation in the generator, **B** = one
secondary source, **C** = source exists but value not confirmed.

| Id | Source | Publisher / licence | URL | Access | What was verified | Grade |
| -- | ------ | ------------------- | --- | ------ | ----------------- | ----- |
| S1 | Abaqus Benchmarks Guide, NL7 "Lee's frame buckling problem" | Dassault Systèmes (university mirrors) | https://docs.software.vt.edu/abaqusv2024/English/SIMACAEBMKRefMap/simabmk-c-nl7.htm ; https://ceae-server.colorado.edu/v2016/books/bmk/ch04s06anf44.html | search | B22 elements, RIKS, reference NAFEMS Test NL7 (NNB Rev. 1, 1989). Deflection at A 0.407 at normalised load 18.55 (matches reference); 0.781 at 31.89 vs reference 0.784 (0.38 % low). Geometry/material not in the extract: L = 120, E = 720, A = 6, I = 2, load at 24 from the corner are the classical Lee-frame data; the generator reproduces 18.56 / 0.406 / 0.781 with them, which confirms the set (normalisation P L²/EI, v/L) | B (quote) → A with S20 generator for 18.55 / 0.407 / 0.781 |
| S1b | Abaqus Benchmarks Guide, NL2 "Axisymmetric thick cylinder" | Dassault Systèmes | https://docs.software.vt.edu/abaqusv2024/English/SIMACAEBMKRefMap/simabmk-c-nl2.htm | search | E = 207 GPa, ν = 0.3, yield 207.9 MPa; pressure 80 → 160 MPa in 20 MPa steps; radial and hoop stress tables at 8 radii (from r ≈ 104.2 to 193.7 mm); one discrepancy (σθθ at 80 MPa, r = 124.2 mm, 95.8 MPa, −2.74 %). Radii a, b and the table values were **not** seen | C |
| S2 | CalculiX CrunchiX User's Manual (`doc/CalculiX.tex`), LOGBOOK, test suite | G. Dhondt; GPL-2.0 | https://github.com/Dhondtguido/CalculiX (commit fd588701edd6a92fde06e99b1bdf01f3b0f80f2c) | git | `*STATIC` parameters SOLVER, DIRECT, EXPLICIT, TIME RESET, TOTAL TIME AT START and the increment line; `*STEP` NLGEOM / INC (default 100); no "riks" / "arc-length" anywhere in the manual; LOGBOOK 25 Oct 2019 "looked into the equations for the arc length method"; `*CONTROLS` and convergence criteria defaults (R_n 0.005, C_n 0.02, R_p 0.02, ε 1e-5, C_ε 0.001, I_p 9; 5 cutbacks; D_f 0.25); `*PLASTIC` hardening options and row rules; `*DEFORMATION PLASTICITY` Ramberg-Osgood form; output PEEQ (frd PE), RF. Test decks (sha256 of the `.inp` at that commit): `beampiso` 2335d106…9735 (isotropic hardening, `*STEP,NLGEOM`, `*STATIC,DIRECT`, `*PLASTIC` 800/0, 1600/0.1), `beampkin` cebe5873…67af, `beampd` 9fb44906…50b9; each has a `.dat.ref` | A (primary documentation) |
| S3 | code_aster source: `code_aster/Cata/Commons/c_pilotage.py` | EDF; GPL-3.0 | https://gitlab.com/codeaster/src/-/blob/94bf28a308de5a77587675a598aacdddb722f84e/code_aster/Cata/Commons/c_pilotage.py | raw | `PILOTAGE` `TYPE` ∈ {DDL_IMPO, LONG_ARC, PRED_ELAS, DEFORMATION, ANA_LIM}: code_aster offers arc-length (LONG_ARC) and limit analysis (ANA_LIM) controls | A (primary source) |
| S4 | suanPan manual, Lee's frame example | T. L. Chang | https://github.com/TLCFEM/suanPan-manual (commit 4af0f1a39fb5abc19962c907aeded0d7eec797b4), `docs/Example/Structural/Statics/lees-frame.{md,supan}` | git | Normalised Lee frame (5 × 5, load at 1 from the corner, pinned supports, EB21 elements, large area 500 to suppress axial deformation), arc-length solution with snap-through and snap-back. No numeric reference values (plot only) | B (qualitative cross-check) |
| S10 | Bisshopp & Drucker, "Large deflection of cantilever beams", QAM 3 (1945) 272–275; Bisshopp 1973 QAM approximations | AMS | https://www.ams.org/qam/1973-30-04/S0033-569X-1973-99716-X | search | Citation and that the exact solution is in complete and incomplete elliptic integrals; SOFiSTiK BE7 verification uses it as reference. No table values seen. The generator derives the closed form independently and cross-checks it with its corotational solver (agreement 6e-5 at λ = 1) | A (generator, two methods) |
| S11 | Abaqus Benchmarks 3.2.14 "Cylinder under internal pressure" | Dassault Systèmes | https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-cylinderunderpress.htm | search | Elastic-perfectly plastic Mises thick cylinder, plane strain, discussed by Prager & Hodge (1951); exact rigid-plastic solution as reference. Formulas not in the extract; the generator derives them | A (generator derivation), problem class B |
| S12 | C. Caprani, Plastic Analysis notes (SA III) | C. Caprani | https://www.colincaprani.com/files/notes/SAIII/Plastic%20Analysis%200809%20-%20Update.pdf | search | Notes cover fixed-fixed and propped cantilever collapse mechanisms; the collapse loads in the generator are derived by virtual work, not quoted | A (generator derivation) |
| S20 | This pack's generator `generate_nls_reference.py` | llull (this repo) | `validation/generate_nls_reference.py` | local | Corotational Euler-Bernoulli beam + spherical arc-length; Lee frame mesh study 10 / 20 / 40 elements per leg: peak 18.6588 / 18.5825 / 18.5632 at v/L 0.40663 / 0.40625 / 0.40616; v/L at 31.89: 0.7809. Independent of S1 (own code, own algorithm) | — |
| S21 | NAFEMS NNB Rev. 1 "NAFEMS Non-Linear Benchmarks" (1989); NAFEMS R0030 | NAFEMS (paid) | https://www.nafems.org/publications/pubguide/benchmarks/ | search (catalogue) | Exists; tests NL1–NL7 referenced by S1/S1b. Content not seen | C |
| L1 | llull architecture, dependency rules, 05 / 08 / PHY-00 / PHY-02 specs | this repo | `.claude/rules/architecture.md`, `.dependency-cruiser.cjs` (`plugins-and-kernels-depend-on-core-only`), `docs/aerospace/05-fea-cae-handoff/`, `docs/physics/00-vv-harness/`, `docs/physics/02-constitutive-models/` | local | Laws, placement constraint, baseline interfaces | — |

## Citation id mapping (spec [Rn] ↔ register [Sn])

| Spec | Register |
| ---- | -------- |
| R1 (14 CFR 25.305), R4 (NASA-STD-5001B) | aerospace 05 register S1a, S2 |
| R2 | S2 |
| R3 | S1, S1b |
| R6 | S3 |
| R7 | S4 |
| R10, R11, R12 | S10, S11, S12 |

## Not verified (follow-up)

- NAFEMS NNB text, NL2 radii and stress tables, NL7B target (gap list: mesh dependent, about 17 % high) — not used.
- The exact ccx stdout increment format (fixture to capture from a real run, TECHNICAL_SPEC §11 q7).
- Altair OptiStruct OS-V:0290 "Lee's Frame Postbuckling" cites NAFEMS P10 with a different geometry (30 × 20 mm section,
  P = 20 kN, E = 71.74 GPa) per search extract; not used.
- Any public source for a default imperfection amplitude or permanent-set threshold (none used by design, AF-31).
