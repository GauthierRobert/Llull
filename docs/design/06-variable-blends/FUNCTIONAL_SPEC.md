# BLD — Advanced blends: variable-radius, conic, curvature-continuous, setback, face and full-round fillets — Functional specification

Gap id: **BLD** · Folder: `docs/design/06-variable-blends/` · Status: specification (2026-10-22) · Track: "design anything" (owner
request 2026-10-22: "I want to give more capabilities in design, so I can design anything I want in any shape") ·
Depends on: SC-N1 persistent naming (built), native OCCT 7.9.2 kernel `llull-kernel` (built), aerospace 02 SRF analysis machinery
(`check_continuity`, `blend_surfaces`, built) · Neighbours: **02 SWG** (sweep scale / twist laws share the law representation of
§5.1), **04 DIR** (dragging a fillet radius in the UI commits one `fillet_edge` / `edit_step_params`), **05 IMP** (smooth implicit
booleans are field blends, not B-rep fillets), **07 MSH** (rounding meshes is out of scope here).

---

## 1. Summary

Blends (fillets, rounds, chamfers) are the most used finishing features in mechanical, consumer-product and tooling CAD: they
remove stress concentrations, make parts castable and mouldable, and give products their look. A fixed-radius round on a straight
edge is the easy case; "design anything" needs the rest of the family that every major CAD system ships:

- **variable radius** along an edge: start / end values, control points, smooth or straight transitions, laws, periodic laws
  on closed edges;
- **cross-section shape**: circular, **conic** (rho), **curvature-continuous (G2)** — the difference between a machined look and
  a consumer-product look, provable with zebra stripes or, for an agent, curvature numbers;
- **corners**: rolling ball vs **setback** vertex blends, and vertices where four or more blended edges meet;
- **face blends**: fillets between two face sets that do not share an edge, **hold-line** (tangent-line driven) fillets,
  **full round** (tri-tangent) fillets that consume a face, constant-width (chordal) blends on curved faces;
- **chamfer variants**: two distances, distance + angle;
- **diagnostics**: "why did my fillet fail, and what radius would work?" — the single most frequent fillet question in every CAD
  community (R15, R16).

