# Sources — PHY-01 PROP (property models)

All sources accessed **2026-10-15**.

**How sources were verified.** From the authoring sandbox, `trc.nist.gov` failed (WebFetch: DNS `ENOTFOUND`;
curl: proxy `403` on CONNECT). The same held for arXiv. GitHub raw files and the GitHub code-search API worked.
So:

- NIST **coefficients** were downloaded from four independent open-source transcriptions (T1–T4 in
  `nist_cryogenic_fits.json`) and compared digit by digit. A set is grade **A** when at least two transcriptions
  agree exactly (README §6.3: ≥ 2 independent sources). The primary page itself was **not** read.
- NIST **ranges and fit errors** come from web-search extracts of the NIST pages (grade A when the extract
  shows the number with its column label; B when only one transcription gives it; TBD otherwise).
- Expected values are **derived** in `generate_prop_reference.py` by evaluating the published forms.

Grades: **A** = ≥ 2 agreeing independent sources, or exact derivation in the generator; **B** = one secondary
source; **C** = sources disagree or value not confirmed; **TBD** = not found.

| Id | Source | URL | Verified from it | How | Grade |
| -- | ------ | --- | ---------------- | --- | ----- |
| S1 | NIST Cryogenics, Material Properties index and per-material pages (6061-T6, 304, Ti-6Al-4V, OFHC Cu, G-10CR, Invar) | https://trc.nist.gov/cryogenics/materials/materialproperties.htm and the page URLs in `nist_cryogenic_fits.json` | Fit form "log10 y = a + b(log10 T) + … + i(log10 T)^8"; 6061-T6 k: data range 4–300 K, equation range 1–300 K, curve-fit error 0.5 %; 6061 cp error 5 %; 6061 E error 1 %, expansion error 4 %; 304 k data 4–300, equation 1–300, error 2 %; 304 cp error 5 %; Ti-6Al-4V k data 23–300, equation 20–300, error 2 %, a = −5107.8774 | search extract | A (forms, the listed ranges and errors) |
| S2 | T1 circuitqed/cryocalc `cryocalc/data/materials.json` | https://raw.githubusercontent.com/circuitqed/cryocalc/HEAD/cryocalc/data/materials.json | Coefficients for 6061-T6 (k, cp, E, expansion), 304 (k, cp, E low/high), 316, Ti-6Al-4V (k, expansion), G-10 (k normal/warp, cp, expansion), OFHC Cu RRR 50/100 (rational), Invar, Teflon; ranges per entry | downloaded | A when matched by another transcription |
| S3 | T2 Krataios14/spacemat `src/spacemat/data/nist_fits.json` ("verbatim NIST cryogenic property curve-fit coefficients") | https://raw.githubusercontent.com/Krataios14/spacemat/HEAD/src/spacemat/data/nist_fits.json | Same coefficients for 6061-T6, 304/304L, 316, Ti-6Al-4V, G-10, Invar, Kapton, Teflon, Inconel 718; separate data vs equation ranges; tLow and below-value for expansion | downloaded | A when matched |
| S4 | T3 amccaugh/cryoheatflow `cryoheatflow/conductivity.py` (GPL-3; read only, no code copied) | https://raw.githubusercontent.com/amccaugh/cryoheatflow/HEAD/cryoheatflow/conductivity.py | 6061-T6, 304 (as "SS"), G-10, Cu RRR 50/100 k coefficients; rational copper form written out; design precedent: NaN outside the data range, extrapolation only on explicit request with `ExtrapolationWarning` | downloaded | A when matched |
| S5 | T4 ipmu-lab/ipmucmblab_genlib data files | https://raw.githubusercontent.com/ipmu-lab/ipmucmblab_genlib/HEAD/lib_materialproperties/data/Al6061_NIST_thermalcod_specificheat.txt · …/OFHCCpper_NIST_thermalcond_RRR.txt | 6061-T6 k and cp coefficients; OFHC Cu RRR 50/100/150/300/500 coefficients a–i with the NIST page URL | downloaded | A when matched |
| S6 | Marquardt, Le, Radebaugh, "Cryogenic Material Properties Database" (NIST, 2000) | https://trc.nist.gov/cryogenics/Papers/Material_Properties/2000-Cryogenic_Material_Properties_Database.pdf | Listed by search as the database paper; content not read | search listing | C (citation only) |
| S7 | Cryogenic Materials Repository, arXiv 2509.23422 | https://arxiv.org/pdf/2509.23422 | New 6061-T6 measurements "consistent with fits at temperatures ≥ 4 K from the NIST website"; large uncertainties at the coldest temperatures | search extract | B |
| S8 | BIPM SI Brochure (9th ed., 2019): N_A = 6.02214076e23 mol⁻¹, k = 1.380649e-23 J/K exact | https://www.bipm.org/en/publications/si-brochure | Definitional constants (R = N_A·k) | not fetched (definitional) | A (definition) |
| S9 | CalculiX ccx 2.23 manual (*ELASTIC, *PLASTIC: "All constants may be temperature dependent"; data interpolated between temperature points; *PLASTIC JOHNSON COOK + *RATE DEPENDENT) — mirror in a GitHub repository | https://raw.githubusercontent.com/WonhoLee1/WHT_Calculixent/HEAD/wht_calculixent_doc/CalculiX/ccx_2.23/doc/ccx/node274.html · node333.html · node336.html | Solver side of FR-PROP-18; J-C rate term `C` and ε̇0 in *RATE DEPENDENT | downloaded | B (one mirror of the official manual) |

