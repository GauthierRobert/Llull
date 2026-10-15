# SRF — Advanced freeform surfacing & aerodynamic geometry — Functional specification

Gap id: **SRF** · Folder: `docs/aerospace/02-advanced-surfacing/` · Status: specification only (2026-10-15) ·
Depends on: **01 KRN** (exact B-rep on desktop OCC, persistent naming) · Feeds: **06 CMP** (ply surfaces),
**05 FEA** (mid-surfaces), **04 XCH** (B-spline faces in STEP AP242).

---

## 1. Summary

Aircraft outer mould lines (OML) — wings, fuselages, nacelles, fairings, control surfaces — are freeform
surfaces defined by **airfoil sections, planform parameters, fuselage stations and conic or curvature-continuous
lofts**, and they are checked with **curvature and continuity analysis** before release. llull today can make a
smooth solid through cross-sections (`loft_sections`), sweep a profile (`sweep_profile`), patch 2 or 4 boundary
curves (`surface_from_curves`) and edit Catmull-Clark cages (`add_subdivision_solid`), and with the OCC kernel
these become exact B-spline solids. But:

- there is **no NURBS entity** (no degree, knot vector or weights the user or an agent can set or read); 2D
  splines are Catmull-Rom only (`SplineEntity`, `packages/core/src/model/types.ts`);
- every loft/sweep section is **resampled to 24 arc-length points** (`SECTION_RING_POINTS`,
  `packages/core/src/geometry/sectionRing.ts`) — a NACA 0012 polygon resampled that way loses **2.0 % of section
  area** and deviates up to **1.1 % of chord** (indicative linear estimate in `validation/README.md` §4), and the
  sharp trailing edge is not kept as a corner;
- there is **no continuity control or measurement** (G0/G1/G2/G3), **no surface analysis** (curvature comb,
  zebra/isophotes, Gaussian/mean curvature maps, draft, deviation);
- there are **no guide curves**, no N-sided fill, no surface trimming, sewing or thickening of open surfaces;
- there are **no aerodynamic tools**: no airfoil import (UIUC Selig/Lednicer `.dat`), no NACA generator, no
  wing-by-parameters (span, chord, sweep, dihedral, twist), no fuselage-by-stations (FS/BL/WL), no conic lofting.

Without these, llull cannot define or check a wing, a fuselage or any aerodynamic fairing to the accuracy an
aerodynamicist, loftsman or tool designer needs, and an AI agent cannot be asked "build a 45° swept wing with a
NACA 23012 root and check the leading edge is G2". This gap closes that.

## 2. Aerospace context & value

### 2.1 How OMLs are defined today

| Practice | What it is | Who / tools | Source |
| --- | --- | --- | --- |
| NACA section families | 4-digit, 5-digit (and later 6-series) sections defined by closed-form thickness and camber equations; generator programs published by NASA Langley | NACA/NASA; every aero code (XFOIL, OpenVSP, AeroSandbox) | [R2] [R3] [R4] [R5] |
| Airfoil coordinate libraries | UIUC Airfoil Coordinates Database: ~1,600 sections as chord-normalised `.dat` files in Selig (TE→upper→LE→lower→TE) or Lednicer (upper LE→TE, then lower LE→TE, counts on line 2) format | Universities, UAV/GA designers, OpenVSP, AeroSandbox | [R6] [R7] |
| Parametric wing / fuselage definition | Wing = sections with span, root/tip chord, taper, sweep at a chord fraction, dihedral, twist about a chord fraction; fuselage = stations | NASA OpenVSP (open source since January 2012 under NOSA 1.3; 50,000–60,000 downloads by 2016 per NASA Spinoff) | [R8] [R9] [R11] |
| Lofting coordinates | Fuselage stations (FS, along the longitudinal axis from a datum near the nose), buttock lines (BL, left/right of the plane of symmetry), water lines (WL, height from a horizontal datum) — inherited from ship lofting | All airframers; FAA maintenance handbook | [R21] |
| Conic lofting | Fuselage frames built from conic arcs controlled by a shoulder point / `rho` value; developed analytically by Roy A. Liming (North American Aviation), book 1944, paper 1947; associated with the P-51 Mustang fuselage | NAA; heritage in every master-line process | [R18] [R19] [R20] |
| NURBS | Industry-standard exact representation of freeform curves and surfaces (degree, knots, weights); reference text Piegl & Tiller | All CAD kernels (OCC, Parasolid, ACIS, CGM) | [R1] [R12] |
| Surface quality checks | Zebra stripes, curvature graphs, continuity between surfaces G0 (position), G1 (tangent), G2 (curvature), G3 (rate of change of curvature) | Rhino, Siemens NX, CATIA/ICEM Surf | [R22] [R23] [R24] |
| Digital product definition | Boeing 777: "first airplane to be 100-percent digitally designed and preassembled on a computer" (CATIA), eliminating the costly full-scale mock-up | Boeing | [R25] |

