# Freeform design ("design anything") — gap analysis and specifications

Status: specifications and validation packs written 2026-10-22 (owner request: "more capabilities in design, so I can design anything I
want in any shape"). Nothing in this track is built yet. Benchmark: the freeform and organic tools of SOLIDWORKS, CATIA, Siemens NX, Creo,
Fusion, Onshape, Rhino / Grasshopper, nTop and Blender, reached on llull's CLI-agent path first and reviewed in the desktop UI.

Authoring rules: [`../aerospace/TEMPLATE.md`](../aerospace/TEMPLATE.md) (sections) and [`../plant/TEMPLATE.md`](../plant/TEMPLATE.md)
(folder layout, source grades A/B/C). Operator model: [`../aerospace/AGENT_FIRST.md`](../aerospace/AGENT_FIRST.md): an AI agent drives
the `llull` CLI; pack 04 is the exception, with the desktop UI as primary surface and every gesture still one registered command.

## Where llull stands today (measured on origin/main 2c7ecc93)

llull already has a broad exact-surfacing base from the aerospace SRF pack ([`../aerospace/02-advanced-surfacing/`](../aerospace/02-advanced-surfacing/)):
NURBS curves and sheets (`create_nurbs_curve`, `create_nurbs_surface`, `edit_nurbs`), `loft_surface` with Gordon guides, fill / trim / sew /
thicken, curvature and continuity analysis; and solids from `extrude_profile`, `revolve_profile`, `sweep_profile`, `loft_sections`,
`add_subdivision_solid` / `edit_subdivision_cage` (exact B-spline patches on the native kernel), `fillet_edge` with variable radii,
`shell_solid`, `push_pull_face`, `blend_union`. What it cannot do:

| Capability | Today | Pack |
| ---------- | ----- | ---- |
| Deform a body (twist, taper, bend, lattice cage, flow along a curve, morph) | nothing; `scale_entity` is uniform only, `mirror_entity` only negates the position | 01 DEF |
| Sweep with twist / scale laws, guide rails, orientation modes; loft end conditions; exact helix | one rotation-minimizing frame; station blend sampled at path frames only (taper result depends on path tessellation); `add_coil` helix 1.16 % R off at the ends | 02 SWG |
| Wrap / emboss / engrave a sketch or text on a curved face; 3D text | `add_text` is annotation only, `add_decal` is paint; the exact face-chart + `faceSlab` machinery exists but only inside the composites plugin; OCCT text unusable (no FreeType) | 03 WRP |
| Drag control points, cage vertices, faces in the viewport | no vertex / edge / face / control-point picking in 3D, no cage overlay, 120 ms debounced previews | 04 DIR |
| Implicit / field modelling, TPMS and strut lattices, smooth blends | nothing implicit; Manifold `levelSet` shipped but unused; topology plugin has a private marching-tetrahedra mesher | 05 IMP |
| Variable / conic / G2 fillets, setback corners, face fillets, full rounds | variable radii exist but are untested by oracles, dropped by code export, failures unexplained (OCCT status unread); OCCT has no conic / G2 profile | 06 BLD |
| Mesh modelling (STL / OBJ import, repair, remesh, smooth, decimate, hull, Minkowski, sculpt, mesh → B-rep) | no mesh file reader at all; `import_mesh` takes raw triangles; Manifold hull / Minkowski / smooth unused | 07 MSH |

## Gaps

| # | Gap | Id | Functional | Technical | Validation | FR | TR | VCs | Plans | Effort |
| - | --- | -- | ---------- | --------- | ---------- | -- | -- | --- | ----- | ------ |
| 01 | Body deformation: non-uniform scale, twist, taper, bend, stretch, FFD lattice, deform by point, flow along curve / onto surface, curve-to-curve, morph; exact (B-spline re-approximation in OCCT) and mesh paths | DEF | [spec](01-body-deformation/FUNCTIONAL_SPEC.md) | [spec](01-body-deformation/TECHNICAL_SPEC.md) | [pack](01-body-deformation/validation/README.md) | 34 | 13 | 37 | 10 | ≈ 21 eng-wk |
| 02 | Advanced sweep / loft: twist, scale and area laws, orientation modes, guide rails, loft end conditions + centerline, exact helix, ruled / network / developable surfaces, `sheetSolid` native op | SWG | [spec](02-sweep-loft-guides/FUNCTIONAL_SPEC.md) | [spec](02-sweep-loft-guides/TECHNICAL_SPEC.md) | [pack](02-sweep-loft-guides/validation/README.md) | 38 | 16 | 39 | 7 | M0–M3 ≈ 11 agent-days, M4–M8 more |
| 03 | Wrap and emboss: fonts + 3D text, wrap / project / unwrap on faces, emboss / deboss / scribe, curve on face, split by curves, knurl | WRP | [spec](03-wrap-emboss/FUNCTIONAL_SPEC.md) | [spec](03-wrap-emboss/TECHNICAL_SPEC.md) | [pack](03-wrap-emboss/validation/README.md) | 35 | 16 | 40 | 7 | ≈ 22 eng-wk |
| 04 | Direct freeform editing in the viewport: picking, cage / control-net overlays, drag sessions (preview local, commit one command), cage topology tools, creases, symmetry, SubD → NURBS, face move / delete | DIR | [spec](04-direct-freeform-editing/FUNCTIONAL_SPEC.md) | [spec](04-direct-freeform-editing/TECHNICAL_SPEC.md) | [pack](04-direct-freeform-editing/validation/README.md) | 44 | 15 | 40 | 6 | MVP ≈ 12, V1 ≈ 12, V2 ≈ 5 eng-wk |
| 05 | Implicit and lattice: field program + engine port, SDF primitives, blended booleans, shell, TPMS, strut / graph lattices, graded and conformal fields, infill, 3MF beam lattice + implicit export, native `llull-field` | IMP | [spec](05-implicit-lattice/FUNCTIONAL_SPEC.md) | [spec](05-implicit-lattice/TECHNICAL_SPEC.md) | [pack](05-implicit-lattice/validation/README.md) | 46 | 17 | 50 | 9 | ≈ 28 eng-wk |
| 06 | Variable blends: coded OCCT diagnostics, `probe_fillet`, `check_blends`, radius laws, conic / G2 / asymmetric profiles, setback corners, face fillets, hold lines, full round, chamfer variants | BLD | [spec](06-variable-blends/FUNCTIONAL_SPEC.md) | [spec](06-variable-blends/TECHNICAL_SPEC.md) | [pack](06-variable-blends/validation/README.md) | 30 | 18 | 33 | 5 | ≈ 24 eng-wk |
| 07 | Mesh modelling: STL / OBJ / PLY / 3MF import, analyze / check / repair, fill holes, decimate, remesh, smooth, cut, hull, Minkowski, offset, hollow, sculpt, segment, mesh → B-rep, quad remesh + cage fit; native `llull-meshops` | MSH | [spec](07-mesh-modeling/FUNCTIONAL_SPEC.md) | [spec](07-mesh-modeling/TECHNICAL_SPEC.md) | [pack](07-mesh-modeling/validation/README.md) | 39 | 16 | 39 | 6 | ≈ 28 eng-wk |

Total: **266 functional requirements, 111 technical requirements, 278 validation cases, 50 scenario plans**. Every pack has at least one
baseline plan that runs on today's llull; all nine were run on 2026-10-22 (`llull run … --continue`, native kernel) and their volumes agree
with the closed forms, with two findings written back into the packs:

- **02 SWG VC-SWG-11** — a 10 → 5 station taper on a straight path measures 18 310.743 mm³, the frustum (−0.083 %), not the smoothstep
  value the code comment promises: `stationRingAt` is only sampled at path frames, so today the section law depends on the path tessellation.
- **06 BLD VC-BLD-13** — OCCT documents contour ends at ≥ 4-edge vertices as not handled, but llull-kernel (OCCT 7.9.2) completes the
  symmetric pyramid apex at r 0.5 (11 faces, 23 edges); `BLD_CORNER_UNSUPPORTED` is now raised only when OCCT reports the vertex faulty.

## Shared foundations (build once, used by several packs)

| Foundation | Owner pack | Also used by |
| ---------- | ---------- | ------------ |
| Native `sheetSolid` op (fitted B-spline faces + caps sewn into a solid) | 02 SWG | 01 DEF exact path, aerospace 02 SRF |
| Coded native diagnostics + `edgeSamples` / `edgeContinuity` B-rep queries (null today) | 06 BLD M0 | 02 SWG checks, 01 DEF `check_deformation`, 04 DIR `check_subdivision` |
| Shared field → mesh mesher `core/lib/isosurface` (moved from the topology plugin) | 05 IMP | 07 MSH offset / wrap, topology plugin |
| Content-addressed mesh assets (documents keep recipes, re-derive meshes) | 07 MSH | 05 IMP derived lattices, LIM-1 document size |
| Length-preserving face charts promoted from composites to core | 03 WRP | 01 DEF flow onto surface, 06 CMP |
| Viewport picking + drag-session → one command | 04 DIR | 01 DEF deform-by-point, 07 MSH `sculpt_mesh` |

## Recommended order

1. **Quick wins on today's kernel:** 02 SWG M0–M3 (twist / scale / area laws, orientation modes, exact helix), 06 BLD M0 (make fillets
   explain themselves), 07 MSH M0 (mesh file import + analyze / check) and M2 (Manifold hull, Minkowski, offset — already linked).
