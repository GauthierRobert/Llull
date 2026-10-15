# PHY-16 PRC: external sources

All entries accessed **2026-10-15**. Access kinds as in the PHY-05 register (git / raw / search).

| Id | Source | Publisher / licence | URL | Access | What was verified | Grade |
| -- | ------ | ------------------- | --- | ------ | ----------------- | ----- |
| S1 | CalculiX User's Manual | G. Dhondt; GPL-2.0 | https://github.com/Dhondtguido/CalculiX (commit fd588701edd6a92fde06e99b1bdf01f3b0f80f2c) | git | `*MODEL CHANGE` (TYPE=ELEMENT ADD [STRAIN FREE default \| WITH STRAIN] / REMOVE; TYPE=CONTACT PAIR; MECHSTRAINTORESIDUAL; expanded 1D/2D elements cannot be removed in the first step); `*EXPANSION` (TYPE ISO / ORTHO / ANISO, ZERO; thermal strain definition); `*INITIAL CONDITIONS` (TYPE STRESS, PLASTIC STRAIN, TEMPERATURE …); `*ORIENTATION`; `*BOUNDARY` OP=NEW and FIXED | A (primary) |
| S2 | Aerospace 07 FTR pack | this repo | `docs/aerospace/07-sheet-metal-machined-features/` | local | Bend conventions, `flat_pattern` data shape, radius-table codes, out-of-scope statement for springback | — |
| S3 | F. J. Gardiner, "The Springback of Metals", Trans. ASME 79 (1957) 1–9 (also cited as Trans. ASM, Jan. 1957, p. 1) | ASME / ASM (paid) | https://link.springer.com/article/10.1007/BF02833692 (a citing article, search) | search | Citation only (venue conflicts between citing sources). The form R_i/R_f = 4u³ − 3u + 1 is **derived** in `generate_prc_reference.py` from the elastic-perfectly-plastic moment-curvature relation and elastic unloading, and the two forms agree to machine precision | A (derivation) / C (citation) |
| S4 | Modified inherent strain method (A. To group): OSU seminar abstract; arXiv 2208.14246 (self-supporting topology optimisation with inherent strain) | OSU / arXiv | https://mae.osu.edu/events/2021/03/modified-inherent-strain-method-predicting-residual-distortion-and-stress-laser ; https://arxiv.org/pdf/2208.14246 | search | Inherent strains extracted from a detailed moving-heat-source simulation in a representative domain and applied layer by layer in a part-scale quasi-static FE model; applications include support design and recoater-crash criteria | B (method description) |
| S5 | NIST AM-Bench 2018, AMB2018-01 post-process part deflection (CHAL-AMB2018-01-PD) | NIST | https://www.nist.gov/node/1339701 ; https://www.nist.gov/ambench/referencing-am-bench-data | search | IN625 bridge deflection 1.276 mm at ridge 1, 15-5 PH 1.168 mm at ridge 1; ridge tops ground, CMM, average of 3 points per ridge; legs separated from the baseplate by EDM; parts from the commercial build machine | B |
| S6 | usnistgov/ambench repository | NIST (public domain notice in LICENSE.md, not reviewed in detail) | https://github.com/usnistgov/ambench (commit 77adb06c6de95b9b97e1dd26d46561f29db927af) | git (tree listing only) | Metadata model (XSD / XLSX) and data-release zip files for AM-Bench 2022; no AMB2018-01 deflection table found in the tree | C |
| S7 | ISO/ASTM 52911-1 (DfAM, L-PBF of metals) | ISO / ASTM (paid) | https://www.iso.org/search.html?q=52911-1 | not fetched | Standard number from secondary knowledge; used only to say overhang rules exist and are machine / material specific | C |
| S8 | Timoshenko (1925) bimetal curvature formula | — | — | not fetched | Used only as a cross-check of the generator's equilibrium solution (agreement to 12 digits for the two-layer case) | C (cross-check only) |
| L1 | llull repo | this repo | `.dependency-cruiser.cjs`, physics PHY-01/02/03/05/06, aerospace 05/07/08 | local | Placement rule and baseline interfaces | — |

## Citation mapping

| Spec | Register |
| ---- | -------- |
| R1 | S1 |
| R2 | S2 |
| R3 | S3 |
| R4 | S4 |
| R5 | S5, S6 |
| R6 | S7 |

## Not verified (follow-up)

- Gardiner 1957 original; any open springback data set with measured radii for an aerospace alloy.
- AM-Bench 2018 data release (per-ridge values, geometry, scan strategy); licence for fixture redistribution.
- ISO/ASTM 52911-1 content and catalogue page.
- Published inherent-strain calibration values (they are process specific; none is used).
