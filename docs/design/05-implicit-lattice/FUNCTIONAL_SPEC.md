# IMP — Implicit / field modelling and lattices — Functional specification

Gap id: **IMP** · Folder: `docs/design/05-implicit-lattice/` · Status: specification (2026-10-22), nothing built ·
Track: "design anything" freeform design (owner request 2026-10-22) · Neighbours: **01 DEF** (space deformations; a deformation of a
field is a coordinate map, §4.2), **03 WRP** (surface textures; `add_surface_texture` stays theirs), **07 MSH** (mesh repair, decimation,
remeshing of the meshes this gap produces), physics **17 TOP** (density field as a grading input), physics **05 FEA** (result fields as
grading input).

---

## 1. Summary

Some shapes cannot be drawn with faces and edges: a gyroid heat-exchanger core, a bone-like implant with graded porosity, a shoe
midsole of 40 000 struts whose thickness follows a pressure map, a bracket with an organic blend wherever three tubes meet. Every
industrial tool that does this (nTop, Fusion Volumetric Lattice, Creo formula-driven lattices, NX implicit modelling, CATIA Lattice
Designer, Carbon Design Engine, Grasshopper with Crystallon or Dendro) represents the part as a **field**: a function of space whose
sign says inside or outside, combined with booleans that never fail, offset by adding a number, graded by multiplying by another
field, and turned into a printable mesh only at the end.

llull today has **none of this**. It has exact B-rep (native OCCT), a mesh kernel (Manifold), Catmull-Clark cages and NURBS
sheets, a `blend_union` that fillets the joints of welded solids with one constant radius (`packages/core/src/commands/brep/blend.ts`), and
a marching-tetrahedra iso-surface used only for topology-optimisation densities (`packages/domain-cae/src/topology/derive.ts`). There is
no signed-distance primitive, no smooth (blended) boolean between arbitrary bodies, no TPMS or strut lattice, no field-driven
thickness, no shell-with-infill, no lattice export (the 3MF writer `commands/exchange/threeMf.ts` writes triangles only), and no
read-only check that tells an agent whether a lattice is printable. An agent asked "lighten this bracket with a 3 mm gyroid infill
and a 1.5 mm skin, thicker near the bolt holes" cannot do it.

This gap adds an **implicit field model** to llull, on the CLI agent path first: SDF primitives and fields from existing solids, sharp
and smooth booleans, offsets and shells, TPMS and strut lattices (uniform, graded, conformal), shells with infill, field → mesh with
measured error, lattice export (3MF beam lattice; the new 3MF Volumetric & Implicit extension), and numeric checks (volume, relative
density, minimum wall, trapped powder, connectivity) — all as registered commands with stable codes.

## 2. Industry context & value

### 2.1 How the benchmark tools do it

