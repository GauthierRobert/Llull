# Gap FTR — external sources (accessed 2026-10-15)

Verification level, as achieved from this authoring sandbox:

- **V-fetch**: page/file fetched or git-cloned and read directly (content quoted or computed from it).
- **V-search**: only the search engine's extract of the page was available, because the sandbox egress proxy refused
  `faa.gov`, `nist.gov`, `eaa.org`, `wikipedia.org`, `scribd.com`, `opencascade.org` and other non-GitHub hosts.
  Each claim taken from a V-search source must be re-checked against the primary document before it becomes a release gate
  (`validation/README.md` §6 lists them).
- **NOT VERIFIED**: named in the specs as something to source, with no claim taken from it. The shared web-search budget ran
  out before these could be searched.

| Id | Source | URL | Level | What was verified / used |
| -- | ------ | --- | ----- | ------------------------ |
| R1 | FAA, AC 43.13-1B *Acceptable Methods, Techniques, and Practices — Aircraft Inspection and Repair* (with Change 1), document page | https://www.faa.gov/regulations_policies/advisory_circulars/index.cfm/go/document.information/documentid/99861 | V-search | Title, status "active"; scope: "methods, techniques, and practices acceptable to the Administrator for the inspection and repair of nonpressurized areas of civil aircraft, only when there are no manufacturer repair or maintenance instructions". |
| R2 | FAA, AC 43.13-1B Chapter 4, Section 4 *Metal Repair Procedures* (full PDF + chapter mirror) | https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_43.13-1B_w-chg1.pdf ; mirror https://raanz.org.nz/techproject/FAA%20AC43.13%20b/Chapter%2004.pdf | V-search | Setback topic starts par. 4-56, page 4-13. Table 4-6 gives recommended inside radii for 90° bends in aluminium alloys by alloy, temper and thickness (**cell values not verified**). 90° setback = bend radius + metal thickness. Table 4-7 = K-chart for bends other than 90°; SB = K(BR + MT). Example values: K = 2.4142 for a 135° bend (closed 45° angle), K = 0.41421 for a 45° bend; for 0.064 in sheet and 0.25 in radius, SB = 0.758 in (135°) and 0.130 in (45°). |
| R3 | EAA, *Making Fittings — Part 2* (builder resources) | https://www.eaa.org/eaa/aircraft-building/builderresources/while-youre-building/building-articles/basic-construction/making-fittings-part-2 | V-search | BA = (0.01743·R + 0.0078·T)·N (N = degrees); example 0.040 in sheet, 0.250 in radius, 60° → BA = 0.2796 ≈ 0.280 in (intermediates rounded). |
| R4 | FAA, FAA-H-8083-31B *Aviation Maintenance Technician Handbook — Airframe* (2023), handbooks page | https://www.faa.gov/regulations_policies/handbooks_manuals/aviation | V-search | Title and 2023 edition only (its bend-allowance chapter not read). |
| R5 | NIST, *Download Free CAD Models, STEP Files, and Test Results* (MBE PMI Validation and Conformance Testing) | https://www.nist.gov/ctl/smart-connected-systems-division/smart-connected-manufacturing-systems-group/mbe-pmi-0 | V-search | CTC = combined test cases, FTC = fully-toleranced test cases, STC = simplified; STEP AP242 and AP203 files; project concluded 2015; report NIST AMS 100-10. |
| R6 | NIST, `usnistgov/CAD-PMI-Testing` repository (branch `nist-pages`) | https://github.com/usnistgov/CAD-PMI-Testing | V-fetch (git clone) | `CTC-FTC-Test-Cases.csv`: CTC 01 PMI list (datums A/B/C, ∅20, ∅25, ∅35 dimensions, 60° ±0.5°, flatness 0.2, position 0.75 …). The repo holds no STEP models. |
| R7 | FreeCAD SheetMetal workbench, `shaise/FreeCAD_SheetMetal` @ `8177569b67ed8b0cd278bf8e9ce0fe220c1d7f03` | https://github.com/shaise/FreeCAD_SheetMetal | V-fetch (WebFetch + git clone) | LICENSE file = LGPL-2.1 (README still says GPLv3). Tools: base shape, flange/bend, relief, corner relief, hem, junction, forming, fold, unfold, extruded cutout. Unfold → DXF/SVG. Material Definition Sheets: K-factor per radius/thickness with linear interpolation, `K-factor (ANSI)` or `K-factor (DIN)`; DIN converted to ANSI as K/2 (`_convert_to_ansi_kfactor`). BA = (R + K·T)·θ (`get_bend_allowance`). `tools/calc-unfold.py` (r = 1.64, T = 2, K = 0.38, ML = 50). `Edge2DCleanup`: "many sheet metal fabrication suppliers, as well as CAM systems and laser cutting software, don't have good support for geometric primitives other than lines and arcs". "Engineering UX mode" requires an explicit K-factor. Generic K table in `tools/README.md` (copied there from Wikipedia — secondary). |
| R8 | FreeCAD PartDesign Hole, `FreeCAD/FreeCAD` @ `4a1904f8db57d4a31e44cdb1dd984d4c98447c10` (`src/Mod/PartDesign/App/FeatureHole.cpp`, `Resources/Hole/*.json`) | https://github.com/FreeCAD/FreeCAD/blob/main/src/Mod/PartDesign/App/FeatureHole.cpp | V-fetch (git clone) | Cut types None / Counterbore / Countersink / Counterdrill; thread types include ISO metric (coarse, fine), UNC, UNF, UNEF; **no UNJ / MJ**; `DrillPointAngle` default 118°; `HoleCutCountersinkAngle` default 90° (ISO 10642 table `"angle": 90`); `ModelThread` (modelled vs cosmetic); depth types Dimension / ThroughAll. |
| R9 | FreeCAD Fasteners workbench, `shaise/FreeCAD_FastenersWB` @ `fddd07af422b7d3a69098b32333711c5eeae184c` | https://github.com/shaise/FreeCAD_FastenersWB | V-fetch (git clone) | GPL-2 licence; ASME B18.6.3 countersunk screws modelled with an 82° countersink (`csk_angle = math.radians(82)`); no NAS/MS/NASM aerospace tables. |
| R10 | Open CASCADE Technology, `Open-Cascade-SAS/OCCT` @ `3d097a0328e71b826377d4814ab05ec3c3d23871` (headers) | https://github.com/Open-Cascade-SAS/OCCT/tree/master/src/ModelingAlgorithms/TKFeat | V-fetch (git clone) | `BRepFeat_MakePrism` (depression/protrusion; Perform(Length), Perform(Until), PerformUntilEnd, PerformFromEnd, PerformThruAll, PerformUntilHeight; Fuse 0 = cut, 1 = fuse); `BRepFeat_MakeDPrism` (draft prism); `BRepFeat_MakeCylindricalHole` (Perform(Radius), PerformThruNext, PerformUntilEnd, PerformBlind, Validate); `BRepFeat_MakeLinearForm` (rib/groove along a planar surface); `LocOpe_Prism`; `BRepOffsetAPI_DraftAngle`; `BRepOffsetAPI_MakeThickSolid`; `BRepTools_History`. |
| R11 | `pzfreo/dw-examples` @ `12fa031f02a9d279c1e13dc1aa51662c63a640f4`, `steps/nist/` | https://github.com/pzfreo/dw-examples/tree/main/steps/nist | V-fetch (git clone) | Unmodified mirror of NIST CTC-01…05 AP242 files; README states they are U.S. federal government works not subject to copyright in the U.S. sha256/size recorded in `validation/README.md` §4. |
| R12 | `cadquery-ocp` 8.0.1.1.0 (PyPI) | https://pypi.org/project/cadquery-ocp/ | V-fetch (pip install) | Python binding of OCCT 8.0 used to generate the synthetic STEP parts and to measure the NIST files. |
| R13 | Web3D Consortium, X3D example archive — NIST STEP conformance (CTC 02, CTC 04, FTC 08) | https://www.web3d.org/x3d/content/ConformanceNist/STEP/CTC02/index.html | V-search | X3D conversions of individual CTC/FTC cases exist (alternative visual reference). |
| R14 | The Fabricator, *Analyzing the k-factor in sheet metal bending* | https://www.thefabricator.com/thefabricator/article/bending/analyzing-the-k-factor-in-sheet-metal-bending | V-search | K-factor = neutral-axis shift divided by material thickness (definition only). |
| R15 | NIST AMS 100-10 *Guide to the NIST PMI CAD Models and CAD System PMI Modeling Capability Verification Testing Results* (ResearchGate listing) | https://www.researchgate.net/publication/320255032 | V-search | Existence and title of the companion report. |
| R16 | CadQuery `cadquery/cq.py` @ `5f5bc62b255f62e3512105740025361b6c31eddd` | https://github.com/CadQuery/cadquery/blob/master/cadquery/cq.py | V-fetch (git clone) | `hole(diameter, depth)`, `cboreHole(diameter, cboreDiameter, cboreDepth, depth)`, `cskHole(diameter, cskDiameter, cskAngle, depth)` signatures (code-export target). |

