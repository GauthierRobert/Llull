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
| `deform_curve_to_curve` (V2) | M   | K?                                                     | `pairs: [{ initialId, targetId? }]`, `fixedPoints?` (world points held still), `stiffness` (0..1), `output`                                                                          | as above                                                               | every initial curve lands on its target within tolerance (residual reported)                                  | `DEF_CURVE_PAIR_INVALID`, `DEF_FOLDOVER`                                                                                     |
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

| Code                                                                                                         | Raised by                                               | Meaning                                                          | ids / paths                                       | Remediation                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `DEF_ENTITY_NOT_FOUND`                                                                                       | all                                                     | unknown id                                                       | `params.id` / `params.ids[i]`                     | `llull describe_scene` to list ids                                              |
| `DEF_TARGET_UNSUPPORTED`                                                                                     | M commands                                              | 2D drafting kind, text, dimension, image, instance               | entity id, kind                                   | 2D: convert to `nurbs_curve` or extrude first; instance: `explode_instance`     |
| `DEF_FRAME_DEGENERATE`                                                                                       | M                                                       | axis zero, reference ∥ axis                                      | `params.frame.axis` / `.reference`                | give a reference not parallel to the axis                                       |
| `DEF_REGION_INVALID`                                                                                         | M                                                       | end ≤ start, non-finite                                          | `params.region`                                   | `end > start` along the axis, document units                                    |
| `DEF_REGION_MISSES_BODY`                                                                                     | M                                                       | the region / support sphere / lattice box does not meet the body | `params.region`, body extent along the axis       | `analyze_deformation` reports the extent; move the region                       |
| `DEF_NO_EFFECT`                                                                                              | M                                                       | identity params (angle 0, factor 1, no moves)                    | param path                                        | —                                                                               |
| `DEF_SCALE_SINGULAR`                                                                                         | `scale_nonuniform`                                      | a factor is 0                                                    | `params.factors[i]`                               | use a small non-zero factor                                                     |
| `DEF_TAPER_DEGENERATE`                                                                                       | `taper_body`                                            | scaleEnd ≤ 0                                                     | `params.scaleEnd`                                 | > 0 (a point apex is not a valid solid face)                                    |
| `DEF_STRETCH_FACTOR` / `DEF_PRESERVE_VOLUME_REGION`                                                          | `stretch_body`                                          | factor ≤ 0 / preserveVolume with a partial region                | `params.factor` / `params.region`                 | factor > 0 / drop the region or preserveVolume                                  |
| `DEF_BEND_UNDERDETERMINED` / `DEF_BEND_OVERDETERMINED`                                                       | `bend_body`                                             | not exactly two of radius, angleDeg, length                      | `params`                                          | give two                                                                        |
| `DEF_BEND_RADIUS_TOO_SMALL`                                                                                  | `bend_body`                                             | R ≤ inner-side distance of the body from the neutral fibre       | `params.radius`; the distance                     | radius > the distance, or move `frame.origin` toward the inner side             |
| `DEF_LATTICE_DEGREE` / `DEF_LATTICE_INDEX` / `DEF_LATTICE_FIXED_MOVED`                                       | `deform_lattice`                                        | degree ∉ 1..8 / index out of range / a fixed layer moved         | `params.degrees[a]` / `params.moves[i].index`     | —                                                                               |
| `DEF_FOLDOVER`                                                                                               | all laws                                                | min det J ≤ 0 inside the body                                    | worst sample point; `params.<param>`              | the closed-form limit when known ("distance < 5.823094"), else reduce the param |
| `DEF_SELF_INTERSECTION`                                                                                      | all                                                     | result overlaps itself (bend > 360°, flow wrap, global fold)     | entity id, intersecting face pair / triangle pair | reduce angle / extent                                                           |
| `DEF_FLOW_OVERLAP`                                                                                           | `flow_on_surface`                                       | wrap length > the closed target period (2πR)                     | `params`                                          | shorten the body or enlarge the target                                          |
| `DEF_FLOW_OUTSIDE_BASE` / `DEF_FLOW_TARGET_INVALID`                                                          | `flow_on_surface`                                       | body not over the base domain / target not a sheet or face       | `params.base` / `params.target`                   | —                                                                               |
| `DEF_TARGET_FACE_NEEDS_KERNEL`                                                                               | `flow_on_surface`                                       | face target without an exact kernel                              | `params.target`                                   | run with the native kernel or use a sheet target                                |
| `DEF_BASE_CURVE_SHORT` (§17.2) &#124; `DEF_CURVE_NOT_FOUND` / `DEF_CURVE_INVALID` / `DEF_CURVE_PAIR_INVALID` | flow / curve-to-curve                                   | missing, not G1, zero length                                     | `params.targetId`                                 | —                                                                               |
| `DEF_MORPH_INCOMPATIBLE`                                                                                     | `morph_bodies`                                          | structures differ                                                | both ids                                          | 05 IMP for topology-changing morphs                                             |
| `DEF_EXACT_UNAVAILABLE`                                                                                      | M with `mode: "exact"`                                  | no exact kernel / kernel lacks `deform`                          | `params.output.mode`                              | `--kernel occt` (desktop default) or `mode: "auto"`                             |
| `DEF_APPROX_TOLERANCE`                                                                                       | exact path                                              | a face / edge approximation above tolerance                      | face index, achieved error                        | raise `tolerance`, narrow the region, or `allowMeshFallback`                    |
| `DEF_KERNEL_REFUSED`                                                                                         | exact path                                              | sidecar returned null (invalid result)                           | recipe path                                       | `check_model` on the source; try the mesh path                                  |
| `DEF_BUDGET_EXCEEDED`                                                                                        | mesh path                                               | > 4 M triangles after refinement                                 | —                                                 | raise `tolerance`                                                               |
| `DEF_RECIPE_INVALID`                                                                                         | load                                                    | malformed deform node                                            | entity id, path                                   | —                                                                               |
| `DEF_NOT_DEFORMED`                                                                                           | `analyze_deformation`                                   | entity has no deform node                                        | `params.id`                                       | —                                                                               |
| `DEF_CHECK_FOLDOVER` · `DEF_CHECK_SELF_INTERSECTION` · `DEF_CHECK_APPROX_ERROR` · `DEF_CHECK_VOLUME_DRIFT`   | `check_deformation` (fail)                              | as named; drift = measured vs predicted volume                   | entity id, value, limit, unit                     | re-run the command with the remediation of the matching `DEF_*` code            |
| `DEF_CHECK_MESH_RESULT`                                                                                      | (warn; with `purpose: "release"` also `reviewRequired`) | faceted result                                                   | entity id                                         | native kernel + `mode: "exact"`                                                 |
| `DEF_CHECK_REGION_CREASE`                                                                                    | (warn)                                                  | crease at a region end > `creaseRad`                             | entity id, angle                                  | `falloff: "smooth"`                                                             |
| `DEF_CHECK_ANALYTIC_LOST`                                                                                    | (info)                                                  | analytic faces became B-splines                                  | count                                             | `preserveAnalytic: true`                                                        |
| `DEF_CHECK_TOLERANCE_DEFAULTED` · `DEF_CHECK_INPUT_UNVERIFIED`                                               | (warn; unverified not suppressible)                     | named default used / unverified source                           | names / ids                                       | give the tolerance / pin the source                                             |

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

## 13. As built (DES-1: M0 + M1, 2026-10-22)

Owner decisions applied: D1 core catalog, D2 one command per law, D3 `mesh` result with `brep` = deform node, D4 default falloff `smooth`, D6 no silent
exact → mesh fallback, D7 2D entities refused (`DEF_TARGET_UNSUPPORTED`).

**Built.** `model/deform.ts` (`DeformFrame/Region/Law/Output/Params`), recipe member `{ op: 'deform' }` (key text + `DEF_RECIPE_INVALID`-style validation in
`geometry/deform/recipe.ts`), `geometry/deform/{frame,region,laws,bounds,meshWarp,predictedVolume,recipe}.ts`, `commands/deform/*` (seven tools in toolset `3d`:
`scale_nonuniform`, `twist_body`, `taper_body`, `stretch_body`, `bend_body`, `analyze_deformation`, `check_deformation`). Laws: affine, twist, taper, stretch,
bend (the point / lattice / flow laws are M3). Kernel plumbing: `KernelOps.deform` + `deformLaws`, `GeometryKernel.supportsDeform(law)` (also read by
`unsupportedOp`, so an entity whose law a kernel cannot build falls back to its stored triangles). Manifold: `deform` op = the core mesh warp. Native: the host
lowers an affine `deform` node to the sidecar op `gtransform` (`BRepBuilderAPI_GTransform`, `gp_GTrsf`; capability `gtransform`; `solver/.../facade.cxx`,
`recipe.rs`, `session.rs`, `server/src/native/kernelProtocol.ts`); the proxy answers every other law null without a round trip.

