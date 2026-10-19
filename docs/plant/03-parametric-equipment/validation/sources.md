# Gap 03 EQP — Sources

Accessed 2026-10-18. Network limits of the authoring sandbox: only PyPI (`pypi.org`, `files.pythonhosted.org`) and
`raw.githubusercontent.com` could be downloaded. Every other host (ASME, API, ISO, TEMA, Autodesk, AVEVA, vendor
catalogues, journals) answered `403 CONNECT` to both `curl` and the fetch tool, so those sources were read through
search-engine extracts only. The search budget of the session was exhausted at the end of the research; open items are
listed at the bottom.

Grades (from [`../../TEMPLATE.md`](../../TEMPLATE.md)):

- **A**: primary source read, reference code run, or two or more independent sources agree.
- **B**: one secondary extract.
- **C**: located, numbers not confirmed. Never used as a pass / fail gate.

## Downloaded files

| File | URL | Size (bytes) | sha256 | Licence | What was used |
| ---- | --- | ------------ | ------ | ------- | ------------- |
| `fluids-1.3.1.tar.gz` | https://files.pythonhosted.org/packages/f0/71/798e4d4b3f965a18e441510521db3cd0f7b3ce2a5840e8a01d6f7c183175/fluids-1.3.1.tar.gz | 2 210 067 | `42014b5f7d0ee3a5c6fea05582cdc37975e7c46d4c864feb6c7cb915df8a1972` | MIT (C. Bell) | `tests/test_geometry.py` (sha256 `3d154846…f83b`) expected values; `fluids/geometry.py` (sha256 `8af5772c…8f64`) formulas and the torispherical head proportion table. Transcribed into `data/tank_head_volumes_jones.json` and `data/head_geometry_references.json`. |
| `ht-1.2.0.tar.gz` | https://files.pythonhosted.org/packages/86/52/ecd3cfb1d4fcca3563c34b9090a7e78b8b79d8c66f4d715f5f0cdadf5219/ht-1.2.0.tar.gz | 886 282 | `ae117387c4e99a1860d78afd391d24b1a4217cb7495250cd480606e2b7fa2ff5` | MIT (C. Bell) | `ht/hx.py` (sha256 `ec3d6a9d…a5c`) TEMA letter tables, tube sizes, shell clearance, unsupported span; `tests/test_hx.py` (sha256 `004eb697…7b`) tube-count cases. Transcribed into `data/tema_designations.json`. |

Neither archive is redistributed: only numbers and short table transcriptions with attribution are stored (MIT allows
both). The archives were extracted under the session scratchpad and **not executed**; the expected values were
re-derived by an independent implementation, `data/derive_expected.py` (written for this pack, no import of either
package). That script reproduces every fluids test value used here to ≤ 1e-12 relative, which is what makes the
Jones rows grade A (two independent implementations agree).

## Source table

