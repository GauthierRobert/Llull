# PHY-20 VAC: external sources

Accessed **2026-10-15**. **git** = file read from GitHub at a pinned commit; **search** = only search text seen
(standards.nasa.gov and other NASA hosts refused by the egress proxy). Grades: A ≥ 2 independent sources or exact
derivation; B one secondary source; C not confirmed.

| Id | Source | Licence / publisher | URL | Access | What was verified | Grade |
| -- | ------ | ------------------- | --- | ------ | ----------------- | ----- |
| S2 | IEC 61260-1:2014 Electroacoustics — Octave-band and fractional-octave-band filters — Part 1 | IEC | https://www.vde-verlag.de/iec-normen/preview-pdf/info_iec61260-1{ed1.0}b.pdf (preview); BSI / AFNOR catalogue pages | search | Base-ten ratio G = 10^(3/10), f_m = f_r G^(x/b) (odd b), (2x+1)/(2b) exponent (even b), f_r = 1000 Hz, edges f_m G^(∓1/(2b)) — as quoted by S4's documentation and NI's octave-analysis page; standard text not read | A (formulas, with S4 code) |
| S3 | ISO 1683:2015 Acoustics — Preferred reference values for acoustical and vibratory levels (replaces 2008) | ISO | https://scc-ccn.ca/standardsdb/standards/8156718 | search | Scope and status only; the 20 µPa value itself was not seen in the catalogue | catalogue |
| S4 | acoustic-toolbox (successor of python-acoustics), `standards/iec_61260_1_2014.py` (G, f_r, nominal octave and third-octave tables, edge formulas), `standards/iso_tr_25417_2007.py` (`REFERENCE_PRESSURE = 2.0e-5` Pa), `decibel.py` (`dbsum` = 10 log10 Σ 10^(L/10)) | BSD-style (Copyright 2024 Acoustic Toolbox) | https://github.com/Universite-Gustave-Eiffel/acoustic-toolbox/tree/9ac5f5bd2ff19163330681e424e2ce3e8e8db0b1 | git | Constants and formulas as listed | A (with S2 / S3 for the definitions) |
| S5 | NASA-STD-7001 Payload Vibroacoustic Test Criteria (1996; A 2011; **B supersedes A, 2017**) | NASA | https://standards.nasa.gov/standard/NASA/NASA-STD-7001 | search | Scope: test factors and minimum workmanship levels; levels relative to MEFL; acoustic tests controlled in third-octave bands. **No values seen** | catalogue |
| S6 | GSFC-STD-7000B GEVS (approved 2021-04-28) | NASA GSFC | https://standards.nasa.gov/standard/GSFC/GSFC-STD-7000 | search | Acoustic test at payload level and random vibration at component level are required by the GSFC programme (search summary). **No values seen** | catalogue |

## Spec id mapping

R2–R6 = S2–S6.

## Not verified

- Any acoustic test level (NASA-STD-7001A/B, GEVS, launch-vehicle user's guides).
- IEC 61672 A-weighting values (V1 item; to be sourced).
- Diffuse-field correlation models (out of scope; SEA / acoustic FE tools own them).
