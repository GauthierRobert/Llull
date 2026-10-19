# SRF — Advanced freeform surfacing & aerodynamic geometry — Functional specification

Gap id: **SRF** · Folder: `docs/aerospace/02-advanced-surfacing/` · Status: specification (2026-10-15); M0–M3 built, see TECHNICAL_SPEC §13 ·
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
| Airfoil coordinate libraries | UIUC Airfoil Coordinates Database: chord-normalised `.dat` files in Selig (TE→upper→LE→lower→TE) or Lednicer (upper LE→TE, then lower LE→TE, counts on line 2) format | Universities, UAV/GA designers, OpenVSP, AeroSandbox | [R6] [R7] |
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

Operator model per [`../AGENT_FIRST.md`](../AGENT_FIRST.md): the **operator** is an AI agent driving the `llull`
CLI; the **owner** asks for a result in plain language and is not assumed to be an aerodynamicist or loftsman;
a **qualified reviewer** appears only when a surface is accepted for design release (OML release, tooling
release) or a quality waiver is decided.

| Role | Who | Uses | In this gap |
| --- | --- | --- | --- |
| Operator (primary) | AI agent (Claude Code or similar) | `llull` CLI (`--doc` headless or `--app`), MCP for cloud agents | Writes plans with `airfoil_from_naca`, `create_wing`, `loft_fuselage`, runs `check_surface_quality`, reads numeric `data`, renders PNGs, exports STEP |
| Owner | Person asking for "a swept wing with a NACA 23012 root" or "a smooth fairing" | Natural language; may watch the desktop app | States the intent, receives a plain-language summary and the files |
| Qualified reviewer (only for release) | OML / surface-quality authority, tooling engineer | Desktop app review overlays (zebra, curvature map), check report, 09 PLM approval | Accepts the OML for release, approves continuity waivers (human gate) |

User stories. The domain roles of the previous revision (aerodynamicist, loftsman, class-A, tooling,
structures, UAV designer) are now the owners or reviewers on whose behalf the agent works:

