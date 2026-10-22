# DEF — Whole-body and space deformation — Technical specification

Gap id: **DEF** · Companion: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Laws: `.claude/rules/architecture.md` L1–L10, conventions C1–C7 · Decisions: KI5 (shape boundary), LC1 (local only).

---

## 1. Current state in llull

### 1.1 What exists near this gap (read 2026-10-22, branch `docs/freeform-design-specs` from origin/main)

| Capability                 | Command / code                                                                                                                                                                                                                                                           | What it really does                                                                                                                                             | What it does not do                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uniform scale              | `scale_entity` — `packages/core/src/commands/edit/transform.ts`, `geometry/scaleGeometry.ts`                                                                                                                                                                             | multiplies kind-specific dimensions (box size, cylinder radius / height, profile points, NURBS poles, decals) by one factor > 0 about the entity's local origin | no per-axis factors, no negative factor, no mirror                                                                                                                                            |
| Mirror                     | `mirror_entity` — same file                                                                                                                                                                                                                                              | negates ONE component of `position`                                                                                                                             | does not reflect the shape: "a handed part keeps its handedness" (its own description)                                                                                                        |
| Recipe scale               | `ShapeRecipe` `{ op: 'scale', factor }` — `model/types.ts` (line ~819), native `scaled()` in `solver/crates/llull-kernel-occt/cpp/facade.cxx` (`gp_Trsf::SetScale` about the origin), Manifold `shape.scale(factor)` in `packages/kernel-manifold/src/manifoldKernel.ts` | uniform scale node, exact on both kernels                                                                                                                       | no `gp_GTrsf`, no non-linear map anywhere in the recipe                                                                                                                                       |
| Rigid placement            | `{ op: 'place' }`, `rotate_entity`                                                                                                                                                                                                                                       | rotation + translation                                                                                                                                          | —                                                                                                                                                                                             |
| Local cage edit            | `edit_subdivision_cage` — `commands/solids/subdivisionCage.ts`                                                                                                                                                                                                           | soft-selection (`falloff`, smoothstep) translate / scale / crease of a Catmull-Clark cage                                                                       | subdivision solids only; not a space deformation of other bodies                                                                                                                              |
| Control-point edit         | `edit_nurbs` (`move_pole`, `set_weight`, …) — `commands/surface/editNurbs.ts`                                                                                                                                                                                            | edits one NURBS curve / sheet                                                                                                                                   | no body-level map                                                                                                                                                                             |
| Face taper                 | `draft_faces` — `commands/brep/faceOps.ts`                                                                                                                                                                                                                               | tilts picked faces about a neutral plane (OCC `faceOp` draft)                                                                                                   | not a body taper (`taper_body`)                                                                                                                                                               |
| Constructive twist / taper | `loft_sections`, `sweep_profile` `stations` — `commands/solids/loft.ts`, `sweep.ts`                                                                                                                                                                                      | can build a twisted or tapered body from rotated / scaled sections                                                                                              | each inline / sketch section is resampled to 24 points (`SECTION_RING_POINTS`), corners rounded; the sweep frame is rotation-minimising with no twist law (02 SWG)                            |
| Kernel ops                 | `GeometryKernel` (`geometry/kernel.ts`), `KernelOps<S>` (`geometry/shapeKernel.ts`); Manifold `unsupported = {fillet, chamfer, shell, blend, faceSlab}`                                                                                                                  | the recipe walker, caching by `recipeKey`                                                                                                                       | no `deform` op; the Manifold `warp` / `warpBatch` / `refineToLength` API (manifold-3d 3.5.4) is not called anywhere (`git grep warp` over `packages`, `server`, `src`: no hit in kernel code) |
| Native sidecar             | `solver/crates/llull-kernel-occt` (`recipe.rs` dispatch: `solid`, `boolean`, `place`, `scale`, `fillet`, `chamfer`, `blend`, `shell`, `featureCut`, `faceSlab`, `faceOp`, `brep`)                                                                                        | exact OCCT 7.9.2 B-rep                                                                                                                                          | no `BRepBuilderAPI_GTransform`, no `BRepTools_Modification` subclass, no surface re-approximation                                                                                             |

`git grep -n "name: '<name>'" -- packages` returns nothing for every command proposed in §4 (checked: `twist_body`, `taper_body`,
`bend_body`, `stretch_body`, `scale_nonuniform`, `deform_lattice`, `flow_along_curve`, `flow_on_surface`, `deform_by_point`,
`deform_curve_to_curve`, `morph_bodies`, `analyze_deformation`, `check_deformation`).

### 1.2 Measured baselines (today's llull, native kernel, `node server/bin/llull.cjs run … --json`)