llull today already does more than the obvious: `fillet_edge` reads per-edge radius laws (start/end and interior control points),
chord-length sizing on planar faces and persistent edge names; the native kernel builds them through OCCT
`BRepFilletAPI_MakeFillet`. What is missing is everything OCCT does **not** offer (conic and G2 profiles, setbacks, face-face and
full-round fillets, hold lines — OCCT's `ChFi3d_FilletShape` options are three _representations of the circle_, R1), the
diagnostics OCCT does offer but llull throws away (`StripeStatus`, faulty contours / vertices, partial results), a numeric
check of what a blend really is (G1/G2 at its contacts, radius realised along it), and agent-grade failure codes.

## 2. Industry context & value

### 2.1 How the benchmark systems do it

| Capability      | SOLIDWORKS                                                                                            | CATIA V5                                                                                          | Siemens NX                                                                                                   | Creo                                                                         | Fusion                                                                                        | Onshape                                                                                           | Rhino / Alias                                                                                                   | OCCT 7.9 (llull's kernel)                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Variable radius | Variable Size Fillet: control points ("Number of Instances"), **Smooth vs Straight transition** (R2)  | Variable Radius Fillet "controlled by couples of radius/vertex", `CATLinearFilletVariation` (R11) | Edge Blend variable radius points (edge, parameter, radius, rho); points stored as % of the whole chain (R9) | variable round sets (R8)                                                     | Variable: "multiple fillet radius values at points that you specify along a single edge" (R3) | Variable fillet per vertex + "Add point on edge" + Smooth transition (R5)                         | VariableFilletSrf handles: AddHandle, SetAll, LinkHandles (R12)                                                 | `Add(R1, R2, E)` linear; `Add(Law_Function, E)`; `Add(UandR array, E)` interpolating (R1)                                                             |
| Cross-section   | Circular, **Conic Rho**, **Conic Radius**, **Curvature Continuous** (R2)                              | bitangency sphere / circle; GSD shape fillet with conical parameter (R11)                         | Edge / face blend shape circular or conic with law-controlled rho (R9, R10)                                  | Circular, Conic (rho .05–.95), **C2 Continuous**, D1×D2 conic, D1×D2 C2 (R7) | G1 or **G2 continuity**, tangency weight; Asymmetric (R3)                                     | Distance (circular), Conic (rho), Curvature (magnitude 0–0.999) (R5)                              | Alias: G1 Circular, **G2 Curvature (degree 5), G3 (degree 7)** (R13); Rhino BlendEdge G2 vs FilletEdge G1 (R12) | circle only: Rational, QuasiAngular, Polynomial (R1)                                                                                                  |
| Size by width   | chord width option (R2)                                                                               | —                                                                                                 | —                                                                                                            | D1×D2 distances (R7)                                                         | **Chord Length** (R3)                                                                         | **Width** (R5)                                                                                    | Alias **Chord** construction; Rhino **DistBetweenRails** (R12, R13)                                             | — (llull converts chord → radius on planar faces)                                                                                                     |
| Corners         | **Setback** distances per edge at a vertex (≥ 3 edges); FilletXpert Corner tab (exactly 3 edges) (R2) | —                                                                                                 | setback + **stop short** (R9)                                                                                | round transitions (R8)                                                       | **Rolling Ball / Setback** corner type (R3); asymmetric only setback (R4)                     | Smooth fillet corners (R5)                                                                        | —                                                                                                               | automatic corner patches; **≥ 4 edges at a contour end not handled** (R1)                                                                             |
| Face blends     | Face Fillet with **hold line** (R2)                                                                   | Face-Face fillet; **Tritangent** fillet (face removed) (R11)                                      | Face Blend: conic law control (R10)                                                                          | —                                                                            | —                                                                                             | Face Blend: rolling ball / swept profile, **tangent & conic hold lines, cliff edges**, trims (R6) | FilletSrf (Rhino 8)                                                                                             | `FilletSurf_Builder` surfaces only (R1)                                                                                                               |
| Full round      | three face sets (R2)                                                                                  | Tritangent (R11)                                                                                  | —                                                                                                            | —                                                                            | Full Round Fillet (R3)                                                                        | Full round (one contiguous face at a time) (R5)                                                   | —                                                                                                               | —                                                                                                                                                     |
| Partial         | start / end conditions (R2)                                                                           | —                                                                                                 | stop short (R9)                                                                                              | —                                                                            | —                                                                                             | **Partial fillet** (position %, entity, offset) (R5)                                              | —                                                                                                               | —                                                                                                                                                     |
| Chamfer         | distance, distance-distance, angle                                                                    | distance-angle                                                                                    | asymmetric                                                                                                   | D×D, D1×D2, angle                                                            | asymmetric                                                                                    | —                                                                                                 | Alias G0 Chamfer (R13)                                                                                          | `Add(D)`, `Add(D1, D2, E, F)`, `AddDA(D, Angle, E, F)`, throat modes (R1)                                                                             |
| Failure aid     | FilletXpert, error messages                                                                           | —                                                                                                 | —                                                                                                            | —                                                                            | —                                                                                             | error visualisation for a too-large fillet (R5)                                                   | —                                                                                                               | `StripeStatus` (StartsolFailure "perhaps the radius is too big", WalkingFailure, TwistedSurface), faulty contours / vertices, partial `BadShape` (R1) |

Known limits, sourced: SOLIDWORKS FilletXpert edits constant-radius fillets only (R2); Fusion asymmetric fillets must be G1 and
only support setback corners (R4); Onshape cannot full-round more than one non-contiguous face at a time (R5); Creo before Creo 3
only had circular rounds (R7) and a constant→variable conversion bug reverted conic to circular (R8); OCCT cannot finish a contour
at a vertex of 4+ edges and fails when the fillet's intersection with a limiting face leaves that face (R1); OCCT failures are
often radius-dependent and appear when the radius exceeds a short adjacent edge (R15, grade C); a constant-radius circular fillet
is **not** G2 to its neighbours (R12) — G2 needs a non-circular section (Alias: degree 5, R13).

### 2.2 What "design anything" means for blends

The best of the benchmark is: any radius law (points, smooth/straight, laws), any section (circular / conic / G2), any corner
(rolling ball / setback, ≥ 4 edges), blends between any two face sets (hold lines, full round), chamfers in all forms, and a
failure that tells you why and what would work. llull should match that **on the CLI-agent path**: every option a parameter of a
registered command, every result checkable in numbers, every failure a stable code with a remediation.

### 2.3 Value

- **Agents can finish parts.** An agent designing an enclosure, a bracket or a handle ends with blends; today any non-trivial blend
  request either fails with a generic "kernel could not" summary or is impossible (G2, setback, full round).
- **Product look, proven.** "Make the edges of this case soft" becomes `profile: curvature`, and the agent proves it with
  `check_blends` (curvature 0 at both contacts), the numeric equivalent of a zebra check (AF-21).
- **Self-repair.** `probe_fillet` and coded refusals (`BLD_RADIUS_TOO_LARGE` with the largest radius that works) let an agent fix
  its own plan instead of guessing radii.
- **Parametric integrity.** Laws, setbacks and face sets are recorded as design intent and by persistent names (SC-N1), so an
  upstream edit re-runs the same blend or refuses with `REF_LOST`, never rounds a different edge.

## 3. Personas & user stories

Operator model per [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md): the **operator** is an AI agent on the
`llull` CLI; the **owner** describes the part ("round all outside edges, soft look, 2 mm") and is not assumed to know CAD; a
**qualified reviewer** appears only when a blend is a stress or fatigue feature on a part that is released (a fillet radius on a
drawing that a stress analysis relied on).

| Role                              | Uses                                               | In this gap                                                                                                                               |
| --------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Operator (primary)                | `llull` CLI (`--doc` headless or `--app` live)     | Writes `fillet_edge` / `fillet_faces` / `fillet_full_round` / `chamfer_edge` steps, probes radii, ends with `check_blends`, renders a PNG |
| Owner                             | natural language; may watch the desktop app        | States intent ("soft", "2 mm", "follow this line"); receives a plain sentence                                                             |
| Qualified reviewer (release only) | desktop app, `check_blends purpose=release` report | Accepts stress-relevant radii (human gate via 09 PLM approval, as SRF FR-SRF-43)                                                          |

| #     | Story                                                                                                                                                              | FR            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| US-1  | As the operator, I round one edge with a radius growing from 1 to 2 mm, or passing through 2 mm at mid-length, and read the realised radius at the control points. | FR-BLD-01, 05 |
| US-2  | As the operator, I round the rim of a cylinder with a radius that varies periodically around it (a scalloped lip) from one expression.                             | FR-BLD-02, 03 |
| US-3  | As the operator, asked for "soft edges", I use a curvature-continuous profile and prove G2 with numbers.                                                           | FR-BLD-07, 21 |
| US-4  | As the operator, I use a conic profile (rho) or asymmetric legs to sharpen or flatten a round.                                                                     | FR-BLD-06, 08 |
| US-5  | As the operator, at a corner where three or more rounded edges meet I choose rolling ball or setback, including at a 4-edge apex where OCCT fails.               | FR-BLD-09, 10 |
| US-6  | As the operator, I blend two faces that do not share an edge, drive a blend from a tangent hold line, or full-round a rib top.                                     | FR-BLD-13..15 |
| US-7  | As the operator, I chamfer with two distances or distance + angle.                                                                                                 | FR-BLD-18     |
| US-8  | As the operator, when a fillet fails I get the code, the failing edge / vertex and the largest radius that works; before trying, I can probe.                      | FR-BLD-19, 20 |
| US-9  | As the operator, I change an upstream dimension and the same blends regenerate, or I get `REF_LOST` with how to re-pick.                                           | FR-BLD-22, 23 |
| US-10 | As the owner, I get one sentence: what was rounded, how (radius / profile), what check passed, what needs a human.                                                 | FR-BLD-21, 26 |
| US-11 | As the qualified reviewer, I see the blend report (radius range, continuity) in the desktop app and approve the release; the agent cannot.                         | FR-BLD-26, 29 |

## 4. Scope / out of scope

### 4.1 Phases

| Phase                                  | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MVP** (make what exists trustworthy) | Diagnostics with stable codes from OCCT's own status (stripe status, faulty contours / vertices, ≥ 4-edge vertices); `probe_fillet`; `check_blends` with G0/G1/G2 at blend contacts and realised radius samples (needs native `edgeSamples` / `edgeContinuity`, null today); radius-law model completed (interpolation linear / smooth, periodic closed edges, expression laws, chain-relative parameter); chord sizing on curved faces; oracle cases for variable laws; code export of laws. |
| **V1** (profiles and chamfers)         | Conic (rho, symmetric and D1×D2 legs) and curvature-continuous (G2) profiles on edge fillets; asymmetric fillets; chamfer distance-distance and distance-angle.                                                                                                                                                                                                                                                                                                                               |
| **V2** (corners and face blends)       | Setback corners (per-edge setbacks, G1 patch), ≥ 4-edge vertices; face-face fillets (radius or width), hold lines, full round; partial fillets (COULD); per-joint radii for `blend_union` (COULD); UI review overlays (COULD).                                                                                                                                                                                                                                                                |

### 4.2 Out of scope

- Rounding triangle meshes (07 MSH) and implicit smooth unions (05 IMP).
- G3 fillets (Alias offers them, R13): COULD later on the same section machinery; not specified here.
- Automatic "fillet everything" rule fillets (Fusion Rule Fillet, R3) beyond what `edgesNear` / face-set selection gives; a
  rule language is a later gap.
- Sheet-metal bend reliefs (aerospace 07) and 2D sketch fillets (`fillet_2d` exists; conic 2D fillets COULD).
- NURBS sheet-to-sheet bridging: `blend_surfaces` exists (aerospace 02 SRF) and is not changed here.

## 5. Functional requirements

Priority: MUST = MVP, SHOULD = V1/V2, COULD = later. Every FR maps to ≥ 1 VC in [`validation/README.md`](validation/README.md).

### 5.1 Edge fillets — radius laws

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                                                                                   | Rationale                                                               | Source                                |
| --------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| FR-BLD-01 | MUST   | Each filleted edge (or tangent chain) takes a **radius law**: constant; start→end linear; control points `(t, r)` at relative positions on the **whole tangent chain** (0..1, as NX stores them) with `interpolation: "linear"` (straight transition) or `"smooth"` (C1/C2 interpolation, today's OCCT behaviour); radii > 0. | SOLIDWORKS smooth/straight transitions, NX chain %, OCCT laws           | R1, R2, R9                            |
| FR-BLD-02 | MUST   | A law on a **closed** edge or closed chain (cylinder rim) is periodic: `r(0) = r(1)` is required (refused with `BLD_LAW_NOT_PERIODIC` otherwise) and the smooth interpolant is periodic.                                                                                                                                      | A rim fillet with a seam step is a defect                               | R1 (closed contours)                  |
| FR-BLD-03 | SHOULD | **Expression law**: `r(t)` given as an expression of `t` (built-ins `pi`, `cos`, …; document parameters allowed) and a sample count; stored as the expression (design intent, L8), sampled deterministically for the kernel.                                                                                                  | Scalloped lips, ergonomic grips                                         | `packages/core/src/lib/expression.ts` |
| FR-BLD-04 | MUST   | **Chord (width) sizing** works on any face pair, not only planes: the width between the two contact lines is held (per sample, from the local wedge angle in the section plane); planar faces keep today's closed form `r = c / (2 cos(α/2))`. Variable widths follow FR-BLD-01.                                              | Fusion Chord Length, Onshape Width, Rhino DistBetweenRails, Alias Chord | R3, R5, R12, R13                      |
| FR-BLD-05 | MUST   | The realised blend can be **read back** in numbers: per blend face the source edge(s), the radius at requested `t` (default the control points + 11 samples), min / max radius, contact edges.                                                                                                                                | Agent proves the law it asked for (AF-21)                               | AF-21                                 |

### 5.2 Edge fillets — profiles

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                                                                                                                                     | Rationale                                                                        | Source              |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------- |
| FR-BLD-06 | SHOULD | **Conic profile** `{ type: "conic", rho }`, `0.05 ≤ rho ≤ 0.95`: the section is the rational quadratic between the two contact lines with weight `w = rho / (1 − rho)` (Liming shoulder definition, the same as `create_conic`); sized by radius (contact lines of the circular fillet of that radius) or by width. `rho = √2 − 1` on a 90° edge reproduces the circle exactly. | SOLIDWORKS Conic Rho, Creo, Onshape, NX                                          | R2, R5, R7, R9      |
| FR-BLD-07 | SHOULD | **Curvature-continuous profile** `{ type: "curvature", shape }`, `0.05 ≤ shape ≤ 0.95`: the section matches position, tangent and **normal curvature** of each face at the contact (G2); with planar faces the section has zero curvature at both contacts. The measured order is reported, never assumed.                                                                      | SOLIDWORKS Curvature Continuous, Creo C2, Fusion G2, Onshape Curvature, Alias G2 | R2, R3, R5, R7, R13 |
| FR-BLD-08 | SHOULD | **Asymmetric** fillets: two leg sizes (first on a named face); with the circular profile the section is the elliptic quarter (conic with rho = √2 − 1), with conic / curvature the legs bound that section.                                                                                                                                                                     | Fusion Asymmetric, Creo D1×D2                                                    | R3, R7              |

### 5.3 Corners and extents

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                                                                            | Rationale                                             | Source     |
| --------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------- |
| FR-BLD-09 | SHOULD | **Corner treatment** per vertex (by point or persistent vertex name, or `all`): `rolling_ball` (default, today's OCCT patch) or `setback` with one distance or one per incident edge (each ≥ that edge's tangent distance at the vertex), the corner filled by an N-sided patch G1 to the blends and faces (G2 COULD). | SOLIDWORKS setback, Fusion Setback corner, NX setback | R2, R3, R9 |
| FR-BLD-10 | SHOULD | A vertex where **4 or more** filleted edges meet and OCCT reports it faulty is completed by the setback corner fill; without `corners` it is refused with `BLD_CORNER_UNSUPPORTED` naming the vertex, never a partial shape. Vertices OCCT completes itself (the symmetric pyramid apex, measured 2026-10-22) are kept.                                                                                                                      | OCCT documents it as not handled; measured: some cases succeed | R1         |
| FR-BLD-11 | COULD  | **Partial fillet**: the blend covers `t ∈ [start, end]` of the edge with a run-out; outside it the edge stays sharp.                                                                                                                                                                                                   | Onshape partial fillet, NX stop short                 | R5, R9     |
| FR-BLD-12 | MUST   | **Tangent propagation** stays automatic (OCCT contours are tangent chains) and is reported: `data.chains[]` lists which input edges were extended along which tangent edges.                                                                                                                                           | Agents must know what was rounded                     | R1, R5     |

### 5.4 Face blends

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                                                                                              | Rationale                                                        | Source                   |
| --------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------ |
| FR-BLD-13 | SHOULD | **Face-face fillet** `fillet_faces`: a rolling-ball (or constant-width) blend between face set A and face set B that need not share an edge; faces between the contact lines are consumed; radius law and profile as for edges. Refused with `BLD_FACE_FILLET_NO_SOLUTION` when no tangent ball of that radius fits inside the material. | CATIA Face-Face, SOLIDWORKS face fillet, Onshape / NX Face Blend | R2, R6, R10, R11         |
| FR-BLD-14 | SHOULD | **Hold line**: on `fillet_faces`, a curve on face set A (an edge, a split line or a drawn curve placed on the face) is the contact line; the radius follows from it per section (planar 90°: `r = h`, general wedge α: `r = h tan(α/2)`).                                                                                                | SOLIDWORKS hold line, Onshape tangent hold lines                 | R2, R6                   |
| FR-BLD-15 | SHOULD | **Full round** `fillet_full_round`: given side set 1, center set, side set 2, the blend is tangent to all three and consumes the center set; the radius is derived per section (half the width for parallel sides).                                                                                                                      | SOLIDWORKS Full Round, CATIA Tritangent, Fusion, Onshape         | R2, R3, R5, R11          |
| FR-BLD-16 | COULD  | Cliff edges (blend clamped to an edge) and trim modes (wall / short / long / none) for face blends.                                                                                                                                                                                                                                      | Onshape Face Blend                                               | R6                       |
| FR-BLD-17 | COULD  | `blend_union` per-joint radii (by joint point / name) and laws; today one radius for every joint.                                                                                                                                                                                                                                        | One-piece frames with different joint sizes                      | `commands/brep/blend.ts` |

### 5.5 Chamfers

| Id        | Pri    | Requirement                                                                                                                                                           | Rationale                             | Source |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------ |
| FR-BLD-18 | SHOULD | `chamfer_edge` gains **distance-distance** (first distance on a named face) and **distance-angle** (angle on that face, degrees); variable (start→end) chamfer COULD. | Every benchmark system; OCCT has both | R1     |

### 5.6 Agent-first, checks and robustness

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                                                                                                    | Measure                                   |
| --------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------- |
| FR-BLD-19 | MUST   | Every refusal has a **stable code** (TECHNICAL_SPEC §7.1) built from the kernel's own status (stripe status per contour, faulty vertices, partial result), the failing edge / vertex / face ids and names, the param path, and a one-line remediation that names a working value when one is known (`"largest radius that builds on edge e(top | side): 4.12 mm (probe_fillet)"`) (AF-11). | VC-BLD-13, 15, 21 |
| FR-BLD-20 | MUST   | `probe_fillet` (read-only): for selected edges (and an optional profile), the **largest radius that builds**, by bisection on exact evaluations, with the limiting reason (code) and the geometric upper bound it respected.                                                                                                                   | VC-BLD-20                                 |
| FR-BLD-21 | MUST   | `check_blends` (read-only, AF-20): per blend face — kind, profile, source edges, radius samples, **G0 gap, G1 angle, G2 curvature jump and order at each contact**, corner patches, validity; findings pass / warn / fail with codes; tolerances named and defaulted ones flagged; an agent ends every blend job with it.                      | VC-BLD-09, 10, 23                         |
| FR-BLD-22 | MUST   | Edge, **vertex** (corner) and **face-set** references are persistent names (SC-N1) recorded at first pick; regeneration uses names; a lost or split reference refuses with `REF_LOST` / `REF_SPLIT` and how to re-pick.                                                                                                                        | VC-BLD-22                                 |
| FR-BLD-23 | MUST   | Laws, profiles, setbacks, hold lines are design intent in params (lengths, fractions, rho, expressions, `=expr` parameters), replay bit-identical (L8, AF-13).                                                                                                                                                                                 | VC-BLD-25                                 |
| FR-BLD-24 | MUST   | Every numeric param states its unit (document length unit, degrees, dimensionless rho / shape / t); every result number carries a unit (AF-04, AF-10).                                                                                                                                                                                         | VC-BLD-28                                 |
| FR-BLD-25 | SHOULD | `export_code` lowers linear / control-point / expression laws to the OCP runtime (`Add(UandR)`); conic, G2, setback and face blends are reported in the export notes with `BLD_CODEGEN_UNSUPPORTED` and exported as exact geometry (never as a silently constant fillet).                                                                      | VC-BLD-26                                 |
| FR-BLD-26 | MUST   | No silent defaults: continuity tolerances, sample counts and probe tolerances are given or named defaults (`defaulted: true`, source); positional picks on a kernel without names are `unverified`; `check_blends purpose=release` sets `reviewRequired` ("fillet radii may be stress-relevant: needs a qualified engineer") (AF-31..33, 36).  | VC-BLD-23                                 |
| FR-BLD-27 | SHOULD | Conic and G2 blend faces are exact B-spline faces; STEP export / reimport keeps them and the volume.                                                                                                                                                                                                                                           | VC-BLD-27                                 |
| FR-BLD-28 | MUST   | Without an exact kernel (Manifold) every mutating blend command refuses (`CMD_KERNEL_UNAVAILABLE` / `BLD_KERNEL_UNSUPPORTED`), the document is unchanged and `check_blends` returns `not_run`; no faceted "fillets".                                                                                                                           | VC-BLD-24                                 |
| FR-BLD-29 | COULD  | Desktop review overlays: radius labels along blends, curvature comb across a blend section, corner patch outlines — built from `check_blends` data only.                                                                                                                                                                                       | component test                            |
| FR-BLD-30 | SHOULD | `llull guide` gains a blends section: which command for which intent, units, how to read `check_blends`, the probe-then-fillet pattern (AF-03).                                                                                                                                                                                                | VC-BLD-28 (guide snapshot)                |

## 6. Workflows

### 6.1 CLI (primary)

```bash
llull search fillet                                   # fillet_edge, fillet_faces, fillet_full_round, chamfer_edge, probe_fillet, check_blends
llull describe fillet_edge                            # laws, profile, corners, units
llull inspect_topology id=bracket-3.1 --doc p.llull.json --kernel occt --json   # edge names e(<face>|<face>)
llull probe_fillet '{"id":"bracket-3.1","edgesNear":[[0,5,2.5]]}' --doc p.llull.json --kernel occt --json   # data.edges[0].maxRadius
llull run blends.plan.json --validate --doc p.llull.json --kernel occt          # BLD_* codes with step path + param
llull run blends.plan.json --doc p.llull.json --kernel occt --json             # fillet_edge (law / profile / corners), fillet_faces, ...
llull check_blends '{"require":"G2"}' --doc p.llull.json --kernel occt --json  # status, blends[], findings[], tolerances
llull render_view view=iso --doc p.llull.json --kernel occt --save out/blends.png
llull export_step --doc p.llull.json --kernel occt --save out/part.step
```

A failed blend exits 1 with `Error BLD_RADIUS_TOO_LARGE at params.radius: largest radius that builds on e(top|side) is 4.12 mm`;
the agent edits the step (`edit_step_params`) and re-runs. `--dry-run` tries a blend without writing the document (AF-42).

### 6.2 UI (review surface)

The desktop app shows the result live (`--app`); fillet dialogs exist because the UI iterates `listCommands()` (law points,
profile, corners as fields). The qualified reviewer reads the `check_blends` report and, when release-relevant, approves through
09 PLM. Overlays (FR-BLD-29) are optional.

## 7. Acceptance criteria

`D` = `--doc t.llull.json --kernel occt --json`. Values and tolerances: `validation/expected_results.json`.

| #     | Given                                      | When (CLI)                                                 | Then                                                                                   | VC            |
| ----- | ------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------- |
| AC-01 | 20×10×5 block                              | `fillet_edge` top edge r 1 → 2 (`radiusEnd`, exists today) | top / side planar faces 170 / 70 mm² (± 1e-6); volume 989.985 ± 0.02 mm³               | VC-BLD-02     |
| AC-02 | same block                                 | control points 1 / 2 / 1, `interpolation: "linear"`        | `check_blends` radius at t = 0.5 is 2 ± 1e-6; top face 170 mm²                         | VC-BLD-03     |
| AC-03 | cylinder R 5 h 10                          | rim law `1 + 0.5*cos(2*pi*t)`                              | volume 778.227639 ± 0.01 mm³                                                           | VC-BLD-04     |
| AC-04 | equilateral prism, cylinder                | chord 2 on a 60° edge; chord √2 on the rim                 | 423.881325 / 778.957433 mm³ ± 1e-3                                                     | VC-BLD-05, 06 |
| AC-05 | block                                      | conic rho 0.25 / √2−1 / 0.5 / 0.75, r = 1                  | 993.646111 / 995.707963 / 996.666667 / 998.912905 mm³ ± 1e-3                           | VC-BLD-07     |
| AC-06 | block                                      | asymmetric 1 × 2, rho √2 − 1                               | 991.415927 ± 1e-3                                                                      | VC-BLD-08     |
| AC-07 | block                                      | curvature profile, d 1, shape 0.5                          | 998.000 ± 1e-3; `check_blends` contacts order G2, contact curvature ≤ 1e-6             | VC-BLD-09     |
| AC-08 | block                                      | circular r 1, `check_blends`                               | contacts G1, g2Gap 1 mm⁻¹                                                              | VC-BLD-10     |
| AC-09 | 10-cube                                    | all edges r 1, setback 2 at 8 corners                      | blend cylinder spans 6 ± 1e-6; patches G1 ≤ 0.01 rad; volume within [920.549, 984.549] | VC-BLD-12     |
| AC-10 | pyramid apex (4 edges)                     | r 0.5 without / with a setback corner                      | valid solid (11 faces today) / valid solid                                             | VC-BLD-13     |
| AC-11 | chamfered square prism                     | `fillet_faces` r 2 / r 1.5                                 | 991.415927 ± 1e-3, chamfer face gone / `BLD_FACE_FILLET_NO_SOLUTION`                   | VC-BLD-14, 15 |
| AC-12 | 4-wide rib                                 | `fillet_full_round`                                        | 765.663706 ± 1e-3; cylinder r 2                                                        | VC-BLD-16     |
| AC-13 | block + drawn hold line 1 → 2 off the edge | `fillet_faces holdLine`                                    | faces 170 / 70 mm²                                                                     | VC-BLD-17     |
| AC-14 | 10-cube                                    | chamfer 1×2, 1 / 30°                                       | 990 / 997.113249 ± 1e-3                                                                | VC-BLD-18     |
| AC-15 | block                                      | `probe_fillet` top edge                                    | `maxRadius` < 5; 0.99× builds, 1.01× refused                                           | VC-BLD-20     |
| AC-16 | `target_error_codes` plan                  | `llull run --continue --json`                              | codes in order, each with ids/paths/remediation, document unchanged                    | VC-BLD-21     |
| AC-17 | any blend plan                             | `--kernel manifold`                                        | refusals, unchanged document                                                           | VC-BLD-24     |

## 8. Standards & regulatory alignment

| Topic                 | Alignment                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Continuity vocabulary | G0 / G1 / G2 as in the SRF pack (Rhino / NX definitions) and `check_continuity`; G2 for a blend = equal normal curvature across the contact in the section plane. |
| Conic definition      | rho as Liming shoulder ratio (SRF pack FR-SRF-18, `create_conic`), `w = rho / (1 − rho)`. Vendor rho ranges 0.05..0.95 (R2, R7).                                  |
| Exchange              | Blend faces are exact surfaces (cylinder / torus / B-spline) in STEP AP214 / AP242 through the existing exporters.                                                |
| Drawings / PMI        | Fillet radius callouts (`R2`, variable `R1→R2`) are an aerospace 03 GDT concern; `check_blends` data feeds them.                                                  |
| Regulation            | No standard prescribes fillet construction. Where a radius is stress-relevant, release is a human gate (AF-33/34).                                                |

## 9. KPIs / success metrics

| KPI                                                    | Target                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Analytic VCs (grade A) passing on the native kernel    | 100 % of `expected_results.json` grade-A cases                                                                                            |
| Refusals with a `BLD_*` / `REF_*` code and remediation | 100 % (today: generic summaries, `CMD_NO_EFFECT`)                                                                                         |
| Benchmark parity (§2.1 rows)                           | variable, chord, conic, G2, setback, ≥ 4-edge corner, face-face, hold line, full round, chamfer D×D / D-A: all available on the CLI by V2 |
| `probe_fillet` cost                                    | ≤ 12 exact evaluations per edge                                                                                                           |
| Agent loop                                             | every target plan runs unchanged and ends with `check_blends` status pass                                                                 |

## 10. Risks & assumptions

| Risk / assumption                                                                                                            | Impact                                                                    | Mitigation                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| OCCT has no conic / G2 / setback / face-face / full-round API (R1)                                                           | Native work in C++                                                        | Rail-preserving section replacement and N-sided fills on top of `BRepFilletAPI_MakeFillet` and `BRepOffsetAPI_MakeFilling` (TECHNICAL_SPEC §5) |
| OCCT fillet robustness (R15, R16)                                                                                            | Agents hit failures                                                       | Diagnostics + probe + codes (MVP first); fuzz / action-matrix coverage                                                                         |
| The variable-radius construction OCCT uses is not documented (sections vs envelope; R16 says OCC differs from other systems) | Volume VCs could be off by up to 0.33 % of the removed volume (slope 0.1) | Gate on construction-independent face areas; VC-BLD-30 identifies the construction                                                             |
| Vendor parameter meanings (rho, C2 factor, magnitude) not public                                                             | "Same as SOLIDWORKS" cannot be promised                                   | llull defines its own parameters (§5.2) and documents the math                                                                                 |
| Persistent vertex names do not exist yet                                                                                     | Corners re-picked by point                                                | Derive vertex names from incident edge names (TECHNICAL_SPEC §3)                                                                               |
| G2 measurement on B-rep needs native `edgeContinuity`, null today                                                            | `check_blends` cannot prove G2                                            | MVP item TR-BLD-04                                                                                                                             |

## 11. References

Full list with access method and grade: [`validation/sources.md`](validation/sources.md).

- [R1] Open CASCADE Technology 7.9.2 headers (BRepFilletAPI_MakeFillet, MakeChamfer, MakeFillet2d, ChFi3d_FilletShape, ChFiDS_ErrorStatus, ChFiDS_ChamfMode, FilletSurf_Builder, GeomFill_Pipe, BRepOffsetAPI_MakeFilling) — Open CASCADE SAS — https://github.com/Open-Cascade-SAS/OCCT/tree/V7_9_2 (accessed 2026-10)
- [R2] SOLIDWORKS Help: Constant / Variable Size Fillets, Face Fillets, Full Round Fillets, FilletXpert, FeatureFillet3 API — Dassault Systèmes — https://help.solidworks.com/2024/English/SolidWorks/Sldworks/r_Variable_Size_Fillet.htm (accessed 2026-10)
- [R3] Fusion — Fillet reference — Autodesk — https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-REF-FILLET.htm (accessed 2026-10)
- [R4] Fusion API — FilletFeatureInput — Autodesk — https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/FilletFeatureInput.htm (accessed 2026-10)
- [R5] Onshape Help — Fillet — PTC — https://cad.onshape.com/help/Content/PartStudio/fillet.htm (accessed 2026-10)
- [R6] Onshape Help — Face Blend — PTC — https://cad.onshape.com/help/Content/PartStudio/face_blend.htm (accessed 2026-10)
- [R7] Creo 13 Help — About the Edit Round User Interface — PTC — https://support.ptc.com/help/creo/creo_pma/r13/usascii/part_modeling/flexible_modeling/about_edit_round_ui.html (accessed 2026-10)
- [R8] PTC Article CS246796 — https://www.ptc.com/en/support/article/CS246796 (accessed 2026-10)
- [R9] NX Open EdgeBlendBuilder; Siemens KB PL8015439, PL8000589 — Siemens — https://support.sw.siemens.com/en-US/okba/PL8015439/The-variable-radius-points-cannot-be-specified-by-percent-Arc-Length-of-each-edge/index.html (accessed 2026-10)
- [R10] NX Open ConicCrossSection — Siemens — https://docs.plm.automation.siemens.com/data_services/resources/nx/12/nx_api/custom/en_US/nxopen_python_ref/NXOpen.GeometricUtilities.ConicCrossSection.html (accessed 2026-10)
- [R11] pycatia (CATIA V5 R28 automation): VarRadEdgeFillet, TritangentFillet, HybridShapeFilletBiTangent — https://pycatia.readthedocs.io/en/0.93/api/pycatia/part_interfaces/var_rad_edge_fillet.html (accessed 2026-10)
- [R12] Rhino 8 — VariableFilletSrf; McNeel forum — Robert McNeel & Associates — https://docs.mcneel.com/rhino/8/help/en-us/commands/variablefilletsrf.htm (accessed 2026-10)
- [R13] Alias 2014 — Surface Fillet — Autodesk — https://help.autodesk.com/cloudhelp/2014/ENU/Alias/files/SurfacesMultiSurfacefilletSurfacefillet.htm (accessed 2026-10)
- [R14] Hartmann, E. — G^n-blending with Rolling Ball Contact Curves (abstract) — TU Darmstadt — https://www2.mathematik.tu-darmstadt.de/~ehartmann/pub/parblrb_abs/parblrb_abs.html (accessed 2026-10)
- [R15] OCCT bug tracker / forum on fillet failures — https://tracker.dev.opencascade.org/view.php?id=27030 (accessed 2026-10, extracts only)
- [R16] FreeCAD wiki — PartDesign Fillet — https://wiki.freecad.org/PartDesign_Fillet (accessed 2026-10, extracts only)
- [R17] llull source, origin/main 2c7ecc93 (paths in TECHNICAL_SPEC §1)