| Tool | Feature (as named by the vendor) | What it does / options | Known limits (from the vendor's pages) | Source |
| --- | --- | --- | --- | --- |
| nTop (nTopology) | Implicit bodies, **Ramp**, **Plane from Normal**, **Boolean Union**, **Mix**, **Transfer Function**, lattice **thickness** input | Scalar fields drive lattice thickness: a Ramp maps a field's in-min/in-max to out-min/out-max (lesson values: 0–95 mm → 3–8 mm); fields are combined with Boolean Union and Mix | A field needs a finite negative domain for some ops (the lesson thickens a surface by 1 mm first) | [R1] |
| nTop | **Walled TPMS Unit Cell** (with Offset), **Periodic Lattice** (Unit Cell, Cell Map, Unit Cell Parameters) | Library of TPMS cells (enum), orientation, **"Exact thickness"** option that refines wall thickness to the requested value (slower); periodic lattice can be TPMS, graph or custom implicit | Exact thickness is a beta overload and slower | [R2] [R3] |
| Autodesk Fusion | **Volumetric Lattice** (Volumetric properties) | Internal lattice inside a solid or closed mesh body: pick a cell shape, adjust distribution, solidity and offset | One volumetric lattice per component; only in Additive setups; must be converted to a mesh body (Create Mesh) to be used in other workspaces | [R4] |
| PTC Creo (Additive Manufacturing Extension) | **Lattice** feature, formula-driven lattices; representations **Full geometry / Simplified / Homogenized / Volumetric** | Volumetric representation for formula-driven lattices with an accuracy setting; homogenised representation for analysis of dense beam lattices | Full geometry is resource heavy with many cells; simplified is an approximation | [R5] |
| Siemens NX | Three lattice command sets: **graph**, **body**, **TPMS**; implicit modelling | Graph-based, body lattice and TPMS structures; implicit modelling presented as more robust than traditional modelling | — | [R7] |
| Dassault Systèmes (3DEXPERIENCE) | **Lattice Designer** role (CATIA / SOLIDWORKS 3DEXPERIENCE Works) | Rectangular, circular and TPMS (gyroid) cells, custom cells; associative with the CAD model; 2023x adds an assistant and an automated FE model (tets for solid regions, 1D beams for lattice) | Lattice data managed on the 3DEXPERIENCE platform | [R8] [R9] |
| Altair OptiStruct | **Lattice Structure Optimization** | Two phases: topology with reduced penalty, then porous zones become tetra / pyramid-diamond lattice cells from the FE mesh, beam radii sized per joint with automatic Euler buckling constraints (LATPRM, BUCKSF) | Cell size tied to the mesh size; not combinable with shape / free-size / topography / level-set optimisation; no heat transfer or FSI | [R10] |
| Carbon | **Design Engine** | Five conformal lattice types, performance predicted before generation, cloud application | Cloud-based (computation remote) | [R11] |
| Rhino / Grasshopper | **Crystallon** (lattice tools as editable clusters), **Dendro** (OpenVDB volumes: boolean, smoothing, offset, morphing), Rhino 8 **ShrinkWrap** (closed mesh around NURBS, SubD, meshes, points; target edge length, offset, fill holes, smoothing) | Voxel / volume workflows inside Rhino | Crystallon is GPL-3.0, Dendro MPL-2.0 (licences on the repositories) | [R12] [R13] [R14] |
| Blender | Geometry Nodes **Volume to Mesh** | Mesh from a volume at a threshold (iso value); resolution by grid, voxel amount or voxel size; adaptivity reduces faces | — | [R15] |
| Manifold (open source, in llull's dependency tree) | `Manifold.levelSet(sdf, bounds, edgeLength, level, tolerance)` | Marching tetrahedra on a body-centred cubic grid ("better for manifoldness"), level inset/outset, optional vertex refinement to a tolerance | **Positive inside** (llull and 3MF use negative inside); one JS callback per sample in the WASM build | [R16] |
| 3MF Consortium | **Beam Lattice Extension 1.2.0**; **Volumetric & Implicit Extensions 1.0.0** (published 2025-11-13) | Beams = conical frusta between mesh vertices with radii r1/r2, cap modes, balls, clipping mesh; `<levelset>` objects defined by an implicit node graph (sin, min, max, mesh distance, beam-lattice distance …) inside a bounding mesh | Beam lattice: circular sections only; implicit: consumers must support levelset shape | [R17] [R18] |

What "design anything" means here: llull must match the union of these on the agent path — fields from primitives and existing
solids, booleans that never fail, smooth blends with a stated radius, TPMS and strut lattices with exact wall thickness, graded and
conformal lattices, shells with infill, meshes with a stated error, and an export a printer accepts — and add what none of them
offers to an agent: numbers instead of pictures (relative density, minimum wall, trapped volume), stable error codes, and a closing check.

### 2.2 Reference cases used for validation

| Case | Public data / closed form | Used for |
| --- | --- | --- |
| Exact SDFs of sphere, torus, box, capsule | closed forms, brute-force cross-check (`data/sdf_primitives.json`) | VC-IMP-01, 02 |
| Quadratic and exponential smooth minimum | deviation ≤ k/4 and k ln 2, 1-Lipschitz (`data/smooth_min.json`) | VC-IMP-03, 04 |
| Smooth union of two orthogonal half-spaces | setback k, bisector k/4, added area k²/6 (`data/smooth_min.json`) | VC-IMP-05 |
| Gyroid (Schoen 1970), Schwarz P, Schwarz D nodal approximations | equations [R21] [R22] [R23]; volume fraction 1/2 at t = 0 by symmetry; fractions, areas, gradient ratios computed (`data/tpms_*.json`) | VC-IMP-10..14 |
| Simple-cubic strut lattice | ρ = 3π x² − 8√2 x³ from Steinmetz solids [R24] | VC-IMP-15, 16, baseline plan |
| BCC, FCC, octet strut lattices | strut length per cell closed form; exact ρ by quadrature (`data/strut_lattices.json`) | VC-IMP-17 |
| Shell + gyroid infill of a cube | V = 40 672 mm³ exact by symmetry (`data/composites.json`) | VC-IMP-22, 23 |
| Graded gyroid sheet column | ρ = 0.40438 by quadrature (`data/composites.json`) | VC-IMP-24 |
| Field → mesh convergence | marching tetrahedra reference, second order (`data/mesh_convergence.json`) | VC-IMP-20, 21 |

### 2.3 Value

- **Lightweighting and function by numbers:** an agent states a target relative density or wall thickness and gets a part whose
  measured density matches the closed form (VC-IMP-10..17), instead of guessing a slider value.
- **Booleans that do not fail:** field booleans are `min` / `max` of numbers; the classical B-rep failure modes (tangent faces,
  sliver solids, kernel refusals that `blend_union` reports today) do not exist in the field domain.
- **Organic blends with a radius that means something:** the smooth union's radius k is the distance at which the blend leaves each
  face (VC-IMP-05), so "blend 2 mm" is checkable.
- **Small documents:** the document stores the field recipe (a few kB), never the 10⁶–10⁷-triangle lattice mesh, which is
  re-derived on load (LIM-1 measured 11 MB documents from six boolean meshes; a lattice would be far larger).
- **Printable output:** STL / 3MF meshes with a stated error, 3MF beam lattices that slicers rebuild themselves, and the 3MF
  implicit extension that hands the field itself to the printer software.

## 3. Personas & user stories

Operator model per [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md): the **operator** is an AI agent on the `llull`
CLI; the **owner** asks for a result in plain words ("make it lighter with a gyroid inside") and is not assumed to be an engineer; a
**qualified reviewer** appears only when a lattice part is released for a load-bearing, medical or flight use.

| Role | Who | Uses | In this gap |
| --- | --- | --- | --- |
| Operator (primary) | AI agent (Claude Code or similar) | `llull` CLI (`--doc` headless, `--app` live) | Builds fields and lattices in a plan, realises the body, reads `implicit_properties` / `lattice_properties`, ends with `check_implicit`, exports STL / 3MF |
| Owner | Product designer, maker, engineer's manager | Natural language; may watch the desktop app | States the intent ("lighter", "softer here", "1.5 mm skin"); receives volumes, densities, the files and a plain sentence |
| Qualified reviewer (release only) | AM / structures engineer, medical-device engineer | Desktop app review: section views, check report | Accepts a lattice for a load-bearing release (mechanical estimates are `unverified`), human gate |

| # | Story | FR |
| --- | --- | --- |
| US-1 | As the operator, asked "lighten this bracket with a 3 mm gyroid and a 1.5 mm skin", I call `infill_solid` on the bracket and report the new volume and the mass saved from `implicit_properties`. | FR-IMP-20, 23, 30 |
| US-2 | As the operator, I make a blend between three tubes that "looks cast" with `combine_fields` (`blend.radius = 4`) and prove that the blend leaves each tube 4 mm from the joint. | FR-IMP-04, 05 |
| US-3 | As the operator, I fill a heat-exchanger core with a sheet gyroid of 0.6 mm walls and read the wetted area per volume and the relative density. | FR-IMP-10, 11, 31 |
| US-4 | As the operator, I grade a strut lattice from 0.4 mm to 1.2 mm radius by the distance to the bolt faces, and read min / max radius and slenderness. | FR-IMP-13, 15, 16, 32 |
| US-5 | As the operator, I wrap a lattice around a cylindrical sleeve with whole cells around the circumference; a non-integer cell count is refused with a code, not a seam. | FR-IMP-17 |
| US-6 | As the operator, I end every lattice job with `check_implicit`: minimum wall and pore against the printer limits I was given, trapped powder, islands, mesh closedness, resolution adequacy — pass / warn / fail with codes. | FR-IMP-40..44 |
| US-7 | As the operator, I export the lattice as a 3MF beam lattice (small file, slicer rebuilds struts) or as a mesh with the error I state. | FR-IMP-50..53 |
| US-8 | As the owner, I get one sentence: what was made, its mass, what passed, what needs a qualified person. | FR-IMP-62 |
| US-9 | As the qualified reviewer, I open the part in the desktop app, step through section views and the check report, and approve or reject the release; the agent cannot do it for me. | FR-IMP-45, 63 |

## 4. Scope / out of scope

### 4.1 Phases

| Phase | Content |
| --- | --- |
| **MVP** | Field model and engine; SDF primitives (sphere, box, rounded box, cylinder, capsule, torus, cone, plane); `field_from_solid` (any closed llull solid or mesh); sharp booleans and smooth booleans (quadratic, exponential, chamfer) with a stated radius; offset, shell (inside / outside / centred), uniform transforms; TPMS (gyroid, Schwarz P, diamond) sheet / network with thickness, level or target relative density, distance-normalised by default; strut lattices (cubic, BCC, FCC, octet) with constant radius; region clipping; `create_implicit_body` (marching tetrahedra, closed manifold, stated voxel); `implicit_properties`, `lattice_properties`, `evaluate_field`, `check_implicit`; STL / OBJ / 3MF mesh export of the derived body; native Rust engine with the TS engine as small-grid fallback. |
| **V1** | Scalar fields (coordinate, distance to entity / face / point, ramp with clamp and easing, arithmetic, seeded noise) and field-driven thickness / radius / cell size; graded lattices; `infill_solid`; conformal cell maps (cylindrical, spherical, along a NURBS sheet's (u, v) with an offset direction); more TPMS (I-WP, Neovius, Lidinoid, Fischer–Koch S, split P) and strut cells (Kelvin, diamond, BCCZ, FCCZ, re-entrant); `add_graph_lattice` from sketched lines / curves; `section_field` numeric sections; vertex refinement to a tolerance; 3MF **beam lattice** export; density field from a topology study (17 TOP) and FE result fields (05 FEA) as inputs; trapped-powder and connectivity checks with drain-hole suggestions. |
| **V2** | 3MF **Volumetric & Implicit** export (`<levelset>` + implicit node graph); dual contouring / sharp-feature mesher; stochastic (Voronoi) lattices; lattice homogenisation on `llull-voxfe` (effective E, G, ν of a cell, recorded through a trust-model record command); GPU field evaluation (wgpu) for interactive preview; overhang / self-support analysis for a build direction; field → B-rep conversion of simple results via 07 MSH. |

### 4.2 Out of scope

- Space deformations (twist, bend, FFD) of fields and solids: **01 DEF** (a field deformation is a coordinate map; IMP exposes the
  `map` hook, DEF specifies the maps).
- Textures and knurls on faces: **03 WRP** (`add_surface_texture`).
- Mesh repair, decimation, remeshing, mesh → NURBS: **07 MSH** (consumes IMP meshes).
- Topology optimisation itself: physics **17 TOP**; IMP only reads its density field.
- Certified mechanical allowables of lattices: IMP gives estimates flagged `unverified` and `reviewRequired`; test data is the
  owner's responsibility.
- Slicing / build preparation (supports, nesting, toolpaths).

## 5. Functional requirements

Priority: MUST = MVP, SHOULD = V1, COULD = V2. Every FR maps to ≥ 1 VC in `validation/README.md`.

### 5.1 Fields, primitives and booleans

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-IMP-01 | MUST | A **field** is document data: a directed acyclic graph of nodes with parameters that are design intent (radii, sizes, blend radius, cell size, laws), never sampled values. Fields are named, listed, edited and deleted by commands; bodies built from them are re-derived when a field changes (L8). | Parametric replay; small documents. | L8; [R18] (graphs must be acyclic) |
| FR-IMP-02 | MUST | **Sign convention**: signed distance in document length units, **negative inside**, positive outside, stated in every result. Each node reports its distance quality: `exact` (true Euclidean distance), `bound` (1-Lipschitz, never over-estimates the distance) or `approximate` (scaled, e.g. raw TPMS). | Offsets and shells are only uniform on exact fields; agents must know. | [R18] beam-lattice node sign; `data/sdf_primitives.json` |
| FR-IMP-03 | MUST | **SDF primitives**: sphere, box (optional edge rounding), cylinder, capsule, torus, cone, plane / half-space, each placed with `position` + `rotation` like llull solids, exact where a closed form exists. | Building blocks of every implicit model. | `data/sdf_primitives.json` |
| FR-IMP-04 | MUST | **Booleans** union, intersect, subtract on fields (sharp: min / max), with an optional **blend** `{kind: quadratic \| exponential \| chamfer, radius}`; the result's distance quality is reported (sharp booleans of exact fields are `bound`, not exact, inside the region where both act). Lists of operands are accepted. | Booleans that never fail; organic joints. | `data/smooth_min.json` |
| FR-IMP-05 | MUST | The **blend radius is measurable**: for the quadratic blend the surface leaves each operand at distance `radius` from the sharp intersection (tangent setback) and the maximum deviation from the sharp result is radius/4; the command's result data reports both. | "Blend 4 mm" must mean a checkable number. | derived (§5.2 of TECHNICAL_SPEC) |
| FR-IMP-06 | MUST | **Field from an existing solid** (`field_from_solid`): any closed llull solid (primitive, B-rep result through its tessellation at a stated deflection, mesh) becomes a signed distance field (sign by generalised winding number, distance via BVH), so lattices, blends and shells apply to parts made with the rest of llull. Open or non-manifold meshes are refused with a code. | Every vendor starts from the CAD body (Fusion: "solid or closed mesh body"). | [R4] |
| FR-IMP-07 | MUST | **Offset** by a distance and **shell** with a thickness (side inside / outside / centred), with an optional opening (remove the shell where a half-space or face points), uniform on exact fields; on `bound` / `approximate` fields the command warns that the thickness is not uniform. | Skins, walls. | [R1] (thicken), `data/sdf_primitives.json` onion |
| FR-IMP-08 | MUST | **Transforms**: translate, rotate, uniform scale (distance scaled accordingly); non-uniform scale and deformations belong to 01 DEF and downgrade the quality to `approximate`. | Placement without breaking distance. | — |

### 5.2 Lattices

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-IMP-10 | MUST | **TPMS lattices** gyroid, Schwarz P, diamond (MVP) with cell size (scalar or per axis), phase / origin, orientation; form **sheet** (wall around the surface) or **network** (one labyrinth solid); controlled by wall `thickness` (sheet), `level` (network) or `relativeDensity` (target; inverted from the field's own fraction table). | The core TPMS set of every benchmark tool. | [R2] [R5] [R7] [R8]; [R21]–[R23] |
| FR-IMP-11 | MUST | Sheet walls are **distance-normalised by default** (field divided by its gradient norm), so the requested thickness is the wall thickness to first order; `normalize: none` keeps the raw level-set offset and the result reports the wall-thickness ratio over the surface (gyroid and diamond 1.2247, Schwarz P 1.7321 for the raw form). | nTop's "Exact thickness" exists because raw TPMS walls are not uniform. | [R2]; `data/tpms_surface.json` |
| FR-IMP-12 | MUST | The network form at `level = 0` has relative density **exactly 1/2** for gyroid, P and D (each surface splits space into two congruent labyrinths); fractions for other levels and thicknesses follow `data/tpms_volume_fraction.json`. | Closed-form anchor for every TPMS implementation. | [R22]; symmetry derivation |
| FR-IMP-13 | MUST | **Strut lattices** cubic, BCC, FCC, octet (MVP) with cell size and strut radius; struts are cylinders through the nodes (node spheres optional, `nodeRadius`); periodic in the region; strut graph kept for counting and beam export. | Graph / beam lattices of NX, Creo, OptiStruct, Lattice Designer. | [R7] [R10] [R17] |
| FR-IMP-14 | MUST | **Region**: a lattice is clipped to a region field (a body, a box, the inside of a shell); cells cut by the region are kept as clipped, and the clipped strut ends are reported (`danglingStruts`). | Infill of real parts. | [R4] |
| FR-IMP-15 | SHOULD | **Field-driven parameters**: TPMS thickness / level, strut radius and (V2) cell size can be a scalar field instead of a number; the agent reads min / max of the realised value. | Graded lattices: nTop Ramp into thickness. | [R1] |
| FR-IMP-16 | SHOULD | **Scalar fields**: coordinate along an axis, distance to an entity / face / point / plane, ramp (in-min, in-max, out-min, out-max, clamp, easing linear / smoothstep), mix, arithmetic (add, multiply, min, max, clamp), seeded deterministic noise; topology density (17 TOP study id) and FE result (05 FEA case + quantity) as V1 inputs. | Field-driven design as in nTop / Lattice Designer. | [R1] [R9] |
| FR-IMP-17 | SHOULD | **Conformal cell maps**: rectangular (default), cylindrical (whole number of cells around, radial and axial cell size), spherical, and along a NURBS sheet's (u, v) with an offset depth; a map whose periodicity would leave a seam (non-integer cells around) is refused. | Conformal lattices (nTop, Carbon). | [R3] [R11]; `data/composites.json` |
| FR-IMP-18 | SHOULD | **More cells**: TPMS I-WP, Neovius, Lidinoid, Fischer–Koch S, split P; strut Kelvin, diamond, BCCZ, FCCZ, re-entrant; **graph lattice** from sketched lines / polylines / NURBS curves of the document with per-beam end radii. | Coverage of vendor libraries; custom graphs. | [R2] [R8] |
| FR-IMP-19 | COULD | **Stochastic lattice**: Voronoi struts from a seeded point process inside a region, density from a field. | CATIA 2026x Voronoi bars (secondary). | [R9] (search extract) |

### 5.3 Bodies and composites

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-IMP-20 | MUST | **Realise a body** (`create_implicit_body`): field → closed, consistently oriented, manifold triangle mesh entity at a stated voxel size (or a triangle budget), inside stated or automatic bounds; the mesh is derived, read-only (derivation guard) and re-derived from the recipe on load / edit; data reports voxel, triangles, the estimated geometric error and the volume from the field and from the mesh. | One place where the field becomes geometry; printable output. | [R15] [R16] [R20] |
| FR-IMP-21 | MUST | Mesh error is **stated and bounded**: default mesher is marching tetrahedra (always closed and manifold); vertex refinement to a requested tolerance (SHOULD); the volume error of the default mesher converges at second order in the voxel size (`data/mesh_convergence.json`). | "Mesh with a stated error" for agents. | [R16] [R20]; measured |
| FR-IMP-22 | MUST | Implicit bodies take part in the rest of llull: mass properties, booleans with other solids (field domain preferred; the mesh kernel otherwise), render, export; the exact STEP export lists them as skipped with a code (no exact B-rep). | Interoperability without pretending exactness. | KI5 |
| FR-IMP-23 | SHOULD | **Shell with infill** in one command (`infill_solid`): skin of a stated wall on an existing solid, a lattice inside clipped to the skin's inner offset, optional opening and drain holes; composes the commands above via `execute`. | Fusion Volumetric Lattice / Creo lattice infill in one call. | [R4] [R5] |
| FR-IMP-24 | COULD | **Field → B-rep** for results with few faces is delegated to 07 MSH (mesh → NURBS); IMP exposes the mesh and its error only. | Avoid a second fitting stack. | — |

### 5.4 Queries and numbers (AF-21)

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-IMP-30 | MUST | `implicit_properties`: volume (field quadrature at two resolutions with the difference as error estimate, and mesh volume), surface area, relative density in a region, bounds, number of solid components and of enclosed voids; units in every field. | The numbers that replace "looks right". | — |
| FR-IMP-31 | MUST | `lattice_properties`: cells, struts, nodes, total strut length, strut radius min / max, slenderness L/d, node valence, first-order and measured relative density, Maxwell count per cell (stretch- vs bending-dominated); for TPMS: wall thickness min / max, pore (inscribed sphere) diameter, surface area per volume. | Lattice design is driven by these numbers. | `data/strut_lattices.json`, `data/tpms_surface.json`; [R25] (classification) |
| FR-IMP-32 | SHOULD | `section_field`: the section of a field / body by a plane as closed polylines with area, perimeter and solid fraction of the section; the numeric equivalent of looking at a cut. | Internal structure is invisible from outside. | AF-21 |
| FR-IMP-33 | MUST | `evaluate_field`: values, gradients and distance quality at up to 10 000 points, for agents testing their own fields. | Self-verification. | AF-20 |
| FR-IMP-34 | COULD | Mechanical **estimates**: Gibson–Ashby type scaling (E*/Es = C ρ^n with the exponent of the topology class and a coefficient that must be given or comes from a named table) and, V2, numerical homogenisation of a cell on `llull-voxfe`; always `unverified: true`, `reviewRequired: true`. | Early sizing; never an allowable. | [R25] [R26] |

### 5.5 Checks (AF-20, AF-30)

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-IMP-40 | MUST | `check_implicit` read-only check of a body or field: pass / warn / fail list with stable codes. Findings: closed manifold mesh, resolution adequacy (smallest wall or strut < 2 voxels), minimum wall and minimum pore against the process limits, disconnected islands, enclosed voids. | One closing check per job (AF-20). | — |
| FR-IMP-41 | MUST | **Process limits are never invented**: min wall, min pore / powder-removal size and min strut diameter are given by the agent (with a source string) or taken from a named process table entry whose source is cited; absent ⇒ the check warns `IMP_CHECK_NO_PROCESS_LIMITS` and reports the measured values only. | AF-31; no vendor table was verified in this research. | AF-31 |
| FR-IMP-42 | MUST | **Trapped volume**: an enclosed void (no path to the outside through the void) is a fail for powder-bed and resin processes, with its volume, a point inside it and a suggested drain-hole location. | Unprintable / uncleanable parts. | — |
| FR-IMP-43 | SHOULD | **Distance-quality warnings**: offsets or shells taken on `bound` / `approximate` fields, non-uniform transforms, and blends larger than a feature are reported (`IMP_OFFSET_NOT_EXACT`, `IMP_BLEND_EXCEEDS_FEATURE`). | Silent non-uniform walls. | FR-IMP-02 |
| FR-IMP-44 | SHOULD | **Overhang** analysis for a build direction (area below a critical angle) and self-supporting cell orientation hints (COULD). | Printability. | — |
| FR-IMP-45 | MUST | A check with `purpose: "release"` carries `reviewRequired: true` with the reason "lattice acceptance for a load-bearing / medical / flight use is a design-release decision: needs a qualified engineer"; mechanical estimates are always `unverified`. | AF-33. | AF-33 |

### 5.6 Exchange

| Id | Pri | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-IMP-50 | MUST | Realised bodies export through the existing mesh exporters (`export_stl`, `export_obj`, `export_3mf`, `export_gltf`) unchanged; the export reports the triangle count and file size before writing (AF-12). | Printers and slicers take meshes. | — |
| FR-IMP-51 | SHOULD | `export_3mf` with `beamLattice: true` writes strut lattices as a **3MF Beam Lattice** (namespace `http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02`): nodes as vertices, beams with r1 / r2, `minlength`, `radius`, cap mode, the region as `clippingmesh` (clipping mode inside) and the realised mesh as `representationmesh`. | Small files; slicer-native struts. | [R17] |
| FR-IMP-52 | COULD | `export_3mf` with `implicit: "levelset"` writes the field as a **3MF Volumetric & Implicit 1.0** `<levelset>` object (implicit node graph with native nodes; bounding mesh; `minfeaturesize` from the voxel) instead of a mesh. | The printer software evaluates the field: no mesh at all. | [R18] |
| FR-IMP-53 | MUST | `export_step_ap242` lists implicit bodies in `skipped` with `IMP_STEP_NOT_EXACT` (no silent faceted B-rep); the agent is told to export STL / 3MF. | KI5: STEP means exact. | KI5 |
| FR-IMP-54 | COULD | Read a 3MF beam lattice back into a graph lattice (round trip of FR-IMP-51). | Interop. | [R17] |

### 5.7 Non-functional and agent-first requirements

| Id | Pri | Requirement | Measure |
| --- | --- | --- | --- |
| FR-IMP-60 | MUST | Every capability is a registry command reachable from the `llull` CLI and the UI (L1, L5), with agent-written descriptions (what, when, units, refusals, next command) (AF-01, AF-02); one `build_project` plan holds a whole job and validates with `--validate` (AF-05). | VC-IMP-41 |
| FR-IMP-61 | MUST | Every refusal and check finding has a stable code (TECHNICAL_SPEC §7.1), the offending ids / param paths and a one-line remediation (AF-11). | VC-IMP-40 |
| FR-IMP-62 | MUST | Plain-language summary for the owner: what was made, mass / volume, density, what passed, what needs a human (AF-36); `data.provenance` names method, voxel, engine and device (AF-35). | VC-IMP-42 |
| FR-IMP-63 | MUST | Mechanical estimates and anything built from unverified inputs (unpinned meshes, noise fields used as load proxies) carry `unverified`, which propagates to every derived result and `check_implicit` (AF-32). Release acceptance is a human gate through 09 PLM approvals (AF-34). | VC-IMP-43 |
| FR-IMP-64 | MUST | Deterministic: the same plan gives the same field, the same mesh (vertex order included) and the same numbers on the Rust-CPU and TS engines within the stated tolerance; GPU paths say `deterministic: false` (AF-13, RS1 rule 3). | VC-IMP-44 |
| FR-IMP-65 | MUST | Offline and local: everything runs on the desktop (native `llull-compute` job binary, TS fallback); no cloud service (Carbon's model is not followed) (AF-41, LC1). | VC-IMP-45 |
| FR-IMP-66 | MUST | Budgets and bounded output: grid size, triangle count and wall time are checked **before** work (`IMP_GRID_BUDGET`, `IMP_TRIANGLE_BUDGET`) and reported; `--progress` and `--timeout` honoured for realisation (AF-40, AF-12). | VC-IMP-46 |

## 6. Workflows

### 6.1 CLI (primary: the operator agent)

The complete job "lighten this box with a gyroid infill and a 2 mm skin, check, export", headless on a file:

```bash
llull search lattice gyroid infill            # finds add_tpms_lattice, infill_solid, create_implicit_body, check_implicit
llull describe add_tpms_lattice               # params with units: cellSize (mm), thickness (mm), level (field units), relativeDensity (0..1)
llull guide                                   # implicit section: sign convention, distance quality, minimal infill plan
# 1. plan (validation/plans/target_shell_gyroid_infill.json): add_box -> field_from_solid -> shell_field -> add_tpms_lattice
#    -> combine_fields -> create_implicit_body -> implicit_properties -> check_implicit -> export_3mf
llull run infill.plan.json --validate --doc part.llull.json           # names the step path + param on error
llull run infill.plan.json --doc part.llull.json --progress --json    # ids, data, durationMs per step
# 2. numbers, not pictures
llull implicit_properties id=$body --doc part.llull.json --json       # data.volume 40672 mm³, data.relativeDensity, data.errorEstimate
llull section_field '{"field":"$part","plane":{"origin":[0,0,0],"normal":[0,0,1]}}' --doc part.llull.json --json
# 3. closing check: pass/warn/fail with codes, process limits with their source, unverified, reviewRequired
llull check_implicit '{"id":"$body","process":{"minWallMm":0.4,"minPoreMm":1,"source":"owner: printer spec sheet"}}' --doc part.llull.json --json
# 4. look at it (multimodal agents): outside and a section
llull render_view view=iso isolate=$body --doc part.llull.json --save out/part.png
# 5. deliver
llull export_3mf entityIds=$body --doc part.llull.json --save out/part.3mf
```

A design change is one parameter: `llull edit_field id=$infill cellSize=10 --doc …` re-derives the body (L8); steps 2–4 again.
`--dry-run` tries a mutating command without writing the file (AF-42). Any refusal exits 1 with a stable code.

### 6.2 UI (review and approval surface)

The desktop app shows the realised body live with `--app`; the reviewer uses the existing section / clipping views and the
`check_implicit` report; release approval goes through 09 PLM (FR-IMP-45, 63). Menus and forms exist for every command because the UI
iterates `listCommands()`; no capability depends on them. A field preview (coarse mesh while editing a parameter) is a COULD.

## 7. Acceptance criteria

Every criterion runs unattended as a CLI call with `--json` and an assertion against `validation/expected_results.json` (field `cli`).
`D` = `--doc t.llull.json --json`.

| # | Given | When (CLI) | Then (JSON assertion) | VC |
| --- | --- | --- | --- | --- |
| AC-01 | sphere R 10, torus 5/2, box 6×4×2, capsule | `llull evaluate_field` at the pack's sample points `D` | `data.values[i]` equal `data/sdf_primitives.json` within 1e-9; `distanceQuality = "exact"` | VC-IMP-01 |
| AC-02 | quadratic blend radius 2 of two orthogonal half-spaces clipped to a 20×20×10 box | `llull run plans/target_smooth_union_corner.json D` | `data.volume` = 1446.6667 ± 0.1 %; evaluate at (2, 0, 5) and (0, 2, 5) = 0 ± 1e-9 | VC-IMP-05 |
| AC-03 | gyroid / P / D network level 0 in an integer number of cells | `llull implicit_properties` `D` | `data.relativeDensity` = 0.5 ± 2e-3 (mesh) and ± 1e-4 (field quadrature) | VC-IMP-10 |
| AC-04 | gyroid sheet `relativeDensity: 0.3`, normalised | `llull add_tpms_lattice …` then `implicit_properties` | measured ρ = 0.300 ± 0.005; `data.thickness` reported in mm | VC-IMP-12 |
| AC-05 | SC cell a 10, r 1 | `llull run plans/baseline_sc_unit_cell_cylinders.json D` and `plans/target_sc_strut_lattice_cell.json` | volume 82.934 (exact kernel ± 1e-6 rel; mesh ± 0.5 %); `lattice_properties.data.rho1` = 0.0942478 | VC-IMP-15, 16 |
| AC-06 | cube 40, skin 2, gyroid a 12 level 0 | `llull run plans/target_shell_gyroid_infill.json D` and `plans/target_infill_solid_box.json D` | `data.volume` = 40672 ± 0.2 % both; no `fail` finding | VC-IMP-22, 23 |
| AC-07 | graded sheet gyroid column | `llull run plans/target_graded_gyroid_column.json D` | `data.relativeDensity` = 0.40438 ± 0.005; wall min 0.5, max 2.5 mm ± 0.02 | VC-IMP-24 |
| AC-08 | cylindrical map 16 cells around / 6.5 cells around | `llull run plans/target_cylindrical_gyroid_sleeve.json D` / `target_errors.json` step 3 | no seam finding / exit 1 with `IMP_MAP_SEAM` | VC-IMP-25 |
| AC-09 | octet 2×2×2 block, r 0.5 | `llull run plans/target_octet_beam_lattice_3mf.json D` | `lattice_properties.data.beams` = 240, `nodes` = 63; 3MF has 240 `<b:beam>`; volume = ρ_octet(0.05) × 8000 ± 0.5 % | VC-IMP-17, 30 |
| AC-10 | sphere R 10 at voxel 1, 0.5, 0.25 | `create_implicit_body` + `implicit_properties` | mesh volume error ≤ 0.6 %, 0.15 %, 0.04 % and closed manifold | VC-IMP-20 |
| AC-11 | a hollow sphere (sealed cavity) | `llull check_implicit … D` | `fail` with `IMP_TRAPPED_VOID`, void volume = 4/3 π 8³ ± 1 % | VC-IMP-33 |
| AC-12 | every step of `plans/target_errors.json` | each step as its own CLI call | exit 1 and the documented code | VC-IMP-40 |
| AC-13 | any IMP plan run twice / on TS and native engine | compare `--json` | identical ids and meshes per engine; numbers within tolerance across engines | VC-IMP-44 |

## 8. Standards & alignment

| Topic | Alignment |
| --- | --- |
| Lattice exchange | 3MF Beam Lattice Extension 1.2.0 [R17] (beams = conical frusta, radii interpolated linearly, cap modes, clipping mesh). |
| Implicit exchange | 3MF Volumetric & Implicit Extensions 1.0.0, published 2025-11-13 [R18] (levelset with bounding mesh; acyclic node graphs; beam-lattice distance node negative inside). |
| Mesh output | 3MF core (existing `export_3mf`), STL (existing). |
| Iso-surfacing | Marching cubes [R20] (256 cases reduced by symmetry to 14 patterns; linear interpolation), marching tetrahedra (Manifold BCC variant [R16]), dual contouring [R19] (QEF per cell, pseudo-inverse with singular values below 0.1 truncated; manifold only with a safety test). |
| TPMS definitions | Schoen 1970 NASA TN D-5541 [R21]; nodal approximations as in [R22] [R23]. |
| Mechanical scaling | Gibson & Ashby, *Cellular Solids* [R25] (catalogue only: estimates are `unverified`). |
| Regulation | No regulation prescribes lattice design rules; process limits are owner / printer data (FR-IMP-41). Medical or flight use is a qualified-reviewer decision (FR-IMP-45). |

## 9. KPIs / success metrics

| KPI | Target |
| --- | --- |
| Closed-form cases (SDF exactness, smooth-min bounds, 1/2 TPMS fraction, SC density, shell + infill volume, smooth corner volume) | 100 % within tolerance on both engines |
| Mesh error | sphere R 10 at voxel 0.25: volume error ≤ 0.04 %, closed manifold 100 % of realised bodies |
| Performance (native engine, desktop) | 40 mm gyroid-infill cube at voxel 0.2 (≈ 8 × 10⁶ samples) realised ≤ 5 s; TS fallback refuses above its cap with `IMP_GRID_BUDGET` and the native hint |
| Document size | a realised lattice adds ≤ 20 kB to the saved document (recipe only) |
| Agent success | every `validation/plans/target_*.json` runs unchanged and ends with a `check_implicit` without `fail`; 100 % of refusals carry a §7.1 code |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| --- | --- | --- |
| Lattice meshes are huge (10⁶–10⁸ triangles) | Memory, document size, viewport and export time | Store the recipe only; derive on demand with budgets checked before work; 3MF beam / implicit export avoids meshes; decimation by 07 MSH |
| TS evaluation is too slow for real parts | Agent jobs time out | Native Rust engine (`llull-compute field`) with interval pruning is the target path; TS kept for small grids and as the bit-exact oracle (RS1 rule 4) |
| Raw TPMS walls are not uniform (ratio up to 1.73 for Schwarz P) | Walls thinner than asked → print failure | Distance-normalised default; report min / max wall (FR-IMP-11, 31) |
| Smooth booleans and offsets of non-exact fields are not distances | Non-uniform shells | Distance quality on every node; warnings (FR-IMP-02, 43) |
| Process limits differ per printer / material and were not verified here | Wrong pass / fail | Never defaulted silently (FR-IMP-41) |
| Mechanical estimates from scaling laws are crude | Unsafe sizing | `unverified`, `reviewRequired`, V2 homogenisation on llull-voxfe, test data from the owner |
| 3MF implicit extension is new (2025-11) and consumer support is unknown | Files no slicer reads | COULD priority; mesh export always available |
| Manifold's `levelSet` uses positive inside | Sign bugs if used as an oracle | Adapter negates; contract test |

## 11. References

- [R1] nTop — *Follow Along: Field Driven Bracket* (Ramp, Plane from Normal, Boolean Union, Mix, Transfer Function) — https://docs.ntop.com/lessons/intro-to-field-driven-design/follow-along-field-driven-bracket (accessed 2026-10)
- [R2] nTop — *Walled TPMS Unit Cell* block documentation — https://docs.ntop.com/Product-Documentation/ntop/block-documentation/blocks/lattices/unit-cells/walled-tpms-unit-cell (accessed 2026-10)
- [R3] nTop — *Periodic Lattice* lesson — https://docs.ntop.com/lessons/intro-to-lattices/periodic-lattice (accessed 2026-10)
- [R4] Autodesk — Fusion help, *Volumetric properties* (Volumetric Lattice) — https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-VOLUMETRIC-PROPERTIES.htm (accessed 2026-10)
- [R5] PTC — Creo Parametric 10.0 help, *About the Lattice Representation* — https://support.ptc.com/help/creo/creo_pma/r10.0/usascii/part_modeling/part_modeling/About_Lattice_Representation.html (accessed 2026-10)
- [R7] Siemens — *Design with a Purpose: Introduction into Lattice Structures* (NX blog) — https://blogs.sw.siemens.com/nx-design/design-with-a-purpose-introduction-into-lattice-structures/ (accessed 2026-10)
- [R8] Dassault Systèmes SOLIDWORKS blog — *Design Light, But Strong with Lattice Designer* — https://blogs.solidworks.com/products/solidworks/design-light-but-strong-with-lattice-designer/ (accessed 2026-10)
- [R9] 3DEXPERIENCE community wiki — *[CATIA] Lattice Designer* (What's new 2023x) — https://3dswym.3dexperience.3ds.com/wiki/3dexperience-platform-user-s-community/catia-lattice-designer_3oXxnKnTSsadk-aaUBboKA (accessed 2026-10)
- [R10] Altair — OptiStruct help, *Lattice Structure Optimization* — https://help.altair.com/hwsolvers/os/topics/solvers/os/lattice_structure_optimization_intro_r.htm (accessed 2026-10)
- [R11] 3D ADEPT Media — *Carbon Design Engine, software designed to enhance & automate the production of lattices* — https://3dadept.com/carbon-design-engine-software-designed-to-enhance-automate-the-production-of-lattices/ (accessed 2026-10)
- [R12] Crystallon — GitHub repository (GPL-3.0) — https://github.com/GHCrystallon/Crystallon (accessed 2026-10)
- [R13] Dendro — GitHub repository (MPL-2.0, OpenVDB-based) — https://github.com/ryein/dendro (accessed 2026-10)
- [R14] Robert McNeel & Associates — Rhino 8 help, *ShrinkWrap* — https://docs.mcneel.com/rhino/8/help/en-us/commands/shrinkwrap.htm (accessed 2026-10)
- [R15] Blender Foundation — Blender manual, *Volume to Mesh Node* — https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/volume/operations/volume_to_mesh.html (accessed 2026-10)
- [R16] Manifold — `src/sdf.cpp` (LevelSet, Apache-2.0) — https://github.com/elalish/manifold/blob/master/src/sdf.cpp ; local `node_modules/manifold-3d` 3.5.4 type declarations (`Manifold.levelSet`) (accessed 2026-10)
- [R17] 3MF Consortium — *3MF Beam Lattice Extension* 1.2.0 — https://github.com/3MFConsortium/spec_beamlattice (file `3MF Beam Lattice Extension.md`, sha256 f8ef33843748dcf551a1b8e9214d70123c600e29aa2a104ad39d44e9d9fab454) (accessed 2026-10)
- [R18] 3MF Consortium — *3MF Volumetric & Implicit Extensions* 1.0.0 (published 2025-11-13, BSD-2-Clause repository) — https://github.com/3MFConsortium/spec_volumetric (file `3MF Volumetric Extension.md`, sha256 ef2f3e7507d96f11c24be8a00151c19833584282475994802c8247dc07d2ea99) (accessed 2026-10)
- [R19] Ju, T.; Losasso, F.; Schaefer, S.; Warren, J. — *Dual Contouring of Hermite Data*, ACM TOG 21(3), 2002 — https://people.engr.tamu.edu/schaefer/research/dualcontour.pdf (accessed 2026-10)
- [R20] Lorensen, W. E.; Cline, H. E. — *Marching Cubes: A High Resolution 3D Surface Construction Algorithm*, Computer Graphics 21(4), 1987 — https://alecjacobson.com/seminar/lorenson-and-cline-1987.pdf (accessed 2026-10)
- [R21] Schoen, A. H. — *Infinite periodic minimal surfaces without self-intersections*, NASA TN D-5541, 1970 — https://ntrs.nasa.gov/citations/19700020472 (accessed 2026-10)
- [R22] *Gyroid* — Wikipedia — https://en.wikipedia.org/wiki/Gyroid (accessed 2026-10)
- [R23] *Schwarz minimal surface* — Wikipedia — https://en.wikipedia.org/wiki/Schwarz_minimal_surface (accessed 2026-10)
- [R24] Weisstein, E. W. — *Steinmetz Solid*, MathWorld — https://mathworld.wolfram.com/SteinmetzSolid.html (accessed 2026-10)
- [R25] Gibson, L. J.; Ashby, M. F. — *Cellular Solids: Structure and Properties*, 2nd ed., Cambridge University Press, 1997, doi 10.1017/CBO9781139878326 — https://www.cambridge.org/core/books/cellular-solids/preface-to-the-second-edition/4F23FFD7B056693147EEAF3F704F6DFD (catalogue page only, accessed 2026-10)
- [R26] Hsieh, M.-T. et al. — *The mechanical response of cellular materials with spinodal topologies*, arXiv:1904.06733 (abstract) — https://arxiv.org/abs/1904.06733 (accessed 2026-10)

([R6] intentionally unused: the PTC knowledge-base article on lattice STEP export could not be fetched, see `validation/sources.md`.)