| # | Story | FR |
| --- | --- | --- |
| US-1 | As the operator, asked for "a wing with a NACA 23012 root", I call `airfoil_from_naca` (or `import_airfoil` on a `.dat` the owner supplied) and read `airfoil_properties` `data` (thickness, camber, LE radius, TE gap, with units) to confirm the section before building. | FR-SRF-10..13 |
| US-2 | As the operator, I build the wing from span, chords, sweep, dihedral and twist in one plan, then read `wing_properties` (area, AR, MAC with units) and report them to the owner in plain words. | FR-SRF-14..16 |
| US-3 | As the operator, I define a fuselage by FS/BL/WL stations with conic halves, loft it, and prove smoothness with numbers: `check_continuity` G0–G3 values per internal edge, not a zebra picture. | FR-SRF-17..19, 22 |
| US-4 | As the operator, I loft through sections with guide curves and read the per-section deviation in `data` to show the surface passes through the master lines. | FR-SRF-05 |
| US-5 | As the operator, I end every surface job with `check_surface_quality`; it returns pass/warn/fail with stable codes, the tolerances it used (named defaults), any `unverified` inputs, and `reviewRequired` when the result is meant for release. | FR-SRF-20..22, 39..43 |
| US-6 | As the operator, I measure the deviation of the rebuilt surface from a reference STEP or point CSV and report max/RMS with units. | FR-SRF-25 |
| US-7 | As the operator, I check draft against a pull direction for a mould and list the samples below the minimum draft. | FR-SRF-24 |
| US-8 | As the operator, I trim, sew and thicken skins into a solid and read free-edge counts and volumes. | FR-SRF-07..09 |
| US-9 | As the operator, I fill an N-sided hole with a G1 patch and read the achieved G0/G1 per boundary. | FR-SRF-06 |
| US-10 | As the owner, I get one sentence: what was built, what passed, what needs a qualified person. | FR-SRF-42, 44 |
| US-11 | As the qualified reviewer, I open the desktop app, look at the zebra / curvature overlays built on the same `data`, and approve or reject the release or a continuity waiver; the agent cannot do this for me. | FR-SRF-23, 43 |

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
| FR-SRF-20 | MUST | **Curve curvature** (numeric equivalent of the curvature comb, AF-21): curvature (and radius), curvature derivative, torsion at parameters/arc length, inflection count, plus comb vectors as data (sample points + comb vectors, scale) for any curve or edge; all in `data` with units (1/length unit, length unit). | Fairness check of sections/master lines without a picture. | [R1] [R22] |
| FR-SRF-21 | MUST | **Surface curvature** (numeric equivalent of curvature colour maps, AF-21) at (u,v) samples or a grid on a face: normal, k1, k2, principal directions, Gaussian K, mean H (sign convention documented), with min/max and their locations over the face; units in `data`. | Curvature maps as numbers; analytic checks. | [R12] GeomLProp_SLProps (max, min, mean, Gaussian) |
| FR-SRF-22 | MUST | **Continuity check** (numeric equivalent of zebra stripes and isophotes, AF-21) between two curves at a joint or two faces along a shared edge: G0 gap, G1 angle, G2 curvature gap (relative and absolute), G3 curvature-derivative gap; verdict per order against tolerances (given, or named defaults per FR-SRF-40); worst sample location. | Release criterion for OMLs. | [R12] LocalAnalysis_*Continuity (C0/G1/G2 values); [R23] (G3 definition) |
| FR-SRF-23 | COULD | **Visual review overlays** in the desktop app for the qualified reviewer: curvature comb, zebra stripes, isophote shading, curvature colour maps with legend & clamping. Built only from the `data` of FR-SRF-20..22 and 24 (the numeric equivalents are the requirement, AF-21); toggled per entity, never modifying the document. Agents see the same objects with `render_view … --save view.png` (AF-22). | The reviewer judges G1/G2 visually as in Rhino/NX. | [R22] |
| FR-SRF-24 | SHOULD | **Draft analysis** against a pull direction: per-sample draft angle (deg), area below a minimum draft, undercut samples, all in `data`; colour map only as a review overlay. | Mould/tooling for composite fairings. | [R12] (draft angle tools) |
| FR-SRF-25 | SHOULD | **Deviation**: distance from points (CSV/pinned scan) or another surface/solid to a face set: max, mean, RMS, signed (along normal), histogram and worst locations in `data` with units; pass/fail against a tolerance; colour map only as a review overlay. | Validate a rebuilt OML against reference (CRM STEP, scan). | [R12] BRepExtrema_DistShapeShape / ProjectPointOnSurf |

### 5.4 Surfaces of the product (CLI / MCP / UI)

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-SRF-26 | MUST | Every capability above is a registered command reachable from the `llull` CLI (`--doc` / `--app`, found by `llull search` / `describe`), MCP (toolsets `surface`, `aero`) and the UI, with agent-written descriptions (what, when, units, refusals, next command) and numeric `data` results. | Laws L1, L5, KI6; AF-01, AF-02. | `.claude/rules/architecture.md` |
| FR-SRF-27 | MUST | Surfaces and wings persist in the llull document with full recipe (degree/knots/weights/sections) and export to STEP as `B_SPLINE_SURFACE_WITH_KNOTS` / rational forms (via OCC) without tessellation. | Exchange fidelity. | KI5 decision |
| FR-SRF-28 | SHOULD | Code export (`export_code`) emits CadQuery equivalents (e.g. spline/loft) for the new commands where CadQuery has them, else the exact B-spline data. | Existing codegen parity (KI5). | — |
| FR-SRF-29 | SHOULD | Without the OCC kernel (Manifold/web), NURBS entities still display (core tessellation) and query commands that need only core math (curve curvature, airfoil, wing metrics) work; kernel-only operations no-op with the standard refusal. | Offline web mode stays usable (L6, L9). | KI5 |
| FR-SRF-30 | COULD | Import an OpenVSP `.vsp3` WingGeom (planform + XSec airfoil types NACA 4-series / AF file) into a llull wing. | Aero-tool interoperability. | [R8] |