## Internal llull sources (read in the repository)

`packages/core/src/geometry/kernel.ts` (GeometryKernel), `packages/core/src/model/types.ts` (`ShapeRecipe`, `CadDocument`,
`SOLID_KINDS`), `packages/core/src/commands/brep/*` (boolean, fillet/chamfer/shell, inspect_topology, export_step_exact),
`packages/core/src/commands/solids/*` (extrude/revolve/sweep/loft, primitives), `packages/core/src/commands/edit/*`
(array_linear/array_polar/pattern_along_path), `packages/kernel-occt/src/*` (opencascade.js@1.1.1 kernel),
`packages/domain-aec/src/building/exchange/dxfWriter.ts` + `dxfExport.ts` (`export_dxf`), `packages/mcp/src/exchangeTools.ts`
(`import_step`/`export_step` via CadQuery), `server/src/cli/usage.ts`, `docs/decisions/KI4…KI6`.

## NOT VERIFIED (no claim taken; to source before the V1 gate)

| Topic | Intended primary source | Why needed |
| ----- | ----------------------- | ---------- |
| 100° countersink for flush aerospace rivets / bolts | NASM20426 (rivet), NAS1097, NAS1580/NAS1581 family, NAS/AIA catalogue pages; or the fastener catalogue of gap 08 | Default `cskAngle` preset; the 100° value appears in the specs only as a *convention to confirm*. |
| UNJ thread form (controlled root radius) | SAE AS8879 catalogue page (supersedes MIL-S-8879) | Thread designation grammar and classes for the cosmetic thread attribute. |
| MJ metric aerospace thread | ISO 5855-1/-2/-3 catalogue pages (iso.org) | Same, metric. |
| Minimum bend radii by alloy/temper/thickness | AC 43.13-1B Table 4-6 (cell values), MMPDS (Battelle) catalogue, AMS-QQ-A-250 | Seed data of the `bend_radius_table`. |
| Joggle and lightening-hole practice | AC 43.13-1B ch.4, FAA-H-8083-31B ch.4 | Default joggle run/offset ratios, flanged-hole proportions. |
| CATIA *Aerospace Sheetmetal Design* (ASL) and SOLIDWORKS sheet metal docs | help.3ds.com, help.solidworks.com | Competitive feature list (joggle, flanged cutout, stiffening bead, surfacic flange, K-factor/bend tables). |
| Programme case studies (monolithic machined frames/ribs, hydroformed/rubber-pad-formed sheet parts) | NASA NTRS, manufacturer press/technical papers | Value statements in FUNCTIONAL_SPEC §2 are left qualitative until sourced. |
