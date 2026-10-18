# Gap 12 CFD — Sources

Accessed 2026-10-18. Network limits of the authoring sandbox: GitHub raw files and PyPI could be downloaded; the FEATFLOW
(TU Dortmund), FAU GitLab, Ansys help and NASA GRC NPARC hosts could not be resolved; journals and other pages were reached through
search-engine extracts only. Grades as in the other packs:

- **A**: the primary source was read, or two or more independent sources agree, or a closed form of a cited model.
- **B**: one secondary extract, or secondary extracts of a primary source that was not read.
- **C**: located but numbers not confirmed. Never used.

| Id | Source | What was taken | How it was checked | Grade |
| -- | ------ | -------------- | ------------------ | ----- |
| S1 | Franke J. et al., COST Action 732 Best practice guideline for the CFD simulation of flows in the urban environment, 2007 | domain 5H upstream / lateral / above, 15H downstream; blockage ≤ 3 % | three concordant secondary sources: a CFD study following AIJ 2008 + COST 732 (arXiv 2609.15769), Dlubal RWIND manual 005829, a PMC article attributing the 3 % limit to Franke et al. 2007 | B (rules), primary not read |
| S2 | Tominaga Y. et al., AIJ guidelines for practical applications of CFD to pedestrian wind environment around buildings, J. Wind Eng. Ind. Aerodyn. 96:1749–1761, 2008; AIJ benchmark cases | same domain rules; cases A–G exist; data via AIJ / Open CAE Society of Japan (AIJ-PWEAB) | SimScale validation pages (cases C, D, E, F), OpenFOAM wiki (Niigata case) | B (rules), TBD (case data) |
| S3 | Richards P. J., Hoxey R. P., J. Wind Eng. Ind. Aerodyn. 46–47:145–153, 1993 | log-law inlet form (V1 only) | standard form, no number taken | A (form) |
| S4 | NACA Report 1135, 1953 | θ-β-M relation, normal-shock relations, Rayleigh pitot formula, isentropic stagnation | closed forms; the M 2 / 10° oblique-shock values match the 11 FLD pack data (`compressible_naca1135.json`) to all printed digits | A |
| S5 | Aftosmis M. J., Berger M. J., Melton J. E., AIAA J. 36(6):952–960, 1998; NASA Cart3D (NTRS 20020050405, 20110010909) | Cartesian cut-cell method on surface triangulations, component intersection | bibliographic record in a later Aftosmis reference list + NASA Tech Briefs / NTRS descriptions (search extracts) | A (method description, no number taken) |
| S6 | Sod G. A., J. Comput. Phys. 27:1–31, 1978 | shock-tube initial data | closed-form test; the derived star state equals the widely published values (p* 0.30313, u* 0.92745) | A |
| S7 | Krüger T. et al., The Lattice Boltzmann Method — Principles and Practice, Springer 2017; Zou Q., He X., Phys. Fluids 9:1591, 1997 (arXiv comp-gas/9611001) | LBM formulation; half-way bounce-back second order for Poiseuille | Zou & He abstract and text (arXiv), HAL 00986823 on "magic parameters" | A (method), no number taken |
| S8 | Geier M., Schönherr M., Pasquali A., Krafczyk M., Comput. Math. Appl. 70(4):507–547, 2015, doi:10.1016/j.camwa.2015.05.001; Geier, Pasquali, Schönherr, J. Comput. Phys. 348:862–898, 2017 | cumulant collision (V1) | dblp record, lbmpy merge-request description, TU Braunschweig publication list | A (bibliography), no number taken |
| S9 | Toro E. F., Riemann Solvers and Numerical Methods for Fluid Dynamics, 3rd ed., Springer 2009 | exact Riemann solver (ch. 4), HLLC (ch. 10) | textbook algorithms; implemented in `derive_references.py` | A |
| S10 | Bouzidi M., Firdaouss M., Lallemand P., Phys. Fluids 13:3452, 2001 | interpolated bounce-back (V1) | standard reference, no number taken | A (method) |
| S11 | wgpu — https://github.com/gfx-rs/wgpu | runs on Vulkan, Metal, D3D12, OpenGL; MIT licence | README and LICENSE.MIT read from GitHub raw | A |
| S12 | PyFR — https://github.com/PyFR/PyFR, https://pyfr.readthedocs.io/en/v2.1/ | BSD 3-clause; backends C/OpenMP, CUDA, OpenCL, HIP, Metal; entropy-filter shock capturing since v2.0.0 | LICENSE read from GitHub raw; CPC program summary and v2.0.0 release notes (search extracts) | A (licence), B (feature list) |
| S13 | FluidX3D LICENSE.md — https://github.com/ProjectPhysX/FluidX3D | no commercial use; no military or defence-industry use; no AI training on the source | LICENSE.md read from GitHub raw (2026-10-18) | A |
| S14 | Schiller L., Naumann A., Z. Ver. Dtsch. Ing. 77:318–320, 1933 | Cd = 24/Re (1 + 0.15 Re^0.687), Re < 800 | OpenFOAM `SchillerNaumannDrag.H` header + arXiv 2211.05458 (two independent quotes; the year is cited as 1933 or 1935) | A (formula), primary not read |
| S15 | Billig F. S., 1967 (sphere and cylinder stand-off correlations), as cited by arXiv 2604.00953 | Δ/R = 0.143 exp(3.24/M²), γ = 1.4 | one secondary citation (arXiv 2604.00953) | B (documentation only) |
| S16 | Schäfer M., Turek S. et al., Benchmark computations of laminar flow around a cylinder, Notes Numer. Fluid Mech. 52, 1996; FEATFLOW DFG benchmark 2D-1 page | geometry, inflow, ν; Cd 5.5795, Cl 0.0107 | FEATool documentation (citing Nabh 1998, John & Matthies 2001) and an LBM study (search extracts); primary page unreachable | B |
| S17 | Ghia U., Ghia K. N., Shin C. T., J. Comput. Phys. 48:387–411, 1982 | lid-driven cavity centreline velocities | bibliographic record only (MFIX V&V manual, Altair validation pages) | TBD |
| S18 | Schmitt V., Charpin F., Pressure distributions on the ONERA-M6-wing at transonic Mach numbers, AGARD AR-138, 1979; NASA NPARC Alliance validation archive | conditions M 0.8395 / 0.84, α 3.06°, Re 11.72e6 / 11.76e6; Cp at 7 stations | NPARC page and two papers (search extracts); Cp files not downloaded | B (conditions), TBD (Cp) |

## Not verified (not used as gates)

- Any number from S16, S17, S18 until the primary data is pinned with its sha256 in `data/`.
- The accuracy of the Schiller-Naumann correlation itself; VC-CFD-21 uses a llull acceptance band instead.
- Performance figures of any existing GPU CFD code; the targets in TECHNICAL_SPEC §8 are llull goals, measured by VC-CFD-54.
