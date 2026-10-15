# PHY-09 DYN: external sources

Accessed **2026-10-15**. Access column: **git** = cloned / raw file read from GitHub at a pinned commit;
**search** = only web-search text was seen (WebFetch failed DNS and the egress proxy refused curl with 403 for
standards.nasa.gov, ntrs.nasa.gov, vibrationresearch.com, everyspec.com, klabs.org, extapps.ksc.nasa.gov and the
Berkeley mirror of NASA-STD-7001). Source grade for values: **A** ≥ 2 independent sources or exact derivation,
**B** one secondary source, **C** not confirmed.

| Id | Source | Licence / publisher | URL | Access | What was verified | Grade |
| -- | ------ | ------------------- | --- | ------ | ----------------- | ----- |
| S1 | CalculiX CrunchiX User's Manual `doc/CalculiX.tex` | G. Dhondt, GPL-2.0 | https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c | git | Keyword sections read in full: `*STEADY STATE DYNAMICS` (second line fields, defaults 20 points / bias 3, point-count rule nm − m + n, HARMONIC=NO), `*MODAL DYNAMIC` (STORAGE=YES requirement, DIRECT/DELTMX, STEADY STATE), `*DYNAMIC` (HHT ALPHA ∈ [−1/3, 0] default −0.05, EXPLICIT values), `*MODAL DAMPING` (MODAL=DIRECT lines, RAYLEIGH ",,α,β", ζⱼ = α/(2ωⱼ) + βωⱼ/2), `*DAMPING` (Rayleigh for *DYNAMIC; STRUCTURAL as material card, F = iζK x), `*BASE MOTION` (DOF 1–3, TYPE default ACCELERATION, acceleration only for SSD), `*AMPLITUDE` (frequency in SSD), frequency-analysis participation factors and effective mass, complex SSD output and `PU`/`PHS`/`PNT`, output keys `U`, `V`, `A`. No PSD/random or response-spectrum procedure found (grep). Manual typo noted: the `*DAMPING` example text says "2·10⁻⁴" for `BETA=2.e-3` | A (primary) |
| S2 | CalculiX test suite `beamdy1`, `beamdy3`, `beamdy8`, `beamdy10bm`, `beamdynamic` (`.inp`, `.dat.ref`) | GPL-2.0 | same commit, `test/` (sha256 in `calculix_dynamics_cases.json`) | git | beamdy8: eigenfrequencies, participation, effective mass, fractions of totals, 9 SSD points, modal coordinates and node-100 displacements (quoted in `expected_results.json`). Same 261-node mesh as aerospace 05 beamf | B (single primary output; consistency proven by VC-DYN-06) |
| S3 | GSFC-STD-7000B General Environmental Verification Standard (approved 2021-04-28; 7000A 2013 inactive) | NASA GSFC | https://standards.nasa.gov/standard/GSFC/GSFC-STD-7000 ; PDF link seen in search: https://standards.nasa.gov/system/files/tmp/GSFC-STD-7000B_Approved_Admn%20Ext.pdf | search | Existence, revision, approval date; that Table 2.4-3 gives "Generalized Random Vibration Test Levels, Components (ELV), 22.7 kg (50 lb) or less". The table itself was **not** seen | catalogue |
| S4 | GEVS component random levels as quoted: 20 Hz 0.026 g²/Hz, +6 dB/oct to 50 Hz, 0.16 g²/Hz 50–800 Hz, −6 dB/oct to 2000 Hz 0.026 g²/Hz, 14.1 g rms qualification; acceptance 3 dB lower | (a) Vibration Research application note; (b) `wobbl` `src/wobbl/life/modal.py`, MIT | (a) https://vibrationresearch.com/?p=20548 ; (b) https://github.com/sohan-bhat/wobbl/blob/1df4cee6a480a8e3aadbe029f614db3508933bb0/src/wobbl/life/modal.py | (a) search; (b) git raw | (a) breakpoints and 14.1 g rms attributed to GSFC-STD-7000B Table 2.4-3; (b) the same qualification breakpoints and acceptance breakpoints 0.013 / 0.08 / 0.08 / 0.013 ("acceptance 3 dB lower"). (b) is a hobby / student code repository, not an authority | B |
| S5 | J. W. Miles, "On structural fatigue under random loading", J. Aeronautical Sciences 21(11):753–762, Nov 1954 | IAS (AIAA) | citation lists on cambridge.org and SAE Mobilus | search | Bibliographic data only (two independent reference lists agree). The formula √(π/2 fₙ Q W) is used as the conventional statement of "Miles' equation" and re-derived in the generator as the ζ → 0 limit of the exact white-noise SDOF integral | A (citation); formula derived |
| S6 | S. K. Thampi, S. N. Vidyasagar, "Random vibration analysis of space flight hardware using NASTRAN", 18th NASTRAN Users' Colloquium, 1 Apr 1990, NTRS 19900015329 (90N24645) | NASA | https://ntrs.nasa.gov/citations/19900015329 | search | Abstract: payload random loads usually via Miles; Miles tends to over-estimate; spectral analysis refines (SLS-1 payloads) | B |
| S7 | D. Smallwood, "An improved recursive formula for calculating shock response spectra", 51st Shock and Vibration Bulletin (1980); ISO 18431-4; Ahlin, "Shock response spectrum calculation — an improvement of the Smallwood algorithm" | — | cited in S8 | git (via S8 references) | Algorithm lineage only; original papers not read | B |
| S8 | pyYeti `pyyeti/srs.py` (`absacce`, `relacce`, `reldisp`, `pvelo` coefficient functions) | pyYeti developers, BSD-3-Clause | https://github.com/twmacro/pyyeti/blob/39c5af215e0e45f1ebce9a83040ba95541b3f6a9/pyyeti/srs.py | git raw | Ramp-invariant absolute-acceleration coefficients b = [1 − S/B, 2(S/B − C), E² − S/B], a = [1, −2C, E²] (reproduced in the generator and checked against an exact solution) | A (code + independent exact check) |
| S9 | NASA-STD-7001 Payload Vibroacoustic Test Criteria (1996; 7001A 2011; 7001B supersedes A, 2017) | NASA | https://standards.nasa.gov/standard/NASA/NASA-STD-7001 | search | Scope: test factors for qualification / protoflight / acceptance, minimum workmanship levels, levels relative to MEFL. **No level values seen** | catalogue |
| S10 | SDOF frequency-response theory (receptance, transmissibility, half-power, white-noise integral, Gaussian exceedance) | textbook mechanics | — | — | No single source was fetched; every formula is written out in the generator and checked numerically (quadrature vs closed form, VC-DYN-07) | derived |
| S11 | Standard acceleration of gravity g = 9.80665 m/s² (conventional value) | CGPM (1901) | — | not fetched | Used as a unit definition only; stated in every result | definition |
| S13 | Abaqus Benchmarks Guide FV32 "Cantilevered tapered membrane" | Dassault Systèmes | https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-fv32.htm ; https://abaqus.uclouvain.be/English/SIMACAEBMKRefMap/simabmk-c-fv32.htm | search | NAFEMS column 44.623, 130.03, 162.70, 246.05, 379.90, 391.44 Hz; t = 0.05 m, E = 200 GPa, ν = 0.3, ρ = 8000 kg/m³; ux = uy = 0 on the y-axis edge, uz = 0; CPS4 results 44.782 … 389.83; cites NAFEMS TNSB Rev. 3 (1990) | A (with S14) |
| S14 | Altair OptiStruct OS-V:0440 Cantilevered Tapered Membrane (2021, 2022 releases; 2023.1 differs) | Altair | https://help.altair.com/hwsolvers/os/topics/solvers/os/cantilevered_tapered_membrane_fv32_r.htm | search | Same six reference values (2021/2022), 16 × 8 CQUAD4, taper 5 m → 1 m; 2023.1 prints a different set (44.61, 131.12, 162.813, 250.666, 392.555, 393.157); FV52 mode 7 printed as 167.89 vs 265.81 in different releases | A for FV32 (with S13); C for FV52 m7 |
| S15 | Miranda, Ferencz, Hughes (1989), Earthquake Eng. Struct. Dyn. 18:643–653 | Wiley | bibliography of S1 | git (S1 bibitem) | CalculiX's reference for the HHT implementation | B |
| S16 | T. Dirlik, PhD thesis, University of Warwick (1985) | — | — | not found | Random-fatigue cycle-count method; PHY-07 COULD item only | C |

## Spec id mapping

| Spec | Register |
| ---- | -------- |
| R1, R2 | S1, S2 |
| R3 | S3 |
| R4a, R4b | S4 (a), S4 (b) |
| R5, R6, R7, R8, R9 | S5, S6, S7, S8, S9 |
| R13, R14, R15, R16 | S13, S14, S15, S16 |

## Not verified (follow-up)

- GSFC-STD-7000B Table 2.4-3 itself, and any acoustic or workmanship level of NASA-STD-7001A/B: host blocked.
  A human must read the PDFs before the library entries are upgraded from B.
- FV32 vertex coordinates (needed for a plan): read `nfv32f4f.inp` (Abaqus) or the NAFEMS original.
- Nastran SOL 111/112 card layouts for V1 export.
- Any published industry default for modal-truncation effective-mass thresholds (none shipped).
