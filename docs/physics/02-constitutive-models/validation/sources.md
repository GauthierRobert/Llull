# Sources — PHY-02 MATL (constitutive models)

All sources accessed **2026-10-15**.

**How sources were verified.** Vendor documentation hosts (ceae-server.colorado.edu, abaqus mirrors, dhondt.de,
web.mit.edu, ntrs.nasa.gov) failed from the authoring sandbox (DNS / proxy 403). GitHub raw files and GitHub code
search worked. So: solver syntax was read from a GitHub mirror of the CalculiX 2.23 manual **and** from the CalculiX
input-parser source at the commit 05 pins (two independent sources for keyword names and data-line layout);
benchmark targets come from search extracts and are reproduced analytically in `generate_matl_reference.py`;
the Treloar table was downloaded from two independent transcriptions and compared.

Grades: **A** = ≥ 2 agreeing independent sources or exact derivation in the generator; **B** = one secondary source;
**C** = not confirmed; **TBD** = not found.

| Id | Source | URL | Verified from it | How | Grade |
| -- | ------ | --- | ---------------- | --- | ----- |
| S1 | Abaqus Benchmarks Guide 4.6.1 NL1 (Colorado v2016 and IPPT v6.13 mirrors), citing NAFEMS NNB Rev. 1 (Oct 1989) | https://ceae-server.colorado.edu/v2016/books/bmk/ch04s06anf38.html · http://dsk.ippt.pan.pl/docs/abaqus/v6.13/books/bmk/ch04s06anf38.html | E 250 GPa, ν 0.25, σy 5 MPa, first-yield strain 0.25e-4, hardening modulus 0 or 62.5 GPa, plane strain CPE4R, eight-step strain history; targets: perfect 5.000 (most points), 3.917 at (0.0, 0.25); hardening 5.482 at (0.50, 0.25), 7.322 at (0.0, 0.50), 4.230 at (0.0, 0.25); Abaqus 3.824 (−2.4 %) and 4.114 (−2.70 %) at (0.0, 0.25) | search extracts (pages not fetched; table layout "somewhat garbled" per extract) | B (targets); A (reproduced by the generator, see below) |
| S2 | NAFEMS non-linear benchmarks catalogue page | https://www.nafems.org/publications/pubguide/benchmarks/page6/ | NNB is a paid NAFEMS publication | search listing | catalogue only |
| S3 | CalculiX ccx 2.23 manual, keyword pages (*CREEP node256, *CYCLIC HARDENING node257, *DEFORMATION PLASTICITY node262, *ELASTIC node274, *HYPERELASTIC node301, *PLASTIC node333, *RATE DEPENDENT node336, *VISCO node370), GitHub mirror | https://raw.githubusercontent.com/WonhoLee1/WHT_Calculixent/HEAD/wht_calculixent_doc/CalculiX/ccx_2.23/doc/ccx/node274.html (and the other node numbers) | Keyword parameters and data-line order; Norton form ε̇ = Aσⁿtᵐ and example `1.E-10,5.,0.,100.`; Ramberg-Osgood `Eε = σ + α(|σ|/σ0)^(n−1)σ` on log strain / Cauchy stress, line E, ν, σ0, n, α, T; ORTHO order D1111…D2323 and ENGINEERING CONSTANTS order E1, E2, E3, ν12, ν13, ν23, G12, G13 / G23, T; Ogden `U = Σ 2μ_i/α_i² (…) + Σ (1/D_i)(J − 1)^(2i)`; Arruda-Boyce 5-term series; Yeoh line C10, C20, C30, D1, D2, D3, T; `*PLASTIC` HARDENING = ISOTROPIC / KINEMATIC / COMBINED / USER / JOHNSON COOK; combined isotropic curve via *CYCLIC HARDENING; orthotropic elasticity allows at most linear hardening; D = 0 replaced by a small compressibility | downloaded | B alone; A together with S4 |
| S4 | CalculiX source, input parsers `elastics.f`, `plastics.f`, `hyperelastics.f`, `creeps.f`, `deformationplasticitys.f`, `cyclichardenings.f`, `viscos.f` at commit fd588701 (the 05 pin) | https://raw.githubusercontent.com/Dhondtguido/CalculiX/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c/src/elastics.f (etc.) | Accepted parameter strings (ARRUDA-BOYCE, MOONEY-RIVLIN, NEOHOOKE, OGDEN, POLYNOMIAL, REDUCEDPOLYNOMIAL, VANDERWAALS, YEOH, N=1..3; TYPE=ISO/ORTHO/ENGINEERINGCONSTANTS/ANISO; HARDENING=KINEMATIC/COMBINED/USER/JOHNSONCOOK; LAW=NORTON/USER); `*PLASTIC` must follow `*ELASTIC,TYPE=ISO` or `ORTHO`; `*DEFORMATION PLASTICITY` reads 5 values + temperature; `*VISCO` is a step procedure. GitHub code search for `VISCOELASTIC` in the repository: no hit | downloaded | A (with S3) |
| S5 | Abaqus documentation / benchmark "Fitting of rubber test data" and material evaluation | https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-rubberfit.htm | Drucker check: tangent stiffness must be positive definite, checked along uniaxial, equibiaxial and planar modes in tension and compression; third-party quote of a nominal strain range −0.9…9; fitted models are often unstable at some strain; benchmark uses Treloar 8 % sulphur rubber | search extract | B |
| S6 | Lempriere (1968) AIAA J. 6:2226, via Norris (2006) Proc. R. Soc. A 462 | https://coewww.rutgers.edu/~norris/papers/2006_RSPA_462_3385-3405.pdf | Citation of the orthotropic Poisson bound paper; exact inequality not visible in the extract | search extract | C (citation); the bound ν12² < E1/E2 is derived in the generator from the compliance minors (A) |
| S7 | pyNastran card classes `MAT1`, `MAT2`, `MAT8`, `MAT9`, `MATHE`, `MATS1` (docstrings with field tables) | https://raw.githubusercontent.com/SteveDoyle2/pyNastran/main/pyNastran/bdf/cards/materials.py · …/material_deps.py | MATS1 fields MID TID TYPE H YF HR LIMIT1 LIMIT2; H = "work hardening slope (slope of stress versus plastic strain)"; HR 1 isotropic, 2 kinematic, 3 combined; YF 1 von Mises; MAT9 G11…G66 field order; MATHE models MOONEY, OGDEN, ABOYCE layouts | downloaded | B (secondary to the MSC/NX QRG) |
| S8 | Ramberg & Osgood, NACA TN 902 (1943), NTRS record 19930081614 | https://ntrs.nasa.gov/citations/19930081614 | Three-parameter formula (Young's modulus and two secant yield strengths); tested on aluminium, stainless and carbon steel sheet; unsuitable for alclad | search extract | B |
| S9 | CalculiX discourse "Deformation plasticity strain output" | https://calculix.discourse.group/t/deformation-plasticity-strain-output/3836 | R-O parameters fitted to true stress / logarithmic strain; example card 70000, 0.3, 360, 14, 7 | search extract | B |
| S10 | Treloar (1944) data as tabulated by Steinmann, Hossain & Possart (2012) Arch. Appl. Mech. 82:1183–1217 — transcriptions T5 llamm-de/thermalCANN (`data/Treloar/*_steinmann.csv`) and T6 3MAH/simcoon (`examples/hyperelasticity/comparison/Treloar.txt`) | https://raw.githubusercontent.com/llamm-de/thermalCANN/HEAD/data/Treloar/uniaxial_steinmann.csv (+ pure_shear, equibiaxial) · https://raw.githubusercontent.com/3MAH/simcoon/HEAD/examples/hyperelasticity/comparison/Treloar.txt | UT 25 points (to λ 7.61, 6.30 MPa), ET 17 points (to λ 4.44), PS 14 points (to λ 4.96); T5 and T6 identical row by row (checked programmatically). Paper metadata (authors, journal, DOI) via search | downloaded | B (one secondary table; primary not reached) |
| S11 | Ogden three-term set μ = (0.63, 0.0012, −0.01) N/mm², α = (1.3, 5, −2), quoted by the solids4foam rubber-sealing benchmark (also an MFEM verification manual and LS-DYNA card examples in GitHub code search) | https://github.com/solids4foam/solid-benchmarks/blob/main/hyperElasticity/rubberSealing/README.md | The parameter set; convention not stated there; attribution to Ogden (1972) / Treloar commonly made but not verified | code search extract | B (set), C (attribution) |
| S12 | Arruda-Boyce series coefficients 1/2, 1/20, 11/1050, 19/7000, 519/673750 — FElupe source, Altair RADIOSS law 92, CalculiX manual | https://felupe.readthedocs.io/en/v8.6.0/_modules/felupe/constitution/hyperelasticity/models/_arruda_boyce.html | Same coefficients in ≥ 2 sources (and S3 downloaded) | search extract + S3 | A |
| S13 | WLF "universal" constants C1 17.44, C2 51.6 K at Tr = Tg; valid at or above Tg (Wikipedia, TA Instruments APN001, UC notes) | https://en.wikipedia.org/wiki/Williams%E2%80%93Landel%E2%80%93Ferry_equation · https://www.tainstruments.com/pdf/literature/APN001_Guidelines_for_using_TTS.pdf | Constants and validity statement | search extract | B (secondary; WLF 1955 paper not read) |
| S14 | TFEL/MFront README and `LICENCE-GNU-GPL` | https://raw.githubusercontent.com/thelfer/tfel/master/README.md · …/LICENCE-GNU-GPL | Versions ≥ 2.x under GPL or CeCILL-A; since 2023 a linking exception allows proprietary applications to link TFEL and MFront-generated libraries; MTest imposes strain or stress per component, "from ten to several hundred times" faster than a full FE solver | downloaded | A (primary) |