## Cross-check results (performed while writing the pack)

| Fit | Transcriptions compared | Result |
| --- | ----------------------- | ------ |
| 6061-T6 k | T1, T2, T3, T4 | identical 9 coefficients |
| 6061-T6 cp | T1, T2, T4 | identical |
| 6061-T6 E | T1, T2 | identical coefficients; **ranges differ** (T1 0–299 K; T2 equation 2–295 K, data 0–299 K) → range TBD |
| 6061-T6 expansion | T1, T2 | identical a–e; tLow 18 K / −415.45 only in T2 (B) |
| 304 k, cp | T1, T2 (+ T3 for k) | identical |
| 304 E low segment (5–57 K) | T1 only | B |
| Ti-6Al-4V k | T1, T2 | identical; a = −5107.8774 also in S1 extract |
| G-10CR k normal | T1, T2, T3 | identical coefficients; **equation range differs** (T1 4–300, T2 10–300) → VCs stay in 10–300 K |
| OFHC Cu RRR 50 / 100 | T1, T3, T4 | identical |
| Invar 36 expansion | T1, T2 | **disagree** on e: 9.794e-11 (T1) vs 8.794e-11 (T2); T2 also gives tLow 80 K / −40 → grade C, used only as the conflict-detection fixture (VC-PROP-09) |
| cryocalc 3003-F / 5083-O specific heat | T1 | T1 reuses the 6061-T6 cp coefficients for these alloys — a transcription shortcut, not used here; illustrates why provenance per model matters |

## Not verified / open

1. **Primary NIST pages were not read.** Before the seed library ships (FR-PROP-20, M6), each page must be
   fetched, its sha256 pinned in `sources.lock.json`, and every coefficient, range and error compared.
2. Fit errors for G-10CR, OFHC copper and Invar: **TBD**.
3. Equation ranges for 6061-T6 E and G-10CR k: **TBD** (transcriptions disagree).
4. Cowper-Symonds form and constants: no source fetched; VC-PROP-12 uses a synthetic fixture to check arithmetic only.
5. Johnson-Cook original paper (1983) not fetched; the rate-factor form is taken from the CalculiX manual (S9).
6. The 304 conductivity integral 4–300 K (3 030.8 W/m, VC-PROP-20) is derived from the fit; no independent
   published integral was fetched to compare.
