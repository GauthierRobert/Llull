# SWG — Advanced sweep & loft (guides, laws, orientation, helices, networks, ruled surfaces) — Functional specification

Gap id: **SWG** · Folder: `docs/design/02-sweep-loft-guides/` · Status: specification (2026-10-22) · Track: "design anything" (freeform design) ·
Companion: [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Builds on: **aerospace 02 SRF** ([`../../aerospace/02-advanced-surfacing/`](../../aerospace/02-advanced-surfacing/FUNCTIONAL_SPEC.md): NURBS curves and
sheets, `loft_surface` with Gordon guides, continuity / curvature analysis, `check_surface_quality` — all built, SRF TECHNICAL_SPEC §13) ·
Neighbours: **DEF** (01, whole-body twist / taper / bend), **WRP** (03, curves on faces, flattening), **BLD** (06, blends), **MSH** (07).

---

## 1. Summary

A sweep (a section moved along a path) and a loft (a surface through ordered sections) are the two workhorses of freeform mechanical
design: springs, threads, handles, ducts, hoses, blades, bottles, hulls, ergonomic grips, twisted vanes. Every mainstream CAD system
controls them with **orientation modes** (how the section turns along the path), **laws** (twist and scale as functions of the path
parameter), **guide curves / rails** (curves the section must touch, which scale, stretch or orient it), **start / end conditions**
(tangency or curvature at the end sections), **centrelines**, **section coupling** and **network surfaces** through two families of
curves. llull today has the bare minimum:

- `sweep_profile` (`packages/core/src/commands/solids/sweep.ts`) carries a closed section along a G1 path with **one** orientation
  (a rotation-minimizing frame), no twist, no scale law (only `stations` blended with a fixed smoothstep), **no guide curve**, a path
  that must be a list of points or a **2D** sketch curve (a 3D `nurbs_curve` cannot be a path), and only solids (no swept sheet).
- `loft_sections` / `loft_surface` skin through sections; `loft_surface` (SRF) accepts guide curves (Gordon surface), but there are
  **no start/end tangency or curvature conditions, no centreline, no twist control or seam alignment of exact sections, no coupling
  of sections with different corner counts, no closed (periodic) loft**, and `loft_sections` (solids) has no guides at all.
- `add_coil` approximates its helix with a Catmull-Rom spline through 16 points per turn: measured by the pack's reference script, the
  centre line is up to **0.23 mm off a 20 mm-radius helix (1.2 % of R) at the end segments**, 0.011 mm in the interior
  (`validation/data/coilBaseline.json`); the rectangular wire is a triangle mesh with no exact B-rep. There is **no helix / spiral
  curve** an agent can sweep anything else along (a thread form, a spring with ground ends, a volute).
- There is **no ruled surface between two arbitrary curves, no developable surface**, no network surface from an unsorted curve set.

This pack specifies these capabilities on the CLI-agent path so that an agent can be asked "a twisted, tapered vane along this arc",
"a handle whose section follows two rails", "a variable-pitch spring", "a bottle lofted with tangent shoulders" or "a developable duct
transition" and get an exact, checked result.

## 2. Industry context & value

### 2.1 How the benchmark systems do it

| Capability | SolidWorks | CATIA V5/3DX (GSD) | Siemens NX | Creo | Fusion 360 | Onshape | Rhino | OCCT (llull's kernel) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Orientation modes | Profile orientation *Follow Path* / *Keep Normal Constant*; profile twist *None, Minimum Twist* (3D paths), *Follow Path and First Guide Curve*, *Follow First and Second Guide Curves*, *Specify Twist Value* (degrees, radians, turns; closed paths need a multiple of a full turn), *Specify Direction Vector*, *Tangent to Adjacent Faces* [R18] | explicit profile sweep sub-types *with reference surface*, *with two guide curves*, *with pulling direction*; optional spine; angle law on the reference surface [R21] | orientation method (fixed, face normals, vector, another curve, point, angular law, forced direction) applies with ONE guide [R20] | *Normal To Trajectory*, *Normal To Projection*, *Constant Normal Direction* [R17] | Orientation *Perpendicular* / *Parallel* (single path), *Path + Guide Surface* (twist relative to the surface normal) [R15] | Profile control *None, Keep profile orientation, Lock profile faces, Lock profile direction* [R12] | Sweep1 frame *Freeform* (keeps its angle to the rail), *Roadlike* (axis), *Align with surface* [R7] | `GeomFill_Trihedron`: CorrectedFrenet, Fixed, Frenet, ConstantNormal, Darboux, GuideAC, GuidePlan (± contact), Discrete [R4]; `MakePipeShell::SetMode` overloads [R1] |
| Twist law | angle / turns, linear [R18] | angle law (constant, linear, …) [R21] | angular law [R20] | `trajpar` relations on any section dimension [R17] | Twist Angle [R15] | Twist by *Turns, Angle, Pitch* [R12] | via rails | none directly; auxiliary spine (normal = vector PQ) [R1] [R3] |
| Scale / area law | via guides | area law in multi-sections [R22] | scaling method (constant, blending function, another curve, point, area / perimeter law) [R20] | `trajpar` relations [R17] | Taper Angle; Profile Scaling *Scale / Stretch / None* with a rail [R15] | Scale factor at the end [R12] | Sweep2 *Maintain height* [R8] | `SetLaw(profile, Law_Function)` homothetic law [R1]; `Law_Interpol` [R5] |
| Guide curves / rails | guide curves for sweep and loft [R18] [R19] | one or two guides, fitting / anchor points; auto-computed anchors fail for a planar profile off the spine plane (IBM permanent restriction) [R21] [R23] | 1–3 guide strings, up to 150 section strings, alignment, spine [R20] | origin + extra trajectories [R17] | Path + Guide Rail [R15] | loft guides with continuity [R13] | Sweep2 (two rails), rail continuity *Position / Tangency / Curvature*, *Preserve first/last cross section*, *Add slash* [R8] | auxiliary spine with `BRepFill_NoContact / Contact / ContactOnBorder` [R3] |
| Loft end conditions | *Default, None, Direction Vector, Normal to Profile, Tangency to Face, Curvature to Face*; draft angle; tangent length [R19] | start/end section tangent surfaces; coupling *ratio, tangency, tangency then curvature, vertices*; closing points; spine [R22] | Through Curves first/last continuity [R20] | — (not verified) | — (not verified) | *Normal to profile, Tangent to profile, Match tangent, Match curvature*, *Normal / Tangent direction*, magnitude [R13] | *Match start / end tangent*, *Point* ends, styles *Loose / Normal / Tight / Straight sections / Uniform*, seam adjustment [R10] | `ThruSections`: ruled or smoothed, `pres3d` 1e-6, `AddVertex` only first/last, `CheckCompatibility` against twist [R2]; **no end-tangency API** |
| Centreline loft | centerline + number of sections [R19] | spine [R22] | spine [R20] | — | — | *Path* + section count [R13] | — | — |
| Network surface | boundary surface (not verified) | — (not verified) | *Through Curve Mesh*: primary + cross curves, spine, emphasis, end continuity [R20] | — | — | — | *NetworkSrf*: edge / interior / angle tolerance, edge matching *Loose / Position / Tangency / Curvature*; "curves in one direction must cross all curves in the other direction" [R9] | Gordon surfaces built on OCCT by TiGL (DLR) [R24] |
| Helix / spiral | helix & spiral curve (not verified) | — | — | helical sweep (not verified) | *Coil*: Revolution & Height / Revolution & Pitch / Height & Pitch / **Spiral**, taper angle, circular / square / triangular sections, section position inside / on / outside [R16] | *Helix*: axis / cylinder-cone / circle, turns / pitch / turns and pitch, clockwise / counter-clockwise, start angle [R14] | — | exact helix = 2D line on a cylindrical / conical surface (CadQuery `makeHelix`) [R28] |
| Ruled / developable | ruled surface (not verified) | — | — | — | — | — | *DevLoft*: one developable surface between two curves, unrollable [R11] | — |

Known limits recorded by the vendors themselves: SolidWorks requires twist values on closed paths to be whole turns [R18]; CATIA's
two-guide sweep cannot follow the second guide when anchors are auto-computed for a planar profile not in the spine plane [R23];
Onshape's loft *Path* option does not accept non-planar profiles [R13]; Rhino's NetworkSrf needs every curve of one direction to
cross every curve of the other [R9]; Fusion ignores Taper Angle when a guide rail or surface is given (API reference, search extract)
[R15 note]; OCCT's `ThruSections` has no tangency control at the end sections and a vertex section only first or last [R2].

### 2.2 What "design anything" means here

The best of the benchmark is: **any orientation mode + any twist / scale / area law + 0–2 rails + start/end conditions + exact helices +
network and ruled surfaces**, with numbers (not a preview) to prove the result. llull should match that union on the CLI-agent path,
and add what an agent needs and a GUI user gets by eye: frames, twist and scale **as data** at every sample, a self-intersection
check, and stable refusal codes.

### 2.3 Value

| Use case | Today | With SWG |
| --- | --- | --- |
| Springs, coils, threads, worm gears, volutes | `add_coil` (spline-approximated helix, mesh flat wire), `add_external_thread` (ISO metric only) | exact helix / spiral curves (`add_helix`), any section swept in the axial plane (screw sweep) or normal to the helix, variable pitch, ground ends |
| Twisted / tapered vanes, drill flutes, twisted bars, decorative columns | not possible (no twist law) | twist + scale law on any path, volume provable (`A L` invariance) |
| Handles, grips, hoses, bottle necks, hull strakes defined by rails | not possible (no rail) | 1- and 2-rail sweeps (scale / stretch / orient), rails exactly on the surface edges |
| Bottles, nozzles, fairings with tangent shoulders | loft without end conditions (shoulders kink or bulge) | normal / direction / tangent-to-face / curvature-to-face end conditions with magnitude |
| Ducts, transitions, sheet-metal-like ruled parts | only ruled two-section lofts of compatible curves | ruled surface between any two curves (parameter, arc length, developable), Gaussian curvature as a number |
| Organic class surfaces from a curve net | `loft_surface` with ordered guides (Gordon) | network surface from an unsorted curve set with edge matching to neighbours |

## 3. Personas & user stories

Operator model per [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md): the **operator** is an AI agent on the `llull` CLI, the
**owner** describes a shape in plain words and is not assumed to know what a Frenet frame is, and there is **no qualified-reviewer gate**
in this pack (sweeps and lofts are geometry, not certification evidence); a reviewer appears only through other packs (SRF release,
09 PLM).

| # | Story | FR |
| --- | --- | --- |
| US-1 | As the operator, asked for "a square bar twisted 90° over 100 mm", I call `sweep_profile` with a straight path and `twist: {type:'linear', start:0, end:1.5708}` and prove it with `mass_properties` = side² × L. | FR-SWG-01, 02, 05 |
| US-2 | As the operator, I sweep a section along a 3D `nurbs_curve` path with `orientation.mode` = `fixed`, `frenet`, `minimal`, `binormal` or `surface` and read the frames back from `inspect_sweep` to explain the choice. | FR-SWG-01, 03, 04, 22 |
| US-3 | As the operator, I make a handle whose width follows two rails (`guideIds`, `guideMode: 'scale' \| 'stretch'`) and verify the rails lie on the surface within tolerance. | FR-SWG-08..11 |
| US-4 | As the operator, I create an exact helix or spiral (`add_helix`) and sweep a thread / spring section along it in the axial plane; the volume equals 2π n A r̄ whatever the pitch. | FR-SWG-13..16 |
| US-5 | As the operator, I loft a bottle through sections with `startCondition: {type:'normal', magnitude:1}` and `endCondition: {type:'tangent_to_face', …}` and read the achieved end angles. | FR-SWG-17, 18 |
| US-6 | As the operator, I loft along a centreline, align seams or couple sections with different corner counts, and close the loft back to its first section. | FR-SWG-19..21 |
| US-7 | As the operator, I build a network surface from an unsorted set of crossing curves and match its edges G1 to neighbouring sheets. | FR-SWG-24, 25 |
| US-8 | As the operator, I make a ruled or developable surface between two curves and read its max \|K\| to tell the owner whether it can be bent from flat sheet. | FR-SWG-26, 27 |
| US-9 | As the operator, I end every sweep / loft job with `check_sweep_loft`: self-intersection, guide containment, end conditions, twist detection, law–volume consistency, with stable codes. | FR-SWG-28..31 |
| US-10 | As the owner, I get one sentence: what was built, its key numbers, what was approximated and by how much. | FR-SWG-35 |

## 4. Scope / out of scope

### 4.1 Phases

| Phase | Content |
| --- | --- |
| **MVP** (laws and orientation, exact helix) | `sweep_profile` v2: 3D curve paths (`nurbs_curve`, helix), orientation modes `minimal` (today's RMF, default), `frenet`, `fixed`, `binormal`, `axis_plane`; twist law, scale law, area law, station blend law (`linear` / `smooth`); `add_helix` (cylindrical, conical, planar spiral, variable pitch); `add_coil` v2 on the exact helix; `inspect_sweep` query; `check_sweep_loft` (sweep part); stable `SWG_*` codes. |
| **V1** (rails, sheets, loft conditions) | 1- and 2-rail sweeps (`orient`, `scale`, `stretch`, `contact`); orientation `surface`; `sweep_surface` (sheet, open or closed section); loft start / end conditions (free, normal, direction, tangent-to-face, curvature-to-face, point) on `loft_sections` and `loft_surface`; seam alignment and twist control of exact sections; closed loft; guides on `loft_sections` (solid Gordon); `ruled_surface` (parameter, arc length). |
| **V2** (networks, developable, coupling) | `network_surface` (unsorted curves, edge matching G0/G1/G2); centreline loft; vertex coupling of sections with different corner counts; `ruled_surface` mode `developable`; native `MakePipeShell` fast path; CadQuery export of law / rail sweeps. |

### 4.2 Out of scope (and where it lives)

- Whole-body twist / taper / bend / flow-along-curve of an existing solid → **01 DEF**. SWG twists the *section* while sweeping.
- Wrapping / projecting curves onto faces, unrolling a developable surface to a flat pattern → **03 WRP** (SWG only reports `K` and
  developability).
- Variable-radius fillets and blends → **06 BLD**; `blend_surfaces` (SRF) stays as built.
- NURBS entity model, Gordon algorithm, continuity / curvature analysis, `check_surface_quality` → **SRF** (built; reused, not re-specified).
- Physical spring rates and thread standards beyond geometry (`add_spring` in `@dynamics`, `add_external_thread`) — unchanged.

## 5. Functional requirements

Priority: MUST = MVP, SHOULD = V1, COULD = V2. Every FR maps to ≥ 1 VC in `validation/README.md` §3.

### 5.1 Sweep orientation and laws

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-SWG-01 | MUST | A sweep path may be any 3D curve entity: `nurbs_curve` (incl. helices of FR-SWG-13), a 2D sketch curve (as today), inline points, or a chain of edges given by id; the path must be G1 (or corners handled per FR-SWG-07). | 3D curves exist since SRF but cannot be swept along today. | `sketchCurves.ts` accepts only 2D kinds |
| FR-SWG-02 | MUST | **Twist law** φ(t) (radians) about the path tangent, as constant, linear, S-curve, cubic table of (t, value) pairs with optional end slopes, or an expression in `t` (the existing parametric expression grammar); shorthand `twistTurns`. On a closed path the total twist must be a whole number of turns (or of the section's rotational symmetry) — else refused. | SolidWorks / Onshape / CATIA twist; closed-path rule as in SolidWorks. | [R18] [R12] [R21] [R5] |
| FR-SWG-03 | MUST | **Orientation modes**: `minimal` (rotation-minimizing, default — today's behaviour, bit-identical for existing documents), `frenet`, `fixed` (section stays parallel to its start plane), `binormal` (constant angle to a given direction), `axis_plane` (section kept in the plane through a given axis, i.e. a screw sweep), `surface` (section normal follows a reference surface's normal; V1), `guide` (orientation from a rail, FR-SWG-08). | Union of the benchmark orientation options. | [R1] [R4] [R7] [R12] [R15] [R17] [R18] |
| FR-SWG-04 | MUST | Every orientation mode refuses its degenerate cases with a code instead of flipping silently: Frenet on a straight run or at an inflection, `binormal` / `fixed` with the tangent parallel to the reference direction, `surface` with a path that leaves the surface. | A silent frame flip twists the solid; agents cannot see it. | OCCT `GetStatus` values [R1] |
| FR-SWG-05 | MUST | **Scale law** s(t) > 0 (uniform scale of the section about the path point) and, alternatively, **area law** A(t) (scale = √(A(t)/A₀)); same law types as FR-SWG-02; `stretchX` / `stretchY` laws for non-uniform scale (V1). | SolidWorks / NX / CATIA area and scale laws; Fusion taper. | [R20] [R22] [R15] [R1] |
| FR-SWG-06 | MUST | `stations` (variable section, today) gain `blend: 'smooth'` (today's smoothstep, default) or `'linear'`; the summary and `inspect_sweep` state which. Today the smoothstep is only evaluated at path frames, so the section law depends on how the path is tessellated: on a straight 1-segment path a 10 → 5 taper comes out as the frustum (measured 18 310.743 mm³ display mesh, −0.083 %), on a path with interior frames it bulges towards the smoothstep value (+1.63 %, `scale.json`). The law must be explicit and independent of the path — an agent asking for "a cone" must get one. | Silent non-linear default. | measured: VC-SWG-11 |
| FR-SWG-07 | SHOULD | Path corners (G0 joints) are either refused (today) or handled by `corners: 'round' \| 'miter' \| 'transformed'` (round = bend of `bendRadius`, as today for point paths). | OCCT transition modes Transformed / RightCorner / RoundCorner. | [R1] |

### 5.2 Guides and rails

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-SWG-08 | SHOULD | **One-rail sweep**: `guideIds: [rail]` with `guideMode` `orient` (rail sets the twist: the section keeps its angle to the vector path → rail), `scale` (uniform scale so the section anchor stays on the rail), `stretch` (scale along path → rail only), `contact` (section keeps its size and touches the rail). | SolidWorks *Follow path and first guide*, Fusion *Path + Guide Rail* Scale / Stretch / None, OCCT NoContact / Contact / ContactOnBorder. | [R18] [R15] [R3] |
| FR-SWG-09 | SHOULD | **Two-rail sweep**: `guideIds: [rail1, rail2]`, the section maps its two anchor points onto the rails at every station (`scale` uniform, or `maintainHeight` = stretch along the rail chord only); optional path / spine (default: the rail midline); `preserveFirst` / `preserveLast`; rails stay exactly on the surface boundary. | Rhino Sweep2, SolidWorks two guides, CATIA two guides. | [R8] [R18] [R21] |
| FR-SWG-10 | SHOULD | Section **anchor points** are explicit (`anchors: [[x,y],[x,y]]` in section coordinates) or derived from where the section meets the rails, never guessed from a plane intersection that cannot exist; when they cannot be found the command refuses with `SWG_GUIDE_ANCHOR_UNDEFINED`. | The CATIA auto-anchor restriction [R23]; OCCT `PlaneNotIntersectGuide`. | [R23] [R1] |
| FR-SWG-11 | SHOULD | After every rail sweep the distance from each rail to the result is measured and reported (`data.railDeviation[]`, document units); above tolerance → refusal. | Agent proof that "the surface follows the rail". | Rhino edge tolerance [R9] |
| FR-SWG-12 | SHOULD | `sweep_surface`: the same definition as `sweep_profile` but an open or closed section **curve** (not a closed area) gives an open `nurbs_surface` sheet (exact where the geometry is representable, else fitted with reported deviation), so swept sheets feed SRF trim / sew / thicken / continuity tools. | SRF lists `sweep_surface` (V1) unbuilt; SWG owns it now. | SRF TECHNICAL §4.1 |

### 5.3 Helices, spirals, coils

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-SWG-13 | MUST | `add_helix` creates a helix / spiral curve: axis (position, direction), start radius, any two of pitch / turns / height, handedness, start angle; `endRadius` or `taperDeg` (conical); `type: 'spiral'` (planar, radial pitch); pitch law (variable pitch, e.g. closed spring ends). Stored as design intent (the parameters), with a NURBS approximation within 1e-6 × R for display and core math. | Fusion Coil / Onshape Helix options. | [R14] [R16] |
| FR-SWG-14 | MUST | The exact kernel builds the helix exactly (a straight line in the (u, v) parameter plane of a cylindrical or conical surface), not from the NURBS approximation. | Exact threads and springs; CadQuery uses this construction. | [R28] |
| FR-SWG-15 | MUST | `add_coil` v2 sweeps along the exact helix of FR-SWG-13 (round wire) and makes the rectangular wire an exact `axis_plane` sweep with a B-rep instead of a triangle mesh; existing documents keep their stored geometry (no silent change on load). | Today's helix deviates up to 1.2 % of R at the end turns (`coilBaseline.json`). | measured: VC-SWG-08 |
| FR-SWG-16 | MUST | Helical sweeps refuse self-intersection: local (section extent ≥ radius of curvature R + c²/R) and global (section axial extent ≥ pitch for an axial-plane sweep; sampled turn-to-turn distance for a normal sweep) with `SWG_SELF_INTERSECTION_LOCAL` / `SWG_SELF_INTERSECTION_GLOBAL`. | `add_coil` already refuses the global case; extend to every sweep. | helix curvature, `helical.json` |

### 5.4 Loft extensions

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-SWG-17 | SHOULD | `startCondition` / `endCondition` on `loft_sections` and `loft_surface`: `free` (default, today), `normal` (tangent along the section plane normal), `direction` (a given vector), `tangent_to_face` / `curvature_to_face` (G1 / G2 to an adjacent face or sheet the section lies on), `point` (apex). `magnitude` (dimensionless, 1 = natural: derivative length equal to the distance between the first two section centroids) and an optional `draftDeg` for `normal` / `direction`. | SolidWorks / Onshape / Rhino end conditions; ThruSections cannot do it. | [R19] [R13] [R10] [R2] |
| FR-SWG-18 | SHOULD | The achieved end conditions are measured and reported: angle between the surface's cross derivative and the requested direction (rad), G1 / G2 gaps to the adjacent face (reusing SRF `check_continuity`). | Numbers, not a preview (AF-21). | SRF FR-SRF-22 |
| FR-SWG-19 | SHOULD | **Seam alignment and twist control** for exact (NURBS) sections: `alignment: 'auto'` (closest start points, orientation fixed), `'none'` (as given: a deliberate twist), or explicit `seams` (one parameter or point per section); closed sections are re-seamed exactly (knot insertion), never resampled. Twisted rulings are measured (`data.maxRulingTwistRad`). | SRF §13.3: exact sections are not re-aligned today; OCCT `CheckCompatibility`; Rhino seam adjustment. | [R2] [R10] |
| FR-SWG-20 | COULD | **Coupling** of sections with different numbers of corners / spans: `coupling: 'parameter' \| 'arc_length' \| 'vertices'` with explicit `vertexPairs`; sharp corners map to sharp corners (a B-rep edge along the loft). | CATIA coupling modes; today the exact loft refuses mismatched span counts. | [R22] |
| FR-SWG-21 | SHOULD | **Closed loft** (`closed: true`): the loft continues from the last section back to the first, periodic in v. **Centreline loft** (COULD): `centerlineId` + `sectionCount`; intermediate sections are placed in planes normal to the centreline. | Rhino closed loft; SolidWorks centreline; CATIA spine; Onshape path. | [R10] [R19] [R22] [R13] |
| FR-SWG-22 | SHOULD | `loft_sections` accepts `guideIds` (solid Gordon loft: the SRF `loft_surface` network, capped and sewn into a solid). | SRF FR-SRF-05 solids part, not built. | SRF §13.5 |

### 5.5 Network, ruled and developable surfaces

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-SWG-23 | SHOULD | The station blend of variable sections (FR-SWG-06) and the law types (FR-SWG-02/05) are one shared `law` vocabulary across `sweep_profile`, `sweep_surface`, `add_helix` (pitch) and loft `areaLaw` (COULD). | One concept for the agent to learn. | — |
| FR-SWG-24 | COULD | `network_surface`: from an **unsorted** set of curves, sort into two families (every curve of one family crosses every curve of the other, within tolerance), build a Gordon surface (SRF algorithm), report family assignment, crossing gaps and deviation; refuse unsortable sets. | Rhino NetworkSrf, NX Through Curve Mesh. | [R9] [R20] [R24] |
| FR-SWG-25 | COULD | Network / loft boundary **edge matching**: per boundary `G0 \| G1 \| G2` to a named neighbour sheet, with `edgeTolerance`, `angleTolerance`; achieved values reported. | Rhino edge matching; NX end continuity. | [R9] [R20] |
| FR-SWG-26 | SHOULD | `ruled_surface` between two curves or a curve and a point: `coupling: 'parameter'` (equal parameter), `'arc_length'` (equal arc-length fraction); result a degree-1-in-v sheet; reports area and max \|K\|. | Ruled surfaces are the basis of ducts, blades, hulls. | — |
| FR-SWG-27 | COULD | `ruled_surface` `coupling: 'developable'`: rulings chosen so the surface is developable (tangent plane constant along each ruling); reports max \|K\| (≈ 0) and refuses with `SWG_NOT_DEVELOPABLE` when no developable ruling exists between the curves. | Rhino DevLoft. | [R11] |

### 5.6 Analysis and self-check

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-SWG-28 | MUST | `inspect_sweep` (query): for a sweep / swept sheet / loft returns per sample `t`, arc length, point, tangent, normal, binormal, applied twist (rad) and scale, curvature radius of the path, section extent, `margin = curvatureRadius / extent`; plus totals (path length, total twist relative to the RMF and to Frenet, law integral ∫A ds). | Numeric equivalent of "Show sections" / preview (AF-21). | [R1] `Simulate` |
| FR-SWG-29 | MUST | `check_sweep_loft` (read-only check, AF-20): pass / warn / fail findings with stable codes for local and global self-intersection, degenerate frames, rail deviation, end-condition attainment, loft twist (seam mismatch, ruling twist), section fidelity (reusing SRF), and law–volume consistency (solid volume vs ∫A(s) ds when the centroid stays on the path). | The agent proves its own work. | AF-20 |
| FR-SWG-30 | MUST | No silent tolerance: fit tolerance, rail tolerance, self-intersection margin, end-angle tolerance are given or taken from named defaults reported with their source and `defaulted: true` (AF-31). | | AF-31 |
| FR-SWG-31 | MUST | Approximations are labelled: a law or rail realised by fitting (expression laws, helix NURBS display curve, fitted swept sheets) reports its max deviation; when above the requested tolerance the result is refused (`SWG_FIT_TOLERANCE`), never silently kept. | Agents cannot see a 1 % error. | AF-32 spirit |

### 5.7 Surfaces of the product and non-functional

| Id | Pri | Requirement | Measure |
| --- | --- | --- | --- |
| FR-SWG-32 | MUST | Every capability is a registered command reachable from the `llull` CLI (`--doc` / `--app`), found by `llull search sweep twist rail helix loft tangent`, with agent-written descriptions (what, when, units, refusals, next command); toolset `3d`. | VC-SWG-30 |
| FR-SWG-33 | MUST | Parametric: all params are design intent (laws, angles, ids of curves), never agent-computed point lists of the result; editing a rail, a law value or a helix pitch through the history re-derives the sweep with the same ids (L8). | VC-SWG-31 |
| FR-SWG-34 | MUST | Units: lengths in document units, angles in radians unless the param name says `Deg`; law values carry the unit of the quantity they drive (twist rad, scale dimensionless, area unit²); `t` is the path fraction 0..1 by arc length unless `parameter: 'arc_length'` (document units). | `llull describe` audit, VC-SWG-30 |
| FR-SWG-35 | MUST | Results are agent-readable: `data` with path length, section area, law integrals, analytic volume when one exists (like `add_coil`'s `analyticVolume`), approximation deviations, `provenance` (method, kernel path: exact / fitted / mesh). Summary in plain words. | VC-SWG-30 |
| FR-SWG-36 | MUST | Backward compatibility: existing `sweep_profile`, `loft_sections`, `loft_surface`, `add_coil` documents and plans load and evaluate unchanged (no new param = today's geometry, bit-identical ids and rings). | golden replay, VC-SWG-31 |
| FR-SWG-37 | MUST | Without the exact kernel (Manifold), every sweep / loft of this pack still displays and gives a mesh volume (same frames and laws), and `inspect_sweep` / `check_sweep_loft` work on core math; only exact-B-rep-only steps refuse with the standard kernel refusal. | VC-SWG-32 |
| FR-SWG-38 | SHOULD | Performance (desktop): a law sweep with 2 000 frame samples ≤ 300 ms in TS; `check_sweep_loft` on a 10-turn helical sweep ≤ 1 s; exact solid of a twisted sweep ≤ 2 s on the native kernel. | TECHNICAL §8 |

## 6. Workflows

### 6.1 CLI (primary)

A twisted, tapered vane on an arc, checked, rendered, exported (headless on a file):

```bash
llull search sweep twist                      # sweep_profile, sweep_surface, inspect_sweep, check_sweep_loft
llull describe sweep_profile                  # orientation modes, law shapes, units
llull run plans/target_twist_scale_orientation.json --validate --doc v.llull.json --kernel occt
llull run plans/target_twist_scale_orientation.json --doc v.llull.json --kernel occt --json
llull inspect_sweep id=$vane samples=21 --doc v.llull.json --json        # frames, twist, scale, curvature margin per sample
llull mass_properties entityId=$vane --doc v.llull.json --kernel occt --json   # == data.analyticVolume of the sweep
llull check_sweep_loft '{"ids":["$vane"]}' --doc v.llull.json --kernel occt --json
llull render_view view=iso isolate=$vane --doc v.llull.json --save out/vane.png
llull export_step_ap242 --doc v.llull.json --kernel occt --save out/vane.step
```

A spring with ground ends: `add_helix` (pitch law: wire diameter on the first and last turn), `sweep_profile pathId=$helix radius=…`,
`check_sweep_loft` (global self-intersection = turns touching), `mass_properties`. A bottle: `interpolate_curve` / `create_conic`
sections, `loft_sections` with `startCondition {type:'normal'}` and `endCondition {type:'tangent_to_face', …}`, `check_sweep_loft`
(end angles), SRF `check_continuity` against the neck. Any refusal exits 1 with a `SWG_*` code, the param path and a remediation.

### 6.2 UI (review surface)

The desktop app shows the result live with `--app`. Sweep and loft dialogs are generated from the command schemas (law editors are
plain fields: type + values); an optional "show frames" overlay draws the `inspect_sweep` frames and section outlines (COULD). No
capability depends on the UI.

## 7. Acceptance criteria

`D` = `--doc t.llull.json --kernel occt --json`. Values and tolerances are in `validation/expected_results.json`.

| # | Given | When (CLI) | Then (JSON assertion) | VC |
| --- | --- | --- | --- | --- |
| AC-01 | circle path R 50, section r 10 | `sweep_profile` today | `mass_properties data.volume` = 98 696.044 (2π²Rr²) ± 0.5 % mesh / 1e-6 exact | VC-SWG-01 |
| AC-02 | square 10 on a 100 straight path, twist 90°, 360°, S-curve 180° | `sweep_profile twist=…` D | volume = 10 000 for every law (± 1e-6 rel exact) | VC-SWG-03 |
| AC-03 | circle r 10, L 100, scale 1 → 0.5 linear / smoothstep / 1+0.25 sin 2πt | `sweep_profile scale=…` D | 18 325.957 / 18 625.156 / 32 397.674 | VC-SWG-05, 06, 07 |
| AC-04 | area law 100 → 25 on L 100 | `sweep_profile area=…` | 6 250 (not 5 833.33 of the scale law) | VC-SWG-10 |
| AC-05 | helix R 20, p 10, 3 turns, tube r 2 | `add_helix` + `sweep_profile` D | volume 4 752.386; `inspect_sweep data.minCurvatureRadius` 20.12665 (R + c²/R) | VC-SWG-12 |
| AC-06 | axial-plane rectangle 4 × 3 at r̄ 20, 3 turns, pitch 10 and 5 | `sweep_profile orientation.mode=axis_plane` D | volume 4 523.893 for both pitches | VC-SWG-13 |
| AC-07 | path at 45° to +Z, circle r 10, L 100 | `orientation.mode = fixed` vs `minimal` | 22 214.415 vs 31 415.927 | VC-SWG-15 |
| AC-08 | two straight rails diverging 20 → 10 over 100, circle section | `sweep_profile guideIds=[a,b] guideMode=scale` / `maintainHeight` | 18 325.957 / 23 561.945; `data.railDeviation` ≤ 1e-6 | VC-SWG-16, 17 |
| AC-09 | circles R 10, h 50, seams rotated by φ | `loft_sections ruled alignment=none` | π R² h (1 − (1 − cos φ)/3) for φ = 0, 60, 90, 120, 180° | VC-SWG-19 |
| AC-10 | circles r 10 → 5, h 50 | `loft_sections startCondition/endCondition normal magnitude 1` | volume 9 312.578; end angles 0 ± 1e-6 rad | VC-SWG-21 |
| AC-11 | network z = sin πx + y³, 3 × 3 curves | `loft_surface guideIds` (built) / `network_surface` (unsorted) | max deviation from the analytic surface ≤ 1e-5 | VC-SWG-23 |
| AC-12 | sweep with a section larger than the path curvature radius | `sweep_profile …` | exit 1, `SWG_SELF_INTERSECTION_LOCAL`, path `params.radius`, remediation | VC-SWG-27 |
| AC-13 | closed circular path, twist 100° | `sweep_profile closed twist` | exit 1, `SWG_CLOSED_TWIST_NOT_PERIODIC` | VC-SWG-27 |
| AC-14 | any SWG plan | `check_sweep_loft` | `data.status` pass; every tolerance named with `defaulted` and `source` | VC-SWG-28 |

## 8. Standards & regulatory alignment

| Topic | Alignment |
| --- | --- |
| Vocabulary | Orientation / trihedron names follow OCCT (`GeomFill_Trihedron`) [R4] and map to the vendor names of §2.1 in `llull guide`. |
| Frames | Rotation-minimizing frame by double reflection (Wang et al. 2008) [R25], already llull's default (`geometry/sweep.ts`). |
| Volumes | Pappus [R26], Cavalieri [R27]; generalised sweep volume derived in validation §4. |
| Exchange | Exact sweeps export as STEP B-spline / analytic faces through the existing AP242 path; no new standard. |
| Regulation | None applies: this pack makes geometry; release decisions belong to SRF / 09 PLM gates. |

## 9. KPIs / success metrics

| KPI | Target |
| --- | --- |
| Analytic volume suite (Pappus, twist, scale, area, rails, orientation, helical, ruled, end conditions) | 100 % within tolerance on the exact kernel (1e-6 rel) and on Manifold (0.5 %) |
| Helix fidelity | max distance to the exact helix ≤ 1e-6 × R (today 1.16e-2 × R at the ends) |
| Rail containment | ≤ 1e-6 × model size on every rail sweep |
| Refusal coverage | 100 % of SWG failure paths return a code of TECHNICAL §7 |
| Backward compatibility | every existing golden plan replays bit-identical |
| Agent success | every `validation/plans/target_*.json` runs unchanged once built; VCs run unattended from the CLI |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| --- | --- | --- |
| OCCT `MakePipeShell` has no twist law; twist via an auxiliary spine is an approximation of the law | twist accuracy | TS evaluator is the reference; exact faces fitted to 1e-6 rel with the deviation reported (TECHNICAL D-SWG-1); MakePipeShell only as a measured fast path |
| `ThruSections` has no end-condition API | loft end conditions impossible through it | TS skinning with derivative constraints (exact NURBS) + kernel sewing (TECHNICAL §5.6) |
| Fitted swept sheets are approximations | not "exact" in the strict sense | fit tolerance named and reported; analytic cases (cylinders, tori, helices) keep analytic faces |
| Two-rail anchors ambiguous (CATIA restriction) | wrong surface | explicit anchors or refusal (FR-SWG-10) |
| Vendor docs for SolidWorks / NX / CATIA were read via search extracts or API mirrors (JS-only help sites) | option names could differ by version | graded B in sources; behaviour requirements stand on OCCT and analytic data (grade A) |
| Developable rulings between arbitrary curves may not exist | `developable` mode often refuses | it is COULD; reports max \|K\| of the best ruled alternative |

## 11. References

- [R1] Open CASCADE — `BRepOffsetAPI_MakePipeShell` class reference — https://occt3d.com/dev/doc/refman/html/class_b_rep_offset_a_p_i___make_pipe_shell.html (accessed 2026-10)
- [R2] Open CASCADE — `BRepOffsetAPI_ThruSections` class reference — https://occt3d.com/dev/doc/refman/html/class_b_rep_offset_a_p_i___thru_sections.html (accessed 2026-10)
- [R3] Open CASCADE — `BRepFill_PipeShell` class reference — https://occt3d.com/dev/doc/refman/html/class_b_rep_fill___pipe_shell.html (accessed 2026-10)
- [R4] Open CASCADE — `GeomFill_Trihedron` enumeration — https://occt3d.com/dev/doc/refman/html/_geom_fill___trihedron_8hxx.html (accessed 2026-10)
- [R5] Open CASCADE — `Law_Function` / `Law_Interpol` class references — https://occt3d.com/dev/doc/refman/html/class_law___function.html , https://occt3d.com/dev/doc/refman/html/class_law___interpol.html (accessed 2026-10)
- [R6] Open CASCADE — `BRepOffsetAPI_MakePipe` class reference — https://occt3d.com/dev/doc/refman/html/class_b_rep_offset_a_p_i___make_pipe.html (accessed 2026-10)
- [R7] Robert McNeel & Associates — Rhino 8 *Sweep1* — https://docs.mcneel.com/rhino/8/help/en-us/commands/sweep1.htm (accessed 2026-10)
- [R8] Robert McNeel & Associates — Rhino 8 *Sweep2* — https://docs.mcneel.com/rhino/8/help/en-us/commands/sweep2.htm (accessed 2026-10)
- [R9] Robert McNeel & Associates — Rhino 8 *NetworkSrf* — https://docs.mcneel.com/rhino/8/help/en-us/commands/networksrf.htm (accessed 2026-10)
- [R10] Robert McNeel & Associates — Rhino 8 *Loft* — https://docs.mcneel.com/rhino/8/help/en-us/commands/loft.htm (accessed 2026-10)
- [R11] Robert McNeel & Associates — *DevLoft* / RhinoCommon `Brep.CreateDevelopableLoft` (search extracts) — https://developer.rhino3d.com/api/rhinocommon/rhino.geometry.brep/createdevelopableloft ; https://discourse.mcneel.com/t/devloft-command/48554 (accessed 2026-10)
- [R12] PTC Onshape — *Sweep* — https://cad.onshape.com/help/Content/sweep.htm (accessed 2026-10)
- [R13] PTC Onshape — *Loft* — https://cad.onshape.com/help/Content/loft.htm (accessed 2026-10)
- [R14] PTC Onshape — *Helix* — https://cad.onshape.com/help/Content/helix.htm (accessed 2026-10)
- [R15] Autodesk — Fusion *Sweep reference* — https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-REF-SWEEP.htm ; API `SweepFeatureInput` (search extract) — https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/SweepFeatureInput.htm (accessed 2026-10)
- [R16] Autodesk — Fusion *Coil reference* — https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-REF-COIL.htm (accessed 2026-10)
- [R17] PTC — Creo Parametric 9.0 *About Sweeps* — https://support.ptc.com/help/creo/creo_pma/r9.0/usascii/part_modeling/part_modeling/About_Sweeps.html (accessed 2026-10)
- [R18] Dassault Systèmes — SOLIDWORKS Help *Sweep PropertyManager*, *Surface Sweep PropertyManager*, *Swept Cut PropertyManager* (2014–2018; search extracts, pages are script-rendered) — https://help.solidworks.com/2015/English/SOLIDWORKS/sldworks/HIDD_DVE_FEAT_SWEEP.htm ; https://help.solidworks.com/2018/English/SolidWorks/sldworks/r_surface_sweep_property_manager.htm (accessed 2026-10)
- [R19] Dassault Systèmes — SOLIDWORKS Help *Loft PropertyManager*, *Loft with Start and End Constraints* (search extracts) — https://help.solidworks.com/2018/English/SolidWorks/Sldworks/HIDD_DVE_FEAT_LOFT.htm ; https://help.solidworks.com/2017/english/Solidworks/sldworks/t_Loft_with_Start_End_Constraints.htm (accessed 2026-10)
- [R20] Siemens — NX Open reference: `SweptBuilder`, `UF_MODL create sweep`, `ThroughCurveMeshBuilder` (search extracts; site redirects to login) — https://docs.plm.automation.siemens.com/data_services/resources/nx/12/nx_api/custom/en_US/nxopen_python_ref/NXOpen.Features.SweptBuilder.html ; https://docs.plm.automation.siemens.com/data_services/resources/nx/10/nx_api/en_US/custom/nxopen_python_ref/NXOpen.Features.ThroughCurveMeshBuilder.html (accessed 2026-10)
- [R21] pycatia (CATIA V5 automation API mirror) — `HybridShapeSweepExplicit` — https://pycatia.readthedocs.io/en/latest/api/pycatia/hybrid_shape_interfaces/hybrid_shape_sweep_explicit.html (accessed 2026-10)
- [R22] pycatia — `HybridShapeLoft` (multi-sections surface) — https://pycatia.readthedocs.io/en/latest/api/pycatia/hybrid_shape_interfaces/hybrid_shape_loft.html (accessed 2026-10)
- [R23] IBM Support — CATIA APAR: explicit sweep with two guide curves does not follow the second guide (permanent restriction) — https://www.ibm.com/support/pages/node/5049459 (accessed 2026-10)
- [R24] Siggel, M.; Kleinert, J.; Stollenwerk, T.; Maierl, R. — *TiGL: An Open Source Computational Geometry Library for Parametric Aircraft Design*, Math. Comput. Sci. 13 (2019), doi 10.1007/s11786-019-00401-y — https://arxiv.org/abs/1810.10795 (accessed 2026-10)
- [R25] Wang, W.; Jüttler, B.; Zheng, D.; Liu, Y. — *Computation of rotation minimizing frames*, ACM TOG 27(1), 2008 (search extract of the HKU repository record) — https://hub.hku.hk/handle/10722/152386 (accessed 2026-10)
- [R26] Tatum, J. — *The Theorems of Pappus*, Classical Mechanics, LibreTexts — https://phys.libretexts.org/Bookshelves/Classical_Mechanics/Classical_Mechanics_(Tatum)/01%3A_Centers_of_Mass/1.06%3A_The_Theorems_of_Pappus (accessed 2026-10)
- [R27] *Cavalieri's principle* — Wikipedia — https://en.wikipedia.org/wiki/Cavalieri%27s_principle (accessed 2026-10)
- [R28] CadQuery — `cadquery/occ_impl/shapes.py` (`Wire.makeHelix`, `Solid.sweep` / `_setSweepMode`), Apache-2.0, commit 33361dc1b5b70bc83ce36f1b34a01ca85dfca80a — https://github.com/CadQuery/cadquery/blob/master/cadquery/occ_impl/shapes.py (accessed 2026-10)
- [R29] Goodman, A. W.; Goodman, G. — *Generalizations of the theorems of Pappus*, Amer. Math. Monthly 76 (1969) 355–366 (located via a citing paper only; content not read) — https://msp.org/involve/2015/8-5/involve-v8-n5-p07-s.pdf (accessed 2026-10)
