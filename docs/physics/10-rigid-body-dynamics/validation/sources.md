# PHY-10 RBD: external sources

Accessed **2026-10-15**. **git** = cloned or raw file read from GitHub at a pinned commit; **search** = only
web-search text seen (WebFetch failed DNS for archimede.uniba.it and dlmf.nist.gov was not fetched).
Grades: **A** ≥ 2 independent sources or exact derivation, **B** one secondary source, **C** not confirmed.

| Id | Source | Licence / publisher | URL | Access | What was verified | Grade |
| -- | ------ | ------------------- | --- | ------ | ----------------- | ----- |
| S1 | Test Set for IVP Solvers (Università di Bari), problem `andrews` (index-3 DAE, dimension 27; file revision `andrews.F,v 1.2 2006/10/02`) | Bari test set (disclaimer page) | https://archimede.uniba.it/~testset/problems/andrews.php ; report https://archimede.uniba.it/~testset/report/andrews.pdf | via S2 (host not fetched) | The Fortran header in S2 states it is derived from the test set and quotes the revision | A (with S2, S4 reproduction) |
| S2 | deTestSet 1.1.7.4 (K. Soetaert, J. Cash, F. Mazzia; CRAN, published 2023-07-08), `src/Ex_andrews.f` (residual, mass matrix, constraint Jacobian, `andsoln` reference at t = 0.03 computed with PSIDE, rtol = atol = 1e-14 on a Cray C90), `R/ex_andrews.R` (initial vector) | GPL | https://github.com/cran/deTestSet/tree/d5c4cbe821920ad0a2ac36ec03c6175531316213 | git | All 42 parameters, q₀, initial accelerations and multipliers, the 27 reference components at 0.03 s (angles and velocities quoted in `andrews_reference.json`), sign convention M q̈ = f − Gᵀλ | A |
| S3 | E. Hairer, G. Wanner, *Solving Ordinary Differential Equations II*, Springer (Andrews' mechanism, p. 377 per S4) | Springer | — | citation (via S2, S4) | Origin of the problem | citation |
| S4 | SolveDAE `examples/daes/andrews.py` | GitHub (licence not checked) | https://github.com/SolveDAE/solve_dae | git raw | Same parameters and initial values as S2; cites S1, S3 and a stabilised index-1 formulation (doi 10.1002/nme.1620320803) | B (corroboration) |
| S5 | M. Arnold, O. Brüls, "Convergence of the generalized-α scheme for constrained mechanical systems", Multibody Syst. Dyn. 18(2):185–202, Sept 2007 | Springer; open copies ORBi, HAL, Halle report 07-09 | https://orbi.uliege.be/handle/2268/27094 ; https://hal.archives-ouvertes.fr/hal-01490825 | search | Abstract: variant of generalized-α for index-3 DAEs, second-order convergence for coordinates and multipliers | B (abstract) |
| S6 | J. Chung, G. M. Hulbert, J. Appl. Mech. 60:371, 1993 (generalized-α) | ASME | — | search | Citation (several reference lists); the α_m, α_f, γ, β(ρ∞) relations are the standard published ones and must be re-checked against the paper before implementation (DOI not confirmed) | B |
| S7 | J. Baumgarte, "Stabilization of constraints and integrals of motion in dynamical systems", CMAME 1:1–16, 1972, doi:10.1016/0045-7825(72)90018-7 | Elsevier | — | search | Citation and DOI | A (citation) |
| S8 | NIST DLMF §22.19(i): pendulum period 4K(sin(α/2)) in scaled time; separatrix at α = π | NIST | https://dlmf.nist.gov/22.19 | search | Period formula and modulus; √(l/g) scaling from secondary sources (arXiv physics/0510206, 2108.09395) | A (with numerical check) |
| S9 | NIST DLMF §19.8: K(k) = π / (2 M(1, k′)) | NIST | https://dlmf.nist.gov/19.8 | not fetched | The identity is verified numerically in the generator against Simpson quadrature of the defining integral (agreement to 12 digits) | A (derived) |
| S10 | Project Chrono | BSD-3-Clause ("Copyright (c) 2016, Project Chrono Development Team") | https://github.com/projectchrono/chrono (HEAD 60b3938a9d4ecb56d99d8b8724abdbc89db68f32) | git raw (LICENSE) | Licence only | — |
| S11 | MuJoCo | Apache-2.0 | https://github.com/google-deepmind/mujoco (HEAD 0d1406da61670d085bb0bcec47b502899b188a03) | git raw | LICENSE; `doc/programming/simulation.rst`: "MuJoCo simulations are deterministic"; warm-start note on reproducibility; `doc/computation/index.rst` models soft constraints; README lists JavaScript bindings and WebAssembly support | — |
| S12 | Rapier and rapier.js | Apache-2.0 | https://github.com/dimforge/rapier (HEAD 475caa3ff4646fd9a796b67d14116256f4962bc7) | git raw | LICENSE; README JavaScript bindings; `crates/rapier3d/Cargo.toml` feature `enhanced-determinism = ["simba/libm_force", "parry3d/enhanced-determinism"]` | — |
| S13 | Elementary rigid-body mechanics (pendulum tension, parallel-axis theorem, slider-crank kinematics, SMD, Coulomb oscillator) | textbook | — | — | No source fetched; every formula is written out in the generator and cross-checked numerically (finite differences, ODE simulation, exact piecewise solution) | derived |

## Spec id mapping

| Spec | Register |
| ---- | -------- |
| R1, R2, R3, R4 | S1, S2, S3, S4 |
| R5, R6, R7 | S5, S6, S7 |
| R8, R9 | S8, S9 |
| R10, R11, R12 | S10, S11, S12 |

## Not verified (follow-up)

- The Bari report PDF itself (host blocked); values come from its Fortran distributed in deTestSet and are
  reproduced independently.
- Body-fixed pivot coordinates of Andrews' mechanism (figure in S3) for a native llull plan.
- Chung–Hulbert parameter formulas against the original paper; Arnold–Brüls algorithm details beyond the abstract
  (the open Halle report 07-09 should be read before M2).
- Chrono JS/WASM availability; Rapier cross-platform determinism beyond the Cargo feature name.
- A sourced friction-coefficient dataset (none found; friction values stay user inputs with citations).
