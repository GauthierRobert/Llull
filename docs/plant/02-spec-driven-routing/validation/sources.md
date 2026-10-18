# Gap 02 RTE — Sources

Accessed 2026-10-18. Network limits in this session: direct downloads worked only from PyPI
(`pypi.org`, `files.pythonhosted.org`), the npm registry and some `raw.githubusercontent.com` paths. Vendor help sites
(help.autodesk.com, docs.aveva.com, docs.hexagonppm.com, docs.cadmatic.com), manufacturer tables (wermac.org,
texasflange.com, ferrobend.com, pipedata.org), law.resource.org and arxiv.org refused the CONNECT tunnel (403) or did
not resolve. Their content was read through search-engine extracts, which is why most vendor rows are grade B.

Grades ([`../../TEMPLATE.md`](../../TEMPLATE.md)):

- **A**: primary source read, reference code read / re-derived, or two or more independent sources agree.
- **B**: one secondary extract.
- **C**: located, numbers not confirmed. Never used as a gate.

## Downloaded files

| File | URL | sha256 | Size | Licence | Used |
| ---- | --- | ------ | ---- | ------- | ---- |
| `fluids-1.3.1.tar.gz` (not redistributed; table transcribed to `data/b36_10m_pipe_dimensions.json`) | https://files.pythonhosted.org/packages/f0/71/798e4d4b3f965a18e441510521db3cd0f7b3ce2a5840e8a01d6f7c183175/fluids-1.3.1.tar.gz | `42014b5f7d0ee3a5c6fea05582cdc37975e7c46d4c864feb6c7cb915df8a1972` | 2 210 067 B | MIT (C. Bell) | `fluids/piping.py` (sha256 `c3e20f96…e424b`): `NPS40`, `S40o`, `S40t`, `S40i`, `NPSSTD`, `STDo`, `STDt` read with `ast.literal_eval` under `python3 -I` |
| `ht-1.2.0.tar.gz` (not redistributed; example transcribed to `data/insulation_heat_loss.json`) | https://files.pythonhosted.org/packages/86/52/ecd3cfb1d4fcca3563c34b9090a7e78b8b79d8c66f4d715f5f0cdadf5219/ht-1.2.0.tar.gz | `ae117387c4e99a1860d78afd391d24b1a4217cb7495250cd480606e2b7fa2ff5` | 886 282 B | MIT (C. Bell) | `ht/conduction.py` (sha256 `a2ad8509…c1fd`): `R_cylinder`, `cylindrical_heat_transfer` formula and docstring example |
| Revit PCF Exporter `README.md` (read only) | https://raw.githubusercontent.com/shtirlitsDva/Revit-PCF-Exporter/master/README.md | — | 2 kB | see repo `LICENSE.md` | states that the PCF specification is obtained from Intergraph (Hexagon); no sample `.pcf` in the README |
| `formulab-0.72.3.tgz` (npm, MIT) | https://registry.npmjs.org/formulab | — | — | MIT | searched for B16.9 / elbow data: none. Not used. |

Nothing downloaded was executed. The two Python files were parsed as text.

## Source table