**Differences from the plan above.**

- Mesh refinement is _measured_, not only bounded: an edge is split while the deformed curve leaves its chord by more than `tolerance` at 1/4, 1/2, 3/4
  (`chordRule`); the §5.7 bound `√(8 tol / M2)` is still computed (`curvatureBound`, `maxEdgeLength`, matches `mesh_budget.json`: 6.77146 / 1.90693), with an extra
  oblique-edge term (twist |θ'|, taper |s'|, bend 1/R), and used for the `DEF_BUDGET_EXCEEDED` estimate. Edges are cut at region ends where the law has a kink
  (stretch, bend, linear ramp). Manifold's `refineToLength` / `warpBatch` are not used: one TS implementation serves Manifold, the no-kernel path and analysis.
- Predicted volume (§5.10) is a cross-section integral ∫[d(z)A(z) + d'(z)My(z)]dz of the source triangles split at the region ends, not the Keast fan (exact for
  affine / twist / stretch, 1e-6 for taper / bend).
- Frame convention: stored `reference` is always the local x direction. `bend_body` reads the _user's_ `frame.reference` as the direction toward the centre of
  curvature (local y) and stores the matching x.
- `check_deformation`: exact-path default `volumeDriftRel` is 1e-3 (spec 1e-4): the native kernel integrates B-spline faces with its default Gauss rule
  (4.4e-4 relative volume, 0.4 % area on a GTransform-ed sphere r 10 → [1,1,2]; the surface is exact to 1e-15). New findings: `DEF_CHECK_NOT_CLOSED`.
  New refusal codes: `DEF_TOLERANCE_INVALID`, `DEF_SOURCE_UNAVAILABLE`.
- Not in M1 (left for later milestones): `keepSource`, `ids` (multi-body), `infinite` regions, `beyond: fixed` in the commands (the law library supports it),
  `analyze_deformation` `stepIndex` / `compareTo`, `topology` before/after, `allowMeshFallback`, `preserveAnalytic` (refused), curves and sheets (M3), the OCCT warp
  (M2: `mode: "exact"` on a non-affine law refuses with `DEF_EXACT_UNAVAILABLE`; `auto` takes the mesh path and the summary says so), `compareTo`.
- Defaults: origin = bounding-box centre, so explicit `region` numbers are measured from the centre (the bend uses the start-face centre). The VC-DEF-10 `cli.run`
  without a frame therefore needs `frame.origin` for the numbers 20..60 to mean body coordinates.

**Measured (mesh path unless noted; `tests/unit/deform/*`, tolerance 0.005 unless noted).** VC-01 twist volume rel error ≤ 7e-5 (tol 0.001: 6e-5 / 5.5e-5 / 2.6e-5 /
7.4e-5); VC-02 area 4203.96 vs 4204.109, 4207.04 vs 4207.299 (≤ 1e-4); VC-04 crease 0.15580650 / 0; VC-05 taper 5e-13 (linear, flat), 1.3e-5 (smooth); VC-07 bend
volume +3.2e-5, fibres exact; VC-09 refused, min det J −0.25; VC-10 12000 / 10000 exact; VC-12 6000; VC-19 flagged `method: mesh`, chord error ≤ tolerance; VC-25 identical
documents; VC-26 `reviewRequired`; VC-27 codes with paths + remediation; VC-30 parity ≤ 1e-9 for twist, twist*smooth, taper, taper_flat, bend, stretch, scale_nonuniform
(point / flow / ffd rows are M3); VC-36 refused. Source tessellation limits primitives: cylinder → frustum / torus −1.1 % (24-gon, no kernel) / −0.64 % (Manifold),
sphere scale −4.2 % / −2.2 % against the closed form — the \_deformation* error against the tessellated source (`analyze_deformation volume.driftRel`) is < 2e-3.
Native (CLI, `occt-7.9.2`): `target_scale_nonuniform_sphere` exact path, volume 8373.9165 (closed form 8377.5804, −4.4e-4, kernel Gauss), area 2156.18
(closed form 2147.84, +0.39 %); cargo test: surface residual 1.1e-15, mirror valid and 6000. `target_twist_box` native: 36 956 triangles, 0.23 s,
volume 9999.391; the pack's taper / bend torus plans use `mode: "exact"` and refuse until M2. Baselines on this build: twisted loft 9995.931 / 4122.903
(exact), bent sweep 7853.98 / 3341.592 (method exact — the sweep now has an exact path).
Performance (mesh path, default tolerance 1e-5 × diagonal): 90° twist of 10 × 10 × 100: 0.4–0.6 s, 37–39 k triangles; 360°: 2.7 s, 158 k.

**Review follow-up (DES-1).** `bend_body` refuses 360° and more (`DEF_SELF_INTERSECTION`; the pack's `target_bend_cylinder_torus` ring needs `angleDeg` just
under 360 and `mode: "exact"`, so it stays blocked until M2), and from a quarter turn on, when straight parts remain, checks the built result for crossings (up to
60 000 triangles). The bend radius pre-check uses only the triangles that meet the bent region. `beyond: "fixed"` and a stepped falloff for twist / taper were removed
(`DeformRegion.beyond` is `rigid`; falloff `none` is the stretch law only; the validator refuses the rest). `analyze_deformation` measures the approximation error on
the STORED mesh (each vertex pulled back by the closed-form inverse `geometry/deform/inverse.ts`, edge middles mapped forward: `storedError.ts`) instead of re-warping.
A kernel refusal keeps the core warp's own code (`DEF_BUDGET_EXCEEDED`, `DEF_FRAME_DEGENERATE`) so codes do not depend on the host.
`scale_nonuniform` defaults the frame reference to the first world axis not parallel to the axis. `predictedVolume` no longer spreads typed arrays into `Math.min/max`
(a 210 000-vertex test covers it).

## 14. As built (DES-1b: M2 to M5, 2026-10-24)

**Done.** M2 exact OCCT warp, M3 lattice / point / flow along a curve, M4 flow on a surface, M5 curve to curve and morph. Not done: `preserveAnalytic`
(VC-DEF-23: done in §17.11), the UI overlays of M4 (`src/ui` untouched), B-spline lattices and oriented boxes (M5).

**Commands added.** `deform_lattice`, `deform_by_point`, `flow_along_curve`, `flow_on_surface`, `deform_curve_to_curve`, `morph_bodies` (meshes are morphed through their placed, world-coordinate vertices; toolset `3d`). All
deformation commands take `ids` (several bodies, one feature step) and `keepSource`. `bend_body` accepts up to 360 degrees; a bend that closes the whole body is a ring
(exact kernel only). `analyze_deformation` gained `compareTo` (torus, cylinder, cone, spheroid) and topology before/after; `check_deformation` exact drift default is back at
1e-4. Curves and sheets are deformed in core (`runSheet.ts`, `geometry/deform/curveWarp.ts`): an affine law maps the poles exactly, any other law refits by interpolation
(curves: `approximatePoints`; sheets: tensor interpolation, doubled grid up to 65 x 65, cell middles checked by foot-point search with a stride cap); a trimmed sheet under a
non-affine law is refused (`DEF_TARGET_UNSUPPORTED`).

**Native warp.** `cpp/deform_laws.hxx` writes every law once over a first-order jet (value and derivative); `cpp/deform_fit.hxx` refits faces and edges; `cpp/deform.cxx`
(split with `cpp/deform_topology.cxx`: face splitting, ring, sewing) drives `BRepBuilderAPI_ModifyShape` with a `BRepTools_Modification` subclass. Decisions, with evidence:

- Each face is refit as a cubic C2 B-spline interpolating F(S) on a uniform (u, v) grid, refined per direction until the mid-cell error is under tolerance; edges use
  `GeomAPI_Interpolate` with exact end tangents. `GeomConvert_ApproxSurface` was rejected (error estimate unreliable); `GeomAPI_PointsToBSplineSurface::Interpolate` gave garbage
  above 128 nodes. The (u, v) parameterisation is kept; the modification must return the old pcurves and vertex parameters or closed edges collapse.
- Faces are split at region ends and lattice box planes (`BRepAlgoAPI_Splitter`); the 360 degree ring drops the two caps and sews.
- Refusals are coded: BRepCheck failure, non-positive volume or det J at or below 1e-6 on the surface (the determinant comes from the forward-mode jets of the law, exact and one-sided at a kink, not from
  finite differences) report `DEF_FOLDOVER` / `DEF_APPROX_TOLERANCE`. A `ShapeFix_Shape` repair is recorded (`fixed`, `fixedTolerance` in the report) and refused when it raises the largest
  sub-shape tolerance above four times the requested one. The native self-intersection test was dropped (false positives); the TS side checks the tessellation of the result for crossings
  (up to 60 000 triangles) for the bend past a quarter turn with straight parts left AND for every flow along a curve, field (curve to curve) and flow on a surface, whose map can be regular
  (det J > 0) while the body overlaps itself (a path winding past a full turn over the body: `DEF_SELF_INTERSECTION`).