### 2.2 Reference programmes used for validation

| Programme / dataset | Public data | Used for |
| --- | --- | --- |
| NACA 0012 / 2412 / 23012 | UIUC `.dat` (pinned via AeroSandbox mirror, sha256 recorded) | VC-SRF-01..04 airfoil generator & import |
| NACA TR-1208 swept wing (Langley, early 1950s) as built in the OpenVSP API tutorial | Root chord 21.941 in, semi-span 63.63 in, taper 0.45, 45° c/4 sweep, MAC 16.672 in, Sref 2024.35 in² | VC-SRF-10 wing planform |
| NASA Common Research Model (CRM) | IGES/STEP geometry on the NASA CRM site; full-scale Sref 383.65 m², span 58.76 m, cref 7.0 m (published in arXiv 2210.00304); AR 9, 35° c/4 sweep (arXiv 1806.07299) | VC-SRF-12 import + analysis of a real transonic wing |
| P-51 conic fuselage | Liming method (book/paper), secondary sources | VC-SRF-14 conic sections (analytic) |
| Sears–Haack body | Closed-form radius distribution and volume | VC-SRF-13 fuselage-by-stations loft |

### 2.3 Value

- **Aero ⇄ CAD round trip:** an aerodynamicist's section and planform numbers become an exact B-rep wing in
  one command, with a volume and wetted area that match the analytic/OpenVSP value (VC-SRF-10/11), instead of
  being re-traced by hand in a commercial CAD.
- **Quality before release:** a numeric G1/G2 report (angle and curvature gap per edge) and visual maps replace
  "looks smooth" judgement; an agent can enforce "all OML internal edges G2 within 0.1 rad / 5 %".
- **Agentic design:** every capability is a command, so Claude can generate NACA families, sweep a design
  space (sweep, taper, twist) and report geometry metrics without UI work (L1).
- **Downstream gaps:** composites (06) drape over these surfaces; FEA (05) needs their mid-surfaces; AP242 (04)
  needs exact B-spline faces.

## 3. Personas & user stories

| Persona | Story | FR |
| --- | --- | --- |
| P1 Aerodynamicist (conceptual) | As an aerodynamicist I generate a NACA 23012 or import a UIUC `.dat` and get an exact section curve with sharp TE, so the CAD section equals my analysis section. | FR-SRF-10..13 |
| P1 | I define a wing by span, root/tip chord, sweep at c/4, dihedral and twist and get the planform metrics (area, AR, MAC, y_MAC) back, matching OpenVSP. | FR-SRF-14..16 |
| P2 Loftsman / OML surface designer | I define the fuselage by stations in FS/BL/WL with conic (rho) upper and lower halves and longitudinal control curves, and get a G1/G2 skin. | FR-SRF-17..19 |
| P2 | I loft through sections **with guide curves** (leading-edge line, crown line) so the surface follows the master lines exactly. | FR-SRF-05 |
| P3 Class-A / quality engineer | I see curvature combs on curves, zebra and Gaussian/mean curvature maps on faces and a G0–G3 table per edge, before releasing the OML. | FR-SRF-20..24 |
| P3 | I measure the deviation of my surface from a scanned point cloud or a reference STEP surface and get max/RMS deviation and a colour map. | FR-SRF-25 |
| P4 Tooling / manufacturing engineer | I check draft angle against a pull direction on a fairing mould and see undercut regions. | FR-SRF-24 |
| P5 Structures engineer | I trim the wing skin between spar planes, sew skins and close-outs into a solid and offset the OML inward by skin thickness. | FR-SRF-07..09 |
| P6 AI agent (CLI / MCP) | I call `airfoil_from_naca`, `create_wing`, `check_continuity` in one `build_project` plan and read numeric results (no screenshots needed). | FR-SRF-26..28 |
| P7 UAV / GA designer | I fill an N-sided hole (wing-fuselage fairing corner) with a G1 patch. | FR-SRF-06 |

## 4. Scope / out of scope

### 4.1 Phases

| Phase | Content |
| --- | --- |
| **MVP** (aero geometry that is exact) | NURBS curve & surface entities (read/write degree, knots, weights); interpolate/approximate curves through points with end tangents; airfoil import (Selig + Lednicer) and NACA 4/5-digit generator; exact section curves (no 24-point resampling) with sharp TE; multi-section wing (span, chord, sweep, dihedral, twist, linear/smooth loft); curvature/continuity **query** commands (curve curvature + comb data, surface K/H/k1/k2 at samples, G0/G1/G2 per edge); planform/section metrics. |
| **V1** (surface toolkit) | Loft with guide curves; sweep with guide/scaling law; N-sided fill (G0/G1); surface trim by curves/planes; sew to solid; thicken/offset; fuselage by stations (FS/BL/WL) with conic sections and control lines; UI analysis displays (comb, zebra, curvature map, draft map); deviation analysis (surface↔points, surface↔surface). |
| **V2** (Class-A / advanced) | G3 measurement and G2 matching (match surface to neighbour); blend surfaces between faces with G1/G2; isophotes/highlight lines as data; OpenVSP `.vsp3` wing import; CRM-scale performance; Liming conic master-line workflow (shoulder curves, rho law along length); CST/other parametric airfoils (COULD). |