| Plan (validation/plans)                                                                                    | Today's result                                                                       | Closed form                                           | Error                  |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- | ---------------------- |
| `baseline_twisted_bar_loft.json` — 10 × 10 × 100 bar, 90°, smooth loft through 11 rotated 40-point squares | volume 9995.931 (method exact), area 4122.903                                        | volume 10000, area 4204.109 (`data/twist_cases.json`) | −0.041 % / **−1.93 %** |
| `baseline_bent_bar_sweep.json` — 10 × 10 bar swept along a 90° arc of radius 50                            | volume 7803.611 (method mesh: `mass_properties` integrates the sweep's display mesh) | 7853.982 (Pappus, `data/bend_cases.json`)             | −0.64 %                |

Both are constructive work-arounds an agent must design by hand; neither deforms an existing body.

## 2. Target architecture

### 2.1 Layer placement

| Piece                                                                                                           | Layer                                                                                                                                                                                                | Why (law)                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Deformation laws, frames, regions, Jacobians, closed-form bounds, FFD, flow maps, mesh refinement + vertex warp | `packages/core/src/geometry/deform/` (pure: `frame.ts`, `region.ts`, `laws.ts`, `ffd.ts`, `flow.ts`, `pointPush.ts`, `jacobian.ts`, `bounds.ts`, `meshWarp.ts`, `curveWarp.ts`, `lowering.ts`)       | domain-neutral geometry used by commands and both kernels; no kernel needed for the math (L2, L9)                            |
| Types `DeformLaw`, `DeformFrame`, `DeformRegion`, `DeformOutput`                                                | `packages/core/src/model/deform.ts`; `ShapeRecipe` gains `{ op: 'deform' }` (`model/types.ts`)                                                                                                       | recipe = document (L8)                                                                                                       |
| Commands                                                                                                        | new core feature catalog `packages/core/src/commands/deform/catalog.ts` (one file per command family), listed in toolset `3d`                                                                        | general modelling capability, not a domain (L10); no new toolset (a new toolset needs a design-language example, SRF §13.3)  |
| Mesh-kernel evaluation                                                                                          | `packages/kernel-manifold/src/manifoldKernel.ts`: `deform` op = `refineToLength(h)` + `warpBatch(law)`                                                                                               | Manifold is the in-process mesh kernel (L9)                                                                                  |
| Exact evaluation                                                                                                | native sidecar: `solver/crates/llull-kernel-occt/cpp/deform.cxx` (+ `deform.hxx`), Rust `src/deform.rs` (ffi) and `src/recipe/nodes.rs::deform`; host payload in `server/src/native/kernelLeaves.ts` | exact B-rep re-approximation needs OCCT (C++), heavy numerics native (C7: OCCT is already the exact kernel; no new language) |
| Mesh leaves on the exact kernel                                                                                 | lowered in core (`geometry/deform/lowering.ts`, like `geometry/featureLowering.ts`): a `deform` over a triangle-mesh leaf becomes a new mesh leaf warped in TS                                       | deforming planar triangles "exactly" is meaningless; one implementation for meshes                                           |
| Review overlays                                                                                                 | `src/ui/viewport/3d/overlays/deform*.tsx` fed by `analyze_deformation` `data`                                                                                                                        | presentation only (L1, L4)                                                                                                   |

### 2.2 Data flow

```
CLI / UI ─execute─> twist_body (core command)
   ├─ resolve target: entity → operandRecipe(kernel, entity)            (existing helper, geometry/operandRecipe.ts)
   ├─ build node { op:'deform', source, law:{kind:'twist',…}, frame, region, output }
   ├─ pre-check: law bounds over the source bounds (closed-form Jacobian min, fold limits)  → DEF_FOLDOVER / DEF_BEND_RADIUS_TOO_SMALL
   ├─ kernel.evaluate(node)  ── native: deform.cxx (exact)  │ Manifold: refine + warpBatch │ none: geometry/deform/meshWarp.ts
   ├─ post-check: validity (BRepCheck + self-intersection) / mesh closure + self-intersection, approximation error
   └─ commitKernelResult(...) → mesh entity { mesh, brep: node }  (pattern of fillet_edge, commands/brep/modify3d.ts)
nurbs_curve / nurbs_surface targets: geometry/deform/curveWarp.ts (core refit) → same kind, new data
```

### 2.3 Laws check

- L1 / L5: every capability is a `defineCommand`; `analyze_deformation` and `check_deformation` are read-only queries.
- L3: commands return a new document; the source entity is consumed (or kept with `keepSource`).
- L8: params are intent (angle, factor, radius, region positions, lattice moves by index / near point); the recipe embeds the law
  data so `recipeKey` caches it; replay re-mints identical ids.
- L9: kernel-OPTIONAL commands (no `requiresKernel`): exact path with the native kernel, mesh path with Manifold or none,
  `output.mode: "exact"` refuses without an exact kernel (`DEF_EXACT_UNAVAILABLE`), each command tagged
  `@invariant kernel-optional: …` and tested on both paths. Exception: `flow_on_surface` with a B-rep **face** target needs the
  exact kernel for that branch (named refusal), a sheet target works everywhere.
- L10: core, not a plugin: deformation is generic modelling (every domain plugin may use it via `execute`).

## 3. Data model

```ts
// packages/core/src/model/deform.ts  (pure data)
import type { Vec3 } from './types';
import type { NurbsCurveData, NurbsSurfaceData } from '../lib/nurbs/types';

/** Local frame: z = axis, x = reference projected ⟂ axis, y = z × x. Origin in world coordinates. */
export interface DeformFrame {
  readonly origin: Vec3;
  readonly axis: Vec3;
  readonly reference: Vec3;
}

/** Region along the frame z axis (document units from the origin). */
export interface DeformRegion {
  readonly start: number;
  readonly end: number; // > start
  readonly falloff: 'none' | 'linear' | 'smooth'; // 'none' only for stretch (a step); 'smooth' = 3t² − 2t³ (C1)
  readonly beyond: 'rigid' | 'fixed'; // rigid: carry the end transform (Barr); fixed: no effect past the end (only laws continuous there)
}

export type DeformLaw =
  | { readonly kind: 'affine'; readonly matrix: readonly [Vec3, Vec3, Vec3]; readonly translation: Vec3 } // scale_nonuniform, preserveVolume stretch
  | { readonly kind: 'twist'; readonly angleRad: number }
  | { readonly kind: 'taper'; readonly scaleEnd: number; readonly flat: boolean }
  | { readonly kind: 'stretch'; readonly factor: number }
  | { readonly kind: 'bend'; readonly radius: number; readonly symmetric: boolean }
  | {
      readonly kind: 'lattice';
      readonly box: { readonly min: Vec3; readonly max: Vec3 };
      readonly degrees: readonly [number, number, number];
      readonly offsets: ReadonlyArray<{ readonly index: readonly [number, number, number]; readonly delta: Vec3 }>;
    }
  | {
      readonly kind: 'flowCurve';
      readonly base: NurbsCurveData;
      readonly target: NurbsCurveData;
      readonly stretch: boolean;
      readonly orientation: 'minimal' | 'fixed_up';
      readonly up?: Vec3;
    }
  | {
      readonly kind: 'flowSurface';
      readonly base: FlowBase;
      readonly target: FlowTarget;
      readonly targetOrigin: Vec3;
      readonly targetU: Vec3;
    }
  | {
      readonly kind: 'point';
      readonly center: Vec3;
      readonly direction: Vec3;
      readonly distance: number;
      readonly radius: number;
      readonly falloff: 'smooth_c2' | 'cubic';
    }
  | {
      readonly kind: 'curvePairs';
      readonly pairs: ReadonlyArray<{ readonly initial: NurbsCurveData; readonly target?: NurbsCurveData }>;
      readonly stiffness: number;
    }; // V2

export type FlowBase =
  | { readonly kind: 'plane'; readonly origin: Vec3; readonly normal: Vec3; readonly u: Vec3 }
  | { readonly kind: 'sheet'; readonly surface: NurbsSurfaceData };
/** A face target keeps the source recipe of the target solid and a point naming the face (resolved by the exact kernel). */
export type FlowTarget =
  | { readonly kind: 'sheet'; readonly surface: NurbsSurfaceData }
  | { readonly kind: 'face'; readonly source: import('./types').ShapeRecipe; readonly near: Vec3; readonly name?: string };

export interface DeformOutput {
  readonly mode: 'auto' | 'exact' | 'mesh'; // auto: exact when an exact kernel is installed, else mesh
  readonly tolerance: number; // document units, > 0 (named default §5.9)
  readonly preserveAnalytic: boolean; // FR-DEF-12
}
```

```ts
// packages/core/src/model/types.ts — ShapeRecipe gains one member
  /** Space deformation of `source` (01 DEF): every point p of the source maps to frame⁻¹(law(frame(p))) within output.tolerance. */
  | { readonly op: 'deform'; readonly source: ShapeRecipe; readonly law: DeformLaw; readonly frame: DeformFrame;
      readonly region?: DeformRegion; readonly output: DeformOutput }
```

- Result entity: `mesh` with `brep` = the deform node (same as fillets and booleans), so later booleans, fillets, STEP and
  mass properties see the exact shape. `nurbs_curve` / `nurbs_surface` targets stay their kind with refit data.
- Analysis reads the outermost `deform` node of `entity.brep` (or the node at `stepIndex` of the feature history).
- `unverified`: computed on read from the recipe chain (AGENT_FIRST AF-32 propagation rule), nothing stored.
- Persistence: no version bump; the new recipe member is additive and validated by `geometry/shapeRecipe.ts` (unknown `law.kind`
  → load refusal with `DEF_RECIPE_INVALID`). `recipeKey` hashes the whole node, so a param edit invalidates exactly the cache
  entries downstream of it.

## 4. Commands

Notation: Q = query, M = mutating; K? = kernel-optional (exact path with the native kernel, mesh path otherwise). All in
`commands/deform/catalog.ts`, toolset `3d`. Shared schema fragments (`commands/deform/schema.ts`): `frame` (origin, axis,
reference; each defaulted from the body bounds and reported), `region` (`start`, `end`, `falloff`, `beyond`, `infinite`),
`output` (`mode`, `tolerance`, `preserveAnalytic`), `keepSource`, `ids` (FR-DEF-20; `id` or `ids`).

| Command                      | Q/M | Kernel                                                 | Params (sketch)                                                                                                                                                                      | @affects                                                               | @invariant                                                                                                    | @failure (codes §7.1)                                                                                                        |
| ---------------------------- | --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `scale_nonuniform`           | M   | K? (exact = affine, no approximation)                  | `id \| ids`, `factors: [sx, sy, sz]` (unitless), `center?` (default bounds centre), `frame?`                                                                                         | replaces 1..n entities by mesh+brep (or same kind for curves / sheets) | volume × \|sx sy sz\|; a negative product reverses face orientation in the kernel so the result stays outward | `DEF_SCALE_SINGULAR` (a factor 0), `DEF_NO_EFFECT` (all 1)                                                                   |
| `twist_body`                 | M   | K?                                                     | `angleDeg`, `frame`, `region`, `output`, `keepSource`                                                                                                                                | as above                                                               | det J = 1: volume unchanged                                                                                   | `DEF_NO_EFFECT` (0), `DEF_REGION_INVALID`, `DEF_REGION_MISSES_BODY`                                                          |
| `taper_body`                 | M   | K?                                                     | `scaleEnd` (> 0), `flat?`, `frame`, `region`, `output`                                                                                                                               | as above                                                               | det J = s(z)² (s flat)                                                                                        | `DEF_TAPER_DEGENERATE` (≤ 0)                                                                                                 |
| `stretch_body`               | M   | K?                                                     | `factor` (> 0), `preserveVolume?` (whole body only), `frame`, `region` (`falloff` `none` allowed), `output`                                                                          | as above                                                               | det J = f in region, 1 outside                                                                                | `DEF_STRETCH_FACTOR`, `DEF_PRESERVE_VOLUME_REGION`                                                                           |
| `bend_body`                  | M   | K?                                                     | any two of `radius`, `angleDeg`, `length` (region length; or `region`), `frame` (`reference` = toward the centre of curvature), `symmetric?`, `output`                               | as above                                                               | neutral fibre (frame origin plane) keeps its length; det J = (R − y)/R                                        | `DEF_BEND_UNDERDETERMINED`, `DEF_BEND_OVERDETERMINED`, `DEF_BEND_RADIUS_TOO_SMALL`, `DEF_SELF_INTERSECTION` (> 360° overlap) |
| `deform_lattice` (V1)        | M   | K?                                                     | `degrees: [l, m, n]` (1..8), `box: 'bounds' \| {min, max}` (frame coordinates), `moves: [{ index: [i, j, k] \| near: [x, y, z], delta }]`, `fixedLayers?` (k), `frame?`, `output`    | as above                                                               | no moves = identity; an affine set of control points = that affine map                                        | `DEF_LATTICE_DEGREE`, `DEF_LATTICE_INDEX`, `DEF_LATTICE_FIXED_MOVED`, `DEF_FOLDOVER`                                         |
| `deform_by_point` (V1)       | M   | K?                                                     | `point`, `direction` (unit after normalising), `distance`, `radius`, `falloff: 'smooth_c2' \| 'cubic'`, `output`                                                                     | as above                                                               | displacement = distance at `point`, 0 at and beyond `radius`                                                  | `DEF_FOLDOVER` (with the limit), `DEF_REGION_MISSES_BODY`                                                                    |
| `flow_along_curve` (V1)      | M   | K?                                                     | `baseCurve?` (default the frame axis segment through the body), `targetId` (`nurbs_curve`, sketch curve, or `{entityId, edgeNear}`), `stretch?`, `orientation`, `up?`, `output`      | as above                                                               | arc length along the base preserved unless `stretch`                                                          | `DEF_CURVE_NOT_FOUND`, `DEF_CURVE_INVALID` (not G1, zero length), `DEF_FOLDOVER` (body radius > target curvature radius)     |
| `flow_on_surface` (V1)       | M   | K? (face target: exact only)                           | `base: {plane:{origin, normal, uDirection}} \| {sheetId}`, `target: {sheetId} \| {entityId, faceNear}`, `targetOrigin`, `targetUDirection`, `output`                                 | as above                                                               | (u, v) arc lengths along the base kept at the target origin; normal offset w kept                             | `DEF_FLOW_TARGET_INVALID`, `DEF_FLOW_OUTSIDE_BASE`, `DEF_FLOW_OVERLAP`, `DEF_TARGET_FACE_NEEDS_KERNEL`, `DEF_FOLDOVER`       |
| `deform_curve_to_curve` (V2) | M   | K?                                                     | `pairs: [{ initialId, targetId? }]`, `fixedFacesNear?`, `stiffness` (0..1), `output`                                                                                                 | as above                                                               | every initial curve lands on its target within tolerance (residual reported)                                  | `DEF_CURVE_PAIR_INVALID`, `DEF_FOLDOVER`                                                                                     |
| `morph_bodies` (V2)          | M   | –                                                      | `fromId`, `toId`, `t` (0..1)                                                                                                                                                         | 1 new entity                                                           | t = 0 ⇒ from, t = 1 ⇒ to                                                                                      | `DEF_MORPH_INCOMPATIBLE`                                                                                                     |
| `analyze_deformation`        | Q   | – (reads the recipe; exact-only fields `null` on mesh) | `id`, `stepIndex?`, `samples?` (default 9³ per lattice cell / region slab), `compareTo?` (analytic reference shape: `torus`, `cone`, `cylinder`, `spheroid`)                         | —                                                                      | `data` shape §7.2                                                                                             | `DEF_ENTITY_NOT_FOUND`, `DEF_NOT_DEFORMED`                                                                                   |
| `check_deformation`          | Q   | –                                                      | `ids?` (default every entity whose recipe has a `deform` node), `purpose: 'design' \| 'release'`, tolerances `approx`, `volumeDriftRel`, `creaseRad` (each optional ⇒ named default) | —                                                                      | `data {status, findings[], tolerances, unverified, reviewRequired, reviewReason?, provenance}`                | `DEF_ENTITY_NOT_FOUND`                                                                                                       |

Descriptions follow AF-02 (what, when, units, refusals, next command: "then call `analyze_deformation` and `check_deformation`").

## 5. Kernel / algorithms

### 5.1 Frame and region

- Frame: `z = normalise(axis)`, `x = normalise(reference − (reference·z) z)`, `y = z × x`; `DEF_FRAME_DEGENERATE` when \|axis\| = 0
  or reference ∥ axis. Local coordinates `q = Rᵀ (p − origin)`; the result is `origin + R · law(q)`.
- Defaults (reported in `data.frame` with `defaulted: true`): origin = bounding-box centre for twist / taper / stretch / scale,
  the box face centre at `start` for bend (neutral fibre through the centroid in y); axis = the longest box direction;
  reference = the next longest. Region default = the body extent along the axis (SOLIDWORKS trim planes at the extents [R1]).
- Ramp `w(t)`, `t = (z − start)/(end − start)`: `linear` = clamp(t, 0, 1); `smooth` = 3c² − 2c³ (c = clamp(t)); `none` (stretch only).
  `infinite: true` replaces the region by the whole axis with the law's rate measured per unit length (`angleDeg` per `length`).

### 5.2 Axis laws (Barr 1984 [R25], formulas as given in [R27]; Jacobians derived here)

| Law     | Map (local q = (x, y, z))                                                                                                   | det J               | Preserves                                       | Closed forms used by the VCs                                                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| twist   | θ = Θ w(t); x' = x cos θ − y sin θ, y' = x sin θ + y cos θ, z' = z                                                          | 1                   | volume, every z-section (rotated)               | box a × b × L, linear: lateral area = 2L·[2G(b/2) + 2G(a/2)], G(Y) = Y√(1+k²Y²)/2 + asinh(kY)/(2k), k = Θ/L            |
| taper   | s = 1 + (S − 1) w; x' = s x, y' = s y (flat: y' = y)                                                                        | s² (s)              | sections similar                                | linear: V = A L (1 + S + S²)/3; flat: A L (1 + S)/2; smooth: A L (1 + c + 13c²/35), c = S − 1; cylinder → cone frustum |
| stretch | z' = start + f (z − start) in region, z + (f − 1)(end − start) beyond                                                       | f in region         | sections                                        | V' = V + (f − 1) V_region                                                                                              |
| bend    | θ = (ẑ − start)/R, ẑ = clamp(z); y' = R − (R − y) cos θ + (z − ẑ) sin θ; z' = start + (R − y) sin θ + (z − ẑ) cos θ; x' = x | (R − y)/R in region | neutral fibre length; V' = A (R − ȳ) Θ (Pappus) | box: V' = a L (y1 − y0)(1 − (y0 + y1)/(2R)); fibre at y: (R − y) L / R; cylinder 360° → torus 2π²Rr², area 4π²Rr       |
| affine  | q' = M q + t                                                                                                                | det M               | —                                               | sphere → spheroid areas (closed forms in `generate_analytic_refs.mjs`)                                                 |

Derivations recorded once here (the generator cross-checks each numerically):

- **Twist area element.** On the face x = a/2 parameterised by (y, z): ∂P/∂y = R(θ) e_y (unit), ∂P/∂z = (θ' R(θ) J (a/2, y), 1) with
  J the 90° rotation; ∂y·∂z = θ' a/2 and \|∂z\|² = 1 + θ'²(a²/4 + y²), so \|∂y × ∂z\| = √(1 + θ'² y²).
- **Crease at a linear region end.** Just inside the region the face normal is ∝ (1, 0, k y) against (1, 0, 0) outside: crease angle
  atan(k \|y\|), maximum atan(k b/2) (= 0.155806 rad for b = 10, Θ = 90° over 50); `smooth` gives 0 because θ'(start) = 0.
- **Bend Jacobian.** In the region ∂(y', z')/∂(y, z) has determinant (R − y)/R (polar coordinates with radius R − y and angle z/R),
  so det J ≤ 0 iff y ≥ R: `DEF_BEND_RADIUS_TOO_SMALL` when R ≤ max y of the body on the centre side. Beyond the region the map is
  rigid (det 1); the map is C1 across `end` (tangent continuous), C0 in curvature.
- **Bend overlap.** For \|Θ\| > 2π the images of z and z + 2πR coincide: refused as `DEF_SELF_INTERSECTION` before evaluation.

### 5.3 Lattice (FFD, Sederberg & Parry 1986 [R26])

- Normalised lattice coordinates (s, t, u) in the lattice box (axis-aligned in the frame; the paper's equation (1) reduces to a
  division per axis); control points P_ijk = box corner + (i/l, j/m, k/n) ∘ size + offset_ijk; image
  X(s, t, u) = Σ B_i^l(s) B_j^m(t) B_k^n(u) P_ijk (paper equation (2)).
- **Identity / affine reproduction**: Bernstein polynomials reproduce linear functions, so undisplaced points give X = p, and
  P_ijk = A p_ijk + b gives X = A p + b exactly (VC-DEF-14, residual 7e-15 / 1.4e-14 in `data/ffd_cases.json`).
- **Jacobian**: computed analytically from the derivative lattice (differences of control points, degrees l−1 / m / n …);
  its min is sampled on a (2·deg + 1) grid per cell and bounded by the Bernstein coefficients of det J (the paper: "the largest
  and smallest polynomial coefficients provide upper and lower bounds on the volume change"). Barrel case m = 1.5: exact range
  [1, 1.5625], Bernstein bound [1, 1.8333] (`data/ffd_cases.json`). Bound ≤ 0 with sampled min > 0 ⇒ refine samples (×2, 3 times),
  then decide on the sampled value.
- **Local continuity**: `fixedLayers: k` refuses moves of the k outer layers adjacent to any lattice face the body crosses
  (`DEF_LATTICE_FIXED_MOVED`), which gives C^(k−1) continuity with the undeformed part (paper §3.1).
- Points outside the box are not moved (the lattice must enclose the deformed region; `box: 'bounds'` adds 1e-6 × diagonal margin).
- A deformed parametric surface stays parametric ("a simple composition", paper §2.1), which is exactly what §5.6 approximates.

### 5.4 Flow

- **Along a curve**: base frame along the base curve (straight by default), target frame along the target curve at the same arc
  length (or scaled by L_target / L_base with `stretch`); frames are rotation-minimising (double reflection) or `fixed_up`;
  p = base(s) + x n_b + y b_b ↦ target(s') + x n_t + y b_t. On a circular target this is exactly `bend` (VC-DEF-18:
  max difference 0 in `data/flow_cases.json`). Local fold: a body point at distance d > ρ_min (smallest radius of curvature of the
  target, on the centre side) folds: `DEF_FOLDOVER` with ρ_min.
- **Onto a surface**: base point (u, v, w) (arc-length coordinates on the base plane / sheet, w along its normal) ↦
  S(u*, v*) + w N(u*, v*), (u*, v*) found so that the arc lengths from `targetOrigin` along `targetUDirection` and the
  perpendicular iso-curve equal u and v (geodesic-polar for a developable target, iso-parameter arc length otherwise, the
  choice reported). On a cylinder of radius R this is (x, y, w) ↦ ((R + w) sin(x/R), y, (R + w) cos(x/R) − R),
  det J = (R + w)/R: plate W × H × t outside gives V = W H (t + t²/(2R)) (VC-DEF-17). Overlap when the wrap exceeds 2πR,
  fold when w < −ρ (inside the radius of curvature).

### 5.5 Point push

- p ↦ p + d · dir · φ(\|p − c\|/r), φ(s) = (1 − s²)³ for s < 1 (`smooth_c2`, C2 at s = 1), φ = 1 − 3s² + 2s³ (`cubic`, C1).
- det J = 1 + d (dir · ∇φ); min det = 1 − \|d\| max\|∇φ\|, max\|∇φ\| = 96/(25√5 r) at s = 1/√5 for `smooth_c2`, hence fold limit
  \|d\| < 25√5 r/96 = 0.5823 r (exact, VC-DEF-16).
- Volume change for a push along the normal of a planar face that the support sphere cuts in a full disk:
  ΔV = d ∫_disk φ dA = d π r²/4 (divergence theorem; VC-DEF-15).

### 5.6 Exact path (native sidecar, `cpp/deform.cxx`)

| Step | Operation                                                                                                                                                                                                                                                                                           | OCCT classes [R28]                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Similarity (uniform scale × rotation): `gp_Trsf` — analytic faces kept                                                                                                                                                                                                                              | `BRepBuilderAPI_Transform` (existing `transformed_named`)                                                                                                                                                     |
| 1    | Affine law: `gp_GTrsf` (3 × 4 matrix), copy = true; negative determinant handled by the modification (`RevFace` when the transform is negative)                                                                                                                                                     | `BRepBuilderAPI_GTransform` (it runs `BRepBuilderAPI_NurbsConvert` unconditionally first, so faces other than planes become B-splines: master `BRepBuilderAPI_GTransform.cxx`), `BRepTools_GTrsfModification` |
| 2    | Non-linear law: convert all geometry to B-splines with the same parameterisation                                                                                                                                                                                                                    | `BRepBuilderAPI_NurbsConvert` ("except for Planes"), then `ShapeCustom::ConvertToBSpline(shape, true, true, true, planeMode = true)` ("with same parameterisation")                                           |
| 3    | Split faces where the law is not C2: region ends for `linear` falloff (C0) and for bend / smooth twist / taper ends (C1 / C2 breaks), lattice cell boundaries for B-spline lattices (V2)                                                                                                            | `BRepAlgoAPI_Splitter` with the planes z = start / end (frame)                                                                                                                                                |
| 4    | Warp: a `BRepTools_Modification` subclass `WarpModification` driven by `BRepTools_Modifier`                                                                                                                                                                                                         | `BRepTools_Modification`, `BRepTools_Modifier`                                                                                                                                                                |
| 4a   | `NewSurface`: wrap the face's surface S, restricted to the face's UV bounds (`BRepTools::UVBounds` + 1 % margin), in `WarpedSurface : Adaptor3d_Surface` with `D0 = F(S)`, `D1` / `D2` by the chain rule (J_F S_u, J_F S_v, J_F S_uu + H_F[S_u, S_u], …; `UContinuity` = min(S, F)); approximate it | `Adaptor3d_Surface` (virtual `D0`/`D1`/`D2`), `GeomConvert_ApproxSurface(adaptor, tol_s, C2, C2, maxDeg 9, maxDeg 9, maxSegments, precisCode)`, `MaxError()`                                                  |
| 4b   | `NewCurve2d`: return the existing p-curve: the approximation keeps the (u, v) parameterisation of S over the same bounds, so every p-curve stays valid                                                                                                                                              | — (key property; verified by the curve-on-surface check of step 6)                                                                                                                                            |
| 4c   | `NewCurve`: 3D edge curve C → `WarpedCurve : Adaptor3d_Curve` (F∘C) → approximation; degenerate edges (poles) keep no 3D curve                                                                                                                                                                      | `Adaptor3d_Curve`, `GeomConvert_ApproxCurve(adaptor, tol_c, C2, maxSegments, maxDeg)`                                                                                                                         |
| 4d   | `NewPoint`: F(P); `NewParameter`: unchanged                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                             |
| 5    | Tolerances and same-parameter                                                                                                                                                                                                                                                                       | `BRepLib::SameParameter`, `ShapeFix_Shape` (tolerances only, no topology change)                                                                                                                              |
| 6    | Validity: solid, closed, curve-on-surface consistent, no self-intersection                                                                                                                                                                                                                          | `BRepCheck_Analyzer`, `BOPAlgo_ArgumentAnalyzer` (`SelfInterMode`, `CurveOnSurfaceMode`) → `DEF_SELF_INTERSECTION` / `DEF_KERNEL_REFUSED`                                                                     |
| 7    | `preserveAnalytic` (FR-DEF-12): replace B-spline faces / edges recognised within `tolerance`                                                                                                                                                                                                        | `ShapeAnalysis_CanonicalRecognition` (`IsPlane`, `IsCylinder`, `IsCone`, `IsSphere`, `IsLine`, `IsCircle`, `IsEllipse`)                                                                                       |
| 8    | Report: max approximation error over faces / edges, faces converted, faces split, history                                                                                                                                                                                                           | `GeomConvert_Approx*::MaxError`, `BRepTools_Modifier::ModifiedShape` (face map for SC-N1 persistent names: a face keeps its name; split faces get `<name>~r<k>`)                                              |

Tolerance split: `tol_s = 0.5 tol`, `tol_c = 0.25 tol`, so an edge lies within tolerance of both adjacent faces. A face whose
approximation fails or exceeds `tol_s` after `maxSegments` (default 64 per direction) refuses the whole node with
`DEF_APPROX_TOLERANCE` and the face index; `mode: "auto"` then falls back to the mesh path **only if** `output.allowMeshFallback`
is true (default false: an exact body never silently becomes a mesh, the rule of `kernelShape.ts`).

The C++ law evaluator (`deform_laws.hxx`, closed forms of §5.2–5.5 with first and second derivatives) mirrors
`geometry/deform/laws.ts`; parity is a test against `validation/data/point_vectors.json` (TR-DEF-04).

Wire: `server/src/native/kernelLeaves.ts` encodes the node as `{ op: 'deform', source, law, frame, region, output }` (JSON, the
NURBS payloads of flow laws with the existing `encodeBspline` / `encodeSurface`), sent only when the sidecar reports the
capability `deform` in `info` (pattern of `bsplineSections`); otherwise `supports('deform')` is false on that kernel and the command
takes the mesh path in `auto` mode.

### 5.7 Mesh path

1. Source mesh: the kernel tessellation of the source recipe (Manifold) or the entity's display mesh (no kernel, mesh entities).
2. Refinement: edge length h ≤ √(8 tol / M2), M2 = closed-form bound of the second derivative of the law along any direction over
   the deformed region (`geometry/deform/bounds.ts`):

| Law     | M2 bound                                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------- |
| twist   | θ'² ρ_max + \|θ''\| ρ_max (θ' = Θ w'(t)/(end − start))                                                          |
| taper   | \|s''\| ρ_max (0 for linear: no refinement along z, only across the region ends)                                |
| bend    | (R + \|y\|\_max) / R²                                                                                           |
| lattice | max over cells of the second differences of the control net × degree factors (B-spline second-derivative bound) |
| point   | d · max\|∇²φ\| (smooth_c2: 6 \|d\| / r² at s = 0)                                                               |
| flow    | from the target's curvature: (1 + w_max κ_max) κ_max                                                            |

Example (data/mesh_budget.json): 90° twist of a 10 × 10 × 100 box at tol 0.01 → h ≤ 6.77; bend R 50, y ∈ [−5, 5] → h ≤ 1.91.
Manifold: `refineToLength(h)` then `warpBatch(law)` (manifold-3d 3.5.4: "allows the vertices to be moved according to any
arbitrary input function … that is not checked here" [R29]); no kernel: midpoint subdivision in `meshWarp.ts`. 3. Checks: closed-form Jacobian bound before warping; after warping a BVH triangle-triangle test (`geometry/meshBvh.ts`) for
self-intersection and the closure check (`meshClosure.ts`). Budget: refuse with `DEF_BUDGET_EXCEEDED` above 4 M triangles. 4. Result flagged `representation: "mesh"`, `method: "mesh"` in every downstream measurement (as `mass_properties` does today).

### 5.8 Curves and sheets (core, FR-DEF-17)

`nurbs_curve`: sample the deformed curve at Greville-refined parameters (≥ 8 per span, doubled until the mid-sample error
≤ tol / 2), refit with the existing `approximate_curve` machinery (`lib/nurbs`) at the same degree; `nurbs_surface` likewise with
the global surface fit of `surface_from_points` (A9.4); affine laws map the control points exactly (NURBS are affinely invariant).
Trim loops of sheets are kept in (u, v) (the parameterisation is kept by construction).

### 5.9 Tolerances and named defaults

| Name                     | Default                                                                                       | Source (reported)                        |
| ------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `output.tolerance`       | 1e-5 × bounding-box diagonal, clamped to [1e-6, 0.01] document units                          | "llull DEF default, TECHNICAL_SPEC §5.9" |
| `volumeDriftRel` (check) | 1e-4 exact path, 5e-3 mesh path                                                               | same                                     |
| `creaseRad` (check)      | 0.01 rad (OCCT `BRepOffsetAPI_MakeFilling` TolAng default, reused for G1 as in SRF FR-SRF-40) | SRF TECHNICAL_SPEC §5.9                  |
| Jacobian floor           | det J ≥ 1e-6 counts as positive                                                               | same                                     |

### 5.10 Predicted volume (volume-drift check)

∫_source det J dV is integrated over the source solid by a signed tetrahedral fan of its closed tessellation (one tetrahedron per
triangle to the centroid, degree-5 Keast rule per tetrahedron; exact for affine laws and twist, convergent otherwise); the
measured volume is the exact (`massProperties`) or mesh volume of the result. A difference above `volumeDriftRel` is the finding
`DEF_CHECK_VOLUME_DRIFT`: an independent proof that the kernel built what the law describes.

## 6. Interop & persistence

| Item            | Behaviour                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document        | the `deform` node lives in `MeshSolidEntity.brep`; params in the feature step; no new top-level slice                                                                                                                                                   |
| STEP            | exact results export through the existing `export_step_ap242` path as B-spline faces (`B_SPLINE_SURFACE_WITH_KNOTS`); mesh results as faceted solids with a note (existing behaviour of mesh entities)                                                  |
| Mesh formats    | STL / OBJ / glTF / 3MF from the tessellation                                                                                                                                                                                                            |
| Code export     | CadQuery: affine laws as `transformGeometry` with a non-uniform matrix (to verify against CadQuery docs when implementing, D9); other laws: a named note "deformation not expressible in CadQuery", the body exported as the deformed STEP and imported |
| Load validation | `shapeRecipe.ts` validates law kinds, finite numbers, degrees, index ranges; failures name the entity and path                                                                                                                                          |

## 7. CLI / UI surfaces and error codes

### 7.1 Stable error and finding codes (AF-11)

| Code                                                                                                       | Raised by                                               | Meaning                                                          | ids / paths                                       | Remediation                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `DEF_ENTITY_NOT_FOUND`                                                                                     | all                                                     | unknown id                                                       | `params.id` / `params.ids[i]`                     | `llull describe_scene` to list ids                                              |
| `DEF_TARGET_UNSUPPORTED`                                                                                   | M commands                                              | 2D drafting kind, text, dimension, image, instance               | entity id, kind                                   | 2D: convert to `nurbs_curve` or extrude first; instance: `explode_instance`     |
| `DEF_FRAME_DEGENERATE`                                                                                     | M                                                       | axis zero, reference ∥ axis                                      | `params.frame.axis` / `.reference`                | give a reference not parallel to the axis                                       |
| `DEF_REGION_INVALID`                                                                                       | M                                                       | end ≤ start, non-finite                                          | `params.region`                                   | `end > start` along the axis, document units                                    |
| `DEF_REGION_MISSES_BODY`                                                                                   | M                                                       | the region / support sphere / lattice box does not meet the body | `params.region`, body extent along the axis       | `analyze_deformation` reports the extent; move the region                       |
| `DEF_NO_EFFECT`                                                                                            | M                                                       | identity params (angle 0, factor 1, no moves)                    | param path                                        | —                                                                               |
| `DEF_SCALE_SINGULAR`                                                                                       | `scale_nonuniform`                                      | a factor is 0                                                    | `params.factors[i]`                               | use a small non-zero factor                                                     |
| `DEF_TAPER_DEGENERATE`                                                                                     | `taper_body`                                            | scaleEnd ≤ 0                                                     | `params.scaleEnd`                                 | > 0 (a point apex is not a valid solid face)                                    |
| `DEF_STRETCH_FACTOR` / `DEF_PRESERVE_VOLUME_REGION`                                                        | `stretch_body`                                          | factor ≤ 0 / preserveVolume with a partial region                | `params.factor` / `params.region`                 | factor > 0 / drop the region or preserveVolume                                  |
| `DEF_BEND_UNDERDETERMINED` / `DEF_BEND_OVERDETERMINED`                                                     | `bend_body`                                             | not exactly two of radius, angleDeg, length                      | `params`                                          | give two                                                                        |
| `DEF_BEND_RADIUS_TOO_SMALL`                                                                                | `bend_body`                                             | R ≤ inner-side distance of the body from the neutral fibre       | `params.radius`; the distance                     | radius > the distance, or move `frame.origin` toward the inner side             |
| `DEF_LATTICE_DEGREE` / `DEF_LATTICE_INDEX` / `DEF_LATTICE_FIXED_MOVED`                                     | `deform_lattice`                                        | degree ∉ 1..8 / index out of range / a fixed layer moved         | `params.degrees[a]` / `params.moves[i].index`     | —                                                                               |
| `DEF_FOLDOVER`                                                                                             | all laws                                                | min det J ≤ 0 inside the body                                    | worst sample point; `params.<param>`              | the closed-form limit when known ("distance < 5.823094"), else reduce the param |
| `DEF_SELF_INTERSECTION`                                                                                    | all                                                     | result overlaps itself (bend > 360°, flow wrap, global fold)     | entity id, intersecting face pair / triangle pair | reduce angle / extent                                                           |
| `DEF_FLOW_OVERLAP`                                                                                         | `flow_on_surface`                                       | wrap length > the closed target period (2πR)                     | `params`                                          | shorten the body or enlarge the target                                          |
| `DEF_FLOW_OUTSIDE_BASE` / `DEF_FLOW_TARGET_INVALID`                                                        | `flow_on_surface`                                       | body not over the base domain / target not a sheet or face       | `params.base` / `params.target`                   | —                                                                               |
| `DEF_TARGET_FACE_NEEDS_KERNEL`                                                                             | `flow_on_surface`                                       | face target without an exact kernel                              | `params.target`                                   | run with the native kernel or use a sheet target                                |
| `DEF_CURVE_NOT_FOUND` / `DEF_CURVE_INVALID` / `DEF_CURVE_PAIR_INVALID`                                     | flow / curve-to-curve                                   | missing, not G1, zero length                                     | `params.targetId`                                 | —                                                                               |
| `DEF_MORPH_INCOMPATIBLE`                                                                                   | `morph_bodies`                                          | structures differ                                                | both ids                                          | 05 IMP for topology-changing morphs                                             |
| `DEF_EXACT_UNAVAILABLE`                                                                                    | M with `mode: "exact"`                                  | no exact kernel / kernel lacks `deform`                          | `params.output.mode`                              | `--kernel occt` (desktop default) or `mode: "auto"`                             |
| `DEF_APPROX_TOLERANCE`                                                                                     | exact path                                              | a face / edge approximation above tolerance                      | face index, achieved error                        | raise `tolerance`, narrow the region, or `allowMeshFallback`                    |
| `DEF_KERNEL_REFUSED`                                                                                       | exact path                                              | sidecar returned null (invalid result)                           | recipe path                                       | `check_model` on the source; try the mesh path                                  |
| `DEF_BUDGET_EXCEEDED`                                                                                      | mesh path                                               | > 4 M triangles after refinement                                 | —                                                 | raise `tolerance`                                                               |
| `DEF_RECIPE_INVALID`                                                                                       | load                                                    | malformed deform node                                            | entity id, path                                   | —                                                                               |
| `DEF_NOT_DEFORMED`                                                                                         | `analyze_deformation`                                   | entity has no deform node                                        | `params.id`                                       | —                                                                               |
| `DEF_CHECK_FOLDOVER` · `DEF_CHECK_SELF_INTERSECTION` · `DEF_CHECK_APPROX_ERROR` · `DEF_CHECK_VOLUME_DRIFT` | `check_deformation` (fail)                              | as named; drift = measured vs predicted volume                   | entity id, value, limit, unit                     | re-run the command with the remediation of the matching `DEF_*` code            |
| `DEF_CHECK_MESH_RESULT`                                                                                    | (warn; with `purpose: "release"` also `reviewRequired`) | faceted result                                                   | entity id                                         | native kernel + `mode: "exact"`                                                 |
| `DEF_CHECK_REGION_CREASE`                                                                                  | (warn)                                                  | crease at a region end > `creaseRad`                             | entity id, angle                                  | `falloff: "smooth"`                                                             |
| `DEF_CHECK_ANALYTIC_LOST`                                                                                  | (info)                                                  | analytic faces became B-splines                                  | count                                             | `preserveAnalytic: true`                                                        |
| `DEF_CHECK_TOLERANCE_DEFAULTED` · `DEF_CHECK_INPUT_UNVERIFIED`                                             | (warn; unverified not suppressible)                     | named default used / unverified source                           | names / ids                                       | give the tolerance / pin the source                                             |

### 7.2 Result conventions (AF-10, AF-31..35)

`analyze_deformation` `data`:
`{ law: { kind, params }, frame { origin, axis, reference, defaulted }, region?, path: 'exact' | 'mesh', unit, angleUnit: 'rad',
jacobian { min, max, minAt, bound?: { min, max, method } }, volume { source, predicted, measured, driftRel }, maxDisplacement,
approximation? { maxError, tolerance: NamedTolerance, facesConverted, facesSplit }, topology? { before { faces, edges, vertices },
after {…} }, regionCrease?: [{ at: 'start' | 'end', angleRad }], fibres? { neutral, inner, outer } (bend), compareTo? { maxDeviation },
unverified, provenance { method, formula, reference, kernel, inputs } }`. Mass / area via `mass_properties`.

### 7.3 Agent-first compliance

| AF                         | Where                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| AF-01, AF-02               | §4: registry commands, agent descriptions with units and next command                            |
| AF-03                      | FR-DEF-33 `llull guide` deformation section                                                      |
| AF-04                      | `angleDeg`, lengths in document units, factors unitless — in every schema description            |
| AF-05                      | all plans in `validation/plans/` pass `--validate` (target plans once the commands exist)        |
| AF-10, AF-12               | §7.2; samples summarised (min / max / worst), `output: "samples"` for raw grids                  |
| AF-11                      | §7.1                                                                                             |
| AF-13                      | deterministic sampling grids, fixed seeds, step-scoped ids                                       |
| AF-20, AF-30               | `check_deformation`                                                                              |
| AF-21                      | Jacobian, crease angles, fibre lengths, volume drift in `data` instead of a visual judgement     |
| AF-22                      | `render_view isolate=<id> --save`                                                                |
| AF-31, AF-32, AF-33, AF-35 | §5.9 named defaults, recipe-walk `unverified`, `reviewRequired` for mesh + release, `provenance` |
| AF-40, AF-42               | `--timeout`, `--progress` on the exact path (per face); `--dry-run`                              |
| AF-41                      | all computation in core TS, Manifold (bundled) or the bundled native sidecar; no network         |

## 8. Performance & robustness budgets (desktop, native sidecar, one worker)

| Operation                                                                          | Budget                                                                                                                                                      | Notes                                    |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `scale_nonuniform` on a 500-face B-rep                                             | ≤ 0.5 s                                                                                                                                                     | GTransform, no approximation             |
| `twist_body` / `taper_body` / `bend_body` on a 200-face B-rep at default tolerance | ≤ 2 s                                                                                                                                                       | step 4a dominates                        |
| same, 2000 faces                                                                   | ≤ 15 s, `--progress` per 100 faces                                                                                                                          |                                          |
| mesh path, 1 M output triangles                                                    | ≤ 3 s                                                                                                                                                       | `refineToLength` + `warpBatch`           |
| `deform_lattice` degrees [3, 3, 3] on 200 faces                                    | ≤ 4 s                                                                                                                                                       |                                          |
| `analyze_deformation`                                                              | ≤ 1 s for 1 M Jacobian samples                                                                                                                              |                                          |
| Robustness                                                                         | null from the kernel → no-op with code; never a crash on zero-volume regions, coincident frame vectors, tolerance ≤ 0, bodies with seams or poles (spheres) | fuzz tests over random frames and params |

## 9. Test strategy

| Level            | Location                                                                                                                                      | Content                                                                                                                           | VC                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Unit (laws)      | `tests/unit/deform/laws.test.ts`                                                                                                              | maps, Jacobians and bounds vs `validation/data/*.json`; parity vectors `point_vectors.json`                                       | 01–18, 30                         |
| Unit (commands)  | `tests/unit/deform/*.test.ts`                                                                                                                 | happy + failure per command, `is pure`, both paths (stub exact kernel + Manifold), codes of §7.1                                  | 09, 12, 16, 17, 19, 21, 24, 27    |
| Agent-first      | `tests/unit/deform/agentFirst.test.ts`, `tests/unit/contract/`                                                                                | named defaults, unverified propagation, reviewRequired, units audit, schema snapshot                                              | 26, 28                            |
| Golden           | `tests/golden/plans.ts`: `deform_twist_box`, `deform_bend_torus`, `deform_ffd_barrel`, `deform_point_push` (`validation/plans/target_*.json`) | id-normalised snapshot + replay equality                                                                                          | 25                                |
| Native (cargo)   | `solver/crates/llull-kernel-occt/src/deform.rs` tests                                                                                         | WarpModification on box / cylinder / sphere (poles) / torus; p-curve validity; `MaxError` ≤ tol; C++ laws vs `point_vectors.json` | 02, 03, 06, 08, 20, 30            |
| Server (sidecar) | `server/tests/nativeKernelDeform.test.ts`                                                                                                     | exact volumes / areas of the analytic suite, `preserveAnalytic`, STEP round trip, self-intersection refusal                       | 01–11, 13, 15, 17, 20, 22, 23, 36 |
| Mesh kernel      | `tests/unit/deform/manifold.test.ts`                                                                                                          | the same suite at mesh tolerance; refinement budget                                                                               | 19                                |
| Perf             | `tests/unit/deform/perfBudget.test.ts` + server perf                                                                                          | §8 (4 × slack in CI)                                                                                                              | 29                                |
| Component        | `tests/component/DeformOverlay.test.tsx`                                                                                                      | overlays toggle without document change                                                                                           | 35                                |

### 9.1 Technical requirements

| Id        | Requirement                                                                                                                                                                                                                                          | Spec           | VCs                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------- |
| TR-DEF-01 | Pure law library `geometry/deform/` (maps, first / second derivatives, Jacobian, closed-form bounds, ramps) with no kernel                                                                                                                           | §2.1, §5.1–5.5 | 01–18                      |
| TR-DEF-02 | `DeformLaw` / `DeformFrame` / `DeformRegion` / `DeformOutput` types and the `deform` `ShapeRecipe` member, validated on load, hashed by `recipeKey`                                                                                                  | §3             | 25, 27                     |
| TR-DEF-03 | Native exact path: `WarpModification` (BRepTools_Modification) + `WarpedSurface` / `WarpedCurve` adaptors + `GeomConvert_Approx*`, affine via `BRepBuilderAPI_GTransform`, similarity via `gp_Trsf`, region splitting, validity, capability `deform` | §5.6           | 02, 03, 06, 08, 11, 20, 22 |
| TR-DEF-04 | TS ↔ C++ law parity on `validation/data/point_vectors.json` (≤ 1e-9 absolute)                                                                                                                                                                        | §5.6           | 30                         |
| TR-DEF-05 | Mesh path: refinement bound per law, Manifold `refineToLength` + `warpBatch`, TS fallback, post-warp self-intersection and closure checks                                                                                                            | §5.7           | 19, 36                     |
| TR-DEF-06 | Pre-checks: closed-form fold limits (bend, point, flow), FFD Bernstein bound + sampling                                                                                                                                                              | §5.2–5.5, §5.3 | 09, 13, 16, 17             |
| TR-DEF-07 | Topology preservation and persistent-name mapping through the modifier history (split faces suffixed)                                                                                                                                                | §5.6 step 8    | 20                         |
| TR-DEF-08 | Core curve / sheet refit path                                                                                                                                                                                                                        | §5.8           | 24                         |
| TR-DEF-09 | `analyze_deformation` / `check_deformation` result shapes, volume-drift integration                                                                                                                                                                  | §5.10, §7.2    | 04, 07, 13, 26             |
| TR-DEF-10 | Stable codes with path, ids, remediation for every refusal and finding                                                                                                                                                                               | §7.1           | 27                         |
| TR-DEF-11 | Named defaults, unverified propagation, reviewRequired, provenance                                                                                                                                                                                   | §5.9, §7.2     | 26                         |
| TR-DEF-12 | Purity, determinism, performance budgets                                                                                                                                                                                                             | §2.3, §8       | 25, 29                     |
| TR-DEF-13 | Exact results export to STEP as B-spline faces; `preserveAnalytic` via canonical recognition                                                                                                                                                         | §5.6, §6       | 22, 23                     |

## 10. Delivery plan

| Milestone      | Content                                                                                                                                                                                                                                            | Depends on                  | Effort (eng-weeks) |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------ |
| M0             | decisions D1–D8; `model/deform.ts`, recipe member + validation; `geometry/deform/` laws + bounds + parity vectors test; `commands/deform/` schema fragments                                                                                        | —                           | 2                  |
| M1 (MVP mesh)  | `scale_nonuniform` (exact affine on the native kernel from day one: GTransform is a few lines), `twist_body`, `taper_body`, `stretch_body`, `bend_body` on Manifold and without a kernel; `analyze_deformation`, `check_deformation`; golden plans | M0                          | 4                  |
| M2 (MVP exact) | `deform.cxx` WarpModification + adaptors + approximation + splitting + validity + capability `deform`; host wire; server tests; STEP of results                                                                                                    | M1, native toolchain (SV1)  | 5                  |
| M3 (V1)        | `deform_lattice`, `deform_by_point`, `flow_along_curve`, curves / sheets path, `ids` multi-body, `keepSource`                                                                                                                                      | M2                          | 4                  |
| M4 (V1)        | `flow_on_surface` (sheet and face targets), `preserveAnalytic`, UI overlays (frame, region, lattice, Jacobian map)                                                                                                                                 | M3                          | 3                  |
| M5 (V2)        | `deform_curve_to_curve` (RBF / thin-plate displacement fitted to curve pairs, then the generic warp), `morph_bodies`, B-spline lattices and oriented boxes                                                                                         | M4; 04 DIR for drag handles | 3                  |

Total ≈ 21 eng-weeks. Cross-pack: 04 DIR commits these commands from drag gestures; 03 WRP may reuse `geometry/deform/flow.ts` for
curves on faces; 07 MSH may reuse the mesh refinement.

## 11. Open questions / decisions needed

| #   | Question                                                            | Proposal                                                                                                          |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| D1  | Core feature catalog or plugin?                                     | core (`commands/deform/`): generic modelling, used by every domain                                                |
| D2  | One `deform_body` with a law union, or one command per law?         | one command per law (discoverable by `llull search`, specific param descriptions), one internal `DeformLaw` union |
| D3  | Result kind                                                         | `mesh` entity with `brep` = deform node (fillet pattern); no new entity kind                                      |
| D4  | Default falloff                                                     | `smooth` (no crease); `linear` explicit (Rhino-style "blends in and out" is the closest benchmark)                |
| D5  | Default bend neutral fibre                                          | through the body centroid (volume preserved by Pappus); `frame.origin` overrides                                  |
| D6  | `mode: "auto"` fallback from exact to mesh on approximation failure | only with `allowMeshFallback: true`; default refuse (an exact body never silently becomes a mesh)                 |
| D7  | 2D drafting entities                                                | refuse in MVP; V1 could map planar laws (in-plane bend, taper) to `nurbs_curve` output — owner to decide          |
| D8  | Lattice basis                                                       | Bernstein (the paper) in V1; B-spline lattices (local control, many cells) in V2                                  |
| D9  | CadQuery code export of affine maps                                 | verify `transformGeometry` in the CadQuery docs before relying on it; else a note                                 |

## 12. References

Same numbering as FUNCTIONAL_SPEC §11 ([R1]–[R29]). OCCT headers read (7.9.2, `include/opencascade/` of llull's sidecar build):
`BRepBuilderAPI_GTransform.hxx`, `BRepTools_GTrsfModification.hxx`, `BRepTools_Modification.hxx`, `BRepTools_Modifier.hxx`,
`BRepBuilderAPI_NurbsConvert.hxx`, `ShapeCustom.hxx`, `GeomConvert_ApproxSurface.hxx`, `GeomConvert_ApproxCurve.hxx`,
`Adaptor3d_Surface.hxx`, `Adaptor3d_Curve.hxx`, `ShapeAnalysis_CanonicalRecognition.hxx`, `BOPAlgo_ArgumentAnalyzer.hxx`,
`BRepCheck_Analyzer.hxx`, `BRepLib.hxx`; source `src/ModelingAlgorithms/TKTopAlgo/BRepBuilderAPI/BRepBuilderAPI_GTransform.cxx`
(master) — https://github.com/Open-Cascade-SAS/OCCT (accessed 2026-10). llull internal: `.claude/rules/architecture.md`,
`docs/aerospace/AGENT_FIRST.md`, `docs/aerospace/02-advanced-surfacing/TECHNICAL_SPEC.md` (§5.9 tolerances, §13 sidecar patterns).