2. **Shape-changing tools:** 01 DEF M0–M1 (laws on the mesh kernel, exact non-uniform scale), 03 WRP M0–M3 (fonts, 3D text, wrap,
   emboss on developable faces).
3. **Interaction and new kernels:** 04 DIR MVP (picking, overlays, drag sessions), 05 IMP MVP (field engine, TPMS / strut lattices, native
   `llull-field`), 01 DEF M2 (exact OCCT deformation).
4. **Everything else** in each pack's V1 / V2.

## Owner decisions collected from the packs (detail: each TECHNICAL_SPEC §11)

| Pack | Decision | Proposed |
| ---- | -------- | -------- |
| 01 | Commands in core, one command per law, result = `mesh` with exact `brep` recipe, default falloff `smooth`, no silent exact → mesh fallback, 2D entities refused in MVP | as listed |
| 02 | Fitted B-spline faces as the default exact sweep path (`MakePipeShell` = fast path); `add_coil` v2 on the exact helix for new calls only; laws by arc-length fraction; stay in toolset `3d` | yes |
| 03 | `CadDocument.blobs` gains binary media types for embedded fonts; font engine in TypeScript (core `lib/font`); bundle Fira Sans (+457 KB); 2 % default distortion limit | yes |
| 04 | Stable step-scoped cage element ids instead of indices; one history step per drag (+ optional `squash_steps`); T-splines out of scope; Catmull-Clark in TS core (OpenSubdiv later if needed) | yes |
| 05 | Saved files keep recipes, not meshes; new toolset `implicit`; no printer process-limit table until sourced; blocking spawnSync for long jobs | yes |
| 06 | Extend `fillet_edge` for edge options, new commands only for face fillets and full rounds; rolling-ball corners by default; `check_blends purpose=release` sets `reviewRequired` | yes |
| 07 | Content-addressed result assets; new toolset `mesh`; `boolean` keeps imported meshes as meshes (no one-face-per-triangle B-rep); raise the 2000 cage-vertex cap; pin the Manifold version in provenance | yes |

## Validation plans and the rot gate

Target plans name commands that do not exist yet; they are listed in `tests/unit/contract/blockedPlanCommands.json` (regenerate with
`UPDATE_BLOCKED_PLANS=1 npx vitest run tests/unit/contract/validationPlanCommands.test.ts`) and leave that list as the commands are built.
Generator scripts are Node ESM without dependencies (`node docs/design/NN-*/validation/<script>.mjs`) and are deterministic, except
`04-direct-freeform-editing/validation/data/latency_probe.json` (grade C, timing).