### 4.2 Out of scope

- Aerodynamic analysis (panel/VLM/CFD) — llull hands geometry off (STEP, OpenVSP-style DegenGeom is a COULD).
- NACA 6-series/6A generation (requires conformal-mapping program, NASA TM X-3069 [R3 note]) — import via `.dat` only.
- Subdivision-to-NURBS conversion beyond what `add_subdivision_solid` + OCC already does.
- Automotive Class-A tooling (highlight-line optimisation) beyond the V2 measurements.
- Mesh/scan reverse engineering (fitting surfaces to scans) — only deviation measurement is in scope.

## 5. Functional requirements

Priority: MUST = MVP, SHOULD = V1, COULD = V2. Every FR maps to ≥ 1 VC in `validation/README.md`.

### 5.1 NURBS core

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-SRF-01 | MUST | Create, read and edit a **3D NURBS curve**: degree p (1..25), control points, weights (> 0), knot vector (clamped or periodic, non-decreasing, multiplicities ≤ p, ≤ p+1 at clamped ends); rational and non-rational. | Exact freeform data; conics are rational quadratics. | [R1] [R12] (Geom_BSpline max degree 25) |
| FR-SRF-02 | MUST | Create, read and edit a **NURBS surface** (degrees p,q; poles grid; weights; U/V knots; periodic flags) as an open sheet entity, plus a solid made from sewn sheets. | OML panels are open surfaces before closing. | [R1] |
| FR-SRF-03 | MUST | **Interpolate** a curve through ordered points (chord-length or centripetal parameterisation) with optional end tangents and optional periodic closure; and **approximate** within a tolerance with degree range. | Airfoil and master-line definition from points. | [R1] §9; [R12] GeomAPI_Interpolate / PointsToBSpline |
| FR-SRF-04 | MUST | Interpolate/approximate a surface through a grid of points (degree range, continuity, 3D tolerance). | Wind-tunnel / OpenVSP surface point grids. | [R12] GeomAPI_PointsToBSplineSurface (defaults DegMin 3, DegMax 8, C2, Tol3D 1e-3) |
| FR-SRF-05 | SHOULD | **Loft** through ordered section curves that keeps each section **exactly** (no resampling), with optional **guide curves**, start/end tangency or curvature conditions, ruled or smooth, open (sheet) or closed (solid); and report the max deviation of the result from each input section. | Wing/fuselage lofts must pass exactly through the defining sections and master lines. | [R12] BRepOffsetAPI_ThruSections (pres3d 1e-6, smoothing, continuity, max degree) |
| FR-SRF-06 | SHOULD | **N-sided fill** of a closed loop of 3..N boundary edges/curves with per-boundary G0/G1 (G2 COULD) to adjacent faces, optional interior constraint points; report achieved tolerances. | Fillet corners, wing–fuselage fairings. | [R12] BRepFill_Filling / BRepOffsetAPI_MakeFilling (Tol3d 1e-4, TolAng 0.01, TolCurv 0.1 defaults) |
| FR-SRF-07 | SHOULD | **Trim** a surface by curves (projected along a direction or on-surface) or by planes; keep chosen side. | Skin panels between spars/ribs; cut-outs. | [R12] |
| FR-SRF-08 | SHOULD | **Sew** a set of surfaces into a shell/solid with a stated tolerance; report free edges and non-manifold edges; fail without a closed solid when asked for a solid. | OML → watertight solid for mass properties/STEP. | [R12] BRepBuilderAPI_Sewing |
| FR-SRF-09 | SHOULD | **Thicken / offset** a surface (inward OML offset by skin thickness) and **blend** between two surfaces with G1/G2 (blend COULD G2). | Skin solids, fairings. | [R12] |