- Mode "auto" falls back to the faceted path when the exact warp is refused for any reason except a fold (`DEF_FOLDOVER`) or a ring: the summary names the code (`The exact warp refused (...)`) and
  `data.exactRefused` carries it; mode "exact" and folds stay refused. A full-turn ring is built only when the kernel reports `ring: true`; a full-turn bend whose body has not exactly two equal planar
  end faces (rounded or split ends) is refused natively with `DEF_SELF_INTERSECTION`. Absolute epsilons of the ring test scale with the tolerance.
- Mass properties: shapes produced by a warp or general transform carry a `refined_mass` flag and are integrated with adaptive `BRepGProp` (eps 1e-9) when its error
  estimate is under 1e-5; the flag follows the shape through placement, scaling, booleans, fillet / chamfer / blend, shell, offset features and unify. Other shapes keep the default Gauss rule (adaptive was 1.8e-5 off on conic blend faces, and a rule chosen by face type would change the NIST corpus). This closes the -4.4e-4 of VC-DEF-11 to -2.1e-7.
- Flow tables (stations P, T, N, B; surface P, N grid with bicubic Catmull-Rom) are stored in the law so TS, mesh and native evaluate the same function. The `rbf` law
  is a triharmonic spline (r^3 kernel: an |r| kernel kinks and broke the exact fit) plus an affine part; collinear centres get a ridge on the tail block, duplicate
  constraints are merged, conflicting ones refused.
- `flow_on_surface`: plane base only; the target is a sheet or a solid face (sampled 65 x 65 through `faceQuery`, since native `faceQuery.bspline` returns null).
- `deform_curve_to_curve` takes `fixedPoints` instead of the spec's `fixedFacesNear`.

**Deviations (tolerance changes).**

- VC-DEF-11 volume: pack 1e-9, measured -2.1e-7 relative on the exact sphere to [1,1,2] (surface exact; limit is BRepGProp quadrature on a rational NURBS), tolerance set to 1e-6.
- The pack's `ffd` golden vector extrapolates outside the lattice box; the spec says outside is unmoved, so the parity test skips outside points.
- `check_deformation` exact `volumeDriftRel` 1e-3 returned to 1e-4 now that the native volume is refined.

**Measured (native, CLI, release sidecar).** Plans: baselines 4/4 and 4/4; `target_twist_box` 6/6 (V 10000.001, drift 8.8e-8, det J 1); `target_taper_cylinder_cone` 6/6
(V 1633.6282, closed form 1633.62818); `target_bend_cylinder_torus` 6/6 (ring V 24674.011, torus deviation 1.0e-6 mm, drift 1.4e-8); `target_scale_nonuniform_sphere` 5/5
(8377.5786); `target_ffd_barrel` 5/5 (V 1.3666666, drift 1.6e-16); `target_point_push` 5/5 (V 500157.08, drift 1.5e-9, 5 s); `target_flow_plate_on_cylinder` 6/6 (V 2479.9987 vs 2480);
`target_bad_plan_codes` 2/6 ok with the four expected refusals (`DEF_BEND_RADIUS_TOO_SMALL`, `DEF_FOLDOVER`, `DEF_SCALE_SINGULAR`, `DEF_ENTITY_NOT_FOUND`).
Twist 90 / 120 / 360 degrees: area error 3e-9 to 1e-8 at tolerance 1e-4 (cargo); quarter and half torus bends 6168.5025 / 12337.0053 against 6168.50275 / 12337.0055.

**Left.** `preserveAnalytic` (VC-DEF-23); UI overlays;
`compareTo` for the remaining shapes (a free-form result has none); fit speed for localised features (a non-uniform fit grid; point push on a 100 mm slab takes 5 to 8 s); native `faceQuery.bspline`;
flow-surface and rbf exactness validated at moderate scale only.

## 15. As built (DES-7d: deforming large meshes, 2026-10-30)

**Problem.** `scale_nonuniform` on a stored 327,680-triangle scan (noisy icosphere, level 7) did not finish in 580 s on the desktop host. Not a quadratic step in the warp:
with the native kernel installed a `mesh` entity without a B-rep went to the exact path, and `loadTarget` and `build` both asked the kernel to evaluate its `solid` leaf,
which sews one OCCT face per stored triangle (1,280 triangles 1.9 s, 5,120 8.3 s, 20,480 41 s) to give back the same triangles. FR-DEF-08 already put these entities on
the mesh path; the code did not.

