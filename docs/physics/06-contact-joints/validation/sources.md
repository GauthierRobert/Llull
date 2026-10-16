# PHY-06 CNT: external sources

All entries accessed **2026-10-15**. Access kinds as in the PHY-05 register: **git**, **raw** (gitlab raw / API with
sha256), **s3** (public object download, sha256), **search** (search-result text only; page not reachable).

| Id | Source | Publisher / licence | URL | Access | What was verified | Grade |
| -- | ------ | ------------------- | --- | ------ | ----------------- | ----- |
| S1 | CalculiX User's Manual and test suite | G. Dhondt; GPL-2.0 | https://github.com/Dhondtguido/CalculiX (commit fd588701edd6a92fde06e99b1bdf01f3b0f80f2c) | git | `*CONTACT PAIR` (TYPE NODE TO SURFACE / SURFACE TO SURFACE / MORTAR / MASSLESS; all pairs of a deck must have the same type; SMALL SLIDING; ADJUST), `*SURFACE BEHAVIOR` (EXPONENTIAL, LINEAR with defaults slope = 50 × first elastic constant and σ∞ = E/70 000, TABULAR, TIED, HARD reduced to LINEAR; mortar hard = no card), `*FRICTION` (μ, λ; λ default = first elastic constant / 2), `*PRE-TENSION SECTION` (SURFACE / ELEMENT, NODE; force on DOF 1; positive = tension; surface rules), `*MODEL CHANGE` (contact pairs ADD / REMOVE). Test decks (sha256 of `.inp`): `pret1` fb4003e6…9a3a, `pret2` 19062bff…1465, `bolt` 999f67da…ef73, `contact1` 486e4be5…dda3, `contact2` 5509c9ab…9415, `friction1` 30222015…b777, `friction2` 4e92b7a9…b3f2, `hueeber1_mortar` 8310b047…4555 (Hüeber PhD example p. 44), `beamcontact` 931ec3e5…cc8e; each has a `.dat.ref` | A (primary) |
| S2 | code_aster test SSNP154 (`ssnp154a.comm`, `ssnp154b.comm`) | EDF; GPL-3.0 | https://gitlab.com/codeaster/src/-/blob/94bf28a308de5a77587675a598aacdddb722f84e/astest/ssnp154a.comm | raw (sha256 76c20b5c…4752; b: f3c87fed…1287; last commit 97a88b3d) | Plane strain (D_PLAN), cylinder E = 210 000, block E = 70 000, ν = 0.3, symmetric half with FORCE_NODALE FY = −17 500; analytic solution printed in the file: a = 6.21, p0 = 3585.37, p(x) = p0 √(1 − (x/a)²); FE pressure check −3811.9 vs −3800.5 at N5 (0.4 %). The radius is not in the command file (mesh is MED); R = 50 mm is inferred from a and p0 (R = a² π E*/(4P′) = 49.93 mm with a rounded to 6.21; R = 50 reproduces p0 to 2e-6) | A (quote + generator) |
| S3 | code_aster test SSNV104 (`ssnv104a.comm`) | EDF; GPL-3.0 | https://gitlab.com/codeaster/src/-/blob/94bf28a308de5a77587675a598aacdddb722f84e/astest/ssnv104a.comm | raw (sha256 a2ac8561…757de) | Two hemispheres R = 50 (sphere centre at y = 50), E = 20 000, ν = 0.3, imposed DY = −2 on the half model; analytic σyy reference −2798.3 (FE −3176.3 with linear PENTA6 elements, PRECISION 0.14). Generator gives 2798.33 with total approach 4 mm | A (quote + generator) |
| S4 | SimScale validation "Hertzian contact between two spheres" (code_aster SSNV104 re-run) | SimScale | https://www.simscale.com/docs/validation-cases/hertzian-contact-between-two-spheres/ | search | Same reference −2798.3 MPa; errors 1.1–2.8 % depending on mesh and contact method | B (corroboration) |
| S5 | NASA-STD-5020 Requirements for Threaded Fastening Systems in Spaceflight Hardware, baseline approved 2012-03-12 | NASA; "approved for public release – distribution is unlimited" | https://imlive.s3.amazonaws.com/Federal%20Government/ID22733872581604231767905658536785766455/NASA-STD-5020.pdf | s3 (sha256 ea1b5b03e9a1c00ba166715fe88c493c58a7d8ef35a44d1dbf09623acb41100a, 3 632 624 B; text extracted with pdftotext) | Eqs. 6-2, 6-3, Table 1 (5 % short-term relaxation for all-metallic joints), 6-4, 6-5a, 6-5b, 6-7 to 6-11, 6-23; §6.1.c (separation-critical Γ from test, 90 % probability / 95 % confidence), §6.1.d defaults (torque: 25 % lubricated / 35 % non-lubricated; turn: 25 %; stretch: 10 %); §6.4 friction caps 0.2 / 0.1; Appendix A.2 (A.2-1 … A.2-7) and A.10 (A.10-1 … A.10-6); §4.4 locking feature. **Not readable**: Figure 1 separation-FoS logic; eq. 6-6 text | A (primary, 2012 edition) |
| S6 | NASA-STD-5020B (2021-08-06; revalidated 2026-01-05) | NASA | https://standards.nasa.gov/sites/default/files/standards/NASA/B/0/2021-08-06-nasa-std-5020b_final.pdf | search | Exists; search extracts repeat the Γ 25 % / 35 % defaults and the separation-critical rule. Full text not opened | B |
| S7 | NASA TM-106943 "Preloaded Joint Analysis Methodology for Space Flight Systems" (NTRS 19960012183) | NASA | https://ntrs.nasa.gov/api/citations/19960012183/downloads/19960012183.pdf | search | Lists joint stiffness factor, loading-plane factor and preload uncertainty in its nomenclature; not opened | C |
| S8 | VDI 2230 Blatt 1 | VDI (paid) | https://www.vdi.de/richtlinien | not fetched | Title only (systematic calculation of highly stressed bolted joints) | C (catalogue) |
| S9 | K. L. Johnson, Contact Mechanics (CUP 1985) | CUP (paid) | — | not fetched | Subsurface stress expressions used in the generator; values VC-CNT-13 are therefore B | C |
| S10 | Air Force stress manual lug chapter; ESDU 91008 / 06021 | — | https://engineeringlibrary.org/reference/lug-analysis-air-force-stress-manual | search | Plastic bearing coefficient terminology; methods not verified | C |
| L1 | llull repo | this repo | `.dependency-cruiser.cjs`, `packages/core/src/commands/motion/motionStudy.ts`, aerospace 05 / 08, physics PHY-00 / 02 / 03 / 05 | local | Placement rule, baseline interfaces | — |

## Citation mapping

| Spec | Register |
| ---- | -------- |
| R1 | S1 |
| R2 | S5 (and S6 for the current edition) |
| R3 | S2 |
| R4 | S3 |
| R5 | S8 |
| R6 | S9 |

## Not verified (follow-up)

- NASA-STD-5020B text (diff against the 2012 baseline), Figure 1 separation factor logic, eq. 6-6.
- NAFEMS cylinder-roller benchmark original (Konter 2006, paid); used only through SSNP154, which prints the same values.
- SSNP154 geometry (radius, block size) from its MED mesh — radius inferred, block size chosen by llull.
- Subsurface Hertz formulas (Johnson 1985) and any analytic lug method.