### 5.2 Aerodynamic geometry

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-SRF-10 | MUST | **Import an airfoil** `.dat` in Selig or Lednicer format (auto-detect: line 2 values > 1 ⇒ Lednicer counts), tolerate header text, blank lines, Fortran exponents and duplicate LE points; produce an exact section curve and a report (format, points, TE gap, LE index, chord, closed/open TE). | UIUC database is the de-facto public source. | [R6] |
| FR-SRF-11 | MUST | **Generate NACA 4-digit and 5-digit** (standard mean lines 210–250, reflexed COULD) sections from the published equations: thickness with open TE (a4 = −0.1015) or closed TE (a4 = −0.1036), thickness applied perpendicular to the mean line, cosine or uniform spacing, configurable point count; or as an exact curve (B-spline through dense samples within 1e-6 c). | Reproduce NASA reference ordinates. | [R2] [R4] [R5] |
| FR-SRF-12 | MUST | **Normalise** imported/generated sections on request: chord line from the TE midpoint to the farthest point (geometric LE), scale to chord 1, derotate; or keep as given (default). | UIUC files mix conventions (e.g. pinned `naca2412.dat` is rotated ≈ 0.0014 rad from the analytic definition, VC-SRF-03). | measured, `validation/data/naca_uiuc_comparison.json` |
| FR-SRF-13 | MUST | Section **metrics** query: max thickness & location, max camber & location, LE radius (fitted), TE thickness & included angle, section area, centroid. | Aero sanity check and agent feedback. | [R2] (LE radius 1.1019 t² for 4-digit) |
| FR-SRF-14 | MUST | **Create a wing** from ≥ 2 sections: each with airfoil, chord, span station, twist (about a chord fraction, default c/4 as in OpenVSP), and per-segment sweep (at a chord fraction), dihedral; or from planform parameters (any 3 of span, area, AR, taper, root/tip chord); linear (ruled) or smooth loft; optional mirror about XZ; sharp TE kept as an edge; optional rounded or flat tip cap. | OpenVSP-equivalent definition in CAD. | [R8] (`Span`, `Root_Chord`, `Tip_Chord`, `Sweep`, `Sweep_Location`, `Dihedral`, `Twist`, `Twist_Location`=0.25 default) |
| FR-SRF-15 | MUST | **Wing metrics** query: projected and true span, planform area (per side/total), AR, taper, MAC and its spanwise/chordwise location, LE/c4/TE sweep, wetted area, volume, per-section twist and chord. | Validates against OpenVSP/tutorial numbers. | [R9] |
| FR-SRF-16 | SHOULD | Edit any wing parameter later (parametric history) and re-derive the B-rep; sections keep their identity (named) for downstream features. | L8 recipe. | — |
| FR-SRF-17 | SHOULD | **Fuselage / body by stations** in an aircraft frame **FS/BL/WL** (datum, units, +directions declared): each station a closed section (circle, ellipse, superellipse, conic upper/lower halves, or imported curve) at FS, with optional longitudinal control curves (crown WL, keel WL, max-half-breadth BL, shoulder lines); loft G1/G2. | Airframer coordinate convention; body lofting. | [R21] |
| FR-SRF-18 | SHOULD | **Conic section / Liming conic**: conic arc from start point, end point, tangent intersection (or end tangents) and `rho` (shoulder) — 0 < rho < 1; rho < 0.5 ellipse, = 0.5 parabola, > 0.5 hyperbola — exact as rational quadratic B-spline. | Historical and current fuselage lofting practice. | [R1] [R18] [R19] |
| FR-SRF-19 | COULD | Conic **master-line lofting**: rho and shoulder/tangent lines as longitudinal curves; sections derived at any FS. | Liming method full workflow. | [R19] [R20] |

### 5.3 Analysis

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-SRF-20 | MUST | **Curve curvature**: curvature (and radius), curvature derivative, torsion at parameters/arc length, and **curvature-comb** data (sample points + comb vectors, scale) for any curve or edge. | Fairness check of sections/master lines. | [R1] [R22] |
| FR-SRF-21 | MUST | **Surface curvature** at (u,v) samples or a grid on a face: normal, k1, k2, principal directions, Gaussian K, mean H (sign convention documented), with min/max over the face. | Curvature maps; analytic checks. | [R12] GeomLProp_SLProps (max, min, mean, Gaussian) |
| FR-SRF-22 | MUST | **Continuity check** between two curves at a joint or two faces along a shared edge: G0 gap, G1 angle, G2 curvature gap (relative and absolute), G3 curvature-derivative gap; verdict per order against user tolerances; worst sample location. | Release criterion for OMLs. | [R12] LocalAnalysis_*Continuity (C0/G1/G2 values); [R23] (G3 definition) |
| FR-SRF-23 | SHOULD | **Visual analysis** in the viewport: curvature comb, zebra stripes (direction, spacing), environment/isophote shading, Gaussian/mean/min/max curvature colour maps with legend & clamping; toggled per entity, never modifying the document. | Visual G1/G2 judgement as in Rhino/NX. | [R22] |
| FR-SRF-24 | SHOULD | **Draft analysis** against a pull direction: per-sample draft angle, regions below a minimum draft, undercuts; data + colour map. | Mould/tooling for composite fairings. | [R12] (draft angle tools) |
| FR-SRF-25 | SHOULD | **Deviation**: distance from points (CSV/pinned scan) or another surface/solid to a face set: max, mean, RMS, signed (along normal), histogram, colour map; with a pass/fail tolerance. | Validate a rebuilt OML against reference (CRM STEP, scan). | [R12] BRepExtrema_DistShapeShape / ProjectPointOnSurf |