**Decision.** `DeformTarget.faceted` is `hasMeshLeaf(source)` (`geometry/operandRecipe.ts`): a `solid` leaf of a `mesh` entity anywhere in the recipe (no exact construction, including the `operandRecipe` fallback when
the kernel lacks an op of the tree). A faceted target never reaches the kernel (`loadTarget` reads the entity's triangles; `useKernel` is false), the summary says why
("The source is a mesh without an exact construction"), and `mode: "exact"` refuses with `DEF_EXACT_UNAVAILABLE` naming it. A mesh-path result keeps the scan as the leaf of its `deform`
recipe, so deforming it again stays faceted too; a deformed solid (box, extrusion) keeps the exact path. The same guard keeps `analyze_deformation` / `check_deformation` (`sourceMeshOf`, `exactShape`, the source shape) and a `flow_on_surface` face target (refused `DEF_FLOW_TARGET_INVALID`) off the kernel; `check_deformation` for release names both the faceted result and an unverified input.

**Measured** (desktop host, native kernel, stored 327,680-triangle noisy sphere, `POST /command` wall clock): `scale_nonuniform` 1.1 s, `twist_body` 2.3 s, `taper_body`
2.0 s, `stretch_body` 1.7 s, `bend_body` 2.2 s (before: `scale_nonuniform` did not finish in 580 s). At 81,920 triangles 0.37 to 0.65 s.

**Tests.** `tests/unit/deform/facetedSource.test.ts`: with an exact stub kernel whose `evaluate` is recorded, `scale_nonuniform` and `twist_body` on an imported mesh take
the mesh path and never evaluate a mesh leaf; `mode: "exact"` refuses by name; a box and a deformed mesh still take the exact path. Both cases fail without the fix.

**Review round 1 (2026-10-30).** The first fix looked at the top node only: a deformed scan deformed again, and `analyze_deformation` / `check_deformation` on it
(the step every deform summary asks for), still evaluated the scan through the kernel. `hasMeshLeaf` walks the recipe (boolean, blend, every node with a source).
Tests: the spy predicate is `hasMeshLeaf`; a scan deformed twice then analysed and checked; a scan as a flow face target; `hasMeshLeaf` on nested recipes (the two
command cases fail with the top-level predicate). The other kernel consumers of a recipe over a scan are DES-7e (§16).

## 16. As built (DES-7e: no command sews a large scan in the exact kernel, 2026-10-30)

**Problem.** §15 kept the deform commands off the kernel for recipes over a scan; about 30 other commands still build an operand recipe and evaluate it
(`boolean`, `blend`, fillets, holes, pockets, topology and face queries, PMI, STEP planning). A `solid` leaf of a `mesh` entity becomes one OCCT face per
triangle, sewn: measured on the native kernel (box minus a scan, `boolean` engine `kernel`): 320 triangles 0.18 s, 1,280 0.61 s, 5,120 3.1 s; a deform of
20,480 took 41 s. `mass_properties` on a raw scan is not affected (mesh integration, 0.21 s at 327,680).

**Decision.**

- One guard for every command (`commands/kernelMeshGuard.ts`): `execute` hands commands a view of the exact kernel (name `occt` or an OCCT version in its info;
  Manifold takes triangles natively and is left alone) whose `evaluate` refuses (null, the answer every caller already handles) a recipe with more than
  `KERNEL_MESH_LEAF_CAP` = 20,000 imported-mesh triangles (`meshLeafTriangles`: stored assets at full size, inline meshes by their triangles). The outermost
  execute appends a note with the size, the cap and the remedies. The view is cached per kernel (stable identity for kernel-keyed caches); nested executes reuse it.
- `boolean` `engine: "auto"`: a mesh-path deform result counts as triangle-only (`isTriangleOnly` uses `hasMeshLeaf`), and an operand built on more than the cap
  sends the boolean to the mesh engine, with the reason in the summary; below the cap mixed operands keep the exact kernel. Decided from the document alone
  (`asset.triangles`), so replay is host-independent. `engine: "kernel"` above the cap is refused by the guard.
- Rejected: a cap per command (30 call sites, each would drift); refusing every mesh leaf (small scans in exact booleans and `mesh_to_brep`-style work are fine
  and used); a cap in the native host only (the stub and future kernels would hang alike, and core tests could not see it).

**Tests.** `tests/unit/brep/kernelMeshGuard.test.ts` (stub exact kernel with every evaluated recipe's scan size recorded): `meshLeafTriangles` on nested recipes;
`boolean` engine `kernel` over a 20,480-triangle scan unchanged with the note and never reaching the kernel; engine `auto` runs the mesh engine above the cap and
the kernel below it; two mesh-path deform results union on the mesh engine; Manifold unguarded; `inspect_topology` on a large scan refused by name. The four
routing cases fail with the wiring removed (`execute`, `boolean`, `isTriangleOnly`).

**Review round 1 (2026-10-30).** Every kernel member that takes a recipe goes through the cap (`blendReport` and `deformReport` beside `evaluate`: a refused
`blend_union` otherwise asked `blendReport` to explain itself and sewed the scan anyway); the FEA part geometry, built outside `execute`
(`server/src/fea/transports.ts`), uses the same `guardedKernel`, so a scan part falls to its stored triangles (`server/tests/feaScanGuard.test.ts`); `boolean`
`auto` compares the operands' total with the cap, as the guard does. The cap counts a scan's real size (`asset.triangles`), also when the kernel would only
receive its display level of detail: deliberate, so the answer does not depend on which reads a command declares. Tests added: `blend_union` over a scan
(fails without the `blendReport` guard), five scans under the cap one by one and above it together, the note once on a nested `build_project` and a clean
next execute.

## 17. As built (DES-1c, 2026-10-30)

**`output.allowMeshFallback`** (every deform command). Decision D6 asked for a refusal by default; the as-built rule of §14 (mode `auto` answers an exact
refusal with the faceted path and names the code in the summary and `data.exactRefused`) already reads "no silent fallback" as "never unannounced", and
agents rely on it. The default stays `true` (that rule); `false` refuses with the exact code and its param path, so an exact body never becomes a mesh.
Folds and rings refuse either way. Test: `tests/unit/deform/exactWarp.test.ts` (the `DEF_APPROX_TOLERANCE` refusal with the option false).

### 17.1 `region.infinite` (FR-DEF-06, Rhino "Infinite")

`region.infinite: true` (twist_body, taper_body, stretch_body, bend_body; the key is absent otherwise, so every existing recipe key and result is unchanged)
makes `start` and `end` fix the **rate** only: t = (z − start) / (end − start) is not clamped and the law holds at every height of the axis, also beyond
both ends. There is no end to be rigid past and no kink to split at (no face split, no crease finding). The native spec carries it in header slot 15
(`cpp/deform.cxx`, formerly reserved); `Region.infinite` in `cpp/deform_laws.hxx` is read by `ramp`, `bend_map` and the stretch case.

| Law     | Infinite map                                                                              | det J                  |
| ------- | ----------------------------------------------------------------------------------------- | ---------------------- |
| twist   | θ = Θ · t                                                                                 | 1                      |
| taper   | s = 1 + (S − 1) · t, linear and not clamped                                               | s² (s when flat)       |
| stretch | z' = start + factor · (z − start) for every z (uniform scale about `start`; `end` unused) | factor everywhere      |
| bend    | θ = (z − start) / R for every z; nothing straight remains                                 | (R − y) / R everywhere |

Decisions.

- **Falloff.** The ramp is linear. `falloff: "smooth"` with `infinite` is refused with `DEF_REGION_INVALID` (a cubic blend has ends; the code's remediation
  names it); omitted or `"linear"` is stored as `linear` (`none` for the stretch step). A recipe node with `infinite` on another law, `infinite: false`, or
  a smooth ramp fails `validateShapeRecipe`. `beyond` has no user parameter (always `rigid`); it is ignored for an infinite region.
- **Region checks.** `end > start` is still required; `DEF_REGION_MISSES_BODY` does not apply (the whole axis meets the body).
- **Fold (taper).** s is linear in z, so det J = s² hides the sign: s ≤ 0 anywhere on the BODY is a fold, whether s changes sign inside it or the whole body
  lies past the zero (mirrored and scaled, s² > 0). `jacobianRange` takes the body extent (not the region) and reports min det J = 0 at the zero of s clamped
  to the body, and the command refuses with `DEF_FOLDOVER` (flat taper: det J = s < 0 is caught at the ends). The native warp samples det J on the surface
  only, which sees neither, so `taper_scale_vanishes` (`cpp/deform_topology.cxx`) refuses it with `DEF_FOLDOVER` when s ≤ 0 at either end of the body span.
  The span is measured in the frame's own coordinates (the shape moved into the frame, then its tight box), not from the world-aligned box, whose corners
  overstate the extent on an oblique axis and would refuse a body the mesh path accepts: both paths refuse the same bodies.
- **Bend.** `region` gives the rate (`length` or `start`/`end`, or `angleDeg` with `radius`) and where the arc begins (`start`); `symmetric` is kept: the
  same arc moved rigidly so that the middle (start + end) / 2 stays in place. A body whose axial length / R is 2π or more is refused with
  `DEF_SELF_INTERSECTION` (no ring: the closed-ring path of §14 needs a finite region and is skipped; no straight-part overlap test, nothing is straight).
  The closed-form inverse (`unmapLocal`) unwraps the `atan2` angle to the turn whose source height is nearest the middle of the source z window
  (`storedChordError` passes the source extent), so a 270 degree infinite bend is measured without a false approximation error.
- **Old sidecars.** The native `info` lists the capability `deform-infinite`; `nativeSupportsDeform` (`server/src/isolatedKernel.ts`) requires it when
  `region.infinite` (`GeometryKernel.supportsDeform(law, region)`), so a sidecar built before slot 15 existed, which would silently build the clamped warp, is
  treated as unable to build the node: `auto` answers with the mesh path, `exact` refuses with `DEF_EXACT_UNAVAILABLE`.
- **Stretch stays a warp.** An infinite stretch is the affine map diag(1, 1, f) with a translation, so it could be lowered to the `gtransform` op. Decision:
  keep the warp. The result is exact already (volume 15000 to 1e-9, no face split, six faces), the recipe and the analysis keep one law (`stretch`) and one
  native path with the other three laws, and a lowering would add a second construction whose equivalence needs its own proof for no accuracy gain.
- **Analysis.** `regionCreases` is empty and `splitHeights` is empty; `bendFibres` use the body length (neutral fibre = length along the axis); the predicted
  volume integrates det J over the body without region breaks (exact for twist and stretch, converging for taper and bend as before); the mesh estimate
  counts every triangle (no region filter).

Tests: `tests/unit/deform/infinite.test.ts` (closed forms per law, both mesh kernels; refusals; purity; default recipes carry no key; check/analyze),
`server/tests/nativeKernelDeform.test.ts` (exact path against the mesh path and the closed forms, fold refused on both), `solver` `deform_tests.rs`
(`deform_infinite_tests.rs`: `an_infinite_*`: twist area equal to the whole-body linear twist, stretch volume 15000, frustum volume, 180 degree torus segment,
symmetric bend, taper past its zero, oblique axis; and the shared pack). The pack `validation/data/point_vectors.json` (generated by `generate_analytic_refs.mjs`
from the independent reference `deformLaws.mjs`) now holds infinite vectors for all four laws, flat taper and symmetric bend, with points below the start and
beyond the end; `laws.test.ts` and `deform_infinite_tests.rs` check every one to 1e-9 (the Rust header takes slot 15 from the pack parameters).

### 17.2 `flow_along_curve` `baseCurve` (FR-DEF-14)

`baseCurve` (the id of a `nurbs_curve`) replaces the default base, the frame axis. The law (`flowCurve`) carries a second frame table `base`
(`{step, stations}`, the same 12 numbers per station P, T, N, B, in local frame coordinates, uniform arc length `step`, rotation-minimising from the frame x
direction). A body point q is taken in the base frame at the arc length s where `(q − P_b(s))·T_b(s) = 0` (Newton from the nearest station; the base is
extended straight beyond its ends), with offsets x = (q − P_b)·N_b and y = (q − P_b)·B_b, and goes to `P_t(ratio (s − z0)) + x N_t + y B_t`. `z0` is the arc
length where the body starts on the base, so the target is entered at its start. The first normal of the target is the base normal at `z0`: a bent bar
flowed from its own centreline onto a line is straightened with its cross-section orientation kept. TS (`flow.ts`, `projectOnBase`) and native
(`cpp/deform_laws.hxx`, `project_on_base`, the implicit derivative of s in the Jet) run the same iteration; the pack vectors `flow_base_line`, `flow_base_arc`,
`flow_base_line_stretch` (closed form for a base arc onto a line or an arc, stretch ratio 2) agree to 1e-8 on both (the tables are Hermite samples).

- **Det J.** In base coordinates the map multiplies the volume element by ratio (1 − κt·o) / (1 − κb·o). The Jacobian pre-check and the analysis sample det J
  at the body's own vertices (`DeformPlan.samples`; the extent box is not the body for a curved base). The predicted volume is the section integral
  ∫ ratio (A(s) − kt1 Mx(s) − kt2 My(s)) ds over planes normal to the base (`predictedBaseFlow.ts`, area and moments by Green's theorem), independent of the surface.
- **Samples (review round 1).** The vertices alone miss a fold of the target between them, so the pre-check, `analyze_deformation` and `check_deformation` also sample a
  grid in the base frame (`baseFlowGrid.ts`): the corners of the body's offset range (x, y) at four arc lengths per interval of the target table, and every interval
  whose turn times the widest offset reaches 0.25 (the sharpest 1000), since a table with a sharp corner has more stations than the uniform cap can sample.
- **Base fold guard.** The base side of det J is 1 − k1 x − k2 y at each vertex's own signed offsets (`frameCurvatures`); `DEF_FOLDOVER` when it reaches the
  Jacobian floor. A plate on the outer side of an arc, or wider than the radius across the plane of the arc, is valid. Reached only for a vertex at the centre of
  curvature inside the base's sector (a unit test on `resolveBase`); a body past the centre leaves the sector and is `DEF_BASE_CURVE_SHORT` (pinned separately).
- **Predicted volume past a half turn.** A base turning more than 180 degrees makes the normal plane at s also cut the far part of the body; only triangles whose
  projected arc lengths bracket s belong to the section (a 270 degree test).
- **Projection cost.** `projectOnBase` seeds Newton from the nearest of a coarse grid of every sqrt(count)-th station, refined within one stride (2 sqrt(count)
  distances instead of count; mirrored in C++). On a 4096-station table and 327000 vertices the seed alone fell from 2.2 s (full scan) to about 0.1 s and the whole
  projection costs 3.0 s (Newton now dominates); before it was about 5.1 s.
- **Jacobian parity.** The cargo pack test now compares det J (forward-mode, `warp_determinants`, one Jet evaluation per axis) with the pack's det at 1e-6, so a
  mis-scaled implicit derivative of the projection no longer passes on the images alone. `parse_spec` moved to `cpp/deform_spec.cxx` (`deform.cxx` was at its size limit).
- **Default.** A base that is a straight line on the frame axis running toward +z is the default: it is dropped, so the node, the mesh and the summary are
  byte-identical to the call without `baseCurve` (the documents differ only in the recorded step params).
- **Refusals.** Not a `nurbs_curve` or missing: `DEF_CURVE_NOT_FOUND` (`params.baseCurve`); zero length / tangent: `DEF_CURVE_INVALID`; the body starts before or
  ends after the base along it: new `DEF_BASE_CURVE_SHORT`; the body reaching as far as the base's radius of curvature: `DEF_FOLDOVER` (a body past the centre
  of curvature leaves the base's sector and is refused as short); a target whose frame table would be degenerate or an up vector parallel to its tangent keep their
  codes. Only `nurbs_curve` bases (other curve kinds: convert first).
- **Old sidecars.** The sidecar `info` lists `deform-base-curve`; `nativeSupportsDeform` requires it when the law has a base (the extra table after the target's
  is ignored by an older warp), as for `deform-infinite`.
- **Frame fix found on the way (also in `flow_on_surface` and the default up vector).** The law maps local frame coordinates, but the target curve was passed in world coordinates, so with a frame other than the
  world one (a body away from the origin: the default frame origin is its start face centre) the result was moved by the frame origin. The curves are now
  converted to local coordinates (`curveToLocal`; the up vector is a world direction, default +z, always passed as its local components: without it, fixed_up fell
  back to +z read in local coordinates and was refused on a body whose axis is not world z). `flow_on_surface` had the same bug: the sheet, `targetOrigin`, the
  `uDirection` and the face normal are now read in the base frame before the table is tabulated (a base plane with an origin or a tilted normal landed shifted or turned); for a world-identity frame the numbers are unchanged (bit-identical).

Tests: `tests/unit/deform/flowBase.test.ts` (frame fix, straight base == default byte-identical, arc base onto a line: extent, volume, det J range, predicted
volume, refusals, recipe validation, the pack vectors), `server/tests/nativeKernelFlowBase.test.ts` (exact vs mesh path vs closed form on the native kernel,
the capability), cargo `deform_infinite_tests.rs` (`a_bent_rod_flowed_from_its_own_arc_onto_a_line_is_straight_again`, the pack).

### 17.3 `analyze_deformation` `compareTo`: more reference shapes

The reference list of the validation pack (README VC table) holds the shapes the laws produce: torus (VC-08), cylinder (VC-03, VC-17), cone (VC-06), spheroid
(VC-11) were already there. Added (`geometry/deform/referenceShape.ts`; every distance is unsigned, document units, over every vertex of the result):

| kind               | fields                                          | distance                                                                                                                 | produced by                                                                                                                                                |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sphere`           | `center`, `radius`                              | exact, \| \|p − c\| − r \|                                                                                               | `scale_nonuniform` with equal factors of a sphere                                                                                                          |
| `plane`            | `point`, `normal`                               | exact, \|(p − point)·n\|                                                                                                 | flat taper / stretch / morph of a plate (VC-34 plane z = 3), a pyramid face                                                                                |
| `ellipticCylinder` | `point`, `axis`, `reference`, `radii` [a, b]    | first order, \|f\| / \|∇f\|, f = (x/a)² + (y/b)² − 1 in the plane across the axis (on the axis, where ∇f = 0: min(a, b)) | `scale_nonuniform` of a cylinder (VC-11: r 5 × [2, 1, 1])                                                                                                  |
| `helicoid`         | `point`, `axis`, `reference`, `rate`, `offset`? | first order, \|g\| / \|∇g\|, g = x cos(k z) + y sin(k z) − offset (x along `reference`, z from `point`)                  | `twist_body` (constant rate: `region.infinite`, or inside a linear region): the image of the plane x = offset is this surface; offset 0 is a true helicoid |

Decisions. The first-order distance is the same estimate the spheroid already uses (exact on the surface, within a few percent of the true distance for a
deviation small against the radii of curvature); the exact distances (sphere, plane) are exact. A twisted box face is the helicoid with the face offset, so a
twisted prism is checked face by face with `offset`; `rate` is the twist rate per unit length (a `twist_body` of Θ over L is Θ / L in radians). `maxDeviation`
counts every vertex, so a body is only comparable when all its vertices lie on the shape (a thin plate for a plane or a helicoid, which deviates by its half thickness; the Manifold cylinder has no cap
centre vertex, the document's own cylinder mesh has). At zero gradient (the centre of an ellipse or spheroid) the distance is the shortest semi-axis, a length, not the unitless residual. A pyramid and a frustum of planes are `plane` per face; the frustum of a round taper is the existing `cone`.

Tests: `tests/unit/deform/referenceShapes.test.ts`: closed forms on and off the surface per kind (including a helicoid point at a height, the elliptic cylinder in a
tilted reference), and per law result: sphere scaled by 2 vs radius 20 (and 19.5: 0.5), plate stretched vs plane (and a plane shifted 0.3: 0.3), cylinder × [2, 1, 1]
vs 10 × 5 (and 10.3: 0.3), plate twisted at 36 degrees per 20 vs the helicoid (offset 0.2: 0.2; rate × 1.1: far), `DEF_COMPARE_INVALID` by field name.

### 17.4 `deform_lattice`: B-spline lattices and oriented boxes (FR-DEF-13)

Two optional extensions of the lattice law (`lattice.ts`; both absent: the Bernstein, frame-aligned lattice of §5.3, bit-identical results).

- **`splineDegrees` [p, q, r]** (each min(2, degree)..the axis degree): the basis along each axis is a uniform clamped B-spline of that degree on the same (l+1)(m+1)(n+1) control net
  (knots: p+1 zeros, l−p interior knots at i/(l+1−p), p+1 ones). A control point acts only on the p+1 knot spans around it (local control); points rest on the
  Greville abscissae g*i = (t*{i+1}+…+t\_{i+p})/p, so zero offsets are the identity and an affine displacement of every point is that affine map (linear precision).
  p equal to the lattice degree is the Bernstein lattice. `index` and `near` use the Greville positions. Degree 1 on an axis whose lattice degree is larger is refused (`DEF_LATTICE_DEGREE`): the interior knots
  would be kinks the exact warp would have to split at; p ≥ 2 is C¹.
- **`orientation` {uAxis, vAxis}** → `axes` (orthonormal rows, frame coordinates): the box is measured in c = A q about the frame origin (`box.min/max` in those
  coordinates, default `"bounds"` = the body bounds along them); points outside it do not move; the offsets stay displacements in frame coordinates. The Jacobian is
  I + (∂D/∂c) A. Degenerate axes: `DEF_FRAME_DEGENERATE` (`params.orientation`).
- **Bounds.** The det J enclosure is the Bernstein-coefficient bound over each knot span (degree 3p−1 per axis), extremes over the spans; the sampled values are those of the
  span nodes. An oriented Bernstein lattice uses the whole-box bound with the points mapped back from the box.
- **Native.** The spec gets a 13-number trailer after the offsets (spline degrees, oriented flag, the nine axes entries; absent = Bernstein, aligned). The warp splits faces
  at the oriented box faces (`Cut` with a direction) as at the aligned ones; interior knot planes are not split (C¹). The sidecar `info` lists `deform-lattice-spline`;
  `nativeSupportsDeform` requires it when the law has a trailer. Predicted volume: the divergence-theorem chord integral cuts the chord at the oriented box and, for a B-spline
  lattice, integrates the Gauss pieces between knot planes.
- **Pack.** `ffd_spline`, `ffd_oriented`, `ffd_spline_oriented` in `point_vectors.json`, from an independent reference (`ffdGeneral`: textbook Cox-de Boor recursion on explicit
  knots, Greville rest positions, the box mapped by the axes), checked by TS and cargo (images 1e-9, det J 1e-6 away from the box faces).

Tests: `tests/unit/deform/latticeSpline.test.ts` (pack, Greville positions, linear precision, local control support, enclosure, command: local control of the body, oriented
affine map = 1.2 x the volume, default oriented box, refusals), `server/tests/nativeKernelLattice.test.ts` (exact vs mesh vs closed form on the native kernel, the capability,
fold on both paths), cargo pack vectors.

### 17.5 `flow_on_surface` from a curved base sheet (FR-DEF-15)

`base: {sheetId, origin?, uDirection?, flipNormal?}` replaces `base.plane` (exactly one; both or neither: `DEF_FLOW_BASE_INVALID`). The body is laid out on a curved `nurbs_surface`:
a point q is taken in the base sheet frame, q = P_b(x, y) + w N_b(x, y), with x and y arc lengths on the base sheet (from `origin`, along `uDirection` and across it, built exactly
like the target's) and w the offset along its normal, and goes to P(x, y) + w N(x, y) of the target. The plane base is the special case (x, y, w) = q.

- **Law.** `flowSurface.baseNodes`: P_b and N_b of the base on the SAME (x, y) grid as the target table (one grid refinement checks both). Absent for a plane (every existing
  node, key and result is unchanged; the plane path is the previous code). `solveBase` (`flowSurface.ts`) inverts the base: Newton on F = P_b + w N_b − q with central-difference
  columns, seeded from the nearest of a coarse grid of base nodes (√count stride, then one stride around it); the C++ twin `flow_surface_base` runs the same iteration and takes
  the implicit derivative d(x, y, w) = J⁻¹ dq along the Jet direction, so det J of the exact warp is forward-mode, not differenced.
- **Frame.** The body and both sheets stay in world coordinates (the frame is the world one): there is no base plane to define one.
- **Sizing.** The (x, y, w) ranges come from the body's vertices (a stride beyond 800) projected on the base sheet (closest point, then the arc lengths: `Target.coordinatesOf`). A
  closed x direction takes the complement of the largest gap between the x values modulo the period (`wrappedRange`), so a wrap past a half turn is not folded onto the
  wrong side. A vertex whose normal line misses the sheet by more than the tolerance (it lies past an edge) is `DEF_FLOW_BASE_OUTSIDE`; a body longer than a closed base or target turn is
  `DEF_FLOW_OVERLAP`.
- **Fold check.** The Jacobian pre-check samples the body's vertices and a base-coordinate grid (`baseSurfaceGrid`: two samples per table interval along x up to 801, five levels
  across, at both extreme offsets), the same points in `analyze_deformation`, not the extent box (a curved base's box is not the body).
- **Predicted volume.** The existing tetrahedral quadrature of the flow onto a surface applies: its fan from the vertex centroid stays inside the tube of the base for the cases
  tried, including a 300 degree wrap (test); a dedicated base-coordinate integral was written, found not to change any result, and removed.
- **Old sidecars.** The sidecar `info` lists `deform-base-sheet`; `nativeSupportsDeform` requires it for a law with `baseNodes`; the spec carries the base table after the target's
  (`6 nx ny` numbers, optional).
- **Pack.** `flow_surface_base_plane`, `flow_surface_base_cylinder` (base cylinder R 50 onto a plane and onto a cylinder R 30), closed form from `flowSurfaceBase`; tables of
  step 0.2 are built by the TS test and the cargo test from formulas; images agree to 2e-5 (Catmull-Rom on a circle) and det J to 2e-4 in TS and, forward-mode, in C++.

Tests: `tests/unit/deform/flowSheetBase.test.ts` (pack, grid, recipe validation, a plate bent on R 50 unrolled onto a flat sheet: extents, volume, det J range 50/51..50/49, predicted
volume; a 300 degree wrap; a flat base sheet equals `base.plane`; refusals by name; a target fold), `server/tests/nativeKernelFlowSheet.test.ts` (exact vs mesh vs closed form on the
native kernel, the capability), cargo pack vectors.

### 17.6 Review round on §17.4 and §17.5

- **Oriented box nodes.** The det J bounds, the dense grid and the polish now evaluate the Jacobian at the normalised box coordinates directly (`determinantAtNormalised`):
  a face node mapped to frame coordinates and back landed about 1e-16 outside an oriented box and read as outside (identity, det J = 1; 195 of 7938 face nodes wrong, the Bernstein
  enclosure off by up to 11). An oriented box also gives a 1e-12 relative slack to a face in `normalised`. Test: an oriented lattice and its aligned twin (offsets turned by the axes)
  have equal `determinantBounds` and equal det J at every node of a 9 x 9 x 9 grid of the box, faces included.
- **B-spline sampled extremes.** A dense grid inside every knot span (7 per axis) and a pattern-search polish from the best points replace the interpolation nodes alone (test: the
  sampled extremes are within 1e-9 of a 31³ grid of the lattice).
- **Spline degree 1.** `splineDegrees` accepts min(2, degree)..degree per axis: 1 where the axis degree is 1 (that is the Bernstein degree), 2 or more elsewhere (TS command, recipe,
  `parse_spec`).
- **Centre of curvature of a base sheet.** det J of the base map tends to infinity there, never to the floor, so a closed base around its axis tore a body silently. `planSheetBase`
  now finds the base sheet's focal points (P + N / kappa for both principal curvatures on a 41 x 41 grid, from the second fundamental form) and refuses `DEF_FOLDOVER` when one lies
  inside the body (ray parity against the source mesh, `containsPoints.ts`). Test: a box straddling the axis of a closed base cylinder (without the check the table build does not
  terminate in practical time).
- **Unconverged base solve.** `solveBaseChecked` reports the residual of the last Newton iterate. After the table is built the plan checks that the solve at the sampled vertices has
  a tiny residual and agrees with the closest-point coordinates (x modulo the period), else `DEF_FLOW_BASE_OUTSIDE`. The warp sets a flag when a base solve ends with a large residual
  and refuses with the same code instead of returning the last iterate (cargo test: a body running past the table is never built; the test also passes without the flag because the
  B-spline fit of the clamped table already throws, so the flag itself is not proven by it).

### 17.7 The warp never hangs: progress and work bounds of the mesh refinement

With the focal-point refusal of §17.6 bypassed, a body around the axis of a closed base sheet ran for hours: the triangle count grows ×3 per pass (12 → 1.7 M after 13 passes, the passes costing
0.002 s, 1 s, 5 s, 11 s, 25 s, 41 s, 45 s) because a map that is discontinuous (or folded) across the body keeps a chord deviation the size of its jump however small the edges get, so
the chord rule never stops splitting until the 4 M triangle cap. The cap was the only bound; each pass costs triangles × map evaluations, so it was no bound in time. Now (`meshWarp.ts`):

- **Progress.** The chord rule reports, per pass, the worst deviation of the edges it splits and the worst deviation / edge length. A smooth map has a ratio that falls as the edges shrink, a kink one
  that stays bounded; a jump or fold has a ratio that doubles with every pass. From the sixth pass, when the worst deviation is above ten tolerances, the ratio above 100 (an image edge a hundred times
  longer than the edge: det J of 1e6 is not a body deformation) and more than four times its value three passes earlier, the refinement is refused with `DEF_APPROX_TOLERANCE` ("the map is
  discontinuous or folded in the body"). A first criterion on the worst deviation alone refused `deform_by_point` (a localised bump is discovered late: its deviation does not fall while new regions
  are found); the ratio, with its absolute level, does not. The same input now ends after about 8 passes, in seconds.
- **Work.** Independently of the triangle count, the chord evaluations are counted (a map that solves for its argument, the base-frame laws, counts 20 each) and the mesh path refuses with
  `DEF_BUDGET_EXCEEDED` beyond a work bound (4e8 at first, predicted per pass and 4e7 since §17.10; an honest infinite bend of a 157 mm cylinder at 1e-4 needs 2.9M triangles and 35 s: the first value, 4e7, refused it, caught by `nativeKernelDeform`). With the progress check disabled the same input stops by this bound after a few minutes instead of never.
- **Native.** The exact warp's loops were already bounded by construction (a Newton solve of at most 40 steps, the fit by 512 segments per direction and 400 000 points, then
  `DEF_APPROX_TOLERANCE`); the exact path of the same input ends with a refusal within the test bound.

Tests: `tests/unit/deform/flowSheetBase.test.ts` (the focal check switched off by the test-only `focalCheck.enabled`; both kernels; refusal `DEF_APPROX_TOLERANCE` in seconds; red-proof: without the
progress check it ends by the work bound with `DEF_BUDGET_EXCEEDED`, no longer within seconds), `server/tests/nativeKernelFlowSheet.test.ts` (the exact path).

### 17.8 Non-uniform fit grid (the point push on a 100 mm slab)

The exact warp fitted every face by a cubic C2 interpolant on a uniform grid whose segment count doubled until the deviation at the cell middles and quarter points was within the tolerance share.
A push of radius 10 on a 100 x 100 x 20 slab therefore put a grid fine enough for the 10 mm support on the whole 100 mm face (263 294 nodes at tolerance 1e-3).

- **Per-interval refinement** (`deform_fit.hxx`, `Axis`). Each direction keeps its own node list (parameters index / den). After a fit the deviation of every u interval, v interval and cell is measured; an interval above the
  tolerance share is halved, the others keep their nodes. When only cell middles deviate, everything is halved in both directions. A direction where a quarter of the intervals or more deviate
  is refined everywhere, exactly as the uniform doubling did (the node parameters are then bit-identical, so twists, bends and the VC-DEF numbers do not move); only a localised law (a point push, a
  lattice cell, a narrow region) refines just where it acts. The limits are unchanged (512 segments per direction, 400 000 nodes, then `DEF_APPROX_TOLERANCE`).
- **What changes.** The tolerance guarantee is the same (the deviation at every interval's quarter points is within the allowed share, checked on the final grid; `maxError` of the report is that
  measurement). Where the push covers the whole face the result is the uniform grid. The achieved deviation sits closer to the tolerance than before (maxError 1.1e-5 -> 5.2e-5 for the 1e-3 push), still far
  below it; the volume agrees with the uniform fit to 6e-9 relative (200235.6183 vs 200235.6195, closed form 200235.6194). The report gains `fitPoints` (nodes of all the face fits).
- **Measured** (release, 100 x 100 x 20 slab, push r 10, d 3, smooth_c2): fit nodes 263 294 -> 22 926; the warp 914 ms -> 260 ms. Through the server (command + mass + analysis): 21.7 s -> 10.0 s at tolerance
  1e-3, 24.8 s -> 20.5 s at 1e-4, 14.4 s -> 9.4 s for r 25 d 4. What is left is the mass integration of the many-knot B-spline faces (§17.9), tessellation and the analysis.
- **Fix found on the way.** The `base_unconverged` flag of the base-sheet solve (§17.6) was a shared static: parallel warps (cargo tests) set it for each other. It is now thread-local.

Tests: `deform_tests.rs` `a_local_push_on_a_wide_slab_refines_the_fit_only_where_it_acts` (fit nodes < 40 000, volume = box + cap, maxError within the tolerance; red-proof: forcing uniform refinement gives
263 294 nodes and fails it). The 26 `deform` cargo tests and `nativeKernel*` suites keep their numbers.

### 17.9 Mass rule by face type: decided, measured, and what is carried through `blend_union`

`refined_mass` (adaptive `BRepGProp` on the shapes a warp or a kinked blend built, 1e-9, accepted at 1e-5) was kept by transforms, booleans, unify, shell and fillets but not by `blend_union`, whose
result went back to the fixed Gauss rule. A solid built by `blend_union` from a warped operand now asks for the rule too (`ShapeList.refined_mass`, set by `shape_list_add`).

A rule by face type was tried and measured: the fixed rule for planar faces (exact there) and the adaptive one for all curved faces, integrated face by face from one apex. It gives the same numbers as the whole-shape
adaptive rule to rounding (a plane is exact in both rules), so it changes nothing but the bookkeeping; and a rule that keeps the fixed rule on the elementary curved faces is wrong where it matters: the cone pieces
of a straight-law blend lose 2.5e-3 of the removed volume (20 x 10 x 5 block, `a_linear_law_through_a_control_point...`) and the 120-gon mitre 2e-4. Whole-shape adaptive stays the rule of the flagged shapes. The NIST corpus
is not flagged (nothing in it is a warp), so its numbers are untouched by construction (the `nativeKernel*` corpus suites are unchanged).

Loosening the integration accuracy to buy time was measured too: Eps 1e-7 instead of 1e-9 saves 25-30 % of the 10 s push (8.0 s, 14.9 s, 6.6 s) but moves the mitre-blend volumes by 2e-6 relative and fails
`a_ground_sphere_scaled...` (VC-DEF-11); kept at 1e-9. The remaining cost is the adaptive subdivision itself on faces with hundreds of knot spans.

Tests: `blend_tests.rs` `the_blend_union_keeps_the_adaptive_mass_rule_of_its_operands` (red-proof: without the propagation the fused blend is unflagged), `deform_infinite_tests.rs`
`a_cut_warped_bar_mixes_the_fixed_rule_on_its_caps_with_the_adaptive_one_on_its_sides` (closed-form volume and centroid of a warped bar cut by a box).

### 17.10 Review round on §17.7-§17.9: the time bound of the mesh refinement, the fit grid

- **The mesh path ends in seconds, not only ends.** The bound is now PREDICTED before every pass (`warpMesh`): the triangles of the pass times (the bookkeeping of the pass, 4 units per triangle, plus the weighted map
  evaluations of the pass, 5 per triangle, plus those of the final chord measure and move, 2 x 2.5 per triangle) is added to the units already spent, and the pass is refused when the sum exceeds 4e7 units
  (`DEF_BUDGET_EXCEEDED`, with the remedy: output mode 'exact' or a coarser tolerance). Every map evaluation is counted (chord samples, vertex images, the final measure and the move); the cost weight of a base-frame
  law is 10 + 0.2 x sqrt(table size) (the coarse search of the table). 4e7 units are about 10 s on the dev machine (3e6 units/s measured); the first value, 4e8, was minutes.
- **The honest 157 mm infinite bend** (cylinder r 5, bend r 50, region infinite, tolerance 1e-4, mesh mode) needed 2.9M triangles and 35 s: it is now refused up front with the remedy; mode 'exact' builds it
  (natively) and the mesh path at tolerance 1e-3 builds it (`nativeKernelDeform` asserts the three). The other server tests that compared the mesh path at 1e-4 with the exact path use 1e-3 for the mesh.
- **Hostile seeds** (`meshWarp.test.ts`): a twist of 3 pi over 100 mm at tolerance 1e-4 is refused with the remedy by the work bound before a pass crosses it (red-proof: with the bound at 1e12 it warps 1.25M
  triangles instead); a bend with a radius inside the body (a fold) is refused (`DEF_APPROX_TOLERANCE` or `DEF_BUDGET_EXCEEDED`) in seconds. A jump map evading the progress check cannot be built from the
  catalogue laws (the region ends are cut by the plane rule, so a step never lies inside an edge); the work bound is what covers that class.
- **One warp, not two.** A refusal is remembered per node and mesh (`WeakMap`, fingerprint of the coordinates): the host that warps through the Manifold kernel, gets null and re-warps to read the reason, no longer
  warps twice.
- **`focalCheck` is gone** (a mutable module global in core that disabled a refusal). The two tests that flipped it went with it; the exact path's bound is by construction (§17.7), the mesh path's by the above.
- **Fit grid.** Intervals are graded 2:1 (an interval more than twice as long as a neighbour is halved), a cell whose middle deviates halves its own two intervals instead of everything, and an error that no flag
  explains refines everything (the loop cannot stand still). Tests: a push of radius 4 hidden in the middle of a start cell (found by the cell middles), two separated lattice bumps (twice the volume of one).
  The grading is not red-proven by these (the features of the catalogue laws are wide enough to be found at the first grid); it is kept as a guard against a narrow second feature.
- `iges.cxx` file counter is `std::atomic`; the cut-bar test is named for what it checks (§17.9).

**Bisect of the slow VC-DEF-17 (exact path).** Release sidecar, test alone: `feat/des-7d` base about 5 s (28 s file duration with transforms), 68eeabc2 (per-interval fit) about 5 s, 7d0616e8 as first committed about 63 s.
Cause: the cell-middle rule ran whenever a cell deviated, also when an axis error already explained it, so a global law (the plate wrapped on a drum) refined the other direction too and the tensor grid grew.
The rule now applies only when neither axis error exceeds the tolerance (the cell-only case), as before; the time is back to about 5 s (file 16 s), the 30 native server tests pass at the default timeouts (49 s against 113 s).

### 17.11 `output.preserveAnalytic` (FR-DEF-12, VC-DEF-23)

Until now `true` was refused (`DEF_EXACT_UNAVAILABLE`). The exact warp (`cpp/deform_recognise.cxx`) now rebuilds the faces that are still a plane, cylinder, cone or sphere after the warp:

- **Recognition.** Every face the warp fitted (a B-spline) is tried with `ShapeAnalysis_CanonicalRecognition` (plane, cylinder, cone, sphere, in that order) at a quarter of the tolerance. OCCT looks at the surface by itself, so it
  misses a face whose parameterisation moved (a cylinder twisted about its axis: the helical iso-lines defeat it, at any tolerance tried). A face it does not recognise is therefore also tried against the analytic surface
  of its SOURCE face (`origin`: result face -> source face, from the modifier history): sample points of the fitted face (13 x 13) are projected on it and the face takes it when none is farther than the same quarter
  tolerance (a twist about the axis keeps the cylinder, a stretch along it too, a plane normal to the axis stays that plane). `fromSource` counts those.
- **Rebuild.** The face is made again on the analytic surface with the same wires (the 3D edges stay shared with the neighbours). The surface is turned to the side of the fitted one, so the face keeps its orientation and the
  wires theirs; the wires are read without the face's orientation (read with it, a reversed face is reversed twice: the `BadOrientationOfSubshape` of the first attempt). The curves on the new surface are projected
  (exactly on a plane, `BRepLib::BuildPCurveForEdgeOnPlane`; `ShapeFix_Face` otherwise), `SameParameter` runs, and the face must pass `BRepCheck_Analyzer` alone (else it is kept as fitted and counted in `rejected`).
  The faces are replaced with `ShapeBuild_ReShape`; the naming history follows the replacement, so the face names are unchanged.
- **Guard.** The result must stay valid and its volume may move by at most tolerance / 2 x area (a rebuilt face deviates by at most a quarter tolerance); otherwise `DEF_KERNEL_REFUSED` says so.
- **Report.** `DeformReport.analyticFaces` and the command data `analyticFaces`: faces tried, rebuilt per type, `fromSource`, `rejected` (+ `rejectedStatus`, the first BRepCheck status), `gap` (largest deviation of a rebuilt
  face). Torus faces are not recognised (`ShapeAnalysis_CanonicalRecognition` has no torus), nor are edge curves (they stay B-splines).
- **Refused by name** (`DEF_EXACT_UNAVAILABLE`, `params.output.preserveAnalytic`): mode `mesh`, a mesh kernel or a faceted source, a sidecar without the capability `deform-analytic`, a linear scale (the affine law goes
  through `gtransform`, which has no rebuild), an exact warp that was refused and fell back to the faceted path.
- **VC-DEF-23.** The VC-06 taper (r 5 -> 2, h 40): one cone face of half angle 4.289154 degrees (closed form 4.289153, difference < 1e-6) and two planar caps, volume 1633.6292 (VC-06: 1633.62818, 6e-7); a twisted
  cylinder: one cylinder (`fromSource` 1) and two planes; a twisted box: the two caps become planes, the four twisted sides stay free-form (6 faces tried, 2 rebuilt).

Tests: `deform_tests.rs` (`preserve_analytic_turns_the_tapered_cylinder_back_into_a_cone`, `preserve_analytic_keeps_a_twisted_cylinder_a_cylinder_...`; red-proof: with the rebuild switched off the faces stay
"other" and both fail), `server/tests/nativeKernelAnalytic.test.ts` (the command, the topology kinds, the half angle, the refusals), the tool-schema snapshot (the `preserveAnalytic` description).

### 17.12 Native `faceQuery.bspline`

**What the TS side does.** `FaceQueryPort.bspline(shape, face)` is declared (`kernelPorts.ts`) and listed in the native method table, but the sidecar answered `null` (`bins/llull-kernel/src/queries.rs`: "no caller reads it yet"). The one consumer
that wants a face as a surface, the face target of `flow_on_surface` (`faceTarget`), therefore samples the face 65 x 65 through `evaluateFace` and interpolates a cubic B-spline through the samples (an approximation
of the face, not the face).

**What the sidecar answers now** (`face_bspline_json`, `face_queries.cxx`): the surface of the face over the face's parameter box (the box of `faceGeometry.uvBounds`) as ONE clamped, non-periodic B-spline:
`degreeU/V`, `poles[i][j]` (i along u), `weights` when rational, distinct `knotsU/V` with `multsU/V`, `periodicU/V` (always false: `SetUNotPeriodic`, so a cylinder's seam is a doubled pole line and a consumer needs no
wrap-around knots), and `reversed` (the face's normal is the opposite of S_u x S_v).

- A fitted B-spline face (the result of an exact warp) is cut to the box (`Geom_RectangularTrimmedSurface` + `GeomConvert::SurfaceToBSplineSurface`): the same (u, v) give the same point as `evaluateFace`.
- An elementary face (plane, cylinder, cone, sphere, torus, revolution, extrusion) becomes its exact rational B-spline: the SURFACE is the face's, the parameters are not (a rational quadratic circle is not
  angle-parameterised), so a consumer that needs the native parameters keeps `faceGeometry` / `evaluateFace`.
- An index out of range, a face without a surface or a failed conversion answer `null`.

**Parity tests.** `queries_tests.rs` `faceq_bspline_is_the_face_surface_for_planes_cylinders_and_spheres` (Cox-de Boor evaluation of the answer: every point that falls on the face is within 1e-9 of it, `projectOnFace`;
no periodic flag; the unit box, a cylinder, a sphere), `server/tests/nativeKernelFaceBspline.test.ts` (through the sidecar and the library evaluator `evaluateSurface`: box, cylinder, sphere, cone, torus faces within 1e-9
of the face; the fitted faces of a point push parameter for parameter within 1e-9; an out-of-range index answers null), the session test in `bins/llull-kernel/src/queries.rs` (was: answers null). Red-proof: before, every one of these
fails (the answer was `null`).

**Consumer.** `faceTarget` is NOT switched in this change: the rational conversion of an elementary face has other parameters than the sampled cubic fit, and I did not re-measure VC-DEF-17 (the wrap onto a drum face) with it, so
the face target keeps its 65 x 65 sampling. The exact surface is there for the switch, which is a separate, measured change.

### 17.13 VC-DEF-22: an exact deformation through STEP and back

`server/tests/deformStepRoundTrip.test.ts` (the model of VC-WRP-32): a tapered cylinder, a twisted box and a point push on a slab are exported with `export_step_ap242` and read back with `import_step_exact` on the real
sidecar. The read solid has the same number of exact faces, B-spline surfaces where the warp fitted them, and a volume within 2e-6 of the original; a second round trip changes the volume by less than 1e-9 (the exchange
itself is lossless). With `output.preserveAnalytic` (§17.11) the faces come back as one cone and two planes, volume within 1e-6.

**Finding: the 1e-6 of VC-DEF-22 is not met on the raw numbers, and why.** The taper of the VC-06 cylinder is 1633.62792 before the exchange and 1633.63005 after (1.3e-6); the closed form is 1633.62818. The geometry is the
same: the difference is the MASS RULE. A shape built by a deformation carries `refined_mass` (the adaptive `BRepGProp` rule, 1.6e-7 from the closed form here); the flag is a property of how a shape was built, not of its
geometry, and the STEP file does not carry it (the read solid is a fresh shape), so it is integrated by the fixed Gauss rule of its B-spline faces (+1.1e-6 from the closed form, the known
error of that rule on a fitted face, §14). Carrying the flag through the exchange (a marker in the STEP product, read into the blob) is the missing piece; deriving it from the faces (adaptive on every imported B-spline
face) would move the NIST corpus numbers (§17.9), so it is not done here. The test asserts the 2e-6 that the rule gap allows and the lossless second round trip.