### 5.5 Non-functional requirements

| Id | Pri | Requirement | Measure |
| --- | --- | --- | --- |
| FR-SRF-31 | MUST | Determinism: the same plan produces bit-identical document JSON (ids, poles, knots) on replay. | Golden replay equality (VC-SRF-19) |
| FR-SRF-32 | MUST | Units: airfoils are chord-normalised data; wings/bodies use document units; FS/BL/WL frame declares its unit and datum; no silent unit conversion. | Unit tests on `set_units` mm/in/m |
| FR-SRF-33 | MUST | Every refusal and check failure carries a stable code (TECHNICAL_SPEC §7.1, e.g. `AERO_AIRFOIL_TE_GAP`), the offending ids or param path, and a one-line remediation (e.g. "section 3: TE gap 0.02 c exceeds closed-TE tolerance — use `trailingEdge: open` or `normalize: chord`") (AF-11). | Failure tests per command; VC-SRF-31 |
| FR-SRF-34 | SHOULD | Analysis on large models stays interactive: see TECHNICAL_SPEC §8 budgets. | Perf tests |
| FR-SRF-35 | MUST | Results are agent-readable: every query returns compact, bounded numeric `data` with a documented shape, a unit on every number (`unit` field or name suffix), sample counts and worst locations; large grids are narrowed by ids / `grid` or written with `--save` (AF-10, AF-12). | Schema snapshot; VC-SRF-35 |
| FR-SRF-36 | MUST | Every physical param states its unit in its schema description: lengths in document units, angles in the unit named by the param (`sweepDeg`, `g1AngleRad`), airfoil data chord-normalised (AF-04). | `llull describe` audit; VC-SRF-35 |
| FR-SRF-37 | MUST | A whole gap job fits one `build_project` plan checked by `llull run plan.json --validate` before kernel work; validation errors name the step path and the param (AF-05). | VC-SRF-31 |
| FR-SRF-38 | SHOULD | `llull guide` and the MCP prompt gain an aero/surface section: FS/BL/WL axes and units, chord-normalised airfoils, the minimal wing plan, how to read continuity results (AF-03). | Guide snapshot |
| FR-SRF-39 | MUST | Read-only check command `check_surface_quality`: for given entities (or all surfaces) it returns pass / warn / fail findings with stable codes: continuity per internal edge (G0..G3 against tolerances), loft section deviation, free edges, degenerate samples, optional draft. An agent ends every surface job with it (AF-20, AF-30). | VC-SRF-33 |
| FR-SRF-40 | MUST | No silent tolerance: continuity, sewing and fidelity tolerances are given explicitly or taken from a named default that the result reports with its source, e.g. `{"value": 0.01, "unit": "rad", "source": "OCCT BRepOffsetAPI_MakeFilling TolAng default", "defaulted": true}` (AF-31). | VC-SRF-33 |
| FR-SRF-41 | MUST | Inputs without verified provenance (an imported `.dat` with no pinned source, a point cloud with no recorded origin) are flagged `unverified`. The flag propagates to every derived curve, wing, body and query result, and `check_surface_quality` reports it as a warning that cannot be suppressed (AF-32). Sections generated from the published NACA equations are not flagged. | VC-SRF-32 |
| FR-SRF-42 | MUST | A `check_surface_quality` run for release (`purpose: "release"`) and any OML acceptance result carry `reviewRequired: true` with the reason ("OML surface acceptance is a design-release decision: needs a qualified engineer"); the summary says so in plain words (AF-33, AF-36). | VC-SRF-33 |
| FR-SRF-43 | MUST | Waiving a failed continuity or deviation finding is a human gate. The agent may `request_surface_waiver` (pending record: code, edge, reason). Only an approval recorded through 09 PLM `record_approval` by a human caller (TR-PLM-16) turns it into an accepted waiver; until then the finding stays `fail` with `waiverStatus: "pending"` (AF-34). | VC-SRF-34 |
| FR-SRF-44 | MUST | Every computed value can be explained: `data.provenance` gives the method (e.g. "NACA 4-digit, Report 460 equations", "Piegl & Tiller A9.1", "OCC BRepLProp_SLProps"), the formula or standard id, and the inputs (ids, params, tolerances) (AF-35). | Schema snapshot; VC-SRF-32 |

