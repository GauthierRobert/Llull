# Gap 07 PST — Sources

Accessed 2026-10-18. Network limits of the authoring sandbox: direct fetch worked only for PyPI / files.pythonhosted.org
and `raw.githubusercontent.com`; ASME, API, NRC, OSTI, UNT digital library, Hexagon, AVEVA, CADMATIC, Becht, Paulin,
PASS/START-PROF and most engineering sites were blocked (HTTP 403 at the proxy or DNS failure), so their content was
read through search-engine extracts only. The web-search budget of the session ran out before the CAESAR II neutral
file section list could be confirmed (see "Not verified"). Grades:

- **A**: primary source read, reference code run, or two or more independent sources agree.
- **B**: one secondary extract (or sources that may copy each other).
- **C**: located, numbers not confirmed. Never a gate.

## Downloaded files

| File (local copy, not redistributed unless stated) | URL | sha256 | Size (bytes) | Licence | Use |
| -------------------------------------------------- | --- | ------ | ------------ | ------- | --- |
| `psi/tests/test_loads.py` | https://raw.githubusercontent.com/denisgomes/psi/master/tests/test_loads.py | 6bf729f15fea0c6affa1a1ba1471f8cd6f1ad498eb2b116ab5c584ef59fa529b | 6500 | GPL-3.0 | assertions transcribed to `data/psi_benchmarks.json` |
| `psi/tests/test_sifs.py` | …/psi/master/tests/test_sifs.py | 8400ce45881901e5857503cd5f5812d32acfb474e722b5c4eb8929e244704b45 | 3005 | GPL-3.0 | SIF assertions transcribed |
| `psi/tests/test_supports.py` | …/psi/master/tests/test_supports.py | 296533e531a0ce94a75d4d1a792edf23cb7a02e1563157fed88bcb6a509ca92e | 9558 | GPL-3.0 | limit stop, one-way support assertions transcribed |
| `psi/tests/test_elements.py` | …/psi/master/tests/test_elements.py | 2127aba66a125679a89f37b8d002652984c55570c1e5447b3fd7de17a0f82354 | 3100 | GPL-3.0 | element tests (context) |
| `psi/tests/utils.py` | …/psi/master/tests/utils.py | c363f4336020ffda186cf1354b2becb3f7a669694140da6fbe5a2f19702a0da9 | 567 | GPL-3.0 | PSI tolerance rule (3 %) |
| `psi/psi/codes/b311.py` | …/psi/master/psi/codes/b311.py | edac26f886a0287600d1ac57ab291bebadd2f8d4841818f53fbf6ad700f8736c | 17309 | GPL-3.0 | B31.1 formulas read (h, i, k, f, SA, k occasional) |
| `psi/psi/sifs.py` | …/psi/master/psi/sifs.py | 6c110c55729ee1f6207967b7104566c459ef849a22e1358359d83f84d3d7d885 | 8302 | GPL-3.0 | SIF component definitions |
| `psi/psi/elements.py` | …/psi/master/psi/elements.py | 5d811be8f04638524c7bce64ec93360c2d75c4a13167265cc90786b8beaa006a | 44278 | GPL-3.0 | Timoshenko stiffness, shear area A/2 |
| `psi/psi/loads.py` | …/psi/master/psi/loads.py | e39ff023c0e207ce4afc5b8202dbff2e8a794ef395770029725bd043dbd287c1 | 33559 | GPL-3.0 | thermal load: α at T, E at T_ref |
| `psi/psi/data/materials.csv` | …/psi/master/psi/data/materials.csv | d07296ea544a0183f1c845d7c8f5e758b4fa8c0d1d3d2d30af3327261b1b4b38 | 634 | GPL-3.0 | A53A mean α, E, S_h rows (α transcribed) |
| `psi/psi/data/pipes.csv` | …/psi/master/psi/data/pipes.csv | 56a6b5cf9f042f8631fecaaffcf138015758b88b196900097028bb73dc94f832 | 2181 | GPL-3.0 | NPS 3 / 6 / 10 Sch 40 rows transcribed |
| `psi/LICENSE` | …/psi/master/LICENSE | b8093a67bc4c30b5793d22666f2b26a5b71625bc8cc0edeff7a9ae39ef4465d5 | 748 | — | licence notice |
| `fluids-1.3.1.tar.gz` | https://files.pythonhosted.org/packages/f0/71/798e4d4b3f965a18e441510521db3cd0f7b3ce2a5840e8a01d6f7c183175/fluids-1.3.1.tar.gz | 42014b5f7d0ee3a5c6fea05582cdc37975e7c46d4c864feb6c7cb915df8a1972 | 2210067 | MIT | `fluids/piping.py` (sha256 c3e20f96ba75102e0553934b9221bee505cd10fc01fa829b50704702b05e424b, 69901 bytes) Sch 40 arrays transcribed |

No downloaded file is copied into `validation/data/`: PSI is GPL-3.0 (copying code or test files into this MIT-style
repository is avoided; only facts — numbers and formulas — are transcribed, with hashes), and the `fluids` arrays are
transcribed for three rows only. The pack's own files are `data/*.json` and `data/scripts/*.py` (written for this
pack, same licence as the repository).