### 5.4 Surfaces of the product (UI / CLI / MCP)

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-SRF-26 | MUST | Every capability above is a registered command reachable from UI, `llull` CLI (`--app`/`--doc`) and MCP (toolsets `surface`, `aero`), with numeric `data` results usable by agents. | Laws L1, L5, KI6. | `.claude/rules/architecture.md` |
| FR-SRF-27 | MUST | Surfaces and wings persist in the llull document with full recipe (degree/knots/weights/sections) and export to STEP as `B_SPLINE_SURFACE_WITH_KNOTS` / rational forms (via OCC) without tessellation. | Exchange fidelity. | KI5 decision |
| FR-SRF-28 | SHOULD | Code export (`export_code`) emits CadQuery equivalents (e.g. spline/loft) for the new commands where CadQuery has them, else the exact B-spline data. | Existing codegen parity (KI5). | — |
| FR-SRF-29 | SHOULD | Without the OCC kernel (Manifold/web), NURBS entities still display (core tessellation) and query commands that need only core math (curve curvature, airfoil, wing metrics) work; kernel-only operations no-op with the standard refusal. | Offline web mode stays usable (L6, L9). | KI5 |
| FR-SRF-30 | COULD | Import an OpenVSP `.vsp3` WingGeom (planform + XSec airfoil types NACA 4-series / AF file) into a llull wing. | Aero-tool interoperability. | [R8] |

## 6. Workflows

### 6.1 UI (desktop, OCC)

1. **Surface ▸ Airfoil ▸ NACA…**: type `23012`, points 161, cosine spacing, open TE → a section curve
   appears in a chosen plane; the side panel shows metrics (FR-SRF-13).
2. **Surface ▸ Airfoil ▸ Import .dat…** → file dialog → format detected, report shown, optional
   *Normalise chord* checkbox (FR-SRF-12).
3. **Aero ▸ Wing…**: section table (airfoil, span, chord, twist), planform fields (sweep @ fraction, dihedral),
   mirror, loft type → OK creates `wing-…`; **Inspect ▸ Wing properties** shows area/AR/MAC (FR-SRF-15).
4. **Analysis ▸ Curvature map / Zebra / Comb** toggles a display overlay for selected faces/edges;
   **Analysis ▸ Continuity…** pick an edge (or all internal edges) → table G0/G1/G2/G3 with worst values and
   pass/fail colouring (FR-SRF-22/23).
5. **Surface ▸ Fill / Trim / Sew / Thicken** operate on picked faces/edges (V1).

### 6.2 CLI (`llull`, local agent path)

```bash
llull --app run plan.json          # plan below; the desktop window updates live
llull --doc wing.llull query wing_properties '{"id":"wing-1"}'
llull --doc wing.llull query check_continuity '{"id":"wing-1","edges":"internal","g1AngleTol":0.0087,"g2RelTol":0.05}'
llull --doc wing.llull export step out/wing.step
```

`plan.json` (target, see `validation/plans/target_naca0012_trap_wing.json`):
`airfoil_from_naca` → `create_wing` → `mass_properties` → `wing_properties`.

### 6.3 MCP agent (cloud)

1. `enable_toolset aero` (and `surface`).
2. `build_project` with the same plan; read `data` of `wing_properties` (area, MAC) and `check_continuity`.
3. Iterate: `set_parameter sweep 35` → history re-evaluates → re-query metrics (L8).

## 7. Acceptance criteria