## 6. Workflows

### 6.1 CLI (primary: the operator agent)

The complete job "wing from a NACA section, checked, rendered, exported", headless on a file:

```bash
llull search airfoil wing                      # finds airfoil_from_naca, import_airfoil, create_wing, wing_properties
llull describe create_wing                     # params with units (sweepDeg, chords in document units, ...)
llull guide                                    # aero section: axes, chord-normalised airfoils, minimal wing plan
# 1. plan file (validation/plans/target_naca0012_trap_wing.json):
#    set_units -> airfoil_from_naca -> create_wing -> mass_properties -> wing_properties
llull run wing.plan.json --validate --doc wing.llull.json --kernel occt          # names step path + param on error
llull run wing.plan.json --doc wing.llull.json --kernel occt --progress --json  # ids, data, durationMs per step
# 2. numbers, not pictures
llull wing_properties id=wing-3.1 --doc wing.llull.json --kernel occt --json    # data.areaRef, data.mac, data.unit
llull check_continuity '{"id":"wing-3.1","edges":"internal"}' --doc wing.llull.json --kernel occt --json
# 3. closing check: pass/warn/fail with codes, named default tolerances, unverified, reviewRequired
llull check_surface_quality '{"ids":["wing-3.1"]}' --doc wing.llull.json --kernel occt --json
# 4. look at it (multimodal agents)
llull render_view view=iso isolate=wing-3.1 --doc wing.llull.json --kernel occt --save out/wing.png
# 5. deliver
llull export_step_exact --doc wing.llull.json --kernel occt --save out/wing.step
llull export_code language=cadquery --doc wing.llull.json --save out/
```

An imported section: `llull import_airfoil file=naca23012.dat normalize=none --doc wing.llull.json` (file read
through the exchange path, KI6). A design change: `llull set_parameter name=sweep expression=35 --doc …`, then
steps 2–4 again. `--dry-run` tries a mutating command without writing the file (AF-42). Any refusal exits 1 with
a stable code (TECHNICAL_SPEC §7.1); the agent fixes the named param and re-validates.

Fuselage by stations (V1), same loop:

1. Plan: `set_units`, `set_aircraft_frame` (datum FS 0 / BL 0 / WL 0, +FS aft, +BL right, +WL up, unit stated),
   `loft_fuselage` with a station table (nose `point`, `conic` stations with upper/lower rho, `circle` or
   `superellipse` in the cabin, tail `point`) and optional control curves (`interpolate_curve` crown, keel and
   max-breadth lines), `continuity: "G2"` (see `validation/plans/target_sears_haack_conic_fuselage.json`).
2. `--validate`, run, `mass_properties`, `check_continuity edges=internal`, `analyze_surface_curvature grid=[50,50]`
   (flat spots and bumps as min/max K and H with locations), `fuselage_section_at fs=…` for frames.
3. `check_surface_quality purpose=release` returns `reviewRequired: true`; the agent reports the findings and
   hands the release to the qualified reviewer (FR-SRF-42, 43).
4. Edits in the history re-derive the body (L8); downstream trims follow `edgesNear` references (KI5) until
   persistent naming (gap 01).

### 6.2 MCP agent (cloud)

1. `search_tools airfoil wing continuity`, then `enable_toolset aero` and `enable_toolset surface`.
2. `build_project` with the same plan; read `data` of `wing_properties`, `check_continuity` and
   `check_surface_quality`.
3. Iterate: `set_parameter`, the history re-evaluates, re-query (L8).

### 6.3 UI (review and approval surface)