## Source table

| Id | Source | What was taken | How it was checked | Grade |
| -- | ------ | -------------- | ------------------ | ----- |
| S1 | ASME B31.3 Process Piping — catalogue https://www.asme.org/codes-standards/find-codes-standards/b31-3-process-piping | scope and clause numbers only | catalogue page (search extract) | A (existence / scope only) |
| S2 | ASME B31J — catalogue https://www.asme.org/Products/Codes-Standards/B31J-2017-Stress-Intensification-Factors-iFactors | B31J status (2017 reaffirmed, 2023 listed) | search extract of the ASME page | B |
| S3 | Pipe Stress Infinity (PSI), D. Gomes, https://github.com/denisgomes/psi | test assertions (3D thermal / weight / pressure / limit stop / one-way supports / SIFs), B31.1 formulas, A53A α table, pipe dimensions | files read (hashes above); **not run** (downloaded code is not executed); every gated number re-derived independently by S7 or a closed form | B alone; A where S7 or a closed form agrees |
| S4 | fluids 1.3.1 (C. Bell, MIT), `fluids/piping.py` | ASME B36.10M Sch 40 OD / wall for NPS 3, 6, 10 | read; agrees with S3 `pipes.csv` within 0.05 mm | A |
| S5 | "Piping Elbow or Bend SIF", whatispiping.com — https://whatispiping.com/bend-sif/ and "SIF, Flexibility Factor: ASME B31.3 vs ASME B31J" https://whatispiping.com/stress-intensity-factor-sif-flexibility-factor-asme-b-31j/ | h = T R1 / r2², ii = 0.9/h^(2/3), io = 0.75/h^(2/3), k = 1.65/h; App. D deleted in B31.3-2020, B31J mandatory | search extracts; agrees with S6 and with S3 `b311.py` (k = 1.65/h, i = 0.9/h^(2/3)) | A (bend formulas) |
| S6 | "Stress Intensification Factor (SIF)", projectmaterials.com — https://blog.projectmaterials.com/quick-answers/epc/stress-intensification-factor-sif/ | same bend formulas | search extract | A with S5 |
| S7 | `validation/data/scripts/frame3d.py` — independent 3D Timoshenko pipe-frame solver written for this pack | reproduces S3 3D thermal (0.7578 / 1.8911 in / 0.1521°) and weight cases; L-bend reactions equal to the unit-load flexibility integral to 1e-9 | run (python3 3.13, numpy 2.5.3) | A (reference code run) |
| S8 | Bentley AutoPIPE wiki "Thermal expansion values shown in AutoPIPE is not matching with design code B31.8, Why?" — https://communities.bentley.com/products/pipe_stress_analysis/w/pipe_stress_analysis__wiki/70401 | "Thermal Expansion at 400F: 2.70 in/100ft" from B31.3 Table C-1 | search extract; agrees with S3 α (6.82e-6 × 330 × 1200 = 2.7007) | A (400 °F row) |
| S9 | open-exam-prep.com "Thermal Expansion Calculations (ASME B31.3 Appendix C)" | Table C-1 basis (in/100 ft from 70 °F); "≈ 3.4 in at 500 °F" | conflicts with S3 (3.62); not used | C |
| S10 | "Pipe stress range calculation", epcland.com — https://epcland.com/pipe-stress-range-calculation/ ; PSADE notes https://t.me/s/PSADE/49 | S_A = f (1.25 S_c + 0.25 S_h); eq. 1b when S_h > S_L | search extracts; S3 `b311.py` implements the same structure | A (structure) |
| S11 | littlepeng.com "ASME B31.3 Design Criteria For Thermal Stress" and "ASME B31.3 Design for Sustained and Occasional Loads" | S_A forms, occasional 1.33 S_h | search extracts | B |
| S12 | Paulin Research Group, "ASME B31.3 Updates to Stress Range Factors" — https://www.paulin.com/insights/asme-b31-piping-updates-for-stress-range-factors | f = 6 N^-0.2 (≤ 2020) → 20 N^-0.333 (2022), cap 1.2 for SMTS ≤ 75 ksi else 1.0; 1.2 reached at ≈ 3100 / 4600 cycles | search extract; crossing points recomputed: 3125 and 4630 | A with S13 |
| S13 | Vibrationdata blog, "ASME B31.3 Stress Range Factor: The 2022 Revision and Why It Matters" (2026-07-18) — https://blog.vibrationdata.com/2026/07/18/asme-b31-3-piping-fatigue/ | same equations; floor 0.15 introduced 2004 | search extract | A with S12 (equations); B (year of the floor) |
| S14 | Becht, "ASME B31.3 Process Piping — Substantive Changes in the 2022 Edition" — https://becht.com/becht-blog/entry/asme-b31-3-process-piping-substantive-changes-in-the-2022-edition/ ; "Changes to f Factor in the 2022 Edition" | slope 5:1 → 3:1 (Hinnant & Paulin PVP-61871) | search extract (constant not visible) | B |
| S15 | epcland.com "B31.3 pressure relieving reaction load allowable stress"; littlepeng sustained index note | occasional 1.33 S_h; sustained index 0.75 i ≥ 1.0 | search extracts | B |
| S16 | SST CAEPIPE ReadmeSupplement v6.52 — https://www.sstusa.com/downloads/ReadmeSupplement_v652.pdf | structure of the B31.3 sustained equation (axial, bending with indices, torsion) | search extract | B |
| S17 | projectmaterials.com "ASME B31.1 vs B31.3"; Eng-Tips thread 27518; materialwelding.com | B31.1 single SIF, 0.75 i sustained, B31.3 neglects torsion in older sustained forms | search extracts (sources partly disagree on equation numbers) | B |
| S18 | whatispiping.com "Spring hanger"; epcland.com "Manual variable spring support design" | variability = \|k d\| / P_hot ≤ 25 %, 15 % near rotating equipment | several blogs agree on the limit, attribution (MSS SP-58 vs B31.1) conflicts | B (limit); formula is closed form |
| S19 | littlepeng.com "3411 NEMA SM23 Standard for Steam Turbines" | 3F + M ≤ 500 De; cumulative limits in Dc | search extract | B |
| S20 | Eng-Tips "Module NEMA 23 CAESAR 5.1" — https://www.eng-tips.com/threads/module-nema-23-caesar-5-1.227137/ | De = (16 + D)/3 above 8 in; Dc adjusted (18 + D_eq)/3 above 9 in | forum quote of the standard | B |
| S21 | midstreamcalculator.com "API 610 Nozzle Loads: Table 5" ; CAESAR II User's Guide extract (F.1.2a "component ≤ 2 × Table 5") | NPS 6 forces 560 / 460 / 700 (top), 700 / 560 / 460 (end) lbf; moments 1700 / 870 / 1300 ft·lbf | two web extracts that may copy each other | B (never a gate) |
| S22 | Eng-Tips "Nozzle Load table in API 610" — https://www.eng-tips.com/threads/nozzle-load-table-in-api-610.373673/ | 6 in end nozzle 700 / 560 / 460 lbf | forum | B |
| S23 | API Std 610 12th ed. 2021 — catalogue https://www.api.org | Table 5 / Annex F exist; SI and USC tables | catalogue facts only | A (existence) |
| S24 | whatispiping.com "Guided Cantilever Method"; engineersedge.com L-bend guided cantilever calculator | L = √(3 Δ D E / (144 S_A)) (ft, in, psi) — the beam-theory guided cantilever | search extracts; identical to the beam closed form M = 6EIΔ/L², S = 3 E D Δ / L² | A (beam theory) |
| S25 | M. W. Kellogg Co., Design of Piping Systems, 2nd ed., Wiley, 1956 | cited for the guided-cantilever and L-bend methods only | not read (no number taken) | C (citation) |
| S26 | Bezler, Hartzman, Reich, NUREG/CR-1677 Vol. 1, Piping Benchmark Problems (BNL, 1980) — https://digital.library.unt.edu/ark:/67531/metadc1211143/m2/1/high_res_d/6403318.pdf ; ANSYS Verification Manual VMNR01-1-a (search extract) | Problem 1: three straight elements + two bends between two anchors, 7.28 in pipe; ANSYS reports target f1 ≈ 28.5 Hz, node 5 x-displacement ≈ 0.0078 | PDF located, host unreachable; numbers from one extract | C |
| S27 | WRC 537 / 107 / 297: SST tutorial https://www.sstusa.com/tutorials/tutorial_on_local_shell_stresses_at_nozzles_to_equipment__wrc_537_.htm ; whatispiping.com "WRC 107 and WRC 297" | WRC 537 = equation form of the WRC 107 curves; WRC 297 for cylinder-to-cylinder, nozzle-side stresses | search extracts | B (context, V2) |

## Not verified (not used as gates)

- CAESAR II neutral file section list and field layout beyond "`#$` in columns 1–2; first section `#$ VERSION` with
  interface version, CAESAR II release, code page; size limits N1 … N6" (Hexagon guide extract). VC-PST-16 is
  `TBD — measure with CAESAR II` (licensed reviewer).
- ASME B31J tables (VC-PST-19 TBD).
- B31.3 tee formulas: one blog quotes h = 4.4 T/r for a welding tee under "legacy B31.3"; PSI uses 3.1 T/r unless the
  B31.1 crotch conditions hold. Kept as grade B.
- B31.3 Table C-1 rows other than 400 °F (single source S3; values 1.82 / 3.62 / 4.60 in/100 ft at 300 / 500 / 600 °F).
- NUREG/CR-1677 problem data (S26).
- The fm temperature condition (≤ 371 °C / 700 °F) — stated in the brief and widely quoted, but no search extract
  carried it; the cap value 1.2 / 1.0 by SMTS is grade A.
- API 610 Table 5 values other than NPS 6 (S21, B).
