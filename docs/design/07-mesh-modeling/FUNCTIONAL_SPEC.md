# MSH — Mesh modelling for organic, scanned and printed parts — Functional specification

Gap id: **MSH** · Folder: `docs/design/07-mesh-modeling/` · Status: specification (2026-10-22), nothing built ·
Track: "design anything" freeform design (owner request 2026-10-22) · Neighbours: **01 DEF** (whole-body deformation; may
reuse this pack's refinement), **03 WRP** (vector emboss; mesh-only displacement and shrink-wrap projection are here),
**04 DIR** (viewport gestures; a sculpt stroke here is the command a gesture commits), **05 IMP** (fields, SDF, lattices; this
pack's level-set offset uses the same mesher), **06 BLD** (B-rep blends; rounding meshes is here), plant **10 SCN** (point clouds;
this pack starts where a scan is already a triangle mesh).

---

## 1. Summary

A large share of "any shape" arrives as, or is easiest to make as, a **triangle mesh**: a 3D scan, an STL or OBJ from a
download site, a generative-design or topology-optimisation result, a sculpted organic form, a part for a 3D printer. The
reference tools (Fusion Mesh workspace, Rhino, Blender, Meshmixer, Materialise Magics, Geomagic Design X) let a user repair,
simplify, remesh, smooth, shell, cut, combine and sculpt such meshes, and turn them back into exact CAD (faceted, prismatic or
organic B-rep). llull today can **hold** a mesh, but cannot **model** one:

- there is **no file import of a mesh**: `import_mesh` (`packages/core/src/commands/exchange/importMesh.ts`) takes raw
  `positions` / `indices` arrays from the caller and is only used by the STEP import path; no STL, OBJ, PLY or 3MF reader exists
  in `packages/`, `server/` or `src/ui` (a search for an STL parser finds none). Exports exist (`export_stl`, `export_obj`,
  `export_3mf`, `export_gltf`);
- the mesh entity (`MeshSolidEntity`, `model/types.ts`) is a **world-space triangle soup** stored inline in the document JSON
  (cap `MAX_IMPORT_TRIANGLES` = 2 000 000); LIM-1 measured six boolean meshes at 10.7 MB of JSON, so a real scan (10⁶ triangles)
  would make the document unusable;
- there is **no repair, hole filling, decimation, remeshing, smoothing, subdivision, convex hull, Minkowski sum, offset, hollow,
  sculpt brush or mesh-to-B-rep fitting** command. `mesh_to_solid` only recognises **constant-section prisms**; `split_body`
  splits any solid by a plane but keeps both halves and needs a kernel; `boolean` works on meshes, but with the native OCC
  kernel a mesh is sewn into a **polyhedral B-rep with one face per triangle** (`solver/crates/llull-kernel-occt/src/recipe.rs`
  `mesh_solid` → `make_sewn_solid`), which is slow and fragile on scans;
- there is **no mesh health query**: `check_model` has no mesh topology checks, `export_3mf` only reports a per-object
  `manifold` flag.

What llull already has that changes the scope (TECHNICAL_SPEC §1): the **Manifold** kernel (`manifold-3d` 3.5.4, Apache-2.0)
is bundled in the renderer and the server and already exposes hull, Minkowski sum / difference, level sets, smoothing,
refinement, simplification, plane trim / split and genus; a **Catmull-Clark subdivision solid** (`add_subdivision_solid`)
with a custom quad cage that the native kernel turns into **exact bicubic B-spline faces**, so "quad remesh → cage →
B-rep" needs a remesher and a cage fit, not a new surface type; the **scan plugin**'s native RANSAC / Levenberg-Marquardt
primitive fits and content-addressed asset store; `measure_deviation`, the BVH distance engine (`meshBvh.ts`,
`llull-geomq`) and the wall-thickness ray check.

This gap closes the difference: an agent can be asked "take this scanned STL, make it watertight, smooth it, hollow it to
1.2 mm, flatten the base and give me a 3MF", "round this cube by 2 mm with a Minkowski sum", "turn this scan of a bracket
into a STEP with real planes and holes" or "sculpt a bump here", and prove each result with numbers.

## 2. Industry context & value

### 2.1 How the reference tools do it today

| Tool                               | Feature (name in the product)                                                        | Options / behaviour (from the official help)                                                                                                                                                                                                                                                                                | Known limits                                                       | Source                |
| ---------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------- |
| Autodesk Fusion (Mesh workspace)   | **Repair**                                                                           | Close Holes (fastest, "fewest number of changes"), Stitch and Remove (+ double triangles, degenerate faces, tiny shells), One Touch Fix, **Wrap** ("all inner structures are destroyed"), **Rebuild** (Fast, Preserve Sharp Edges, Accurate with Offset + Adaptive, Blocky; Density); Small Shell and Degenerate thresholds | Wrap / Rebuild replace the topology                                | [R3]                  |
| Fusion                             | **Remesh**                                                                           | Adaptive vs Uniform, Density, Shape Preservation, Preserve Sharp Edges, Preserve Boundaries                                                                                                                                                                                                                                 | —                                                                  | [R4]                  |
| Fusion                             | **Reduce**                                                                           | Tolerance (max deviation in design units), Proportion (% of faces), Face Count; Adaptive / Uniform                                                                                                                                                                                                                          | Reducing scans loses hole accuracy (user report, not used)         | [R5]                  |
| Fusion                             | **Smooth, Shell, Plane Cut, Combine, Reverse Normal, Erase and Fill**                | Plane Cut: Trim, Split Body, Split Faces, with a fill type for watertight bodies; Combine: join / intersect / cut / merge                                                                                                                                                                                                   | —                                                                  | [R2]                  |
| Fusion                             | **Convert Mesh**                                                                     | Faceted (one face per triangle), **Prismatic** (face groups → single faces), **Organic** (T-spline form, by accuracy or face number; extension); Parametric vs Base Feature; watertight → solid, else surface body                                                                                                          | Organic needs an extension; prismatic needs face groups            | [R1]                  |
| Rhino 8                            | **QuadRemesh**                                                                       | Target Quad Count or Edge Length, Adaptive Size 0–100, Detect Hard Edges (> 30°), Symmetry Axis, Guide Curves (edge ring / loop), Convert to SubD, **Interpolate SubD** (SubD passes through the mesh vertices, for reverse engineering)                                                                                    | "Re-meshing would fail if the target edge length is set too large" | [R6]                  |
| Rhino 8                            | **ToNURBS**                                                                          | Mesh → NURBS faces (TrimTriangularFaces); SubD → NURBS Packed / Unpacked; ExtraordinaryVertex G0 / G1 / G2                                                                                                                                                                                                                  | Extraordinary vertices only approximated                           | [R12]                 |
| Rhino 8                            | **ShrinkWrap**                                                                       | Wraps meshes, NURBS, SubD, point clouds into a valid closed mesh: Target Edge Length, Offset, Smoothing Iterations, Polygon Optimization, Inflate Vertices and Points, Fill Holes                                                                                                                                           | —                                                                  | [R7]                  |
| Rhino 8                            | **ReduceMesh**, **MeshRepair**, **OffsetMesh**, **Smooth**                           | Reduce to N polygons / by %, Accuracy 1–10, locked points; MeshRepair checks degenerate faces, zero-length edges, duplicate faces, non-manifold edges, inconsistent normals, disjoint pieces, with Fill Hole tools; OffsetMesh Solid / BothSides / direction method; Smooth factor, steps, Fix Boundaries                   | "Many steps and small factor are preferable"                       | [R8] [R9] [R10] [R11] |
| Blender                            | **Remesh** modifier                                                                  | Blocks, Smooth, Sharp, **Voxel** (OpenVDB, keeps volume), Adaptivity, Octree Depth, Remove Disconnected                                                                                                                                                                                                                     | Flat input needs thickness first                                   | [R13]                 |
| Blender                            | **Decimate** modifier                                                                | Collapse (Ratio, Symmetry, Triangulate, vertex group), Un-Subdivide, Planar (Angle Limit, Delimit)                                                                                                                                                                                                                          | —                                                                  | [R14]                 |
| Blender                            | **Sculpt brushes**                                                                   | Draw, Clay, Crease, Inflate, Grab, Smooth ("shrinks volumes by averaging"), Pinch, Snake Hook, Layer, and ~25 more                                                                                                                                                                                                          | Snake Hook "works best with Dyntopo"                               | [R15]                 |
| Autodesk Meshmixer                 | **Remesh**, **Make Solid**                                                           | Target edge length (approximate), Adaptive Density, Regularity, Preserve Sharp Edges, boundary modes; Make Solid voxelises (Fast, Accurate = signed distance field, Blocky, Sharp Edge Preserve), Offset Distance ("positive … outer shells"), Min Thickness                                                                | Last release 2018 (vendor claim, not used)                         | [R16] [R17]           |
| Materialise Magics                 | **Fix** tools                                                                        | Inverted normals, near bad edges (stitch tolerance, max gap), holes (planar / ruled / freedom fill), noise shells, intersecting triangles                                                                                                                                                                                   | —                                                                  | [R18]                 |
| SOLIDWORKS ScanTo3D                | **Mesh Prep Wizard**, **Surface Wizard**                                             | Point cloud → mesh → automatic surface bodies, then knit to a solid                                                                                                                                                                                                                                                         | "not a complete reverse engineering tool" (reseller)               | [R19] (B)             |
| Geomagic Design X                  | **Region** segmentation, **Accuracy Analyzer**, boundary-fit surfacing, LiveTransfer | Regions group triangles for alignment and feature fitting; deviation solid vs mesh                                                                                                                                                                                                                                          | —                                                                  | [R20] (B)             |
| Siemens Parasolid (NX, Solid Edge) | **Convergent Modeling**                                                              | Facet B-rep and classic B-rep in one model; add precise analytic surfaces to scanned data                                                                                                                                                                                                                                   | —                                                                  | [R21] (B)             |
| nTop                               | **Simplify Mesh by Threshold**                                                       | Reduce faces "as much as possible" within a distance threshold; remesh imported meshes first                                                                                                                                                                                                                                | —                                                                  | [R22]                 |

Not benchmarked (official pages not fetched in this session, grade C, no requirement depends on them): CATIA (Digitized Shape
Editor, Imagine & Shape), Creo (Restyle), Onshape (mesh import and booleans).

### 2.2 What "design anything" means here

The best of the benchmark, on the CLI agent path: **(1)** any mesh file in with explicit units; **(2)** a numeric health report;
**(3)** one-call repair modes from minimal (close holes) to destructive (wrap / rebuild); **(4)** decimate by deviation, remesh by
edge length, smooth without shrinkage; **(5)** constructive mesh ops a B-rep kernel does not offer — convex hull, Minkowski
sum / difference, level-set offset and hollow; **(6)** plane cut with caps and booleans that never fail on dirty input;
**(7)** sculpt brushes as replayable commands; **(8)** back to exact CAD in three grades — faceted, prismatic (analytic faces
fitted to regions) and organic (quad remesh → subdivision cage → B-spline). Every step reports how far the result moved from
its input.

### 2.3 Value

- **Scans and downloads become usable parts** (print, boolean, assembly) instead of display-only references.
- **3D printing**: watertight + hollow + drain holes + flat base + wall-thickness check, the core Meshmixer / Magics job, in one
  plan an agent can rerun on every new file.
- **Organic design**: sculpt + quad remesh + B-spline output gives llull a Fusion "Organic" / Rhino "QuadRemesh → ToNURBS"
  equivalent on the exact kernel that already exists (`add_subdivision_solid`).
- **Rounding / growing / shrinking any shape** (Minkowski, offset) is the simplest way to make clearances, moulds, soft-jaws
  and gaskets around arbitrary geometry.

## 3. Personas & user stories

Operator model per [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md): the **operator** is an AI agent on the
`llull` CLI; the **owner** asks in plain language and is not assumed to know mesh processing; a **qualified reviewer** appears
only when a mesh-derived result is used for inspection acceptance (scan vs design) or a release.

| #     | Story                                                                                                                                                                                | FR         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| US-1  | As the operator, I import `part.stl` with `units=mm` and read `analyze_mesh` (triangles, open edges, non-manifold edges, shells, genus, volume if closed) before touching it.        | 01, 03     |
| US-2  | As the operator, I run `repair_mesh mode=stitch` then `fill_mesh_holes` and confirm `closed: true` and the volume, instead of guessing from a picture.                               | 05–07      |
| US-3  | As the operator, I make a 2 M-triangle scan light enough to work with: `decimate_mesh maxDeviation=0.05` and read the achieved Hausdorff distance.                                   | 08, 25     |
| US-4  | As the operator, I smooth scan noise with Taubin smoothing and read that the volume changed by less than 0.2 %.                                                                      | 10         |
| US-5  | As the operator, I hollow a figurine to 1.2 mm with two drain holes, cut a flat base and run `check_mesh purpose=print`.                                                             | 15, 16, 26 |
| US-6  | As the operator, I round a box by 2 mm with `minkowski_sum`, make a 0.3 mm clearance shell with `offset_mesh`, and wrap a set of parts with `convex_hull`.                           | 12–14      |
| US-7  | As the operator, I apply a sculpt stroke (`sculpt_mesh brush=inflate`) with symmetry, and it replays identically when the history regenerates.                                       | 18, 19     |
| US-8  | As the operator, I turn a scanned bracket into a STEP: `segment_mesh`, then `mesh_to_brep mode=prismatic`; I read each fitted plane / cylinder and its residual.                     | 20, 21     |
| US-9  | As the operator, I turn a sculpted organic mesh into exact B-spline faces with `quad_remesh` + `fit_subdivision_to_mesh`, and read the max deviation.                                | 22, 23     |
| US-10 | As the owner, I get one sentence: what was done, how far the result is from the input, what still needs a human.                                                                     | 31, 32     |
| US-11 | As the qualified reviewer (inspection only), I look at the deviation colour map in the desktop app built from the same numbers and accept or reject; the agent cannot accept for me. | 32, 37     |

## 4. Scope / out of scope

### 4.1 Phases

| Phase   | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MVP** | File import (STL / OBJ / PLY / 3MF) with units; mesh library (weld, adjacency, half-edge, loops, components); `analyze_mesh`, `check_mesh`; `repair_mesh` (weld, duplicates, degenerate, orient, small shells, stitch, close holes); `fill_mesh_holes` (Liepa triangulation + refine + fair); `decimate_mesh` (QEM); `remesh_mesh` (isotropic); `smooth_mesh` (Laplacian, Taubin); `convex_hull`; `minkowski_sum`; `cut_mesh`; mesh-engine routing for `boolean`; symmetric deviation; the `MeshProcessingEngine` port with the TypeScript engine (small meshes). |
| **V1**  | Native engine `llull-meshops` (`llull-compute meshops`) for large meshes; content-addressed mesh assets + display LOD; `offset_mesh`, `hollow_mesh`, `repair_mesh mode=wrap` (level set); adaptive remesh; `sculpt_mesh` (draw, inflate, grab, smooth, flatten, pinch, crease, layer); `segment_mesh` + `mesh_to_brep` (faceted, prismatic); `subdivide_mesh`.                                                                                                                                                                                                    |
| **V2**  | `quad_remesh` + `fit_subdivision_to_mesh` (organic B-rep); `fit_surface_to_mesh` (single NURBS patch); dynamic-topology sculpt; `shrinkwrap_mesh`, `displace_mesh` (height map); guide curves for quad remesh.                                                                                                                                                                                                                                                                                                                                                    |

### 4.2 Out of scope

- Point-cloud import, registration and surface reconstruction from points (plant 10 SCN; Poisson reconstruction is a COULD
  there). This pack starts from triangles.
- Implicit / SDF modelling, lattices, TPMS, 3MF beam lattice (05 IMP). This pack uses a level-set mesher only for offset, hollow
  and wrap.
- Volumetric (tetrahedral) meshing for FEA (05 FEA `fea_mesh`, Gmsh / Netgen).
- Texture / UV / colour editing beyond keeping per-body colour; vertex colours are dropped on import (reported).
- Viewport gesture mechanics (04 DIR); B-rep face blends (06 BLD).

## 5. Functional requirements

Priority: MUST = MVP, SHOULD = V1, COULD = V2. Every FR maps to ≥ 1 VC in `validation/README.md`.

### 5.1 Input, representation, inspection

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                        | Rationale                                                                                                | Source                                                |
| --------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| FR-MSH-01 | MUST   | **Import a mesh file** (`import_mesh_file`): STL ASCII and binary, OBJ (triangles and polygons, fan-triangulated), PLY (ASCII / binary little- and big-endian), 3MF (core mesh objects); weld coincident vertices within a stated tolerance; report triangles, welded vertices, dropped attributes, open / non-manifold edges, shells. Units are **required** for unitless formats (STL, OBJ, PLY); 3MF units come from the file.                  | Every benchmark tool starts with file import; llull has none.                                            | [R1] [R2]; `importMesh.ts`                            |
| FR-MSH-02 | SHOULD | **Large meshes as assets**: above an inline cap the triangles live in a content-addressed local asset (sha256), the document holds a reference plus a display level of detail; every command reads the full-resolution asset; replay without the asset refuses with a stable code.                                                                                                                                                                 | A 10⁶-triangle scan inline is > 100 MB of JSON (LIM-1 scale); the scan plugin already uses this pattern. | `docs/decisions/LIM1-scale.md`; plant 10 TR-SCN-01/04 |
| FR-MSH-03 | MUST   | **`analyze_mesh`** (read-only): vertex / edge / face counts, Euler characteristic, genus per shell, boundary loops (edge count, length, centroid), non-manifold edges and vertices, shells (count, faces, volume each), orientation consistency, degenerate and duplicate faces, self-intersecting triangle pairs (count + first n), area, volume and centroid when closed, edge-length and triangle-quality (aspect ratio, min angle) statistics. | Numeric equivalent of the inspector colour spheres (Meshmixer) and the MeshRepair panel (Rhino) (AF-21). | [R9] [R18]                                            |
| FR-MSH-04 | COULD  | Mesh primitive helpers `add_icosphere_mesh` (radius, level) and `add_grid_mesh` (size, cells) so an agent can make test and starting meshes without computing triangles.                                                                                                                                                                                                                                                                           | Plans stay design intent (L8).                                                                           | —                                                     |

### 5.2 Repair

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                                                                                                                                                            | Rationale                                                                            | Source                |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------- |
| FR-MSH-05 | MUST   | **`repair_mesh`** with named modes in increasing intrusiveness: `weld`, `clean` (duplicates, degenerate, zero-length edges), `orient` (consistent outward winding per shell), `stitch` (close gaps ≤ `maxGap`, then `clean`), `close_holes` (`stitch` + `fill_mesh_holes`), `remove_small_components` (by faces or volume); each reports what it changed with counts and the deviation from the input. | Fusion Close Holes / Stitch and Remove, Rhino MeshRepair, Magics Fix.                | [R3] [R9] [R18]       |
| FR-MSH-06 | MUST   | **`fill_mesh_holes`**: select loops (`all`, by index from `analyze_mesh`, by a point near the loop, or up to `maxBoundaryEdges`); triangulate (minimum-area / dihedral weight), **refine** to the surrounding edge density and **fair** (`none`, `tangent`, `curvature`); report per loop the triangles added and the patch area.                                                                      | Liepa 2003 is the reference method; OpenMesh and others implement it.                | [R26]                 |
| FR-MSH-07 | SHOULD | **`repair_mesh mode=wrap`**: rebuild a closed manifold envelope from any soup (self-intersections, inner shells, open parts) by a level set at a stated resolution / vertex tolerance; inner structures are destroyed and the result says so.                                                                                                                                                          | Fusion Wrap / Rebuild, Meshmixer Make Solid, Rhino ShrinkWrap, Blender Voxel remesh. | [R3] [R7] [R13] [R17] |

### 5.3 Simplify, remesh, smooth

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                                                            | Rationale                                                                                                | Source                      |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------- |
| FR-MSH-08 | MUST   | **`decimate_mesh`** by quadric error (Garland–Heckbert): stop at `targetTriangles`, `ratio` or `maxDeviation` (document units, absolute); `preserveBoundary`, `preserveFeatureAngleDeg`, locked region; never creates fold-overs or non-manifold edges; reports reached count and symmetric deviation. | Fusion Reduce (Tolerance / Proportion / Face Count), Rhino ReduceMesh, Blender Collapse, nTop threshold. | [R5] [R8] [R14] [R22] [R23] |
| FR-MSH-09 | MUST   | **`remesh_mesh`**: isotropic (target edge length) by split / collapse / flip / tangential relaxation / projection (Botsch–Kobbelt); adaptive (min / max edge, approximation error); keep feature edges above an angle and boundaries; region restriction; report edge-length statistics and deviation. | Fusion Remesh, Meshmixer Remesh, PMP library.                                                            | [R4] [R16] [R25] [R27]      |
| FR-MSH-10 | MUST   | **`smooth_mesh`**: `laplacian` (λ), `taubin` (λ, pass band kPB, μ derived), weights uniform or cotangent; fixed boundary; region; optional volume correction; report volume change and mean displacement. Taubin is the default because Laplacian smoothing shrinks (VC-MSH-08).                       | Blender Smooth "shrinks volumes"; Taubin λ\|μ removes shrinkage.                                         | [R11] [R15] [R24]           |
| FR-MSH-11 | SHOULD | **`subdivide_mesh`**: `midpoint` (linear), `loop`, and `smooth` (tangent-based refinement to a length or tolerance); feature edges kept sharp.                                                                                                                                                         | Refinement before sculpting / offset; Manifold refine APIs.                                              | [R28]                       |

### 5.4 Constructive operations

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                  | Rationale                                                                                                      | Source      |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------- |
| FR-MSH-12 | MUST   | **`convex_hull`** of any 3D entities and / or explicit points → one closed mesh; reports vertices, faces, volume.                                                                                                                                            | Wrapping, packaging volumes, collision proxies; Manifold `hull`.                                               | [R28]       |
| FR-MSH-13 | MUST   | **`minkowski_sum`** `op: sum` (dilation) or `difference` (erosion) of two closed meshes / solids; exact for convex operands, decomposition-based for non-convex; refuses open meshes.                                                                        | Rounding / growing any shape, tool clearance, mould cavities; Manifold `minkowskiSum` / `minkowskiDifference`. | [R28]       |
| FR-MSH-14 | MUST   | **`offset_mesh`**: signed distance (outward +, inward −), `method: level_set` (robust, rounded outward corners, sharp inward) with a vertex tolerance, or `normal` (vertex normals, small distances, open meshes allowed) ; report the method's error bound. | Rhino OffsetMesh, Meshmixer offset shells.                                                                     | [R10] [R17] |
| FR-MSH-15 | SHOULD | **`hollow_mesh`**: inward shell of `wallThickness` with a sealed cavity or `drainHoles` (position, diameter); reports material volume.                                                                                                                       | Fusion Shell, print preparation.                                                                               | [R2]        |
| FR-MSH-16 | MUST   | **`cut_mesh`** by a plane: `keep` positive / negative / both, `cap` (planar fill of every section loop, holes respected) or open; works without a B-rep kernel and on open meshes.                                                                           | Fusion Plane Cut (Trim, Split Body, Split Faces, fill type).                                                   | [R2]        |
| FR-MSH-17 | MUST   | **Mesh booleans that do not depend on the B-rep kernel**: `boolean` on triangle-only meshes uses the mesh engine (guaranteed-manifold output) even when the native OCC kernel is installed; an explicit `engine` param overrides.                            | Fusion Combine on mesh bodies; Manifold "guaranteed manifold output".                                          | [R2] [R28]  |

### 5.5 Sculpting

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                     | Rationale                             | Source      |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------- |
| FR-MSH-18 | SHOULD | **`sculpt_mesh`**: brushes `draw`, `inflate`, `grab`, `smooth`, `flatten`, `pinch`, `crease`, `layer`; stamps (points on the surface) or a stroke along a curve entity with spacing; `radius`, `strength` (document units), `falloff` (`constant`, `linear`, `smooth`, `sphere`), direction (normal / view / vector), mirror symmetry, mask (region), optional local refinement so detail is possible (dynamic topology COULD). | Blender / Meshmixer sculpting.        | [R15]       |
| FR-MSH-19 | SHOULD | One stroke = one command = one history step; strokes replay identically (L8); the desktop app's brush gesture (04 DIR) previews locally and commits exactly this command.                                                                                                                                                                                                                                                       | Prime directive; agent and UI parity. | `CLAUDE.md` |

### 5.6 Back to exact CAD

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                                                                          | Rationale                                                                | Source           |
| --------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------- |
| FR-MSH-20 | SHOULD | **`segment_mesh`** (read-only): split the mesh into face groups by normal / curvature region growing; fit each group with the best of plane, cylinder, cone, sphere, torus or `freeform`, with parameters, RMS and max residual, and adjacency.                                                                      | Fusion face groups, Design X regions.                                    | [R1] [R20]       |
| FR-MSH-21 | SHOULD | **`mesh_to_brep`**: `faceted` (one planar face per triangle; exists implicitly today), `prismatic` (each analytic group → one exact face, trimmed by its neighbours and sewn; residual per face; falls back per group to faceted) on the exact kernel; reports deviation from the mesh. Generalises `mesh_to_solid`. | Fusion Convert Mesh Faceted / Prismatic; Parasolid convergent modelling. | [R1] [R21]       |
| FR-MSH-22 | COULD  | **`quad_remesh`**: field-aligned quad remeshing with target quad count or edge length, adaptive size, hard-edge detection angle, symmetry axis; output a `subdivision` cage or a quad mesh.                                                                                                                          | Rhino QuadRemesh, QuadriFlow, Instant Meshes.                            | [R6] [R33] [R34] |
| FR-MSH-23 | COULD  | **`fit_subdivision_to_mesh`**: move cage vertices so the Catmull–Clark limit surface fits the target mesh within `maxDeviation` (or interpolates its vertices); the existing native path then gives exact B-spline faces.                                                                                            | Rhino Interpolate SubD + ToNURBS; Fusion Organic.                        | [R6] [R12] [R1]  |
| FR-MSH-24 | COULD  | **`fit_surface_to_mesh`**: one NURBS patch fitted to a mesh region (degree, control grid, smoothing), as a `nurbs_surface`.                                                                                                                                                                                          | Design X boundary-fit surfacing.                                         | [R20]            |

### 5.7 Measurement, checks, exports

| Id        | Pri  | Requirement                                                                                                                                                                                                                                      | Rationale                                                                          | Source                         |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------ |
| FR-MSH-25 | MUST | **Deviation**: `measure_deviation` gains `symmetric: true` (Hausdorff both ways, mean, RMS, histogram, worst points) for mesh ↔ mesh and mesh ↔ solid; every mutating mesh command reports its own deviation from its input in `data.deviation`. | Accuracy Analyzer (Design X); decimate / remesh must say how much shape they lost. | [R20]                          |
| FR-MSH-26 | MUST | **`check_mesh`** (AF-20): pass / warn / fail findings with codes for `purpose` `print` (closed, manifold, oriented, no self-intersection, min wall thickness, small shells), `boolean`, `fit`, `export`; tolerances named.                       | The agent ends every mesh job with it.                                             | AF-20, AF-30                   |
| FR-MSH-27 | MUST | Exports (`export_stl`, `export_obj`, `export_3mf`, `export_gltf`) keep working on every result; asset-backed meshes export at full resolution, never the LOD.                                                                                    | Round trip to slicers and other tools.                                             | `exportStl.ts`, `export3mf.ts` |

### 5.8 Non-functional and agent-first

| Id        | Pri    | Requirement                                                                                                                                                                                                          | Measure       |
| --------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| FR-MSH-28 | MUST   | Determinism: the same plan gives bit-identical meshes (vertex order included) on replay and across the TypeScript and native engines.                                                                                | VC-MSH-21, 32 |
| FR-MSH-29 | MUST   | Units: every length param in document units; file units explicit (`units` param or the 3MF unit); no silent conversion; scale factor reported.                                                                       | VC-MSH-03     |
| FR-MSH-30 | MUST   | Every refusal and check failure carries a stable `MESH_*` code, offending ids / param paths and a one-line remediation (AF-11).                                                                                      | VC-MSH-26     |
| FR-MSH-31 | MUST   | Results in `data` with units on every number, bounded output (loops and pairs truncated with counts), and `provenance` {algorithm, reference, engine, params, input sha256} (AF-10, AF-35).                          | VC-MSH-27, 33 |
| FR-MSH-32 | MUST   | Imported meshes without a pinned source are `unverified`; the flag propagates to every derived mesh, B-rep and query; a deviation report with `purpose: "inspection"` carries `reviewRequired: true` (AF-32, AF-33). | VC-MSH-27     |
| FR-MSH-33 | MUST   | No silent tolerances: weld tolerance, feature angle, level-set resolution, maxGap are given or taken from named defaults reported with `defaulted: true` and their source (AF-31).                                   | VC-MSH-27     |
| FR-MSH-34 | MUST   | Large meshes run on the native engine with progress and timeout (AF-40); the TypeScript engine has a stated triangle cap and refuses above it with a code and the install hint.                                      | VC-MSH-29     |
| FR-MSH-35 | MUST   | Every capability is a registry command, expressible in one `build_project` plan and checkable with `--validate` (AF-01, AF-05).                                                                                      | VC-MSH-26, 33 |
| FR-MSH-36 | SHOULD | `llull guide` gains a mesh section: units on import, the clean-up order (analyze → repair → fill → smooth → decimate / remesh → check), when to use which repair mode, how to read deviation (AF-03).                | VC-MSH-33     |
| FR-MSH-37 | SHOULD | Review overlays in the desktop app (boundary loops, non-manifold edges, face groups, deviation colour map) built only from the query `data`; never change the document.                                              | VC-MSH-34     |
| FR-MSH-38 | COULD  | **`shrinkwrap_mesh`**: project the vertices of a mesh onto a target mesh / solid (nearest point or along a direction) — the Blender Shrinkwrap case handed over by 03 WRP.                                           | VC-MSH-38     |
| FR-MSH-39 | COULD  | **`displace_mesh`**: move vertices along their normal by a height map image (grey value → height range) or a scalar expression; refines first to a stated edge length.                                               | VC-MSH-39     |

## 6. Workflows

### 6.1 CLI (primary)

Scanned STL to a print-ready, checked 3MF, headless on a file:

```bash
llull search mesh repair                     # import_mesh_file, analyze_mesh, repair_mesh, fill_mesh_holes, check_mesh ...
llull describe decimate_mesh                 # params with units (maxDeviation in document units)
llull import_mesh_file file=scan.stl units=mm name=scan --doc p.llull.json --json   # triangles, welded vertices, open edges
llull analyze_mesh id=$scan --doc p.llull.json --json                                # loops, non-manifold, shells, genus
llull run validation/plans/target_scan_cleanup_to_print.json --validate --doc p.llull.json
llull run validation/plans/target_scan_cleanup_to_print.json --doc p.llull.json --progress --json
llull check_mesh '{"ids":["$scan"],"purpose":"print","minWallThickness":0.8}' --doc p.llull.json --json
llull render_view view=iso isolate=$scan --doc p.llull.json --save out/scan.png      # look at it (AF-22)
llull export_3mf entityIds=[$scan] --doc p.llull.json --save out/part.3mf
```

Large scans (V1): `llull mesh import scan.stl --units mm --json` writes the asset and prints its key (same pattern as
`llull scan import`), then `attach_mesh_asset assetKey=…`; the same commands run on the native engine. Scan to STEP (V1):
`segment_mesh` → read the groups → `mesh_to_brep mode=prismatic` → `mass_properties` (method exact) → `export_step`.
Organic to STEP (V2): `remesh_mesh` → `quad_remesh` → `fit_subdivision_to_mesh` → `export_step`. Every refusal exits 1 with a
`MESH_*` code (TECHNICAL_SPEC §7.1); `--dry-run` tries a mutating command without writing (AF-42).

### 6.2 UI (review surface)

The desktop app shows the meshes live with `--app`. Review overlays (FR-MSH-37) highlight boundary loops, non-manifold edges,
face groups and deviation maps from the same `data`. The sculpt brush gesture (04 DIR) previews locally and commits one
`sculpt_mesh` call on release. Menus and dialogs come from `listCommands()`; nothing depends on them.

## 7. Acceptance criteria

`D` = `--doc t.llull.json --json`; values from `validation/expected_results.json`.

| #     | Given                                   | When (CLI)                                                    | Then                                                                                       | VC            |
| ----- | --------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------- |
| AC-01 | icospheres R 10, levels 0–6             | `analyze_mesh D`                                              | area / volume = polyhedral values ± 1e-9 rel; error ratio → 4 per level                    | VC-MSH-01     |
| AC-02 | icosphere, torus 32×16, open hemisphere | `analyze_mesh D`                                              | χ 2 / 0 / —, genus 0 / 1, boundary loops 0 / 0 / 1                                         | VC-MSH-02     |
| AC-03 | pinned STL fixtures (sha256)            | `import_mesh_file units=mm D`                                 | 80 triangles, 42 welded vertices, volume ± 1e-9 rel; `units=in` scales by 25.4             | VC-MSH-03     |
| AC-04 | `data/defect_mesh.json`                 | `run plans/target_defect_repair.json D`                       | counts 2 / 3 / 1 / 1 loop / 2 shells; after repair 320 faces, closed, volume 4047.04467998 | VC-MSH-04     |
| AC-05 | grid with an 8-edge hole                | `fill_mesh_holes D`                                           | 6 triangles, area 100 ± 1e-9                                                               | VC-MSH-05     |
| AC-06 | planar grids                            | `decimate_mesh targetTriangles=40 D`                          | area exact, distance from plane 0                                                          | VC-MSH-06     |
| AC-07 | clean / noisy icosphere l4              | `smooth_mesh method=taubin …` and `laplacian`                 | mean radius and volume = reference run ± 1e-9 rel                                          | VC-MSH-08, 09 |
| AC-08 | icosphere R 10                          | `remesh_mesh targetEdgeLength=1 D`                            | max edge ≤ 4/3, chord deviation ≤ 0.0296737                                                | VC-MSH-10     |
| AC-09 | point sets                              | `convex_hull D`                                               | volumes 1000 / 17.453559925 / torus bound                                                  | VC-MSH-11     |
| AC-10 | cube 10, icosphere r 2 l2               | `minkowski_sum D`                                             | volume 2601.81399162 ± 1e-9 rel; cube⊕cube 2197; cube⊖cube 343; cube⊖ball 216              | VC-MSH-12–14  |
| AC-11 | sphere R 10, cube 10                    | `offset_mesh`, `hollow_mesh D`                                | volumes within the A·ε bound                                                               | VC-MSH-15, 16 |
| AC-12 | unit cube                               | `cut_mesh … cap=true D`                                       | volumes 0.5 / 1/6 / 0.25 + 0.75, cap areas 3√3/4, √3/2, 1                                  | VC-MSH-17     |
| AC-13 | two cubes, native OCC kernel installed  | `boolean engine=auto D`                                       | 15 / 7 / 1 and areas 42 / 24 / 6; result has no `brep`                                     | VC-MSH-18     |
| AC-14 | flat grid                               | `sculpt_mesh brush=draw falloff=… D`                          | displaced volume = discrete values ± 1e-9 rel; mirror error ≤ 1e-12                        | VC-MSH-19–21  |
| AC-15 | tessellated plate with hole             | `segment_mesh`, `mesh_to_brep mode=prismatic --kernel occt D` | 6 planes + 1 cylinder r 5 ± 1e-9; B-rep volume 5607.3009183                                | VC-MSH-23     |
| AC-16 | wrong plan                              | `run plans/target_bad_plan_codes.json D`                      | the listed `MESH_*` codes with paths                                                       | VC-MSH-26     |
| AC-17 | STL without pinned sha                  | import → decimate → `check_mesh`                              | `unverified` on every result; warn `MESH_CHECK_INPUT_UNVERIFIED`                           | VC-MSH-27     |
| AC-18 | clean, open, thin-wall, defect meshes   | `check_mesh purpose=print D`                                  | pass / `MESH_CHECK_NOT_CLOSED` / `MESH_CHECK_WALL_THIN` / non-manifold codes               | VC-MSH-28     |

## 8. Standards & regulatory alignment

| Topic               | Alignment                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mesh file formats   | STL (de-facto; binary layout already written by `export_stl`: 80-byte header, u32 count, 50 bytes per facet), OBJ (Wavefront), PLY, 3MF Core (unit attribute on the model). Only what the existing exporters already write and public format descriptions are relied on; no 3MF clause is quoted. |
| Validity vocabulary | Closed (every edge used by exactly two faces), manifold (edge and vertex fans), oriented, genus via χ = 2 − 2g per closed shell; ε-validity as defined by Manifold [R28].                                                                                                                         |
| Algorithms          | Garland–Heckbert QEM [R23], Taubin λ\|μ [R24], Botsch–Kobbelt isotropic remeshing [R25], Liepa hole filling [R26].                                                                                                                                                                                |
| Regulation          | None prescribes mesh quality. Print checks are rules with named, configurable defaults (AF-30, AF-31).                                                                                                                                                                                            |

## 9. KPIs / success metrics

| KPI                                                     | Target                                                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Analytic suite (VC-MSH-01, 05, 06, 11–19, 23–25, 35–37) | 100 % within tolerance                                                                                                  |
| Benchmark coverage                                      | each row of §2.1 has a llull command with a VC, except dynamic-topology sculpting (COULD)                               |
| Robustness                                              | `repair_mesh mode=wrap` returns a closed manifold for every input soup in the test corpus                               |
| Scale (native)                                          | 1.3 M-triangle mesh decimated, smoothed and remeshed within the budgets of TECHNICAL_SPEC §8 (TBD on first measurement) |
| Agent success                                           | every `target_*` plan runs unchanged; 100 % of refusals carry a `MESH_*` code                                           |

## 10. Risks & assumptions

| Risk / assumption                                                                                                    | Impact                                        | Mitigation                                                                                             |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Manifold refuses non-manifold input ("returns an error status")                                                      | Booleans / hull / Minkowski fail on raw scans | `check_mesh purpose=boolean` first; `repair_mesh` then `wrap` as the last resort; codes say which      |
| Taubin with kPB 0.1 slowly **grows** a clean sphere (+0.12 % mean radius in 10 iterations, +0.58 % in 50; VC-MSH-08) | Silent size drift                             | `volumeCorrection` option (rescale about the centroid to the input volume), on by default and named    |
| Laplacian smoothing shrinks (−1.8 % radius in 10 iterations at λ 0.6307)                                             | Parts shrink                                  | Taubin default; volume change always reported                                                          |
| Inline mesh JSON size                                                                                                | Unusable documents for scans                  | Asset store + LOD (FR-MSH-02)                                                                          |
| GPL / AGPL code (CGAL, TetGen via libigl copyleft modules)                                                           | Licence breach in the bundle                  | Licence policy (TECHNICAL_SPEC §5.11): Apache / MIT / BSD / MPL-2.0 only                               |
| Quad remesh quality on noisy scans                                                                                   | Bad cages, bulges                             | Remesh + smooth first; report deviation; V2                                                            |
| Determinism of third-party code (Manifold, QuadriFlow)                                                               | Replay not bit-identical                      | Single-threaded runs for recorded results; the algorithm and version recorded in provenance; VC-MSH-32 |
| SOLIDWORKS / CATIA / NX help pages not readable in this session                                                      | Benchmark rows graded B / C                   | No requirement depends on them                                                                         |

## 11. References

- [R1] Autodesk — Fusion Mesh help, _Convert Mesh_ — https://help.autodesk.com/cloudhelp/ENU/Fusion-Mesh/files/MESH-CONVERT-TO-SOLID.htm (accessed 2026-10)
- [R2] Autodesk — Fusion Mesh help, _Mesh modification_ (Remesh, Reduce, Smooth, Shell, Plane Cut, Combine, Reverse Normal, Erase and Fill) — https://help.autodesk.com/cloudhelp/ENU/Fusion-Mesh/files/MESH-MODIFY-TOOLS.htm (accessed 2026-10)
- [R3] Autodesk — Fusion Mesh help, _Repair_ — https://help.autodesk.com/cloudhelp/ENU/Fusion-Mesh/files/MESH-REPAIR.htm (accessed 2026-10)
- [R4] Autodesk — Fusion Mesh help, _Remesh_ — https://help.autodesk.com/cloudhelp/ENU/Fusion-Mesh/files/MESH-REMESH.htm (accessed 2026-10)
- [R5] Autodesk — Fusion Mesh help, _Reduce_ — https://help.autodesk.com/cloudhelp/ENU/Fusion-Mesh/files/MESH-REDUCE.htm (accessed 2026-10)
- [R6] Robert McNeel & Associates — Rhino 8 help, _QuadRemesh_ — https://docs.mcneel.com/rhino/8/help/en-us/commands/quadremesh.htm (accessed 2026-10)
- [R7] McNeel — Rhino 8 help, _ShrinkWrap_ — https://docs.mcneel.com/rhino/8/help/en-us/commands/shrinkwrap.htm (accessed 2026-10)
- [R8] McNeel — Rhino 8 help, _ReduceMesh_ — https://docs.mcneel.com/rhino/8/help/en-us/commands/reducemesh.htm (accessed 2026-10)
- [R9] McNeel — Rhino 8 help, _MeshRepair_ — https://docs.mcneel.com/rhino/8/help/en-us/commands/meshrepair.htm (accessed 2026-10)
- [R10] McNeel — Rhino 8 help, _OffsetMesh_ — https://docs.mcneel.com/rhino/8/help/en-us/commands/offsetmesh.htm (accessed 2026-10)
- [R11] McNeel — Rhino 8 help, _Smooth_ — https://docs.mcneel.com/rhino/8/help/en-us/commands/smooth.htm (accessed 2026-10)
- [R12] McNeel — Rhino 8 help, _ToNURBS_ — https://docs.mcneel.com/rhino/8/help/en-us/commands/tonurbs.htm (accessed 2026-10)
- [R13] Blender Foundation — Blender Manual, _Remesh Modifier_ — https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/remesh.html (accessed 2026-10)
- [R14] Blender Foundation — Blender Manual, _Decimate Modifier_ — https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/decimate.html (accessed 2026-10)
- [R15] Blender Foundation — Blender Manual, _Mesh Sculpt Brush Assets_ — https://docs.blender.org/manual/en/latest/sculpt_paint/sculpting/brushes/brushes.html (accessed 2026-10)
- [R16] Autodesk — Meshmixer help, _Edit > Remesh_ — https://help.autodesk.com/cloudhelp/2019/ENU/MSHMXR/files/GUID-6EF8ABD4-AB4A-426F-A0C4-DE96FAABF520.htm (accessed 2026-10)
- [R17] Autodesk — Meshmixer help, _Make Solid Tool_ — https://help.autodesk.com/cloudhelp/2019/ENU/MSHMXR/files/GUID-F8C64203-AFB7-449C-A395-2C029A80BB6C.htm (accessed 2026-10)
- [R18] Materialise — Magics academy, _Fix geometry errors: manual tools_ — https://www.materialise.com/en/academy/industrial/magics/video-tutorials/fix-geometry-errors-manual-tools (accessed 2026-10)
- [R19] Hawk Ridge Systems — _An Overview of ScanTo3D_ (reseller, secondary) — https://hawkridgesys.com/blog/overview-scanto3d (accessed 2026-10)
- [R20] GoEngineer — _Geomagic Design X: Features & Tutorials_ (reseller, secondary) — https://www.goengineer.com/en-us/blog/geomagic-design-x-features-and-tutorials (accessed 2026-10)
- [R21] Digital Engineering 24/7 — _Siemens Parasolid introduces Convergent Modeling on mixed models_ (2019-12-19, trade press) — https://www.digitalengineering247.com/article/siemens-parasolid-introduces-convergent-modeling-on-mixed-models (accessed 2026-10)
- [R22] nTop — block documentation, _Simplify Mesh by Threshold_ — https://docs.ntop.com/Product-Documentation/ntop/block-documentation/blocks/modeling/utilities/simplify-mesh-by-threshold.md (accessed 2026-10)
- [R23] Garland, M.; Heckbert, P. S. — _Surface Simplification Using Quadric Error Metrics_, SIGGRAPH 97, pp. 209–216 — https://www.cs.princeton.edu/courses/archive/fall06/cos526/papers/garland97.pdf ; author page https://www.mgarland.org/research/quadrics.html (accessed 2026-10)
- [R24] Taubin, G. — _A Signal Processing Approach to Fair Surface Design_, SIGGRAPH 95, pp. 351–358, DOI 10.1145/218380.218473 — https://faculty.cc.gatech.edu/~jarek/graphics/papers/09FairingTaubin.pdf (accessed 2026-10)
- [R25] Botsch, M.; Kobbelt, L. — _A Remeshing Approach to Multiresolution Modeling_, SGP 2004, DOI 10.2312/SGP/SGP04/189-196 — https://cg.cs.tu-dortmund.de/publications/2004-remeshing.pdf (accessed 2026-10)
- [R26] Liepa, P. — _Filling Holes in Meshes_, SGP 2003, pp. 200–206, DOI 10.2312/SGP/SGP03/200-206 — https://diglib.eg.org/handle/10.2312/SGP.SGP03.200-206 (accessed 2026-10)
- [R27] PMP Library — _Remeshing_ — https://www.pmp-library.org/remeshing.html ; repository (MIT) https://github.com/pmp-library/pmp-library (accessed 2026-10)
- [R28] Manifold (E. Lalish et al.), Apache-2.0 — https://github.com/elalish/manifold ; npm `manifold-3d` 3.5.4 type declarations `manifold-encapsulated-types.d.ts` as installed in the repo (`node_modules/manifold-3d`) (accessed 2026-10)
- [R29] meshoptimizer (A. Kapoulkine), MIT — https://github.com/zeux/meshoptimizer (accessed 2026-10)
- [R30] geogram (B. Lévy), BSD-3-Clause — https://github.com/BrunoLevy/geogram (accessed 2026-10)
- [R31] CGAL — _License_ — https://www.cgal.org/license.html (accessed 2026-10)
- [R32] libigl — _License_ — https://libigl.github.io/license/ ; repository https://github.com/libigl/libigl (accessed 2026-10)
- [R33] Instant Meshes (Jakob, Tarini, Panozzo, Sorkine-Hornung, SIGGRAPH Asia 2015) — https://github.com/wjakob/instant-meshes ; LICENSE.txt (accessed 2026-10)
- [R34] QuadriFlow (Huang et al., SGP 2018, DOI 10.1111/cgf.13498), MIT — https://github.com/hjwdzh/QuadriFlow (accessed 2026-10)
- [R35] crates.io API — `meshopt` 0.7.0 (MIT OR Apache-2.0), `baby_shark` 0.3.12 (MIT), `manifold-csg` 0.4.1 (Apache-2.0 OR MIT), `parry3d-f64` 0.31.1 (Apache-2.0) — https://crates.io/api/v1/crates/meshopt , …/baby_shark , …/manifold-csg , …/parry3d-f64 ; READMEs https://github.com/dima634/baby_shark , https://github.com/zmerlynn/manifold-csg (accessed 2026-10)
- [R36] _Steiner formula_ — https://en.wikipedia.org/wiki/Steiner_formula (accessed 2026-10)
- [R37] _Jung's theorem_ — https://en.wikipedia.org/wiki/Jung%27s_theorem (accessed 2026-10)
- [R38] _Regular icosahedron_ — https://en.wikipedia.org/wiki/Regular_icosahedron (accessed 2026-10)
- [R39] OpenFOAM — `surfaceLambdaMuSmooth.C` (Taubin citation, λ/μ semantics) — https://cpp.openfoam.org/v13/surfaceLambdaMuSmooth_8C_source.html (accessed 2026-10)
