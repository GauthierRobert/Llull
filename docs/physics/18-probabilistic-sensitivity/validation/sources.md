# PHY-18 PRB: external sources

All entries accessed **2026-10-15**. Access grades: **downloaded** (repository / package downloaded and read),
**fetched** (page opened; none succeeded this session — arxiv.org, asme.org and most journal hosts failed DNS or were
refused by the egress proxy), **search extract** (only search-engine text seen).

| Id | Source | Publisher / licence | URL | Access | What was verified |
| -- | ------ | ------------------- | --- | ------ | ----------------- |
| S1 | Hasofer & Lind, "Exact and Invariant Second-Moment Code Format", J. Eng. Mech. Div. 100(1):111–121, Feb 1974 | ASCE | https://ascelibrary.com/doi/10.1061/JMCEA3.0001848 | search extract | Record: title, volume, issue, pages; abstract: exact formulation of second-moment reliability in multivariate problems; often cited as "An Exact and Invariant First Order Reliability Format". The index's invariance and the HL algorithm are used as standard knowledge; the paper text was not read. |
| S2 | Rackwitz & Fiessler 1978 (HL-RF iteration) | Computers & Structures | — | **not verified** | Citation from general knowledge only; no search confirmed it this session. |
| S3 | Breitung, "Asymptotic Approximations for Multinormal Integrals", J. Eng. Mech. 110(3):357–366, 1984 | ASCE | https://ascelibrary.com/doi/10.1061/%28ASCE%290733-9399%281984%29110%3A3%28357%29 | search extract | Record and abstract: quadratic Taylor expansion gives an asymptotic approximation; linear approximations can have large relative errors. The product formula Π(1 + βκ_i)^(−1/2) is used as standard knowledge (grade B in VC-PRB-04.c). |
| S4 | McKay, Beckman, Conover 1979, Technometrics 21(2) (LHS) | ASA | — | **not verified** | Citation from general knowledge only. |
| S5 | OpenTURNS use cases `stressed_beam.py` (axial stressed beam) | OpenTURNS consortium; **LGPL-3.0+** | https://github.com/openturns/openturns (commit 829e678d78400544bd0849199caefd3f62cbeadd, `python/src/usecases/stressed_beam.py`) | downloaded | Model: R ~ LogNormalMuSigma(3.0e6, 3.0e5), F ~ Normal(750, 50), g = R − F/(π/10000). A published Pf for this use case was **not** found (search returned nothing); the exact Pf in VC-PRB-03 is the generator's own quadrature. An OpenTURNS discussion thread (search extract, https://openturns.discourse.group/t/improving-the-form-example/97) warns that the FORM Pf formula must handle the origin in the failure domain — reflected in TECHNICAL_SPEC §5.3. |
| S6 | SALib `test_functions/Ishigami.py`, `Sobol_G.py` | SALib developers; **MIT** | https://github.com/SALib/SALib (commit 748cf169e82227bcc56dcfc961fcfb03a1e0df45) | downloaded | Ishigami f = sin x1 + A sin² x2 + B x3⁴ sin x1, A = 7, B = 0.1; expected first-order indices x1 0.3139, x2 0.4424, x3 0.0 (citing Saltelli et al. 2008 *Global Sensitivity Analysis: The Primer*); Sobol G cites Saltelli et al. 2010 Comput. Phys. Commun. 181:259–270. |
| S7 | OpenTURNS use case `ishigami_function.py` | OpenTURNS; **LGPL-3.0+** | same repository and commit, `python/src/usecases/ishigami_function.py` | downloaded | X_i ~ U(−π, π); expectation a/2; variance 1/2 + a²/8 + bπ⁴/5 + b²π⁸/18; S1 = (1/2 + bπ⁴/5 + b²π⁸/50)/V; S2 = (a²/8)/V; S3 = 0; S13 = b²π⁸/2 (1/9 − 1/25)/V; ST1 = S1 + S13; ST2 = S2; ST3 = S13. The generator's closed form reproduces these exactly. |
| S8 | MMPDS statistical property analysis overview (2015); CMH-17 basis definitions | Battelle / MMPDS; CMH-17 | https://www.mmpds.org/wp-content/uploads/2015/03/mmpds_2015_statistical_property_analysis_overview.pdf ; https://www.montana.edu/dcairns/documents/introduction_to_aerospace-web/12-DesignAllowables.pdf | search extract | T99 (A-basis): at least 99 % of the population equals or exceeds with 95 % confidence; T90 (B-basis) 90 % with 95 % confidence; CMH-17: 95 % lower confidence bound on the 1st / 10th percentile; mean − K·s form with tolerance factors from tables; A-/B-basis need minimum populations (MMPDS: 100; non-parametric A-basis 299). Tolerance-factor **values** were not seen (VC-PRB-08 is the generator's exact computation; the commonly quoted 2.355 / 3.981 for n = 10 are from memory, to confirm). |
| S9 | Licences of UQ libraries (PyPI metadata): SALib 1.6.0 MIT; OpenTURNS 1.27 LGPL-3.0+; UQpy 4.2.1 MIT; chaospy 4.3.21 MIT; pystra 1.6.0 Apache-2.0 | PyPI | https://pypi.org/project/SALib/ , /openturns/ , /UQpy/ , /chaospy/ , /pystra/ | downloaded (metadata) | Licence fields / classifiers as listed. Candidates for external cross-checks only; llull implements its own pure `@lib` modules. |
| L1 | llull repository | this repo | `packages/core/src/commands/parametric/{parameters,expression,configurations}.ts`, `commands/history/regenerate.ts`, `commands/types.ts`, `commands/inspect/measureSolid.ts`, `commands/solids/basic.ts` | local | `set_parameter` regeneration, `=expr` resolution, expression grammar (no `^`, `pow`, `pi`, trig), `replayCache`, `mass_properties` data shape. |
| L2 | 03 GDT, 08 MAT, PHY-01 packs | this repo | `docs/aerospace/03-gdt-mbd-pmi/TECHNICAL_SPEC.md` §5.7; `docs/aerospace/08-…/TECHNICAL_SPEC.md` §3.1; `docs/physics/01-property-models/TECHNICAL_SPEC.md` §3, §5.5 | local | Seeded PRNG and MC bounds; `Basis`; `PropertyUncertainty { kind, relative, absolute, coverage, provenance }`, band rule, OQ-PROP-10 deferring propagation to PHY-18. |

## Citation id mapping (specs [Rn] ↔ register [Sn])

| Spec | Register |
| ---- | -------- |
| R1 | S1 |
| R2 | S2 |
| R3 | S3 |
| R4 | S4 |
| R5 | S6 |
| R6 | Saltelli et al. 2010, cited inside S6 |
| R7 | S5, S7 |
| R8 | S8 |
| L1 | L1, L2 |

## Not verified (follow-up needed)

- Rackwitz & Fiessler 1978 and McKay et al. 1979 citations (S2, S4).
- Breitung's product formula and sign convention (S3): implemented as standard knowledge, VC-PRB-04.c is grade B.
- Published tolerance-factor tables (CMH-17 Vol. 1 / MMPDS) to confirm VC-PRB-08 independently.
- Any published Pf for the OpenTURNS stressed-beam use case.
- The "rule of three" zero-failure bound and the damped (improved) HL-RF step: textbook knowledge, uncited here.
- 14 CFR 25.613 wording (forum quote only).