## Reproduction results (performed while writing the pack)

| Check | Result |
| ----- | ------ |
| NL1 strain path reconstructed as (0.25,0) (0.5,0) (0.5,0.25) (0.5,0.5) (0.25,0.5) (0,0.5) (0,0.25) (0,0) ×1e-4 | Radial return with 10 equal increments per segment gives 3.8235 (perfect) and 4.1141 (hardening) at point 7 and 5.4821 at point 3 — equal to the Abaqus values 3.824 / 4.114 / 5.482 of S1 to 4 digits. Converged values (100 000 increments): 3.91606 vs NAFEMS 3.917 (−0.024 %), 7.31313 vs 7.322 (−0.12 %), 4.18963 vs 4.230 (−0.95 %) |
| Hardening modulus reading | Only the **plastic** modulus reading (H = 62.5 GPa as slope vs plastic strain) reproduces the Abaqus values; the tangent reading gives 6.087 MPa at point 2 instead of 5.862 |
| Treloar T5 vs T6 | identical |
| Mooney-Rivlin fit to Treloar (3 modes) | C01 < 0, Drucker-unstable in equibiaxial tension above λ = 8.86 (outside the data, inside the scan) and in compression below λ = 0.28 |

## Not verified / open

1. NAFEMS NNB original (paid): NL1 targets only via S1 extracts; the full Abaqus table and points 2, 4, 5, 8 targets
   not read.
2. Treloar 1944 primary table not reached; Steinmann 2012 table pinned.
3. Ogden 1972 attribution and convention of the S11 set (its UT RMS vs the pinned table is 0.29 MPa — possibly a
   mis-quote or a different data set; OQ-MATL-03).
4. Abaqus fitted coefficients for Treloar (rubberfit benchmark) not read — not used.
5. Code_Aster SSNV133 mixed-hardening analytic case (README candidate) not fetched; replaced by closed-form
   Armstrong-Frederick and Prager cases.
6. Nastran QRG (MSC/NX) not read; `CREEP`, `MATEV`, `TABLES1` semantics TBD.
7. Johnson-Cook (1983) and Cowper-Symonds originals not fetched; forms from S3 (J-C) and synthetic arithmetic checks only.
8. MMPDS-style published Ramberg-Osgood `n` values: none publicly sourced; none used.
