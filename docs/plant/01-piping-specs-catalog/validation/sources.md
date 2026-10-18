# Gap 01 PSC — Sources

Accessed 2026-10-18. Network limits of the authoring sandbox: direct downloads worked only from PyPI
(`files.pythonhosted.org`), the npm registry and `raw.githubusercontent.com`. Every other site (Autodesk help, AVEVA,
Hexagon, Wermac, Engineering ToolBox, Project Materials, manufacturer PDFs) returned `403 CONNECT` and was read through
search-engine extracts only. Downloaded archives were unpacked in an isolated scratch directory; no downloaded code was
executed (tables were read with Python `ast.literal_eval` or as JSON / CSV text).

Grades (from [`../../TEMPLATE.md`](../../TEMPLATE.md)):

- **A**: primary source read, reference code run, or two or more independent sources agree.
- **B**: one secondary extract or one open-source transcription. Used as data, flagged `unverified`, never a gate.
- **C**: located, numbers not confirmed. Never used.

## 1. Dimension and rating sources

| Id  | Source | What was taken | How it was checked | Grade |
| --- | ------ | -------------- | ------------------ | ----- |
| S1  | `fluids` 1.3.1, C. Bell, PyPI sdist `fluids-1.3.1.tar.gz` (https://files.pythonhosted.org/packages/f0/71/798e4d4b3f965a18e441510521db3cd0f7b3ce2a5840e8a01d6f7c183175/fluids-1.3.1.tar.gz), module `fluids/piping.py`, MIT | ASME B36.10M schedules 5..160, STD, XS, XXS and ASME B36.19M 5S/10S/40S/80S: NPS, OD, wall (382 rows) → `data/asme_b36_pipe_schedules.json` | 86 rows compared with S2 (agree to 0.005 mm wall, 0.15 mm OD); 2 rows differ, explained (S2 labels a 10S value as Sch 10); llull's own `pipeSizes.ts` STD walls agree on all 19 DN | A (86 rows); B (other rows) |
| S2  | `formulab` 0.72.3, iyulab, npm `formulab-0.72.3.tgz`, `dist/metal/pipeSpec.js` and `dist/metal/flangeSpec.js`, MIT | B36.10M/19M OD + walls (NPS ½..16, 6 schedules); ASME B16.5 WN RF flanges Cl 150/300/600 NPS 1..12 (OD, thickness, bolt circle, bolts, raised face) → `data/asme_b16_5_wn_rf_flanges.json` | Author header states inch × 25.4, cross-checked against 5 public tables; compared with S1 (pipe) and S3 (flange bolting) | A where agreeing with S1/S3/S4; B otherwise |
| S3  | `flange-studbolt-finder` 0.1.14 (KhtaAi), npm, `data/flange-bolting.json` (410 records, B16.5 + B16.47 bolting, B18.2.2 nuts). **No licence declared**: numbers compared only, file not redistributed | bolt count, bolt diameter, flange thickness per NPS / class | 24/24 bolt patterns and 22/24 thicknesses agree with S2 (NPS 6 Cl600 47.8 vs 47.6; NPS 12 Cl600 66.5 vs 66.7) | A (as second source) |
| S4  | Engineering ToolBox "ASME/ANSI B16.5 Flanges and Bolt Dimensions", https://www.engineeringtoolbox.com/flanges-bolts-dimensions-d_464.html ; Wermac weld-neck B16.5 table | NPS 4 Cl150: OD 9 in, bolt circle 7-1/2 in, 8 × 5/8 in, hole 3/4 in; hole = bolt + 1/8 in | search extract; agrees with S2, S3 | A (with S2) |
| S5  | Engineering ToolBox "Carbon Steel Flanges - Group 1.1 Pressure and Temperature Ratings", https://www.engineeringtoolbox.com/steel-flanges-pressure-rating-d_49.html | Cl150 bar at 38/50/100/150/200 °C; Cl300 51.1 bar at 38 °C | search extract | A where S6 agrees, else B |
| S6  | Fike technical bulletin citing ASME B16.5-2017, https://my.fike.com/phoenix/api/files/download/?did=6411 | group 1.1 bar at 38 °C and 50 °C, Cl150..2500 | search extract | A where S5 agrees, else B |
| S7  | Project Materials, "ASME B16.5 PT rating tables explained", "Flange class 150 vs 300", https://www.blog.projectmaterials.com/quick-answers/flanges/asme-b16-5-pt-rating-tables/ | 285 psig / 740 psig at −20..100 °F, group 1.1; linear interpolation permitted; Table 2-x.y naming | search extract | A (with S5) |
| S8  | Texas Flange, 90° and 45° LR elbow tables, https://texasflange.com/butt-weld-fittings/elbow-long-radius/ , https://texasflange.com/butt-weld-fittings/elbow-45-long-radius/ | LR 90 NPS 6 = 9.00 in; LR 45 NPS 4 = 2.50 in, NPS 6 = 3.75 in | search extract | A (with S9/S10) |
| S9  | Wermac, B16.9 elbows / straight tees, https://www.wermac.org/fittings/dim_elbows_c.html , https://wermac.org/fittings/dim_tees_eq.html | LR 90 metric 229 (NPS 6); tee C 64 / 105 / 143 mm (NPS 2/4/6); SR = NPS; ±2 mm tolerance | search extract | A (elbows, with S8); B (tees) |
| S10 | Hardhat Engineer, pipe elbow dimensions in mm, https://hardhatengineer.com/pipe-elbow-dimensions-long-short-radius-elbow-dimensions-in-mm/ | 45° 64 mm (NPS 4), 95 mm (NPS 6) | search extract | A (with S8) |
| S11 | dodo FreeCAD workbench (oddtopus), `tablez/Reduct_SCH-STD.csv`, `Elbow_SCH-STD.csv`, https://raw.githubusercontent.com/oddtopus/dodo/master/tablez/ , LGPL-3.0 | reducer length H by size; **negative example**: elbow `BendRadius` = 0.75 × OD (not B16.9) | downloaded; H agrees with S12 at NPS 4 and 8 | A (H with S12); negative example by construction |
| S12 | Hardhat Engineer "pipe reducer dimensions", Wermac "dim reducers", https://hardhatengineer.com/pipe-reducer-dimensions/ | 8 × 6 length 152 mm; NPS 4 reducers 4 in | search extract | A (with S11) |
| S13 | dodo `tablez/Flange_DIN-PN16.csv`, LGPL-3.0 | EN 1092-1 PN16 DN15..600: D, bore, K, hole, thickness, holes | DN100 D/K agree with S14 | A (DN100 D, K); B (rest) |
| S14 | Wermac, EN 1092-1 type 11 PN16, https://www.wermac.org/din/dim_wn_flg_pn16.html | DN100 220 / 180 | search extract | A (with S13) |
| S15 | Ahlsell product listing, EN 1092-1 type 11 PN40 DN100 | 235 / 190 / 8 × 22 mm / 24 mm | search extract, one source | B |
| S16 | Ferrostaal piping supply catalogue (SlideShare extract), https://www.slideshare.net/slideshow/ferrostaal-piping-supply-catalogue/49684058 | plain-end mass Wpe = 0.0246615 (D − t) t | search extract | A (with S17) |
| S17 | Steel & Tube (NZ), piping systems data charts 2013, https://steelandtube.co.nz/sites/default/files/catalogues/S%26T_piping_systems_data_charts_2013_bm2_0.pdf | m = (D − t) t × 0.02466 | search extract; constant = π × 7850 × 10⁻⁶ = 0.0246615 | A |
| S18 | whatispiping.com, "Pipe thickness calculation per ASME B31.3", https://whatispiping.com/pipe-thickness-calculation-per-asme-b31-3 | worked example NPS 4, 1200 psig, S 19 000 psi: t 3.52, +3 mm, /0.875 → 7.45 mm | search extract; recomputed 3.52053 / 6.52053 / 7.45203 | A (with S19) |
| S19 | epcland.com B31.3 pressure design articles (https://epcland.com/?p=42056); Eng-Tips thread quoting B31.3 Interpretation 2-11 (https://www.eng-tips.com/viewthread.cfm?qid=498113) | eq. 3a t = PD/2(SEW + PY), t < D/6, Y = 0.4 below 482 °C for ferritic steel; t excludes c and mill tolerance | search extracts | A |
| S20 | Project Materials, "ASME B16.10 face to face overview", https://blog.projectmaterials.com/quick-answers/valves/asme-b16-10-face-to-face-overview/ | Cl150 RF gate 178 / 229 / 267 mm (NPS 2/4/6) | search extract | A (with S21) |
| S21 | Wermac, "Face to face dimensions of flanged valves", https://wermac.org/valves/dim_valves_ff.html | same values, gate column Cl150 | search extract | A |
| S22 | Wermac, spiral-wound gaskets B16.20, https://www.wermac.org/gaskets/dim_gaskets_sw.html | NPS 4: inner ring 106.4, sealing element 149.4, Cl150 outer ring 174.8 | search extract | A (inner, outer with S23/S24); B (sealing element) |
| S23 | Garlock product page Class 150 NPS 4 SWG, https://www.garlock.com/product/l00051004001 | inner ring ID 106.43 mm | search extract | A (with S22) |
| S24 | second Class 150 SWG table (search extract via hardhatengineer.com) | NPS 4 outer ring 174.8; Cl300 181.1 | search extract | A (Cl150 with S22); B (Cl300) |
| S25 | llull `packages/domain-aec/src/industrial/piping/pipeSizes.ts` | EN 10220 OD list as implemented | read in repo | — (current state) |
| S26 | Sikla "Rohre (Abmessungen und Gewichte)" DIN EN 10220 table, https://www.sikla.de/fast/600/17%20Rohre%20(Abmessungen%20und%20Gewichte).pdf | 21.3..139.7 series | search extract | A (with S25/S27) |
| S27 | Project Materials, "EU pipe sizes EN 10220 & EN ISO 1127", https://blog.projectmaterials.com/pipes/pipe-tube-sizes/en-10220-1127-eu-pipe-sizes-charts ; DN↔NPS chart https://blog.projectmaterials.com/charts/dn-to-nps-conversion/ | EN 10220 3 series; DN300 = 323.9 / NPS 12 = 12.750 in | search extract | A |

## 2. Product and format sources (functional behaviour, no numbers gated)

| Id  | Source | What was taken | Grade |
| --- | ------ | -------------- | ----- |
| P1  | Autodesk, AutoCAD Plant 3D 2026 Spec Editor help, "About Branch Tables", https://help.autodesk.com/cloudhelp/2026/ENU/Plant3D-SpecEditor/files/GUID-7F6BEC75-9909-47D5-8BB3-67B956E22604.htm | spec = spec sheet + branch table; header × branch cells; several fittings per cell (e.g. reducing tee + latrolet) | B (extract) |
| P2  | Autodesk, "To Modify Piping Components in a Spec" (2023/2026), https://help.autodesk.com/cloudhelp/2026/ENU/Plant3D-UserGuide/files/GUID-84A1217E-AFDF-45F4-A251-DF0DE940D3C8.htm | add/remove sizes, size parameters read-only, property editor, update from catalogue, out-of-range sizes added manually | B |
| P3  | Arkance, "PSPX and PSPC files in Plant 3D", https://ukcommunity.arkance.world/hc/en-us/articles/21549455355026-PSPX-and-a-PSPC-Files-in-Plant-3D | `.pspx` = ZIP with spec header + branch table; `.pspc` = SQLite with fitting definitions | A (several regional copies + Autodesk SQL Server note) |
| P4  | Autodesk "In the Pipes" blog, "Handling bolts in piping specs" (2016) and "Connections with different ratings and facings" (2017), https://blogs.autodesk.com/in-the-pipes/2016/07/16/autocad-plant-3d-handling-bolts-in-piping-specs/ | bolt sets / gaskets selected by nominal size, pressure class, facing; mismatched class/facing joints need DefaultConnectorsConfig.xml edits | B |
| P5  | Autodesk Plant 3D 2017 help, "To add a joint type", https://help.autodesk.com/cloudhelp/2017/ENU/Plant3D-UserGuide/files/GUID-893810FC-B18A-4111-B43F-740BEF9FB509.htm ; IMAGINiT "Connection rules for Plant 3D HDPE end types" | joint = end type 1 × end type 2 + fasteners (gasket, bolt set) + match properties (pressure class, facing) | B |
| P6  | AVEVA E3D 2.1, Catalogues and Specifications Reference Manual, https://help.aveva.com/AVEVA_Everything3D/2.1/CSRM/CSRM13.14.03.html | SPEC → SELE question/answer tree → SPCOM; SPCOM CATREF (catalogue component), DETAIL, MATXT, BLTREF, CMPREF; PBORE per p-point; spec-level RATING, LINETYPE, FLUREF | B |
| P7  | Hexagon Smart 3D, "Interpreting Human Piping Specifications" (PMC 3CS1S02), https://docs.hexagonppm.com/r/en-US/Intergraph-Smart-3D-Interpreting-Human-Piping-Specifications/14/51847 | piping materials class data, corrosion allowance rule, service limits rule, commodity filter, short codes | B |
| P8  | Hexagon Smart 3D Piping Reference Data, "Pipe Takedown Parts"; Smart 3D Catalog generic item-code map, https://docs.hexagonppm.com/r/en-US/Intergraph-Smart-3D-Piping-Reference-Data/13/64358 | short codes, commodity codes (PDS AABBCC) mapping per PMC | B |
| P9  | Hexagon CADWorx Spec Editor docs, https://docs.hexagonppm.com/r/en-US/CADWorx-Spec-Editor/Version-2020-20.0/458188 | Plant 3D catalogue import, size table OD check, units must match | B |
| P10 | Standards catalogue pages: ASME B36.10M (SAI Global), ASME B36.19M-2018 (SFS), EN 10220 (GlobalSpec), ASME B16.10 (GlobalSpec), Wikipedia "Flange" | scope and edition facts only | A (scope) |

## 3. Downloaded files

| File (pack path or scratch) | Size (bytes) | sha256 | Source URL | Licence | In pack? |
| --------------------------- | ------------ | ------ | ---------- | ------- | -------- |
| `fluids-1.3.1.tar.gz` | 2 210 067 | `42014b5f7d0ee3a5c6fea05582cdc37975e7c46d4c864feb6c7cb915df8a1972` | S1 | MIT | no (extracted values → `data/asme_b36_pipe_schedules.json`, MIT notice in its meta) |
| `formulab-0.72.3.tgz` | 593 859 | `5605498057732344998ca5c061d91a45f29c28fca6c4098c626b964dc7cfa1b4` | https://registry.npmjs.org/formulab/-/formulab-0.72.3.tgz | MIT | no (values → `data/asme_b16_5_wn_rf_flanges.json`) |
| `flange-studbolt-finder-0.1.14.tgz` | 119 510 | `ce13725cc4dce7f59f600f25ec54dc7ce56d04bdbd6ea1ee9908aa5f20b2311a` | https://registry.npmjs.org/flange-studbolt-finder/-/flange-studbolt-finder-0.1.14.tgz | none declared | no (comparison results only) |
| `data/dodo_Elbow_SCH-STD.csv` | 646 | `a3d1be6bcc61f7f7dc0f92e3a3877e599381ea3da0e84c8891fe7f4c1300ec99` | S11 | LGPL-3.0 (`data/LICENSE-dodo-LGPL-3.0.txt`) | yes |
| `data/dodo_Reduct_SCH-STD.csv` | 1 091 | `b5438b1d51c0e342585bc614a2874714e80385d65565d95beab8b33c18e8079d` | S11 | LGPL-3.0 | yes |
| `data/dodo_Flange_DIN-PN16.csv` | 597 | `83b870dea518f9d93e4e090ffbbf964dfd28d9ec86ddc874ff0d36feca4ca0ad` | S13 | LGPL-3.0 | yes |
| `data/LICENSE-dodo-LGPL-3.0.txt` | 7 652 | `e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118` | https://raw.githubusercontent.com/oddtopus/dodo/master/LICENSE | — | yes |

Transcribed / derived files in `data/` (no download of their own): `asme_b36_pipe_schedules.json`,
`asme_b16_5_wn_rf_flanges.json`, `asme_b16_5_pt_group_1_1.json`, `asme_b16_9_buttweld_fittings.json`,
`en_1092_1_flanges.json`, `component_references.json`, `llull_pipe_sizes_crosscheck.json`, and the test fixture
`sample_spec_cs150.json` (not a source: written for this pack).

## 4. Not reached / not verified (never gates)

- Autodesk help, AVEVA docs, Hexagon docs, Wermac, Engineering ToolBox, Project Materials, Texas Flange PDFs, Fike,
  Samson (EN 1092-1 connection dimensions PDF), Sikla: all `403` for direct fetch; only search extracts used.
- ASME B16.11 socket-weld / threaded fitting dimensions (no open table found): `TBD — import from a licensed catalogue`.
- ASME B16.9 caps (length E) and reducing tees: one source or none; grade C.
- ASME B16.47 Series A/B dimensions: S3 has bolting rows but no licence and no second source; V1 data task.
- ASME B16.5 group 1.1 ratings above 50 °C for Class ≥ 300 and all other material groups: sources disagree or are single
  extracts.
- B31.3 Table A-1 allowable stresses: not transcribed; `pipe_wall_check` takes S as an explicit input (AF-31).
- MSS SP-97 olet dimensions, EN 10253 fitting dimensions: no open source found; V1.
- The `.pspc` SQLite schema of Plant 3D: only its existence and role are public (P3); table names not confirmed.