The desktop app shows what the agent built, live with `--app`. The qualified reviewer uses it to look at zebra
stripes, curvature maps and combs (FR-SRF-23, drawn from the same `data`), read the `check_surface_quality`
report, and approve a release or a waiver through 09 PLM (FR-SRF-43). Menus and dialogs exist for every command
because the UI iterates `listCommands()`, but no capability depends on them.

## 7. Acceptance criteria

Every criterion runs unattended as a CLI call with `--json` and an assertion against
`validation/expected_results.json` (value, tolerance, unit; field `cli` of each case gives the call and the JSON
path). `D` = `--doc t.llull.json --kernel occt --json`. Exit code 0 unless the case expects a refusal (exit 1).

| # | Given | When (CLI) | Then (JSON assertion) | VC |
| --- | --- | --- | --- | --- |
| AC-01 | pinned UIUC `naca0012.dat` | `llull airfoil_from_naca designation=0012 trailingEdge=open D`, then `measure_deviation` of the file points | `data.maxDeviation` ≤ **1e-6** (chord units) | VC-SRF-01 |
| AC-02 | pinned `naca23012.dat` | same with `designation=23012` | `data.maxDeviation` ≤ **2e-5** (5-decimal file rounding) | VC-SRF-02 |
| AC-03 | pinned `naca2412.dat` (Lednicer naca.exe) | `llull import_airfoil file=naca2412.dat normalize=chord D` vs `airfoil_from_naca 2412` | normalised `data.maxDeviation` ≤ **2e-4**; raw ≈ 1.29e-3 reported, not a failure | VC-SRF-03 |
| AC-04 | Selig and Lednicer sample files | `llull import_airfoil file=… D` | `data.format`, `data.pointCount`, `data.leIndex` match the file; `data.teGap` reported with unit | VC-SRF-04 |
| AC-05 | sphere R 10, cylinder R 5, torus 5/2 | `llull run plans/target_torus_surface_analysis.json D` | `data.samples[*].K`, `abs(H)` within 1e-6 rel of `data/curvature_analytic.json` (torus K abs 1e-6) | VC-SRF-05 |
| AC-06 | analytic joints (corner, line–arc, line–x³, line–x⁴, arc–arc) | `llull check_continuity pairs=[…] D` | `data.joints[*].order` = G0, G1, G2, G3, G3, G1 | VC-SRF-06 |
| AC-07 | conic rho = √2−1 | `llull create_conic … D` then `inspect_nurbs` | weight 0.70710678; radius error at 9 samples ≤ **1e-12** | VC-SRF-07 |
| AC-08 | TR-1208 planform | `llull run plans/target_tr1208_wing.json D` | `wing_properties` `data.areaRef` 2024.35 ± 0.01 in², `data.mac` 16.670 ± 0.005 in, `data.aspectRatio` 8.000 ± 0.03, `data.unit = "in"` | VC-SRF-10 |
| AC-09 | trapezoidal wing cr 2, ct 1, b/2 5 m, NACA 0012 open TE, linear loft | `llull run plans/target_naca0012_trap_wing.json D` | `mass_properties` `data.volume` 0.959117 m³ ± 1e-4 rel | VC-SRF-11 |
| AC-10 | NASA CRM STEP | import + `check_continuity edges=internal` + `analyze_surface_curvature` with `--timeout 60` | completes within budget; values recorded as golden (TBD on first run) | VC-SRF-12 |
| AC-11 | 19 Sears–Haack stations + nose/tail points | `llull run plans/target_sears_haack_conic_fuselage.json D` | `data.volume` within 0.5 % of 4.626377 | VC-SRF-13 |
| AC-12 | closed loop of 3, 4 and 5 boundary edges around a hole at a filleted box corner | `llull fill_surface … D` | `data.boundaries[*].g0Gap` ≤ 1e-4, `g1AngleRad` ≤ 0.01 | VC-SRF-15 |
| AC-13 | two lofted wing segments | `llull sew_surfaces makeSolid=true … D` | `data.freeEdges` = 0; volume = Σ segments ± 1e-6 rel | VC-SRF-16 |
| AC-14 | cone r1 5, r2 3, h 10 | `llull analyze_draft pullDirection=[0,0,1] … D` | lateral `data.samples[*].draftDeg` = 11.309932 ± 0.01 | VC-SRF-17 |
| AC-15 | sphere R 10 vs points on R 10.5 | `llull measure_deviation … D` | `data.max` = `data.mean` = 0.5 ± 1e-6 | VC-SRF-18 |
| AC-16 | any SRF plan | run through CLI, MCP `build_project` and UI dispatch | identical documents and `data` (replay equality) | VC-SRF-19 |
| AC-17 | a plan with a NACA designation `9999x` and a non-increasing span | `llull run bad.plan.json --validate D` / run | exit 1; `data.errors[*].code` ∈ {`AERO_NACA_DESIGNATION_UNKNOWN`, `AERO_SPAN_NOT_INCREASING`} with `path` and `remediation` | VC-SRF-31 |
| AC-18 | a wing built from an imported `.dat` with no pinned source | `wing_properties`, `mass_properties`, `check_surface_quality` | `data.unverified = true` on each; check has a non-suppressible warn `SRF_CHECK_INPUT_UNVERIFIED` | VC-SRF-32 |
| AC-19 | the NACA wing | `llull check_surface_quality '{"ids":["$wing"],"purpose":"release"}' D` | `data.status` pass/warn/fail with codes; `data.tolerances.g1AngleRad.defaulted = true` with `source`; `data.reviewRequired = true` with `reason` | VC-SRF-33 |
| AC-20 | a failing G2 finding and an agent-requested waiver | `request_surface_waiver`, then 09 `record_approval` as agent caller | approval refused (TR-PLM-16); check still `fail` with `waiverStatus: "pending"` | VC-SRF-34 |
| AC-21 | every SRF command | `llull describe <command> --json` | every numeric param has a unit in its description; every query result field has a unit or suffix | VC-SRF-35 |

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
| Agent success | `build_project` plans in `validation/plans/target_*.json` run unchanged; an agent driver runs every VC from the CLI with `--json` and exit codes only, no UI (AF-23) |
| Self-check coverage | every agent surface job ends with `check_surface_quality`; 100 % of refusals carry a code from TECHNICAL_SPEC §7.1 |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| --- | --- | --- |
| opencascade.js 1.1.1 (OCCT V7_4_0p1) does **not** bind `GeomAPI_Interpolate` and `GeomFill_NSections`; `MakePipeShell.Build` is already known unusable in llull's build | MVP interpolation and guided sweeps blocked in WASM | Core-side interpolation (Piegl & Tiller A9.1) producing poles/knots fed to `Geom_BSplineCurve` (bound); custom opencascade.js build (gap 01 KRN) |
| Topological naming instability after edits (KI5) | Continuity/trim references break | Name sections and edges via recipe ids + `edgesNear` fallback; gap 01 persistent naming |
| UIUC licence not stated on the pages reachable during research | Cannot redistribute `.dat` files | Pin URL + sha256 only; tests download on demand or use generated data |
| Lednicer files with differing normalisation (VC-SRF-03) | False failures | Explicit `normalize` option and tolerance per file |
| G2/G3 measured numerically is noise-sensitive near degenerate points (LE, poles) | Spurious failures | Relative + absolute thresholds, skip degenerate samples, report sample counts |
| No authoritative aerospace continuity standard was found | Tolerance defaults may be contested | Defaults from OCC filling defaults (TolAng 0.01 rad, TolCurv 0.1), configurable, and always named in results with `defaulted: true` (FR-SRF-40) |
| The operator is an agent and the owner is not a surface specialist | A marginal surface is reported as "done" | `check_surface_quality` ends every job; failures and unverified inputs cannot be hidden; release results carry `reviewRequired`; waivers need a human approval (FR-SRF-39..43) |
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