| # | Given | When | Then | VC |
| --- | --- | --- | --- | --- |
| AC-01 | the NACA generator | `airfoil_from_naca 0012` (open TE) | every point of pinned UIUC `naca0012.dat` lies within **1e-6 c** of the generated curve | VC-SRF-01 |
| AC-02 | the NACA generator | `airfoil_from_naca 23012` | pinned `naca23012.dat` within **2e-5 c** (5-decimal file rounding) | VC-SRF-02 |
| AC-03 | pinned `naca2412.dat` (Lednicer naca.exe) | imported with `normalize: chord` and compared to `airfoil_from_naca 2412` | max deviation ≤ **2e-4 c**; without normalisation the report shows ≈ 1.29e-3 c (documented convention difference) | VC-SRF-03 |
| AC-04 | Selig and Lednicer sample files | `import_airfoil` | format detected correctly; point counts and LE index match the file; TE gap reported | VC-SRF-04 |
| AC-05 | a sphere R = 10, cylinder R = 5, torus R = 5 / r = 2 | `analyze_surface_curvature` at the listed (u,v) | K and |H| equal the closed-form values within 1e-6 relative (torus K abs 1e-6) | VC-SRF-05 |
| AC-06 | the analytic curve joints (corner, line–arc, line–x³, line–x⁴, arc–arc) | `check_continuity` | reported order is exactly G0, G1, G2, G3, G3/G1 as tabulated | VC-SRF-06 |
| AC-07 | a NURBS curve with rho = √2−1 conic | evaluate 9 samples | radius error vs unit circle ≤ **1e-12** | VC-SRF-07 |
| AC-08 | the TR-1208 planform | `create_wing` + `wing_properties` | area 2024.35 in² ± 0.01, MAC 16.670 ± 0.005 in, AR 8.000 ± 0.03 | VC-SRF-10 |
| AC-09 | trapezoidal wing cr 2, ct 1, b/2 5 m, NACA 0012 open TE, linear loft | `mass_properties` | volume 0.959117 m³ ± 1e-4 relative | VC-SRF-11 |
| AC-10 | the NASA CRM STEP | import + `check_continuity` on wing upper skin + `analyze_surface_curvature` | run completes within the performance budget; values recorded as golden (TBD on first run) | VC-SRF-12 |
| AC-11 | 19 Sears–Haack stations + nose/tail points | `loft_fuselage` (G2) + `mass_properties` | volume within 0.5 % of 3π²R²L/16 = 4.626377 (L = 10, R = 0.5) | VC-SRF-13 |
| AC-12 | an open loop of 3, 4 and 5 edges on a box-with-fillet corner | `fill_surface` with G1 | max G0 gap ≤ 1e-4 and G1 angle ≤ 0.01 rad on every boundary (OCC defaults) | VC-SRF-15 |
| AC-13 | two lofted wing segments | `sew_surfaces` → solid | 0 free edges, a valid solid, `mass_properties` equals sum of segment volumes ± 1e-6 rel | VC-SRF-16 |
| AC-14 | a plane-normal draft test body | `analyze_draft` with pull +Z | draft angles equal analytic values ± 0.01° | VC-SRF-17 |
| AC-15 | a known offset surface (sphere R = 10 vs R = 10.5) | `measure_deviation` | max = mean = 0.5 ± 1e-6 | VC-SRF-18 |
| AC-16 | any SRF command | called through UI, CLI and MCP | identical document results (command log replay equality) | VC-SRF-19 |

## 8. Standards & regulatory alignment

| Topic | Alignment |
| --- | --- |
| NURBS definition | Piegl & Tiller [R1] terminology (degree, knot vector, multiplicity, weights, clamped/periodic); OCC conventions (degree ≤ 25, `GeomAbs_Shape` C0/G1/C1/G2/C2/C3/CN) [R12]. OCC has **no G3 enum** — G3 is computed by llull (TECHNICAL_SPEC §5.6). |
| Continuity vocabulary | G0 position, G1 tangent, G2 curvature, G3 rate of change of curvature, as defined by Siemens NX [R23] and Rhino [R22]. |
| Airfoil equations | NACA Report 460 (4-digit) [R2]; NASA TM X-3284 / TM 4741 generator programs [R3] [R4]; 5-digit 230 constants as tabulated in [R5]. |
| Airfoil data format | UIUC Selig and Lednicer formats as described by the UIUC Airfoil Data Site [R6]. |
| Coordinate frame | Aircraft lofting coordinates FS/BL/WL [R21]; documented per document (datum, +X aft, +Y right, +Z up). |
| Exchange | Exact STEP B-spline surfaces through the existing AP214 path (KI5) and AP242 (gap 04). |
| Regulation | No FAA/EASA rule prescribes a CAD continuity order; OML quality criteria are programme-specific. This spec makes them **configurable tolerances**, not hard-coded. (Assumption; see §10.) |

## 9. KPIs / success metrics

