# Gap 11 FLD — Sources

Accessed 2026-10-18. Network limits: only PyPI and npm could be downloaded. NASA NTRS, manufacturers and Wikipedia
were reached through search-engine extracts. Grades:

- **A**: the primary source or the reference code was read or run, or two or more sources agree.
- **B**: one secondary extract.
- **C**: the source was located but its numbers are not confirmed. C-grade values are never gates.

| Id | Source | Taken | How checked | Grade |
| -- | ------ | ----- | ----------- | ----- |
| S1 | Ames Research Staff, Equations, tables, and charts for compressible flow, NACA Report 1135, 1953, https://ntrs.nasa.gov/citations/19930091059 (NASA-hosted PDF: https://www.nasa.gov/wp-content/uploads/2023/03/equations-tables-charts-compressibleflow-report-1135.pdf) | closed forms; table rows at γ 1.4 | report identity confirmed (JAXA record, NASA PDF, UNT catalogue); rows recomputed from the closed forms and confirmed by independent table reproductions (search extracts: M 2 isentropic, normal shock, ν(2) 26.38°, ν(3) 49.76°, oblique M 2 θ 10° β 39.3139°, M2 1.6405, p2/p1 1.7066, θmax 22.9735°) | A (rows marked B in the JSON: computed only) |
| S2 | NASA CEA, Gordon & McBride, NASA RP-1311 (https://ntrs.nasa.gov/citations/19950013764); official NASA Python package `cea` 3.3.4 (PyPI, Apache-2.0, NASA Glenn, https://pypi.org/project/cea/) | chamber / throat / exit states, c*, Isp (frozen and equilibrium) for 3 cases | `cea` 3.3.4 reproduces the CEA2 Fortran output (May 2004, McBride & Gordon) of RP-1311 Example 8 shipped as `NASA_CEA_Fortran/cea2.out` in the rocketcea 1.2.3 sdist: Tc 3383.84 K, c* 2332.3 m/s, Isp(ε 25) 4348.5 / 4124.4 m/s | A (reference code, not measurements) |
| S3 | Rao G. V. R., Jet Propulsion 28(6), 1958; Huzel & Huang, NASA SP-125 2nd ed. 1971 (https://ntrs.nasa.gov/citations/19710019929) Fig. 4-15 / 4-16 | throat arcs 1.5 R_t / 0.382 R_t; 80 % bell θn / θe vs ε (digitised in rocketisp 0.1.13 `rocketisp/nozzle/huzel_data.py`, PyPI) | arcs: several design notes agree (Newlands "The Thrust Optimised Parabolic nozzle", RRS 2023, IJIRSET 2020); angles: one digitisation of the chart (±0.5°) | A (arcs), B (angles) |
| S4 | NASA SP-125 A-1 stage engine sample calculation (p. 54, 67–70) | 1000 psia, MR 2.35, ε 14, A_t 487 in², c* 5660 ft/s (η 0.975), C_F 1.768 vac / 1.562 SL | rocketisp `examples/A-1_Huzel*.py` transcription + an OCR extract of the NTRS scan | B |
| S5 | L3Harris RS-25 engine page (https://www.l3harris.com/all-capabilities/rs-25-engine); NASA SLS RS-25 fact sheets; Wikipedia RS-25 | Pc 2994 psia, MR 6.0, ε 69 (current large-throat chamber; 77.5 original), 512 300 / 418 000 lbf, 452.3 / 366 s | two or more extracts agree | A |
| S6 | Malina F. J., J. Franklin Inst. 230:433, 1940; Sutton & Biblarz ch. 3; NASA NTRS 19980227347 | λ = (1 + cos α)/2 | standard; cited by the NASA conical-nozzle test report | A |
| S7 | Summerfield, Foster & Swan, Jet Propulsion 24:319, 1954; NASA TP-1207 (https://ntrs.nasa.gov/citations/19780022611) | separation at p_e ≈ 0.4 p_a | NASA TP-1207 extract; NASA TM X-64890 notes 0.5–0.8 in other tests | A (as a rough rule) |
| S8 | F-1: Wikipedia, Astronautix, NASA NTRS 20030093580 | 1.522 Mlbf SL, ε 16, 304 / 263 s; Pc 70 bar vs ~965 psi (conflict) | extracts | A / B (not gated) |
| S9 | NASA SP-8120, Liquid Rocket Engine Nozzles (https://ntrs.nasa.gov/citations/19770009165) | single canted parabola approximates the optimum contour | extract | B (context) |

## Not verified

- Equation numbers and printed rows of NACA 1135 (primary PDF not readable here; closed forms are standard).
- SSME throat diameter from a primary source (~10.3 in, C).
- Merlin 1D Vac data (no reputable source): not used.
- Rao 60 / 70 / 90 / 100 % curves (present in rocketisp, not cross-checked): not used.