| Id | Source | What was taken | How it was checked | Grade |
| -- | ------ | -------------- | ------------------ | ----- |
| S1 | Jones D., "Calculating Tank Volume" (2015), http://www.webcalc.com.br/blog/Tank_Volume.PDF; Jones D., "Calculating Tank Wetted Area", Chemical Processing (2017) | closed forms for partial volumes of vertical / horizontal tanks with conical, ellipsoidal, spherical, torispherical heads; worked examples in inches / gallons | not fetched (403); formulas as printed in S2 docstrings, examples as asserted in S2 tests; re-implemented independently (derive_expected.py) | A |
| S2 | fluids 1.3.1, C. Bell, PyPI sdist (above) | formulas, test values, f/k table of standard torispherical heads | reference code values reproduced by an independent implementation | A (values) / B (f, k rows with one source) |
| S3 | Weisstein E. W., "Spheroid", MathWorld, https://mathworld.wolfram.com/Spheroid.html | oblate / prolate spheroid surface area | via S2 docstring; formula is textbook; S2 tests reproduced | A |
| S4 | Honeywell, "Calculate Surface Areas and Cross-sectional Areas in Vessels with Dished Heads" (UniSim white paper, 2014) | torispherical head area example (6.00394 m²) | via S2 only | B |
| S5 | Wikipedia, "Head (vessel)", https://en.wikipedia.org/wiki/Head_(vessel) | ASME F&D: crown radius = OD, knuckle = 6 % OD (ASME minimum); Klöpper / Korbbogen proportions | search extract; agrees with S2 table | A (with S2) |
| S6 | Hexagon, CodeCalc Help, "Example Shell Analysis", https://docs.hexagonppm.com/r/en-US/CodeCalc-Help/25/303400 | UG-27(c)(1) example: P 200 psi, D 46 in, CA 0.125 in, S 20 000 psi, E 0.85 → 0.3990 in with CA; corroded radius convention | extract; re-derived 0.39899 in | A |
| S7 | Codeware, INSPECT API-510 sample report, https://www.codeware.com/inspect/docs/INSPECT-API510-Sample-Report.pdf | UG-27(c)(1): P 100, R 30, S 18 800, E 1 → 0.1601 in; report structure (design thickness, MAWP) | extract; re-derived 0.160085 in | A |
| S8 | codecalculation.com, "Pressure Vessel Thickness Calculation", http://docs.codecalculation.com/mechanical/pressure-vessel/thickness-calculation.html; ndtinspect.com UG-27 / MAWP calculators | UG-27(c)(1) applicability: P ≤ 0.385 SE, t ≤ R/2; MAWP form SEt/(R+0.6t) | two independent extracts agree | A |
| S9 | open-exam-prep.com, API 510 study guide §4.1 / §4.2 (cylindrical shells, formed heads) | UG-27, UG-32 formula list | extract | B (formulas confirmed A by S6–S12) |
| S10 | checalc.com, "Pressure Vessel Design: Thickness, MAWP & Hydrotest", https://checalc.com/vessel_guide.html | 72 in ID, 250 psig, S 20 000, E 1, CA 0.125: 2:1 head 0.450 / 0.575 in, shell 0.578 in (uncorroded radius) | extract; re-derived | A (head, with S11); B (shell convention) |
| S11 | Scribd, "API Calculations" worksheet, https://www.scribd.com/document/333289705/API-Calculations | 2:1 head D 120 in, P 434 psi, S 17 500 → 1.492 in | extract; re-derived 1.4917 | A (formula agreement with S10) |
| S12 | City of Everett WA, permit file 958401 pp. 67–73, https://lfportal.everettwa.gov/WebLink/0/doc/958401/Page67.aspx | torispherical UG-32: L 12 in → 0.053 in; L 4 in → 0.018 in (P 100, S 20 000, E 1) | extract; re-derived | A |
| S13 | engineersedge.com, "Hydrostatic pressure tests" (pressure-vessel section); Scribd "Calculation Formula for API 510" (471683930) | UG-99(b) Pt = 1.3 MAWP (S_test/S_design) | two extracts agree; sub-paragraph lettering differs between sources (noted) | A |
| S14 | Pressure Vessel Engineering Ltd, CodeCalc reports, https://pveng.com/wp-content/uploads/2017/07/11110c-1_code_calculations.pdf and https://www.pveng.com/wp-content/uploads/2016/06/Vertical_Compress.pdf | SA-516-70 allowable 20 000 psi used at design temperature; report layout (tr, tr+CA, MAWP) | extract | B (used only as the provenance text of a user input) |
| S15 | Politeknik Perkapalan Negeri Surabaya, CPEAA journal article 1520, https://journal.ppns.ac.id/index.php/CPEAA/article/download/1520/1070 | API 650 example: D 7.7 m, H 10.2 m, G 0.895, Sd 137, St 154 MPa, CA 3 → td 5.44 mm, tt 2.43 mm; 6 mm minimum applied | extract; re-derived 5.4402 / 2.4255 | B (formula A via S16) |
| S16 | epcland.com (p=49206), midstreamcalculator.com "API 650 Tank Design Fundamentals", industrialmonitordirect.com "API 650 Shell Course Calculation: The 1-Foot Method" | one-foot method SI and USC forms; ≤ 60 m (200 ft) diameter limit | three independent extracts agree | A |
| S17 | API 650 Table 5-2a extracts: Scribd 370515298 "Tank Design API", Scribd 750142418 "Calculation Form API 650/653", calculation sheets quoted in search | A283M C 205/380/137/154; A36M 250/400/160/171; A516M-485 260/485/173/195 MPa | each row in ≥ 2 extracts; A283M C also matches S15 | A |
| S18 | Scribd 333136633 "Variable Design Point Method" (5.6.1.1 table), Scribd 282455738 "Notes api650" | minimum nominal shell thickness by diameter | <15 m: 5 mm and 15–36 m: 6 mm in one extract; 36–60 m / >60 m not confirmed; a conflicting 6 mm rule for 3.2–15 m | B (first two rows), C (others) |
| S19 | ISO 2858:1975, https://www.iso.org/standard/7862.html; BS EN ISO 2858:2010 (BSI Knowledge) | title, scope (end-suction, 16 bar, flanges 50..200 mm), designation DNs-DNd-impeller | catalogue pages (public facts only) | A (scope) |
| S20 | Smart Water & Irrigation NZ, "ISO2858 End Suction Pumps Technical Data" (ISOPRO), https://www.smartwaterandirrigation.co.nz/files/ISOPRO_Pump_Technical_Data.pdf | a, f, h1, h2 per size | extract | B alone; A where S21–S23 agree |
| S21 | Northridge Pumps XCP ISO 2858 data sheet; Standard Pumps SEL series; APEC Milano ISO 2858; Standartpompa EN 733 catalogue | same dimensions for 50-32-200, 65-40-250 (h1/h2), 80-50-200 | extracts | B each |
| S22 | IS 13518:1992 (identical adoption of ISO 2858:1975) and ISO 2858-1975 (F) preview, https://cdn.standards.iteh.ai/samples/7862/633c41ba0e6f4ea68f0a066a12a63672/ISO-2858-1975.pdf | 50-32-125 h1 112 / h2 140; 50-32-160 row | garbled scan extracts | B |
| S23 | Goulds Pumps IC series ISO chemical process pumps, https://www.lenntech.com/Data-sheets/Goulds-IC-L.pdf | 65-40-250 h1 180, h2 225 | extract | B |
| S24 | BaseTek LLC, "ANSI/ASME Dimension Sheet" (from ASME B73.1M-1991), https://basetek.com/wp-content/uploads/2020/09/ANSIASME-Dimensions.pdf | AA, AB, A05, A60 rows (CP, D, X) | extract; column mapping inferred | B |
| S25 | OnHandSupply, "ANSI B73.1 Standard Dimension Table", http://onhandsupply.net/ansi-standards; Wilfley, "ASME B73.1 and ISO 5199 – a quick comparison" | AA X = 6.5 in; interchangeability purpose; designations AA..A120 | extracts | A (AA X with S24), B (rest) |
| S26 | wermac.org "API centrifugal pumps"; hardhatengineer.com; whatispiping.com; powerzone.com | API 610 type families OH / BB / VS and OH1, OH2, OH3, BB5 descriptions | ≥ 2 extracts agree for those types; VS2 / VS6 / OH4–5 conflict | A (listed rows) / C (conflicting) |
| S27 | ht 1.2.0, C. Bell, PyPI sdist (above), citing TEMA Standards 9th ed. (2007) | TEMA letters; tube OD/BWG/wall; shell clearance; max unsupported spans; tube counts | reference code tables; letters also in S28 | A (letters, counts) / B (tables) |
| S28 | Wikipedia "Tubular Exchanger Manufacturers Association"; wermac.org "Heat Exchangers TEMA Design"; heat-exchanger-world.com | three-letter designation; BEM / AES / AEU meaning | extracts agree with S27 | A |
| S29 | Autodesk, AutoCAD Plant 3D User Guide: "Create Equipment", "About Equipment", "About Equipment Shapes", "To create equipment from an existing pattern", "Add or Modify Nozzles (Change Location)", help.autodesk.com/cloudhelp/2017–2026/ENU/Plant3D-UserGuide | product behaviour: parametric patterns, shapes assembled along an axis, `.peqs` templates, nozzle location top / bottom / radial / line with R, A, L, P, I, N, T fields, fixed pump nozzle positions | extracts | B (functional benchmark only) |
| S30 | buildingSMART, IFC4 ADD2 TC1, IfcTank / IfcPump / IfcDistributionPort | entity names for equipment and ports | not fetched; names from general knowledge | C |
| S31 | AVEVA E3D Design documentation: "Design Templates", nozzle creation (help.aveva.com, docs.aveva.com/bundle/e3d-design) | EQUIPMENT owns primitives and nozzles; nozzle = catalogue component via a specification, bore, height, design data | extracts | B |
| S32 | CADMATIC Plant, "Component Modeller", https://docs.cadmatic.com/plant/Content/Component%20Modeller/componentmodeller.htm | GDL parametric equipment with connection nodes and attributes | extract | B |
| S33 | Hexagon CADWorx Equipment, "Equipment Palette", https://docs.hexagonppm.com/r/en-US/CADWorx-Equipment/22/357265 | shape list: elliptical, torispherical, spherical heads, cone, flat head, body flange, skirt | extract | B |
| S34 | Zick L. P., "Stresses in large horizontal cylindrical pressure vessels on two saddle supports", Welding Journal Research Supplement, 1951 (basis of saddle checks in PV software) | cited as the V1 saddle-check method only | not fetched | C |
| S35 | API Std 650 catalogue / errata page, https://api.org (12th ed. errata 1, 2013) | edition naming; clause renumbering 3.6 → 5.6 | extract | A (public facts) |
| S36 | ASME BPVC Section VIII Div. 1, ASME B73.1-2020 (ANSI webstore), TEMA 10th ed. — catalogue pages only | titles, scope | catalogue pages | A (public facts only) |

## Not verified (not used as gates)

- The Code text of ASME VIII-1 (UG-16 minimum thickness, UG-27(c)(2) and hemispherical-head applicability limits,
  UG-37 reinforcement, UG-99 sub-paragraph lettering). Formulas are gated only where ≥ 2 sources agree.
- API 650 minimum thickness for 36–60 m and > 60 m, the 3.2–15 m 6 mm rule, the stress-basis fractions of Table 5-2a.
- Full ISO 2858 and ASME B73.1 dimension tables (only the rows in `data/pump_envelopes.json`), pump weights, API 610
  VS2 / VS6 / OH4–OH5 definitions.
- TEMA RCB clauses (baffle thickness, tie rods, nozzle impingement), Zick saddle coefficients, lifting-lug rules.
- Plant 3D `.peqs` file content (binary, not public), AVEVA PTRE / datasheet internals, Smart 3D equipment symbols.
- IFC4 `IfcTankTypeEnum` spelling (VC-EQP-20 must confirm against the schema file before gating).
