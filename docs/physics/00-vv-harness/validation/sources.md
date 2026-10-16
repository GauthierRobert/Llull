# PHY-00 VNV: external sources

All entries accessed **2026-10-15**. Access grades:

- **downloaded**: the package or repository was downloaded (PyPI / GitHub through the session proxy) and the files were read.
- **fetched**: the web page itself was opened. (None succeeded in this session: WebFetch failed DNS for every host tried —
  grc.nasa.gov, volupe.com, asme.org mirrors, arxiv.org — and the egress proxy refused `curl` with 403.)
- **search extract**: only the text returned by a web search was seen.

| Id | Source | Publisher / licence | URL | Access | What was verified |
| -- | ------ | ------------------- | --- | ------ | ----------------- |
| S1 | Roache, "Perspective: A Method for Uniform Reporting of Grid Refinement Studies", JFE 116(3), 1994 | ASME | https://scholarhub.vn/publication/Perspective-A-Method-for-Uniform-Reporting-of-Grid-Refinement-Studies/247af627-5c87-4eb6-a231-d7018475d527 | search extract | Title, journal, volume/issue, pages 405–413 (one listing); introduces GCI from generalized Richardson extrapolation. DOI not confirmed. |
| S2 | Celik, Ghia, Roache, Freitas, Coleman, Raad, "Procedure for Estimation and Reporting of Uncertainty Due to Discretization in CFD Applications", JFE 130(7) 078001, 2008 | ASME | https://doi.org/10.1115/1.2960953 | search extract (+ formulas through S4) | Citation and DOI as given in S4/S5. Search extracts: three systematically refined grids recommended; Fs = 1.25. The PDF (asme.org JFENumAccuracy.pdf) was blocked; its Table 1 example could not be checked. |
| S3 | NPARC Alliance, "Examining Spatial (Grid) Convergence" and `verify.f90` | NASA Glenn | https://www.grc.nasa.gov/WWW/wind/valid/tutorial/spatconv.html | not reached (DNS) | Content seen only as reproduced by S5. |
| S4 | gcat — grid convergence analysis toolkit, `gcat/convergence.py`, README | G. B. Santos; **MIT** | https://github.com/gabrielbdsantos/gcat (commit 0b4f6fd839762bca6ad756b89c900296738f2b4e) | downloaded | Formulas: p iteration with s and q(p), relaxation ω = 0.5, tol 1e-5; Richardson f_exact = (r21^p f1 − f2)/(r21^p − 1); GCI_fine = Fs·e_a/(r21^p − 1), Fs default 1.25; GCI_coarse = GCI_fine·r21^p; asymptotic ratio r21^p·GCI21/GCI32. README example: h = 8.30/10.84/14.14, f = 1/1.02/1.08 → GCI21 fine 1.235897e-02, coarse 3.735897e-02, GCI32 fine 3.662651e-02, AR 1.019998, p 4.143231; `gcat check` N1 = 2900, area 0.2 m² → h1 = 8.304548 mm. Cites S2 and Roache 1997 (Annu. Rev. Fluid Mech. 29:123–160). |
| S5 | `convergence` 0.6.7 (Python port of NPARC verify.f90, with Celik 2008 changes) | M. Topper; **GPL-3.0** | https://pypi.org/project/convergence/0.6.7/ (sdist sha256 db9b5c16798d0b2da66153c6858a0a997b92a8e786db6a1b5b7c751cb7fd784a) | downloaded | README example h = 1/2/4, f = 0.970500/0.968540/0.961780 → p 1.786170, f_exact 0.971300, GCI fine (21) 0.001031, coarse-triplet GCI 0.003562, asymptotic ratio 0.997980 (0.997980422462648 to full precision), e_extrap 0.0008239813226325151. States the NPARC required-resolution equation is incorrect and gives h* = h1 / (GCI12/GCI*)^(1/p); unit test: GCI* = 0.1, GCI12 = 0.4, p = 2, h1 = 4 → 2. Only numbers quoted, no code copied (GPL). |
| S6 | Salari & Knupp, "Code Verification by the Method of Manufactured Solutions", SAND2000-1444 | Sandia / OSTI 759450 | https://www.osti.gov/biblio/759450 | search extract | Title, authors, report number, DOI 10.2172/759450; abstract: MMS identifies any coding mistake that affects the order of accuracy; blind-test examples. |
| S7 | ASME V&V 10-2019 (R2025) Standard for V&V in Computational Solid Mechanics | ASME (paid) | https://www.asme.org/codes-standards/find-codes-standards/standard-for-verification-and-validation-in-computational-solid-mechanics | search extract | Edition and R2025 reaffirmation listing; scope: common language, conceptual framework, guidance, glossary; high-consequence CSM focus; ~40 pages. No clause content. |
| S8 | ASME V&V 20-2009 (R2016) Standard for V&V in CFD and Heat Transfer | ASME / ANSI (paid) | https://webstore.ansi.org/standards/asme/asme202009 ; https://sandia.gov/research/publications/details/overview-of-asme-vv-20-2009-standard-for-verification-and-validation-in-com-2010-03-01 | search extract | Scope: quantifies accuracy from comparison of solution and data for a specified variable at a validation point; uses experimental-uncertainty concepts; validation uncertainty and model error. Formulas **not** seen. |
| S9 | "On the quantification of discretization uncertainty: comparison of two paradigms" | arXiv 2103.14559 | https://arxiv.org/abs/2103.14559 | search extract | Roache recommends Fs = 3 in general and 1.25 when the order is known and the asymptotic range is verified (as summarised by the search engine). Paper not opened. |
| S10 | CFD workshop paper (CEHIPAR) on Fs ranges | Lisbon 2006 workshop | https://maretec.tecnico.ulisboa.pt/~maretec.daemon/html_files/CFD_workshops/html_files_2006/papers/Paper_CEHIPAR.pdf | search extract | Fs = 1.25 for 0.5 < p < 3.5, 3.0 for 3.5 < p < 4.5 (text partly garbled in the extract). Not used as a default. |
| L1 | llull repository | this repo | `package.json`, `docs/QUALITY_GATES.md`, `docs/PRODUCTION_GATE.md`, `packages/core/src/commands/project/types.ts`, `commands/parametric/parameters.ts`, `server/src/cli/usage.ts` | local | Quality/production gate scripts, plan format, CLI flags, `set_parameter` regeneration. |
| L2 | 05 FEA pack | this repo | `docs/aerospace/05-fea-cae-handoff/` | local | AnalysisCase, artifact store, staleness, beamp plan and VC-FEA-10.b = 0.0888411 mm, LE10 −5.38 MPa. |

## Citation id mapping (specs [Rn] ↔ register [Sn])

| Spec | Register |
| ---- | -------- |
| R1 | S1 |
| R2, R6 | S2 |
| R3 | S7 |
| R4 | S8 |
| R5 | S6 |
| R7 | S3 |
| R8 | S5 |
| R9 | S4 |
| R10 | S9 |

## Not verified (follow-up needed)

- The texts of **Roache 1994**, **Celik et al. 2008** (incl. its Table 1 worked example), **ASME V&V 10** and **V&V 20**.
  All formulas used were cross-checked only through S4 and S5, which agree with each other and with the generator.
- **Fs = 3 for two-grid studies** and the **r > 1.3** recommendation: secondary search extracts only (S9, search
  summaries). They are named defaults that a reviewer must confirm (TECHNICAL_SPEC §11).
- The **V&V 20 validation-uncertainty formula** (FR-VNV-20, V2): not seen; no value depends on it.
- The **formal-order table** (TECHNICAL_SPEC §5.4): textbook knowledge, no fetched citation.
- The NPARC tutorial page itself (S3).
