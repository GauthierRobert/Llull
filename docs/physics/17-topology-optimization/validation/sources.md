# PHY-17 TOP: external sources

All entries accessed **2026-10-15**. Access grades: **downloaded** (package / repository downloaded through the
session proxy and read, or run), **fetched** (page opened; none succeeded: WebFetch failed DNS for
topopt.mek.dtu.dk and lirias.kuleuven.be), **search extract** (only search-engine text seen).

| Id | Source | Publisher / licence | URL | Access | What was verified |
| -- | ------ | ------------------- | --- | ------ | ----------------- |
| S1 | Andreassen, Clausen, Schevenels, Lazarov, Sigmund, "Efficient topology optimization in MATLAB using 88 lines of code", Struct. Multidisc. Optim. 43(1):1–16, 2011, doi:10.1007/s00158-010-0594-7; DTU page offering `top88.m` | Springer; DTU TopOpt group (educational code) | https://www.topopt.mek.dtu.dk/apps-and-software/efficient-topology-optimization-in-matlab ; https://www.doi.org/10.1007/S00158-010-0594-7 | search extract | Citation; built on Sigmund's 99-line code; adds a density filter; ~100× speed-up on a 7 500-element benchmark through preallocation and vectorisation; full code in the appendix; `top88.m` and the PDE-filter variant `top82.m` downloadable. The paper text and `top88.m` were **not** opened. |
| S2 | Sigmund, "A 99 line topology optimization code written in Matlab", Struct. Multidisc. Optim. 21:120–127, 2001 | Springer | — | search extract (cited in S1 summaries) | Existence and role as the predecessor of S1. |
| S3 | topoptlab 1.0.0 | S. Hiemer; **GPL-3.0** | https://pypi.org/project/topoptlab/1.0.0/ (sdist sha256 4978a92ad52afff9f9211ae4da8a5901d9b7e5abc43b8463a9b03f77ff5c090e) | downloaded + run | README: Python re-implementation in the style of the 88-line code; MBB call `main(nelx=60, nely=20, volfrac=0.5, rmin=2.4, optimizer="oc", bcs=mbb_2d)`; features: modified SIMP, RAMP, sensitivity / density filters, Langelaar 2D AM filter, Heaviside projections, MMA/GCMMA via mmapy, OC. `example_bc/lin_elast.py::mbb_2d` ("the standard case from the 88 line code paper"): fixed = x-DOFs of the left edge + last DOF, f[1] = −1. `optimizer/optimality_criterion.py::oc_top88`: move 0.2, l1 = 0, l2 = 1e9, stop (l2 − l1)/(l1 + l2) > 1e-3, x·sqrt(−dc/dv/λ). `topology_optimization.py`: sensitivity filter H(x·dc)/Hs/max(1e-3, x), density filter H(dc/Hs), stop at change < 0.01, defaults eps = 1e-9, penal = 3. **Run** (stubbing unused imports): final objective 203.19245763914194 (ft = 0), 218.80322107077228 (ft = 1); xPhys mean 0.49997009027820527 (ft = 0). |
| S4 | ToPy | W. Hunter; **MIT** | https://github.com/williamhunter/topy (commit 3c461c4b65c0f5f0c5476a4711a26a7e1ff64e58, 2022-08-31) | downloaded | README: compliance, mechanism synthesis and heat conduction in 2D/3D; stable release Python 2.7 only (`setup.py` `python_requires='~=2.7'`), master "should work with Python 3". |
| S5 | topopt (Python) | Z. Ferguson; **MIT** | https://github.com/zfergus/topopt (commit c3d3bd546327732b72ea3862d0283b324b25422f) | downloaded | README: MBB example with MMA, density-based filter; early development. |
| S6 | CalculiX User's Manual (`doc/CalculiX.tex`) | G. Dhondt; GPL-2.0 | https://github.com/Dhondtguido/CalculiX (commit fd588701edd6a92fde06e99b1bdf01f3b0f80f2c) | downloaded | `*DESIGN VARIABLES` TYPE=COORDINATE (surface nodes moved normal to the surface) or ORIENTATION; `*DESIGN RESPONSE`, `*SENSITIVITY`, `*FEASIBLE DIRECTION`, `*FILTER`, `*GEOMETRIC CONSTRAINT`; worked shape-optimisation example (beam, design-variable node sets). No density / topology optimisation keyword found (grep for "topology optimization" returns nothing). |
| S7 | mmapy 0.3.1 | A. Deetman; **GPL-3.0** | https://pypi.org/project/mmapy/ | downloaded (metadata) | Licence classifier GPLv3. |
| S8 | nlopt 2.11.0 (Python wheel) | PyPI lists **MIT** | https://pypi.org/project/nlopt/ | downloaded (metadata) | Licence classifier MIT for the wheel; NLopt's per-algorithm licensing not checked. |
| S9 | SciPy 1.18.1; NumPy 2.5.x | SciPy developers (BSD-style text); NumPy (`BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0`) | https://pypi.org/project/scipy/ ; https://pypi.org/project/numpy/ | downloaded | Licence metadata; SciPy wheel used for the cross-check. |
| S10 | pyMOTO 2.0.1 | PyPI licence field MIT | https://pypi.org/project/pyMOTO/ | downloaded (metadata) | Another permissive topology optimisation framework (not evaluated). |
| S11 | scikit-fem 12.0.2 | BSD (classifier) | https://pypi.org/project/scikit-fem/ | downloaded (metadata) | Candidate FE assembly library (BSD) if the bridge needs non-voxel elements (V1). |
| L1 | llull repository | this repo | `packages/core/src/plugins/plugin.ts`, `commands/derivation.ts`, `domain-aec/src/shared/derived.ts`, `model/types.ts` (`MeshSolidEntity`), `commands/solids/profile.ts`, `commands/edit/batch.ts`, `commands/draw2d/basic.ts` | local | Derivation guards, derived ids, mesh entity, rebuild commands and their params. |

## Citation id mapping (specs [Rn] ↔ register [Sn])

| Spec | Register |
| ---- | -------- |
| R1 | S1 |
| R2 | S2 |
| R3 | DTU "Topology optimization codes written in Python" page (search extract only) |
| R4 | S3 |
| R5 | S4 |
| R6 | S5 |
| R7 | S6 |
| R8 | S9 |

## Not verified (follow-up needed)

- The **paper text and `top88.m`** (S1): not reachable. The algorithm details were taken from topoptlab (S3) and
  reproduced; two independent codes agree on the final compliance, but the iteration counts and grey levels are
  pinned from one implementation only (grade B).
- **Reported values in the paper** for the MBB problem (compliance, iterations, timing) and for the 300×100 figure:
  not seen; VC-TOP-12 is TBD.
- **Langelaar AM filter**, **Svanberg MMA**, **Bendsøe/Sigmund SIMP** original papers: not opened; only named.
- **NLopt per-algorithm licence** (S8) and the GPL status of using mmapy in a separate process: legal question
  (TECHNICAL_SPEC §11).