| Id | Source | Taken | How checked | Grade |
| -- | ------ | ----- | ----------- | ----- |
| S1 | Autodesk, AutoCAD Plant 3D 2023 User Guide: "About the Compass and Snaps" (https://help.autodesk.com/cloudhelp/2023/ENU/Plant3D-UserGuide/files/GUID-80606EFD-7D5C-43CD-8F90-DBFEF07EE34D.htm), "About Piping" (…/GUID-A857BC95-C50C-4AE3-973A-91694E43C7A5.htm), "About Placing Components and Valves" (…/GUID-BC346EB2-4A37-4477-96DA-6B058330CA2B.htm) | compass ticks = fitting angles of the spec; tolerance angle (91° → 90° elbow); points restricted to the routing plane; elbows at direction changes, tees / olets at branches; a continuation grip not at an open port creates a branch | search extracts of three pages (2017 / 2023 / 2026 versions consistent) | B |
| S2 | Autodesk, Plant 3D Spec Editor 2026: "About Branch Tables" (https://help.autodesk.com/cloudhelp/2026/ENU/Plant3D-SpecEditor/files/GUID-7F6BEC75-9909-47D5-8BB3-67B956E22604.htm) | header size × branch size cell → fitting legend (tee, reducing tee, latrolet, sockolet …) | search extract | B |
| S3 | Hexagon, CADWorx Equipment 22 documentation (https://docs.hexagonppm.com/r/en-US/CADWorx-Equipment/22/793347) | bolts and gaskets added to match flange values; first matching code when several | search extract | B alone; A with S4 |
| S4 | Autodesk support, "Cannot connect parts when trying to insert a flange onto a pipe in AutoCAD Plant 3D" (https://autodesk.com/support/technical/article/Cannot-connect-parts-when-trying-to-insert-a-flange-onto-a-pipe-in-AutoCAD-Plant-3D); IMAGINiT, "Connection Rules for the AutoCAD Plant 3D HDPE End Types" (https://resources.imaginit.com/building-solutions-blog/connection-rules-for-the-autocad-plant-3d-hdpe-end-types); CADMATIC "Flanged connections" (https://docs.cadmatic.com/plant/2025H1/Content/Administrating Cadmatic/Library and Project Databases/Components/Standard Components/flanged_connections.htm) | mating flange + gasket + bolt set added automatically; failures: property mismatch, missing gasket in the spec, "no connection defined for end types FL and SO"; CADMATIC assigns bolt sets / gaskets per connection-type pair and size | three vendor extracts agree on the mechanism | A (mechanism) |
| S5 | fluids 1.3.1, C. Bell, PyPI, MIT (https://pypi.org/project/fluids/) | ASME B36.10M OD / wall Sch 40 and STD | file read as data; matches S6 | A |
| S6 | llull `packages/domain-aec/src/industrial/piping/pipeSizes.ts` `PIPE_SIZES` (EN 10220 / ASME B36.10M) | same OD / STD wall | code read | A (with S5) |
| S7 | Wermac, "Elbows Long Radius, 45-90 deg" (https://www.wermac.org/fittings/dim_elbows_a.html) | B16.9 LR 90 A and 45 B, NPS 2-8 | search extract | A (with S8) |
| S8 | Texas Flange LR elbow tables (https://texasflange.com/butt-weld-fittings/elbow-long-radius/), pipingpipeline.com (http://www.pipingpipeline.com/asme-b16-9-lr-elbows.html), metalspiping.com (http://www.metalspiping.com/asme-b16-9-long-radius-elbows.html), growmechanical.com (https://www.growmechanical.com/asme-ansi-b16-9-elbow-dimensions-chart/) | same A / B rows; inch values 3.00 / 4.50 / 6.00 / 9.00 / 12.00 and 1.38 / 2.00 / 2.50 / 3.75 / 5.00 | search extracts agree with S7 | A |
| S9 | Wermac reducing tees (https://wermac.org/fittings/dim_tees_red_5-16.html), equal tees (https://www.wermac.org/fittings/dim_tees_eq.html) | 6×4 C 143 / M 130; tee NPS 2 C 64; centre-to-end tolerance ±2 mm NPS 5-8 | search extracts | A (with S10-S12) |
| S10 | Ferrobend straight tee (https://www.ferrobend.com/dimensions/ansi-asme/pipe-fitting/b16.9-straight-tee/), huaxisteels (https://www.huaxisteels.com/newsdetail/asme-b169-pipe-tee-dimensions.html), hu-steel (https://www.hu-steel.com/news364_2287.html), pipedata reducer (https://pipedata.org/fittings/concentric-reducer/) | tee C NPS 3-12; reducer NPS 8 H 6.00 in | search extracts agree | A |
| S11 | ASME B16.9-2018 excerpt (https://energy-steel.com/wp-content/uploads/2025/03/ASME-B16.9.pdf); steelmarts B16.9 chart (https://www.steelmarts.com/asme-ansi-b16.9-fittings-dimension.pdf) | tee C NPS 3, 8, 10, 12; OD 273.0 / 323.8 | search extracts | A (with S10) |
| S12 | The Granite Group, 6"×4" standard weld tee (https://store.thegranitegroup.com/Product/6-4DWT); Texas Flange reducing tees (https://texasflange.com/butt-weld-fittings/reducing-tees/) | 6×6×4: run 5.62 in, branch 5.12 in | search extract | A (with S9) |
| S13 | Hajoca reducer data sheet (https://webassets.hajoca.com/bvSpecs/u3427204.pdf); Ferrobend concentric reducer (https://www.ferrobend.com/dimensions/ansi-asme/pipe-fitting/b16.9-concentric-reducer/) | H 3×2 89, 4×3 102, 6×4 140, 8×6 152 | one table for 3×2 / 4×3 / 6×4; two for 8×6 | B (A for 8×6) |
| S14 | Project Materials, Class 150 flange dimensions (https://blog.projectmaterials.com/quick-answers/flanges/flange-dimensions-class-150/); Hardhat Engineer WN dimensions (https://hardhatengineer.com/weld-neck-flange-dimensions/) | RF 1.6 mm included in thickness; 8 holes NPS 4 / 6 | search extracts | A (RF, hole count), B (thickness, conflicting) |
| S15 | Ferrobend Class 150 WN (https://www.ferrobend.com/dimensions/ansi-asme/flange/b16.5-class-150-weld-neck/); apiint (https://apiint.com/flange-dimensions/weld-neck-flange-dimensions/class-150-weld-neck/); pipedata WN (https://pipedata.org/flanges/weld-neck/); Engineering ToolBox (https://www.engineeringtoolbox.com/flanges-bolts-dimensions-d_464.html) | Y NPS 4 3.00 in vs 2.94 in, NPS 6 3.50 vs 3.44 (RF included / excluded); NPS 4 stud 5/8 in | extracts conflict by the RF height | B (used only as spec-stub inputs) |
| S16 | Wermac B16.10 face-to-face of flanged valves (https://wermac.org/valves/dim_valves_ff.html) | gate valve CL150 NPS 4: 229 mm | search extract | A (with S17) |
| S17 | Project Materials, B16.10 valve face-to-face (https://blog.projectmaterials.com/valves/asme-b16-10-valve-face-to-face) | short-pattern gate CL150 NPS 4: 229 mm | search extract | A (with S16) |
| S18 | ASME B31.3 Fig. 328.5.2C (approximately 1.5 mm / 1/16 in gap before welding), Interpretations 6-02, 12-91, 16-06, via AWS forum (https://app.aws.org/forum/topic_show.pl?tid=10267), eng-tips (https://www.eng-tips.com/viewthread.cfm?qid=504652), amarineblog (https://amarineblog.com/2020/12/07/why-is-the-gap-needed-on-socket-welds/) | socket-weld gap ≈ 1.6 mm, no post-weld requirement | forum / blog extracts quoting the code | B |
| S19 | ht 1.2.0, C. Bell, PyPI, MIT (https://pypi.org/project/ht/); Bergman et al., Introduction to Heat Transfer, 6th ed., Wiley 2011 | series cylinder resistances; example Q = 73.120 W/m | formula re-derived in the scratchpad: 73.12000884 W/m | A |
| S20 | AVEVA E3D Design / Model Reference Manual (https://help.aveva.com/AVEVA_Everything3D/2.1/DRMPGC/DRMPCM24.09.07.html; https://help.aveva.com/AVEVA_Everything3D/2.1/DMRM/DMRM5.09.527.html; https://docs.aveva.com/bundle/e3d-design/page/926029.html) | BRANCH = head + tail + components; HREF / TREF / CREF; arrive / leave p-points; implied tube; backwards routing | several page extracts consistent | A (concepts) |
| S21 | Hexagon, Intergraph Smart 3D Piping 13.1 and Smart 3Dx property descriptions (https://docs.hexagonppm.com/r/en-US/Intergraph-Smart-3D-Piping/13.1/65730; https://docs.hexagonppm.com/r/en-US/Intergraph-Smart-3Dx-Property-Descriptions/13/874509) | feature types straight / turn / branch / end / run change / split / along-leg; parts chosen from the run's spec | search extracts | B |
| S22 | TWI FAQ "standard requirements on the proximity of welds" (https://twi-global.com/technical-knowledge/faqs/faq-what-are-the-standard-requirements-on-the-proximity-of-welds); materialwelding.com (https://materialwelding.com/minimum-distance-or-proximity-between-two-circumferential-pipe-weld-joints/); eng-tips threads | no spacing rule in B31.3; BS 2633 / BS 4515 4 × t "whenever possible"; company specs 50 mm or 2T | extracts | B (rule is a named project default, not a gate) |
| S23 | Autodesk AutoCAD MEP "About Sloped Piping" (https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-MEP/files/GUID-97BD674B-B0D1-4020-A65D-27EC5D371C92.htm); Hagerman blog "AutoCAD Plant 3D sloped piping" (https://blog.hagerman.com/autocad-plant-3d-sloped-piping) | slope as rise/run; allowable fitting deflection; 1/4 in per ft example | search extracts | B |
| S24 | Wermac Q&A on MSS SP-91 (https://wermac.org/others/general_QA/qa_999.html); eng-tips thread 450382 | operator force ~670 N on a 300 mm lever; handwheel heights are company practice | extracts | C (no numeric gate) |
| S25 | Autodesk Plant 3D 2017 "P&ID Validation Settings Dialog Box" (https://help.autodesk.com/cloudhelp/2017/ENU/Plant3D-UserGuide/files/GUID-3FDD798F-FB2A-432C-804E-7A616ABFB79A.htm); "To specify Plant 3D error types to flag" (https://help.autodesk.com/cloudhelp/2016/ENU/PNID/files/GUID-13A025D7-1EDB-4F65-9E85-B972D9D21249.htm) | 3D piping checks "Disconnected port", "Property mismatches"; disconnect markers | search extracts | B |
| S26 | CADMATIC "PCF Export" (https://docs.cadmatic.com/plant/Content/Piping Isometrics/Application/Manage/link_pcf.htm); SST CAEPIPE manual "data types from caepipe" (https://www.sstusa.com/docs/users_manual/data_types_from_caepipe.htm) | PCF is Alias IP, not public; TEE records END-POINT / CENTRE-POINT / BRANCH1-POINT; bend near/far ends + CENTRE-POINT tip | extracts | B (format context for 05 ISO) |
| S27 | Lee C. Y., "An algorithm for path connections and its applications", IRE Trans. Electronic Computers EC-10(3):346-365, 1961 | maze (wavefront) routing on a grid | bibliographic data via search | A (citation) |
| S28 | Hart P. E., Nilsson N. J., Raphael B., "A formal basis for the heuristic determination of minimum cost paths", IEEE Trans. SSC 4(2):100-107, 1968 | A* with admissible heuristic | standard reference | A (citation) |
| S29 | Park J. H., Storch R. L., "Pipe-routing algorithm development: case study of a ship engine room design", Expert Systems with Applications 23(3):299-309, 2002, doi:10.1016/S0957-4174(02)00049-0 | cell generation + pattern matching, cost evaluation | abstract extract | B |
| S30 | Blanco V. et al., "Network flow based approaches for the pipelines routing problem in naval design", Omega 111:102659, 2022 (arXiv 2108.00416, https://arxiv.org/abs/2108.00416) | MILP / network-flow formulation incl. bends | bibliographic data via two repositories | A (citation) |
| S31 | Wu H. et al., "Automatic pipe layout design and optimization method based on improved A*", Beijing Institute of Technology (https://pure.bit.edu.cn/en/publications/automatic-pipe-layout-design-and-optimization-method-based-on-imp/) | grid A* with length + bend count + direction heuristic | abstract extract | B |
| S32 | Stanczak M., Pralet C., Vidal V., Baudoui V., "Optimal Pipe Routing Techniques in an Obstacle-Free 3D Space", ICORES 2020 (https://www.scitepress.org/Papers/2020/89233/) | bend catalogue incl. non-orthogonal bends, LP / MILP | abstract extract | B |
| S33 | Marriott K., Stuckey P., Wybrow M., Dwyer T., "Seeing around corners: fast orthogonal connector routing", Diagrams 2014 | A* over an orthogonal visibility graph with bend penalty | abstract extract | B |
| S34 | Standards catalogue pages (public facts only): ASME B31.3-2024 Process Piping (edition note: https://becht.com/becht-blog/entry/asme-b31-3-process-piping-changes-in-the-2024-edition/); ASME B16.9-2024 (https://www.standards.nimonik.com/products/asme/b16pt9/, NPS 1/2-48); ASME B16.5, B16.10, B16.20, B16.21, B36.10M; ASTM C585-22 (insulation inner / outer diameters for nominal pipe sizes, 1/2-5 in thickness, https://infostore.saiglobal.com/en-au/standards/astm-c-585-2022-148981_saig_astm_astm_3145762/); ISO 12241:2022 (calculation rules for thermal insulation of equipment and industrial installations, https://www.iso.org/standard/74655.html); IEEE 515-2017 (electrical resistance trace heating for industrial applications, https://standards.globalspec.com/std/10192837/ieee-515) | scope, title, edition | catalogue extracts | A (scope only) |
| S35 | Revit PCF Exporter README (raw GitHub, downloaded) | PCF spec available from Intergraph/Hexagon on request | read | A (fact about availability) |

## Not verified / not reached

- **Sample PCF / IDF files.** No openly licensed `.pcf` sample was reachable: PyPI has no piping PCF package (`pcf` is
  Capital One's Particle Cloud Framework, `valvepcf` is a Source-engine format), npm search returned only unrelated
  "PCF" packages, the IsoAlgo3d repository (GPL, said to contain samples) was not accessible from this session, and
  GitHub search via `gh` was blocked. The pump-to-vessel plan therefore uses closed-form geometry, and the PCF
  round-trip is left to 05-isometrics-fabrication.
- **ASME B16.9 / B16.5 primary text** (law.resource.org copy of B16.9-2003 refused the tunnel). All dimensions come
  from manufacturer reproductions; only rows with ≥ 2 agreeing reproductions are grade A.
- **Weldolet heights** (MSS SP-97): not confirmed, so SC-RTE-03 counts olets but does not gate the DN50 cut length.
- **Swing check face-to-face CL150 NPS 4**: sources disagreed (292 is the globe long pattern); not used.
- **Plant 3D default compass tolerance and default slope tolerance**: not published in the extracts; llull uses an
  explicit spec value (`angleToleranceDeg`) and names it when defaulted.
- **Insulation thickness tables** (CINI, company economic-thickness tables): proprietary or not found; the spec stub
  uses an illustrative project table, flagged as such.
- **Valve handwheel height limits** (PIP PNE00003, company standards): not reached; no built-in number.