| KPI | Target |
| --- | --- |
| NACA generator vs UIUC reference (0012, 23012) | max deviation ≤ 1e-6 c / 2e-5 c |
| Loft section fidelity | max deviation of a loft from each input section ≤ 1e-6 × chord (vs today ≈ 1e-2 c, indicative) |
| Analytic curvature cases | 100 % within tolerance (sphere, cylinder, torus) |
| Wing metric parity with OpenVSP tutorial | area/MAC within 0.01 % |
| Continuity classification accuracy on analytic suite | 6/6 correct |
| Performance | NACA wing (2 sections, 161 pts) build ≤ 1 s; curvature grid 100×100 on one face ≤ 500 ms; CRM wing continuity check ≤ 10 s (desktop, OCC) |
| Agent success | `build_project` plans in `validation/plans/target_*.json` run unchanged |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| --- | --- | --- |
| opencascade.js 1.1.1 (OCCT V7_4_0p1) does **not** bind `GeomAPI_Interpolate` and `GeomFill_NSections`; `MakePipeShell.Build` is already known unusable in llull's build | MVP interpolation and guided sweeps blocked in WASM | Core-side interpolation (Piegl & Tiller A9.1) producing poles/knots fed to `Geom_BSplineCurve` (bound); custom opencascade.js build (gap 01 KRN) |
| Topological naming instability after edits (KI5) | Continuity/trim references break | Name sections and edges via recipe ids + `edgesNear` fallback; gap 01 persistent naming |
| UIUC licence not stated on the pages reachable during research | Cannot redistribute `.dat` files | Pin URL + sha256 only; tests download on demand or use generated data |
| Lednicer files with differing normalisation (VC-SRF-03) | False failures | Explicit `normalize` option and tolerance per file |
| G2/G3 measured numerically is noise-sensitive near degenerate points (LE, poles) | Spurious failures | Relative + absolute thresholds, skip degenerate samples, report sample counts |
| No authoritative aerospace continuity standard was found | Tolerance defaults may be contested | Defaults from OCC filling defaults (TolAng 0.01 rad, TolCurv 0.1) and user-configurable |
| CRM geometry host not reachable from the research sandbox | sha256 not recorded | Pin page URLs; record sha256 on first CI download (TBD) |

## 11. References

- [R1] Piegl, L.; Tiller, W. — *The NURBS Book*, 2nd ed., Springer, 1997, ISBN 3-540-61545-8 — https://link.springer.com/doi/10.1007/978-3-642-59223-2 (accessed 2026-10)
- [R2] Jacobs, E. N.; Ward, K. E.; Pinkerton, R. M. — *The Characteristics of 78 Related Airfoil Sections from Tests in the Variable-Density Wind Tunnel*, NACA Report No. 460 — NASA NTRS — https://ntrs.nasa.gov/api/citations/19930091108/downloads/19930091108.pdf (accessed 2026-10)
- [R3] Ladson, C. L.; Brooks, C. W. — *Development of a computer program to obtain ordinates for NACA 4-digit, 4-digit modified, 5-digit, and 16 series airfoils*, NASA TM X-3284, 1975 — NASA NTRS — https://ntrs.nasa.gov/search.jsp?R=19760003945 (accessed 2026-10). Companion 6/6A-series program: TM X-3069 — https://ntrs.nasa.gov/search.jsp?R=19740025318
- [R4] Ladson, C. L. et al. — *Computer Program To Obtain Ordinates for NACA Airfoils*, NASA TM 4741, 1996 — NASA NTRS — https://ntrs.nasa.gov/citations/19970008124 (accessed 2026-10)
- [R5] Mason, W. H. — *Appendix A: Geometry for Aerodynamicists* (Configuration Aerodynamics), Virginia Tech — https://archive.aoe.vt.edu/mason/Mason_f/ConfigAeroAppA.pdf (accessed 2026-10)
- [R6] Selig, M. — UIUC Airfoil Data Site / Coordinates Database — University of Illinois — https://m-selig.ae.illinois.edu/ads.html , https://m-selig.ae.illinois.edu/ads/coord_database.html (accessed 2026-10)
- [R7] Sharpe, P. — AeroSandbox (MIT licence), airfoil database mirror, commit edad83dd8bb6108dbb1b54aa76a6b34695844613 — https://github.com/peterdsharpe/AeroSandbox (accessed 2026-10)
- [R8] OpenVSP (NASA Open Source Agreement 1.3), commit 5240ef210f41c5d6aeed0ba7687f6fab0ca0cafb — https://github.com/OpenVSP/OpenVSP (accessed 2026-10)
- [R9] OpenVSP — *Using the API in OpenVSP* (Swept_Wing_API example, NACA TR-1208 wing) — https://github.com/OpenVSP/OpenVSP/blob/main/examples/vspaero_ex/Swept_Wing_API/README.md (accessed 2026-10)
- [R10] NACA TR-1208 — NASA NTRS — https://ntrs.nasa.gov/search.jsp?R=19930092218 (accessed 2026-10, record as linked by [R9])
- [R11] NASA Spinoff 2016 — *Open-Source Software Lets Users Design Aircraft* (OpenVSP) — https://spinoff.nasa.gov/Spinoff2016/pdf/t_6.pdf ; OpenVSP article — https://en.wikipedia.org/wiki/OpenVSP (accessed 2026-10)
- [R12] Open CASCADE Technology source, commit 3d097a0328e71b826377d4814ab05ec3c3d23871 (headers of GeomAPI_Interpolate, GeomAPI_PointsToBSplineSurface, BRepOffsetAPI_ThruSections, BRepOffsetAPI_MakePipeShell, BRepOffsetAPI_MakeFilling, BRepFill_Filling, GeomFill_BSplineCurves, GeomLProp_SLProps, LocalAnalysis_SurfaceContinuity, BRepBuilderAPI_Sewing, Geom_BSplineSurface, GeomAbs_Shape) — https://github.com/Open-Cascade-SAS/OCCT (accessed 2026-10)
- [R13] opencascade.js v1.1.1 (LGPL-2.1), README (OCCT V7_4_0p1) and `dist/Supported APIs.md` — https://github.com/donalffons/opencascade.js/tree/v1.1.1 (accessed 2026-10)
- [R14] NASA — Common Research Model geometry — https://www.nasa.gov/common_research_model/high-speed-crm/geometry/ ; original CAD files — https://commonresearchmodel.larc.nasa.gov/geometry/original-cad-files/ (accessed 2026-10)
- [R15] NASA — CRM experimental approach (wind-tunnel model reference values) — https://www.nasa.gov/common_research_model/high-speed-crm/experimental-approach/ (accessed 2026-10)
- [R16] *Evaluation of Aerodynamic Characteristics in Oscillatory Coning Using CFD Methods* (CRM full-scale reference values) — arXiv:2210.00304 — https://arxiv.org/pdf/2210.00304 (accessed 2026-10)
- [R17] *Global instability of wing shock buffet* (CRM AR 9, 35° sweep) — arXiv:1806.07299 — https://arxiv.org/pdf/1806.07299 (accessed 2026-10)
- [R18] Liming, R. A. — *Practical Analytic Geometry with Applications to Aircraft*, Macmillan, New York, 1944 — review: https://www.cambridge.org/core/journals/mathematical-gazette/article/abs/practical-analytic-geometry-with-application-to-aircraft-by-r-a-liming-pp-xvi-277-tables-and-index-25s-1944-macmillan/37492AB2938124DD5B435AF2E79B4826 ; catalogue: https://libcat.library.tamu.edu/Record/in00000622197 (accessed 2026-10)
- [R19] Liming, R. A. — *Conic Lofting of Streamline Bodies: The Basic Theory of a Phase of Analytic Geometry Applicable to Aircraft*, Aircraft Engineering 19(7), 1947 — Emerald — https://www.emerald.com/aeat/article-abstract/19/7/222/18777/Conic-Lofting-of-Streamline-BodiesThe-Basic-Theory (accessed 2026-10)
- [R20] Aviation CAD TechNotes — *NAA P-51D Mustang: Fuselage: Conics* (secondary) — https://aviationcadtechnotes.com/2015/08/03/naa-p-51d-mustang-fuselage-conics/ (accessed 2026-10)
- [R21] Lofting coordinates — https://en.wikipedia.org/wiki/Lofting_coordinates ; FAA-H-8083-31B *Aviation Maintenance Technician Handbook — Airframe* (summary) — https://sprinkle.com/regulations/faa/handbooks/aviation-maintenance-technician-handbook-airframe (accessed 2026-10)
- [R22] Robert McNeel & Associates — Rhino *Zebra* — https://docs.mcneel.com/rhino/6/help/en-us/commands/zebra.htm ; *Understanding surface continuity* — https://www.rhino3d.com/docs/guides/modeling/rhino-continuity-surfaces/ ; *Global Edge Continuity* — https://www.rhino3d.com/docs/guides/analysis/global-edge-continuity/ (accessed 2026-10)
- [R23] Siemens — *What does Geometric Continuity in NX mean, and how are they defined?* — https://support.sw.siemens.com/en-US/okba/PL7009817/What-does-Geometric-Continuity-in-NX-mean,-and-how-are-they-defined/index.html (accessed 2026-10)
- [R24] Dassault Systèmes — CATIA ICEM Surf — https://www.3ds.com/products-services/catia/products/icem-surf/add-on-modules (accessed 2026-10)
- [R25] Boeing — *Exhibit Gives First-Hand Look at How Computers Were Used to Build the 777 Airplane* (1997-07-11) — https://boeing.mediaroom.com/1997-07-11-Exhibit-Gives-First-Hand-Look-at-How-Computers-Were-Used-to-Build-the-777-Airplane ; IEEE Spectrum 1995 777 article — https://user.eng.umd.edu/~austin/enes489p/lecture-resources/IEEE-Spectrum-Boeing777-1995.pdf (accessed 2026-10)
- [R26] Torus Gaussian curvature K = cos v / (r (R + r cos v)) — Durham University solution sheet — https://www.maths.dur.ac.uk/users/norbert.peyerimhoff/riemgeom1011/sol6.pdf ; Wolfram|Alpha torus — https://wolframalpha.com/input?i=torus (accessed 2026-10)
- [R27] Sears–Haack body — https://en.wikipedia.org/wiki/Sears%E2%80%93Haack_body (accessed 2026-10)
