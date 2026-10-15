# CMP: Composite structures design (technical specification)

Gap id **CMP** · Status: specification only · Written 2026-10-15. Laws referenced: `.claude/rules/architecture.md`
L1-L10; decisions KI5 (shape boundary) and KI6 (desktop + CLI). The functional view is in `FUNCTIONAL_SPEC.md`,
and the validation cases (VC-CMP-nn) are in `validation/README.md`.

## 1. Current state in llull

| Area | Today | Path | Gap for composites |
| ---- | ----- | ---- | ------------------ |
| Materials | `Material` = name, density, PBR colour/metalness/roughness, optional procedural `finish` (`carbon_twill`, `carbon_plain` are **visual only**) | `packages/core/src/model/types.ts` (`Material`, `MaterialFinish`), `commands/document/materials.ts` (`create_material`, `assign_material`) | No elastic constants, strengths, ply thickness or anisotropy |
| Solids and surfaces | Primitives, extrude/revolve/sweep/loft, `surface_from_curves` (thickened Coons patch, exact B-spline under OCC) | `commands/solids/*.ts` | No open "tool surface" entity. A tool face must be picked on a solid (acceptable; see §2) |
| Kernel | `GeometryKernel`: `evaluate`, `tessellate`, `topology` (faces with `surface` type and area, edges), `exportStep`; OCC implements exact B-rep | `packages/core/src/geometry/kernel.ts`, `packages/kernel-occt/src/*` | No face-level geometry query (surface parameters, point projection, normals, UV), no face splitting by curves, no thicken |
| Topology naming | `edgesNear` points re-resolved on replay | KI5, `commands/brep/edgeSelection.ts` | The same idea is needed for faces (`faceNear`) |
| 2D geometry helpers | `polygon.ts` (area, centroid, simple `offsetPolygon`, point-in-polygon), `triangulate.ts` | `packages/core/src/lib/` | No polygon boolean (union/difference/intersection) and no robust offset with corner handling |
| DXF | Reader in core (`lib/dxfRead.ts`, `import_dxf`); writer only inside the AEC plugin | `packages/core/src/commands/exchange/importDxf.ts`, `packages/domain-aec/src/building/exchange/dxfWriter.ts` | Writer is not reachable from another plugin (L10: plugins see core only). It must move to `@lib` |
| Drawings | Sheets, views, SVG export | `commands/drawings/*` (`create_sheet`, `create_drawing_view`, `export_sheet_svg`) | Basis for the ply book |
| Inspection | `mass_properties`, `measure_area`, `inspect_topology`, `check_model` | `commands/inspect/*`, `commands/brep/topology.ts` | `mass_properties` does not know laminates |
| Plugins | `CadPlugin` with commands, guards, `DocumentExtension` (`validate`, `derivedEntityIds`, `restore`) | `packages/core/src/plugins/plugin.ts`, `packages/domain-aec/src/*/plugin.ts` | Template for a composites plugin |
| Python | Bundled CPython + CadQuery on desktop (KI6) | `server/python/llull_bridge.py` | Possible host for V2 AP242 writing (OCP has no composite AP242 writer; entities must be emitted by llull) |

Grep result (2026-10-15): no `ply`, `laminate`, `drape`, `rosette` or `fiber` concept exists in
`packages/*/src` apart from the visual carbon finish.

## 2. Target architecture

```
packages/domain-aero/src/composites/          NEW plugin "composites" (toolset "composites")
  model.ts            CompositesModel validation (DocumentExtension); the types live in core model/composites.ts (§3)
  notation.ts         stacking-notation parser / printer (pure)
  clt.ts              Q, Qbar, ABD, inverse, constants, ply stresses (pure)
  failure.ts          max stress, Tsai-Hill, Tsai-Wu (pure; LaRC03 in V2)
  rules.ts            design-rule checks R1..R5 (+ configurable extras)
  zones.ts            zone blending -> ply list; ramp offsets
  drape.ts            pin-jointed-net solver over a SurfaceQuery port (pure, deterministic)
  flatten.ts          developable unrolling + net-based flattening
  derive.ts           regenerates derived entities (ply outlines, flats, ply solids)
  commands/*.ts       defineCommand files (one concern each, <= 500 lines)
  catalog.ts, plugin.ts
packages/core/src/lib/polygonBoolean.ts       NEW pure 2D boolean + robust offset (shared; also useful to AEC)
packages/core/src/lib/dxfWrite.ts             MOVED generic DXF R12/R2000 writer (from domain-aec), AEC re-imports it
packages/core/src/geometry/kernel.ts          EXTENDED optional face queries (see §5.5)
packages/kernel-occt/src/occtFaces.ts         NEW OCC implementation of the face queries
src/app/plugins.ts                            installs the composites plugin
src/ui/panels/composites/*                    ply tree, zone table, core-sample tooltip, shear map legend
```

How the laws are respected:

- **L1, L4, L5.** Every capability is a `defineCommand` registered in the plugin's `commands`. Panels only
  gather parameters and call `dispatch`. MCP schemas come from `toToolSchemas()`. The CLI reaches the same
  registry.
- **L2, L10.** The plugin imports only the core public API (`model`, `lib`, `geometry`, `plugins/plugin`,
  `commands/{schema,types,noop,derivation,registry}`). Core never imports it. The generic DXF writer moves
  to `@lib` so that both plugins can use it.
- **L3.** Commands return new documents. Query commands return the same document plus `data`.
- **L8.** `CompositesModel` is document data. Derived geometry is regenerated by `derive.ts` and marked by
  `derivedEntityIds`; derivation guards make it read-only. Ids are step-scoped, so replay re-mints identical
  ids.
- **L9.** Drape and flattening on non-planar faces need surface queries. They read `ctx.kernel` only, are
  annotated `requiresKernel: true`, and no-op under Manifold with a clear summary
  ("requires the OCC kernel").

**Package decision (open, §11 Q1).** A new `packages/domain-aero` workspace hosts the aerospace plugins:
composites now, and possibly 07 FTR and 08 MAT. The alternative is one package per gap. Either way, a new
alias `@aero/*` goes into `tsconfig.base.json` (C4).

**Kernel dependency.** OCC on desktop (KI6). MVP CLT, zones, rules and planar or developable flat patterns
on planar faces work without a kernel. Cylinders and cones need face parameters from the kernel.

## 3. Data model

All lengths are in document units (mm in tests), angles in degrees, stresses in MPa. Types are sketches. The
final versions follow C1: no `any`, unions over comments, `readonly`.

```ts
// packages/core/src/model/composites.ts — the type lives in core next to building.ts / civil.ts, because
// `CadDocument` (core) references it and core never imports a plugin (L2, L10). Validation, derivation and
// commands stay in the plugin (packages/domain-aero/src/composites/model.ts implements the DocumentExtension).
export type LaminaForm = 'ud_tape' | 'woven' | 'core_honeycomb' | 'core_foam';
export type AllowableBasis = 'mean' | 'b_basis' | 'a_basis' | 'unknown';

export interface LaminaMaterial {
  readonly name: string;                 // key in CompositesModel.materials
  readonly form: LaminaForm;
  readonly E1: number; readonly E2: number; readonly G12: number; readonly nu12: number;
  readonly G13?: number; readonly G23?: number;
  readonly Xt: number; readonly Xc: number; readonly Yt: number; readonly Yc: number; readonly S: number;
  readonly plyThickness: number;         // cured ply thickness
  readonly density: number;              // mass / unit^3 (same convention as core Material)
  readonly lockingAngle?: number;        // fabrics: max shear before locking (deg)
  readonly warningShear?: number;        // amber threshold (deg)
  readonly tsaiWuF12Star?: number;       // default -0.5
  readonly basis: AllowableBasis;
  readonly source: string;               // free text, e.g. "NCAMP NCP-RP-2009-028 Rev B"
  readonly coreMaterialId?: string;      // optional link to a core Material for colour/PBR
}

export type RosetteMethod = 'translational' | 'cylindrical' | 'radial' | 'edge';
export interface Rosette {
  readonly id: string; readonly name: string;
  readonly origin: Vec3; readonly axis0: Vec3; readonly normal: Vec3;
  readonly method: RosetteMethod; readonly axis?: Vec3;   // cylindrical
}

export interface FaceRef { readonly entityId: string; readonly faceNear: Vec3; readonly faceIndex?: number } // index cached, point authoritative

export type PlyBoundary =
  | { readonly kind: 'whole_face' }
  | { readonly kind: 'curves'; readonly curveIds: readonly string[] }          // 2D sketch / 3D curves projected on the face
  | { readonly kind: 'uv_polygon'; readonly uv: readonly Vec2[] }               // generated (zones)
  | { readonly kind: 'surface_region'; readonly maxPolarAngleDeg?: number };    // test helper (VC-CMP-12)

export interface DrapeSettings {
  readonly method: 'developable' | 'kinematic' | 'projection';
  readonly seedPoint?: Vec3; readonly seedDirection?: Vec3;   // default rosette origin / axis0 rotated by orientation
  readonly stepLength?: number;                               // default = auto (bbox / 200, clamped)
  readonly generators?: 'geodesic' | { readonly warpCurveId: string; readonly weftCurveId?: string };
  readonly allowOverLock?: boolean;
}

export interface Ply {
  readonly id: string; readonly name: string;
  readonly partId: string; readonly order: number;          // stacking order, 0 = tool side
  readonly sequence: string;                                 // ply-book sequence label, e.g. "S12"
  readonly materialName: string; readonly orientation: number; readonly rosetteId: string;
  readonly boundary: PlyBoundary; readonly drape?: DrapeSettings;
  readonly cuts?: readonly { readonly curveId: string; readonly kind: 'dart' | 'splice'; readonly overlap?: number }[];
  readonly zoneOrigin?: { readonly zoneIds: readonly string[]; readonly dropRank?: number }; // when generated
}

export interface Zone {
  readonly id: string; readonly partId: string; readonly name: string;
  readonly boundary: readonly Vec2[];        // in the part's 2D frame (planar) or face UV (curved)
  readonly notation: string; readonly angles: readonly number[];   // expanded, bottom -> top
  readonly priority: number;
}

export interface PlyDropRules {
  readonly rampRatio: number;               // default 20
  readonly minStagger: number; readonly staggerUnit: 'dropped_thickness' | 'length';
  readonly dropOrder: 'inner_first' | 'outer_first';
  readonly coverPlies: number;              // continuous plies on each surface
}

export interface RuleConfig {
  readonly symmetric: boolean; readonly balanced: boolean;
  readonly minFraction: number;             // 0.10
  readonly maxConsecutive: number;          // 4
  readonly outerPlusMinus45: boolean;
  readonly maxAngleChange?: number;         // V1 disorientation rule
  readonly disabled?: readonly { readonly rule: string; readonly justification: string }[];
}

export interface CompositePart {
  readonly id: string; readonly name: string;
  readonly toolFaces: readonly FaceRef[]; readonly laminateSide: 'positive_normal' | 'negative_normal';
  readonly rosetteId: string; readonly plyDropRules?: PlyDropRules; readonly rules?: RuleConfig;
}

export interface CompositesModel {               // CadDocument.composites (absent until first composites command)
  readonly materials: Record<string, LaminaMaterial>;
  readonly rosettes: Record<string, Rosette>;
  readonly parts: Record<string, CompositePart>;
  readonly zones: Record<string, Zone>;
  readonly plies: Record<string, Ply>;
  readonly plyOrder: readonly string[];          // global creation order (stable for replay)
}
```

```ts
// Agent-first records (AGENT_FIRST.md AF-31..34), same core model file
export interface NamedDefault { readonly value: number; readonly unit: string; readonly source: string; readonly defaulted: boolean }
export interface LayupWaiver {                    // CompositesModel.waivers (FR-CMP-71)
  readonly id: string; readonly partId: string; readonly code: string; readonly ids: readonly string[];
  readonly reason: string; readonly requestedBy: 'agent' | 'human';
  readonly approvalRef?: string;                  // 09 PLM approval id; set only after record_approval by a human caller
}
// LaminaMaterial is `unverified` when basis ∈ {'mean','unknown'} or `source` is empty / not a cited reference;
// every result computed from it reports unverified: true (computed on read, cannot be cleared).
```

**Document extension.** `CadDocument` gains an optional `composites?: CompositesModel`. This mirrors
`building?` and `civil?`, and the plugin declares it through `DocumentExtension`:

- `validate(raw)` checks every invariant: E, G, strengths and thickness > 0; ν12² < E1/E2; rosette axes
  non-parallel; unique names; ply → material/rosette/part references exist; zone polygons simple.
- `derivedEntityIds(doc)` returns the derived entity ids: ply outline polylines (3D), flat-pattern 2D
  polylines (placed on a "flats" layer at an offset), optional ply solids, drape net preview meshes.
- `restore(raw)` regenerates them on load.

Document versioning: adding an optional root key requires no migration. Files written before the gap simply
lack `composites`. The persistence guards (`commands/persistence/guards.ts`) gain the plugin validator
through the extension, as for `building`.

**Parameters (L8).** Numeric fields such as orientation, ramp ratio, step length, zone vertices and
thicknesses accept expressions resolved by the existing parameter evaluator (`commands/parametric`). The
notation string may contain `${name}` angle parameters, e.g. `[${a}/-${a}/0/90]s`.

## 4. Commands

All commands are `snake_case` and belong to toolset `composites`. Mutating commands append a feature step,
and query commands return `data` without changing the document. Each command file carries
`@affects @invariant @failure` tags. A failure returns the unchanged document with summary
`<name> rejected: …` (via `failer`).

| Command | Kind | Params (zod sketch) | @affects / @invariant / @failure | Phase |
| ------- | ---- | ------------------- | -------------------------------- | ----- |
| `create_lamina_material` | mutating | `{ name, form, E1, E2, G12, nu12, G13?, G23?, Xt, Xc, Yt, Yc, S, plyThickness, density, lockingAngle?, warningShear?, tsaiWuF12Star?, basis?, source }` | creates/replaces 1 material / all > 0, ν12² < E1/E2, −1 ≤ F12* ≤ 0 / invalid → no-op | MVP |
| `define_rosette` | mutating | `{ name, origin: vec3, axis0: vec3, normal: vec3, method, axis? }` | creates 1 rosette / axis0 not parallel to normal, axis0 re-orthogonalised / degenerate → no-op | MVP |
| `create_composite_part` | mutating | `{ name, toolSurface: { entityId, faceNear } \| { entityId, faceNear }[], rosette, laminateSide? }` | creates 1 part / face resolves on the current B-rep (OCC) or a planar face of a primitive (any kernel) / no face within tolerance → no-op | MVP |
| `define_zone` / `edit_zone` / `delete_zone` | mutating | `{ part, name, boundary: vec2[] \| curveIds, laminate: string, priority }` | creates/edits 1 zone / notation parses; boundary simple, inside the face / parse error names the token | MVP |
| `set_ply_drop_rules` | mutating | `PlyDropRules` + `part` | sets rules / ratio ≥ 1 / — | MVP |
| `set_laminate_rules` | mutating | `RuleConfig` + `part` | sets rules / disabling needs a justification / — | MVP |
| `generate_plies_from_zones` | mutating | `{ part, material, sequencePrefix?, replaceGenerated? }` | creates N plies (deterministic ids) / every zone stack blends into the master stack / non-blendable pair → no-op naming both zones | MVP |
| `add_ply` / `edit_ply` / `delete_ply` / `reorder_plies` | mutating | `{ part, name, material, orientation, sequence?, order?, boundary, drape? }` | 1 ply / material and rosette exist / missing ref → no-op | MVP |
| `split_ply` | mutating | `{ ply, curveId, kind: 'dart'\|'splice', overlap? }` | ply gains a cut, flats re-derived / curve crosses the ply boundary twice / → no-op | V1 |
| `add_core` | mutating | `{ part, boundary, material, thickness, chamferAngle }` | 1 core region / thickness > 0, 0 < chamfer ≤ 90 / — | V1 |
| `core_sample` | query | `{ part, point: vec3 } \| { part, polyline: vec3[], samples? }` | data `{ plies: [{ id, name, material, angleRosette, angleGlobal, z0, z1 }], thickness, core? }` / point projects onto a tool face / off-part → rejected | MVP |
| `check_laminate_rules` | query | `{ part, zones?: string[], thresholds? }` | data `{ status, findings: [{ code, severity, rule, zoneId?, point?, plies, value, limit, unit, remediation, waiverStatus? }], thresholds: Record<string, NamedDefault> }` (codes `CMP_RULE_*`, §7.1) | MVP |
| `analyze_laminate` | query | `{ part, point } \| { angles, material }` + `{ loads?: { Nx?, Ny?, Nxy? (N/mm), Mx?, My?, Mxy? (N·mm/mm) }, criteria?: ('max_stress'\|'tsai_hill'\|'tsai_wu')[] }` | data `{ unit: 'N-mm-MPa', Q, A, B, D, abdInverse, constantsMembrane, constantsFreeBending, plies: [{ stresses12Bottom, stresses12Top, ratios }], firstPlyFailure: { criterion: { R, ply, position } }, defaults: { tsaiWuF12Star: NamedDefault }, unverified, reviewRequired, reviewReason, provenance }` | MVP |
| `laminate_mass` | query | `{ part }` | data `{ mass, area, volume, cg, perMaterial }`; `mass_properties` delegates here when an entity is a composite part | MVP |
| `check_layup` | query | `{ part, purpose?: 'design'\|'release', loads?: LoadCase[], thresholds? }` | data `{ status: 'pass'\|'warn'\|'fail', findings: [{ code, severity, ids, value?, limit?, unit?, remediation, waiverStatus? }], defaults: Record<string, NamedDefault>, unverified, reviewRequired, reviewReason?, provenance }`; aggregates rules, ramps, blending, producibility (V1), FPF R < 1, material completeness and verification (AF-20) | MVP |
| `request_layup_waiver` | mutating | `{ part, code, ids, reason }` | creates 1 pending `LayupWaiver` / `approvalRef` not settable by params (only the 09 PLM approval link sets it) / no matching current finding → `CMP_WAIVER_NO_FINDING` | MVP |
| `drape_ply` | query | `{ ply, stepLength? (mm), output?: 'summary'\|'nodes' }` | data `{ maxShearDeg, nodesOverWarning, nodesOverLock, areaOverLockMm2, overLockRegions: [{ id, nodeCount, centroid }], stepLength: NamedDefault, net? }` (`net` only with `output: 'nodes'`, paged or `--save`) / requiresKernel / no OCC → `CMP_KERNEL_REQUIRED`; missing `lockingAngle` → `CMP_DRAPE_LIMIT_MISSING` | V1 |
| `check_producibility` | query | `{ part, plies? }` | data `{ plies: [{ id, maxShearDeg, nodesOverLock, areaOverLockMm2, findings: [{ code, severity, remediation }], suggestions }] }` | V1 |
| `export_flat_patterns_dxf` | query (export) | `{ part, plies?, labels?, nest?, allowance?, arcTolerance? }` | data `{ files: [{ name, mime: 'image/vnd.dxf', content }] }` / plies with over-lock nodes refused unless `allowOverLock` | MVP (developable), V1 (draped) |
| `export_laser_projection` | query (export) | `{ part, plies?, spacing?: number, cornerAngle?: number, frame?: 'tool'\|'world' }` | text file per part, §6.3 | V1 |
| `ply_book_data` | query | `{ part }` | data `{ sequences: [{ sequence, plies: [{ id, name, material, orientationDeg, areaMm2, flatPieceIds, boundaryLengthMm }] }], reviewRequired: true, unverified }` (numeric content of the ply book, AF-21) | V1 |
| `export_ply_book` | query (export) | `{ part, format: 'svg'\|'pdf', sheetSize? }` | sheets from `ply_book_data` through the drawings renderer **without** mutating the document (in-memory sheet model), written with `--save`; `reviewRequired: true` | V1 |
| `export_ply_table` / `import_ply_table` | query / mutating | CSV text | round-trip of plies (`import_ply_table` creates plies through `add_ply` via `execute`) | V1 |
| `export_laminate_sections` | query | `{ part, format: 'json'\|'nastran_pcomp'\|'calculix' }` | per zone section definitions (05 FEA consumes JSON) | V1 |
| `export_composite_step` | query | `{ part, representation: 'explicit'\|'ap242_composite' }` | explicit = per-ply solids via `exportStep`; ap242_composite = V2 (§6.4) | V1 / V2 |

Notes:

- **Read-only queries** declare `annotations: { readOnly: true }` (`commands/types.ts` `CommandAnnotations`),
  emitted as the MCP `readOnlyHint`, so agents may call them freely (FR-CMP-62).
- **Composition.** `generate_plies_from_zones` and `import_ply_table` compose `add_ply` through
  `ctx.registry` / `execute` (L10). They do not build plies inline.
- **Retirement.** None.

## 5. Kernel and algorithms

### 5.1 Stacking notation (`notation.ts`)

Grammar (ASCII-first; `±` accepted as an alias of `+-`):

```
laminate := '[' items ']' suffix?
items    := item ('/' item)*
item     := group | angle
group    := '(' items ')' ('_' INT)?
angle    := ('+-' | '±')? NUMBER ('_' INT)? '~'?        // '~' on the last item = unduplicated middle ply
suffix   := ('_')? INT? ('s' | 'T')
```

Expansion is bottom to top: `s` mirrors (`half + reverse(half)`); `Ns` repeats the half N times then
mirrors; the trailing `~` makes the middle ply single. Angles are normalised to (−90, 90], so 90 stays 90.
The printer produces the shortest canonical string (VC-CMP-08). The nomenclature follows NASA RP-1351 §
"stacking sequence nomenclature" [R1]. The reference implementation is
`validation/generate_layup_rules_reference.py`.

### 5.2 Classical Laminate Theory (`clt.ts`) [R1][R2]

- **Lamina.** With ν21 = ν12 E2/E1 and Δ = 1 − ν12 ν21:
  - Q11 = E1/Δ
  - Q22 = E2/Δ
  - Q12 = ν12 E2/Δ
  - Q66 = G12
- **Transformation** (m = cos θ, n = sin θ, engineering shear strain):
  - Q̄11 = Q11 m⁴ + 2(Q12 + 2Q66) m²n² + Q22 n⁴
  - Q̄12 = (Q11 + Q22 − 4Q66) m²n² + Q12 (m⁴ + n⁴)
  - Q̄22 = Q11 n⁴ + 2(Q12 + 2Q66) m²n² + Q22 m⁴
  - Q̄16 = (Q11 − Q12 − 2Q66) m³n + (Q12 − Q22 + 2Q66) m n³
  - Q̄26 = (Q11 − Q12 − 2Q66) m n³ + (Q12 − Q22 + 2Q66) m³n
  - Q̄66 = (Q11 + Q22 − 2Q12 − 2Q66) m²n² + Q66 (m⁴ + n⁴)
- **Laminate.** Plies k = 1..N run bottom to top, z_0 = −h/2, z_k = z_{k−1} + t_k:
  - A = Σ Q̄ (z_k − z_{k−1})
  - B = ½ Σ Q̄ (z_k² − z_{k−1}²)
  - D = ⅓ Σ Q̄ (z_k³ − z_{k−1}³)
  - The constitutive law is [N; M] = [A B; B D] [ε⁰; κ].
- **Inverse.** A 6×6 Gauss-Jordan solve with partial pivoting. If the condition number exceeds 1e12, the
  command is rejected as "singular laminate".
- **Engineering constants**, reported twice and labelled:
  - membrane: Ex = 1/(h a11), Ey = 1/(h a22), Gxy = 1/(h a66), νxy = −a12/a11, with a = A⁻¹;
  - free bending: the same formulas on the top-left 3×3 block of [ABD]⁻¹.
  - Both definitions are identical for symmetric laminates (VC-CMP-05 shows the difference).
- **Ply stresses.** At z_bottom and z_top of each ply, ε = ε⁰ + z κ and σ_xy = Q̄ ε. Material axes use
  σ1 = m²σx + n²σy + 2mn τxy, σ2 = n²σx + m²σy − 2mn τxy and τ12 = −mn σx + mn σy + (m² − n²) τxy.
- **Determinism.** Fixed summation order (bottom to top) and IEEE double precision. The results must match
  `clt_reference.json` within rel 1e-9 for exact identities and 1e-4 elsewhere.
- **Units.** Everything stays in document units, and MPa is assumed for mm documents. For other units the
  material record stores its unit system (`stressUnit`), and values are converted on read (`model/units`).

### 5.3 First-ply failure (`failure.ts`)

Strength ratio R is the load multiplier at which a ply point reaches failure. FPF = min R over plies, the
two positions and the chosen criterion.

| Criterion | Index / ratio | Notes |
| --------- | ------------- | ----- |
| Max stress | R = min(X/\|σ1\|, Y/\|σ2\|, S/\|τ12\|), with X = Xt or Xc and Y = Yt or Yc by sign | Mode reported (fibre / matrix / shear) |
| Tsai-Hill | FI = (σ1/X)² − σ1σ2/X² + (σ2/Y)² + (τ12/S)², R = FI^−½ | Sign-dependent X, Y |
| Tsai-Wu | F1 = 1/Xt − 1/Xc, F2 = 1/Yt − 1/Yc, F11 = 1/(Xt Xc), F22 = 1/(Yt Yc), F66 = 1/S², F12 = F12*·√(F11F22). Solve a R² + b R − 1 = 0 with a = F11σ1² + F22σ2² + F66τ² + 2F12σ1σ2 and b = F1σ1 + F2σ2, so R = (−b + √(b² + 4a))/(2a) | Default F12* = −0.5, a common choice without biaxial data [R3]; configurable per material |
| LaRC03 (V2) | Six plane-stress criteria [R4] | Needs fracture-plane angle and in-situ strengths |

Last-ply / progressive failure is V2. The `analyze_laminate` summary states "first-ply failure, linear,
no hygrothermal".

### 5.4 Kinematic drape (`drape.ts`) [R5][R6][R7]

**Model.** A pin-jointed net with inextensible tows of constant step d (Mack & Taylor fishnet [R5]). The
net is seeded at point P0 with two generators: geodesics in directions e_warp and e_weft (e_warp = rosette
0° projected at P0 and rotated by the ply orientation), or user curves. Generator nodes are marched at
constant arc length d along the geodesic. Each interior node P(i,j) satisfies
|P − P(i−1,j)| = |P − P(i,j−1)| = d, P ∈ S, and lies on the side opposite P(i−1,j−1).

**Sphere closed form** (used by the reference generator and as a unit-test oracle). With |X| = R,
X·A = X·B = R² − d²/2, set X = α(A + B) + γ(A × B), α = (R² − d²/2)/(R² + A·B) and
γ = ±√((R² − |α(A + B)|²)/|A × B|²). Keep the root farther from C = P(i−1,j−1).

**General faces (OCC).** The node lies on the circle Γ = sphere(A, d) ∩ sphere(B, d) (centre (A+B)/2,
radius √(d² − |AB|²/4), in the plane normal to AB). Find the root of f(φ) = signed distance from Γ(φ) to S
along the surface normal. Bracket the root on the side away from C, starting from the parallelogram
predictor A + B − C. Solve with Brent to 1e-9·d. Each evaluation uses `projectOnFace` (§5.5), and calls
are batched per front row to amortise the worker round-trip.

**Front propagation.** Rows and columns propagate outward from the generators into 4 quadrants, in a fixed
order (i, then j), so that results are deterministic.

**Stop conditions:**

1. No root: the node lies off the face or beyond a boundary. The node is marked `outside`.
2. Shear γ = 90° − angle(P(i−1,j) − P, P(i,j−1) − P) exceeds `lockingAngle`, and `allowOverLock` is not
   set. The node is marked `locked`, and its successors are not propagated (Altair stops drape at max
   shear [R8]).
3. The cell inverted (crossing angle < 1°).

**Outputs:** the nodes, a shear value per node, fibre directions (finite differences), and status. Shear is
the corner shear of the cell ending at the node. The display interpolates it at vertices.

**Validation oracle** (VC-CMP-12). For a Chebyshev net, φ_uv + K sin φ = 0 [R6][R7]. With φ = 90° on the
generators (mirror symmetry), the shear equals K·Area of the net patch. On a sphere, K = 1/R². The
generator measures |γ − K·A| ≤ 0.5° at d = R/100.

**Limits** (shown in the UI and the summary). The model is purely kinematic: no fabric mechanics, friction
or tool contact. UD prepreg is valid only for moderate deformation (Altair's note [R8]). The 2022
benchmark [R9] found kinematic drape suitable for axisymmetric moulds but not for irregular ones.

### 5.5 Kernel extension (`GeometryKernel`, optional methods)

```ts
export type FaceGeometry =
  | { kind: 'plane'; origin: Vec3; normal: Vec3; xDir: Vec3 }
  | { kind: 'cylinder'; origin: Vec3; axis: Vec3; xDir: Vec3; radius: number }
  | { kind: 'cone'; apex: Vec3; axis: Vec3; xDir: Vec3; halfAngle: number }
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'freeform' };
export interface FaceProjection { point: Vec3; normal: Vec3; uv: Vec2; distance: number }
// These four methods belong to the single optional face-query port owned by gap 01 (`FaceQueryPort`, exposed as
// `GeometryKernel.faceQuery?`, TR-KRN-90..92, docs/aerospace/01-exact-brep-kernel/TECHNICAL_SPEC.md §5.9), where `FaceGeometry` is the shared `SurfaceParams`
// type (`halfAngle` is named `semiAngle`, `freeform` is named `other`). Signatures here state what CMP needs.
interface FaceQueryPort /* subset */ {
  /** Analytic description + UV bounds of face `index` (null: unsupported). */
  faceGeometry?(shape: ShapeHandle, index: number): { geometry: FaceGeometry; uvBounds: [Vec2, Vec2] } | null;
  /** Closest points on face `index` (batched). */
  projectOnFace?(shape: ShapeHandle, index: number, points: readonly Vec3[]): readonly (FaceProjection | null)[] | null;
  /** Points of the face at given UVs (batched) — used to map zone UV polygons to 3D. */
  evaluateFace?(shape: ShapeHandle, index: number, uv: readonly Vec2[]): readonly { point: Vec3; normal: Vec3 }[] | null;
  /** Face mesh with per-vertex UV for display of draped nets and shear maps. */
  tessellateFace?(shape: ShapeHandle, index: number, deflection: number): (MeshData & { uv: number[] }) | null;
}
```

- **OCC implementation** (`occtFaces.ts`):
  - `BRepAdaptor_Surface` (GetType, Plane/Cylinder/Cone/Sphere accessors) and `BRepTools::UVBounds` for
    `faceGeometry`;
  - `GeomAPI_ProjectPointOnSurf` for `projectOnFace`, with `BRepClass_FaceClassifier` to reject projections
    outside the trimmed face;
  - `BRepLProp_SLProps` for normals;
  - `BRepMesh_IncrementalMesh` with `Poly_Triangulation` UV nodes for `tessellateFace`.
  - Each class must be confirmed in the opencascade.js build that llull ships. Any missing binding goes into
    the custom build list (§11 Q3).
- **Manifold.** The methods are absent. The commands report "requires the OCC kernel". Planar faces of
  primitives work without a kernel: the plane is computed from the entity.
- **Worker proxy.** Batched methods follow the existing proxy pattern: key-only handles, and the recipe is
  resent on `SHAPE_NOT_CACHED`.
- **Face naming.** `faceNear` resolves to the face whose closest point is nearest to the stored point.
  Within 1e-6·bbox it is unique. When two faces tie, the command is rejected as ambiguous. This mirrors
  `edgesNear` in KI5.

### 5.6 Zones, blending and ramps (`zones.ts`)

1. Sort zones by ply count, descending. The thickest zone's expanded stack is the **master sequence** M.
   Several equally thick zones must have identical stacks, otherwise the input is rejected.
2. For each zone Z, find an embedding of Z's stack as a subsequence of M, matching from both ends inward so
   that symmetry is preserved and outer cover plies are kept continuous (deterministic: leftmost match).
   If no embedding exists, the input is rejected with the zone names (blending infeasible).
3. Each master ply m has a support set Z(m), the zones where it is present. Its full-thickness region is
   union(Z(m)), computed with `@lib/polygonBoolean` in the part's 2D frame (or the face UV frame).
4. **Ramps.** At each boundary where m is present on one side only, m extends into the thinner side by
   o = r_m · t · rampRatio, where r_m is the drop rank (1 = first dropped). Rank follows `dropOrder`
   (`inner_first`: plies closer to the mid-plane drop first). Stagger = t · rampRatio must be at least
   `minStagger`. The extension uses `offsetPolygon` clipped to the face boundary.
5. **Conflicts.** If an extension reaches another zone boundary that also drops plies, or the face edge,
   within less than o, the check reports `ramp_conflict` with the location (VC-CMP-11).
6. Generated plies carry `zoneOrigin` and deterministic ids `ply-<step>.<k>`, with k = master index.

### 5.7 Flat patterns (`flatten.ts`)

- **Plane.** Map to the rosette frame: x' = rosette 0° direction rotated by the ply orientation. The outline
  is exact.
- **Cylinder** (radius r, axis a). Unroll as (s, z) = (r·φ, z) with φ measured from the rosette xDir.
  Unrolling is isometric, so fibres stay straight at the same angle (VC-CMP-14). A seam is required when the
  ply wraps 360°. The split is placed at the rosette xDir + 180°.
- **Cone** (apex O, half angle α). A point at distance ρ from the apex and azimuth φ maps to polar
  coordinates (ρ, φ·sin α). The sector angle is 2π·sin α (= 360°·r/slant, VC-CMP-15). Meridians become
  radial lines.
- **Doubly curved** (V1). Use the draped net. The node (i,j) maps to the flat point (i·d, j·d) for orthogonal
  tows (woven) in the unsheared material frame. The 3D ply boundary is located in its net cell by inverse
  bilinear interpolation of the cell corners and then mapped to the flat. Boundary segments longer than
  `arcTolerance` are subdivided first. Darts and splices are cut curves processed the same way, producing
  separate pieces.
- **Annotations.** Each flat pattern has a 0° arrow at the piece centroid, a label (name, sequence,
  material, orientation), and an optional allowance offset (`offsetPolygon`).

### 5.8 Design rules (`rules.ts`)

The rules R1-R5 are defined exactly as in `generate_layup_rules_reference.py` (plus the optional
disorientation and drop-symmetry rules):

- angles normalised to (−90, 90];
- families 0 / ±45 / 90 for R3;
- runs counted on the normalised sequence;
- ±45 outer means |a_first| = |a_last| = 45.

Configurable thresholds live in `RuleConfig` (FR-CMP-21). The defaults (10 %, max 4 consecutive, symmetric,
balanced, ±45 outer) are labelled in the UI as "common published guidelines (CMH-17 / industry)", not as
quoted CMH-17 clauses (sources S15-S17 disagree on details, e.g. 4 vs 5 contiguous).

### 5.9 Numerical tolerances

| Quantity | Tolerance |
| -------- | --------- |
| CLT identities (B = 0, A16 = 0) | 1e-9 relative to max\|A\| (·h, ·h²) |
| CLT values versus reference | rel 1e-4 |
| Drape node solve | 1e-9·d on the distance constraints |
| Face projection | OCC `Precision::Confusion()` (1e-7 mm) |
| Flat-pattern arc chord | `arcTolerance` default 0.05 mm (area error ≤ 0.2 % on VC-CMP-16) |
| Zone polygon booleans | snap 1e-6·bbox |

## 6. Interop and persistence

### 6.1 Document

`composites` is JSON in the `.llull.json` file, validated by the plugin. Derived entities are not persisted
(`derivedEntityIds`); they are regenerated on load. The live sync (`@mcp/liveSync`) carries commands, not
diffs (L6), so nothing changes there.

### 6.2 DXF flat patterns

The writer moves to `@lib/dxfWrite.ts` (generic entities: LWPOLYLINE, LINE, TEXT, layers, `$INSUNITS`,
ACI colours). The AEC writer re-imports it, and its behaviour must not change (existing AEC tests are the
guard).

Per ply piece:

- layer `PLY_<name>`, sanitised by `dxfLayerName`;
- a closed LWPOLYLINE in mm, counter-clockwise;
- an arrow (LINE pair) on layer `ORIENT`;
- TEXT `name / seq / material / angle`;
- the DXF header has `$INSUNITS = 4`.

Pieces are laid out left to right with a gap of 10 mm (no nesting in the MVP). DXF is the de-facto cutter
input. ASTM D6673 [R10] documents DXF pattern exchange but excludes cutter instructions, so llull emits
geometry and labels only. The round trip through `import_dxf` is VC-CMP-16.

### 6.3 Laser projection

The format is plain text, because vendor formats (Virtek, SL Laser, LPT [R11]) are proprietary. A
documented neutral layout:

```
# llull laser projection v1   units=mm   frame=tool   part=<name>
PLY <name> SEQ <seq> MATERIAL <mat> ANGLE <deg> POINTS <n>
x y z
...
END
```

Points follow the ply boundary on the tool face (3D), with consistent winding (counter-clockwise seen from
the laminate side). The maximum spacing is `spacing` (default 75 mm, about 3 in [R12]), and every corner
with a turn of at least 20° is included. Converters to vendor formats are out of scope. Customers' projector
software imports point lists.

### 6.4 STEP

- **V1 explicit.** One solid per ply piece: the face region thickened by t at cumulative offset z
  (`BRepOffsetAPI_MakeThickSolid` or offset face + prism, exposed as a new `ShapeRecipe` node `ply_solid`
  so that it stays inside the recipe boundary of KI5). The pieces are exported with the existing
  `export_step_exact` path (AP214). The CAx-IF practice explicitly allows tessellated or explicit per-ply
  solids for unambiguous visual exchange [R13].
- **V2 implicit (AP242 composite).** Write the laminate table, plies, ply orientation, ply boundaries and
  cores as specified by the CAx-IF Recommended Practices for Composite Materials v4.x (supplement to the
  AP242 ed4 practices) [R13], plus the validation properties v1.0 [R14]. OCC/OCP has no composite writer, so
  llull emits the Part 21 entities itself in a pure core module (`codegen`-like), linking them to the
  explicit solids. Conformance: VC-CMP-19 (TBD with a CAx-IF round or checker). The entity names are taken
  from the rec-practice document when implemented. They are not reproduced here, because that text was not
  fully reviewed.

### 6.5 CSV ply table

Columns: `ply,sequence,order,material,orientation,rosette,zones,area_mm2,mass_g`. UTF-8 with `,` as
separator. Numbers use `.` as the decimal mark.

### 6.6 Laminate sections for FEA (handoff to 05 FEA)

```json
{ "part": "Skin panel", "units": "mm-N-MPa",
  "sections": [ { "zone": "Z-base", "plies": [ { "material": "T300_5208", "t": 0.125, "angle": 45 }, … ], "offset": "bottom" } ] }
```

05 FEA maps the sections to PCOMP / CalculiX `*SHELL SECTION, COMPOSITE`.

## 7. CLI, MCP and UI surfaces

- **CLI (primary).** No new verbs: every command is `llull <command> …` / `llull exec`, plans run with
  `llull run plan.json --validate` then `llull run plan.json --json --progress`, exports land with `--save`
  (DXF, laser text, CSV, ply-book SVG/PDF, net JSON). `llull search laminate ply drape` and `llull describe`
  expose the toolset; `llull guide` gains the composites section (FR-CMP-62). Drape and regeneration honour
  `--progress` / `--timeout` (AF-40); mutating commands work with `--dry-run` (AF-42). `render_view
  isolate=<part> --save view.png` shows plies and nets to multimodal agents (AF-22).
- **MCP.**
  - Toolset `composites`, exposed in discovery.
  - Prompts `design_laminate` (requirements → plan) and `layup_loop` (`check_layup` + FPF loop).
  - Read-only queries declare `annotations: { readOnly: true }` (MCP `readOnlyHint`).
  - Export tools return resources (DXF text, laser text, SVG).
- **UI (`src/ui/panels/composites/`, review surface).** Ply tree grouped by sequence (drag to reorder dispatches
  `reorder_plies`), zone table with rule badge, core-sample tooltip, shear-map overlay (green / amber / red from
  `drape_ply` data), flat-pattern preview on a 2D "flats" layer (L7), `check_layup` report, waiver and ply-book
  approval through 09 PLM. Ply outlines render as 3D polylines offset by cumulative thickness; the rosette glyph
  is an arrow triad. All actions dispatch commands (L1); panels compute nothing; no capability depends on them.

### 7.1 Stable error and finding codes (AF-11)

Refusals return the unchanged document, exit 1, and `data.errors[] {code, path, ids, remediation}` (`--validate`
adds the plan step path). Findings of `check_layup` / `check_laminate_rules` / `check_producibility` use the same
shape in `data.findings[]` with `severity` pass / warn / fail (exit 0).

| Code | Raised by | When | Offending ids / path | Remediation |
| ---- | --------- | ---- | -------------------- | ----------- |
| `CMP_NOTATION_PARSE` | `define_zone`, `edit_zone`, `analyze_laminate` | stacking string does not parse | `params.laminate`, token index | use `[a/b/…]`, `_n`, `( )_n`, `s`, `T`, `~` (TECHNICAL §5.1) |
| `CMP_MATERIAL_NOT_POSITIVE_DEFINITE` | `create_lamina_material` | ν12² ≥ E1/E2 | `params.nu12` | check ν12 and the E1/E2 order |
| `CMP_MATERIAL_NOT_POSITIVE` | `create_lamina_material` | a modulus, strength, thickness or density ≤ 0 | `params.<field>` | enter positive values in MPa / mm |
| `CMP_MATERIAL_ALLOWABLE_MISSING` | `analyze_laminate`, `check_layup` | a strength needed by the criterion is absent | material name, field | add Xt, Xc, Yt, Yc, S from a cited source (no default exists) |
| `CMP_F12_RANGE` | `create_lamina_material` | F12* ∉ [−1, 0] | `params.tsaiWuF12Star` | use −0.5 or a value from biaxial data |
| `CMP_ROSETTE_DEGENERATE` | `define_rosette` | 0° axis parallel to the normal, zero vector | `params.axis0` / `params.normal` | give a 0° axis not parallel to the normal |
| `CMP_FACE_NOT_FOUND` / `CMP_FACE_AMBIGUOUS` | `create_composite_part` | `faceNear` resolves to none / two faces within tolerance | `params.toolSurface.faceNear` | pick a point on the intended face interior |
| `CMP_REF_MISSING` | ply / zone commands | material, rosette, part or ply id unknown | `params.<ref>` | create it first or fix the id (`llull describe_scene`) |
| `CMP_ZONE_BOUNDARY_INVALID` | `define_zone` | polygon self-intersects or leaves the face | `params.boundary[i]` | give a simple polygon inside the face |
| `CMP_ZONES_NOT_BLENDABLE` | `generate_plies_from_zones` | a zone stack is not a subsequence of the master stack | the two zone ids | edit the thinner zone so its stack embeds in the thicker one |
| `CMP_ZONES_EQUAL_THICKNESS_CONFLICT` | `generate_plies_from_zones` | equally thick zones with different stacks | zone ids | make their stacks identical or change a ply count |
| `CMP_RAMP_CONFLICT` | `generate_plies_from_zones` (refusal) / `check_layup` (fail) | a ramp does not fit before another boundary or the face edge | location, needed vs available length (mm) | move the zone boundary, lower the ramp ratio (with a reviewer) or reduce the step |
| `CMP_LAMINATE_SINGULAR` | `analyze_laminate` | ABD condition number > 1e12 | stack | add plies in other directions |
| `CMP_KERNEL_REQUIRED` | drape, curved flats | no OCC kernel | — | re-run with `--kernel occt` |
| `CMP_DRAPE_LIMIT_MISSING` | `drape_ply`, `check_producibility` | material has no `lockingAngle` / `warningShear` | material name | enter the fabric's locking angle from a cited source (no default) |
| `CMP_FLAT_OVER_LOCK` | `export_flat_patterns_dxf` | ply has over-lock nodes and `allowOverLock` is not set | ply id, node count | add darts (`split_ply`) and re-drape; or `allowOverLock` (result `reviewRequired`) |
| `CMP_SPLIT_CURVE_INVALID` | `split_ply` | cut curve does not cross the ply boundary twice | `params.curveId` | extend the curve across the ply |
| `CMP_WAIVER_NO_FINDING` | `request_layup_waiver` | no current finding with that code on those ids | `params.code` | run `check_layup` and copy the code |
| `CMP_RULE_R1_SYMMETRY` … `CMP_RULE_R5_OUTER_PM45` | `check_laminate_rules`, `check_layup` (fail) | rule R1..R5 violated | zone / point, plies, value, limit | edit the stack (e.g. mirror it, add the missing −θ, split a run) or request a waiver |
| `CMP_RULE_DISORIENTATION` · `CMP_RULE_DROP_SYMMETRY` | same (fail, V1 rules) | optional rules violated | interface plies | reorder plies |
| `CMP_FPF_RATIO_BELOW_ONE` | `check_layup` (fail) | strength ratio R < 1 for a stored load case | ply, criterion, R | add plies or change angles; acceptance is a human gate |
| `CMP_DRAPE_OVER_LOCK` · `CMP_DRAPE_OVER_WARNING` | `check_producibility`, `check_layup` (fail / warn) | nodes beyond lock / warning shear | ply, counts, regions | add darts or splices, change seed or orientation |
| `CMP_MATERIAL_UNVERIFIED` | `check_layup` (warn, not suppressible) | material basis mean/unknown or uncited source | material name | use a sourced A/B-basis record (08 MAT, NCAMP) |
| `CMP_DEFAULT_USED` | `check_layup` (warn) | a safety-relevant default was applied (F12*, thresholds, ramp ratio) | default name, value, source | give the programme value explicitly |
| `CMP_WAIVER_PENDING` | `check_layup` (attached to a fail) | waiver without a human approval | waiver id | ask the qualified reviewer to approve in 09 PLM |

### 7.2 Result conventions (AF-10, AF-31..35)

- Units: `analyze_laminate` reports `unit: "N-mm-MPa"` (A in N/mm, B in N, D in N·mm, stresses MPa); geometric
  results carry `unit` (document length unit) and angle fields end in `Deg`; masses carry `massUnit`.
- `defaults` lists every `NamedDefault` used (F12* −0.5 source pyfem/Tsai-Wu convention S36; rule thresholds
  "common published guidelines" S15-S17; ramp ratio 20 S16; drape step = bbox/200).
- `unverified` follows the material rule above; `reviewRequired` + `reviewReason` on FPF results, `check_layup`
  with `purpose: "release"`, `allowOverLock` flat patterns and ply-book outputs; `provenance {method,
  reference, inputs}` on every query (e.g. `{method: "CLT", reference: "NASA RP-1351", inputs: {material,
  angles, plyThickness}}`).
- Bounded output: drape nets only with `output: "nodes"` (paged or `--save`); per-ply arrays summarised unless
  requested.

### 7.3 Agent-first compliance

| AF | Where satisfied |
| -- | --------------- |
| AF-01, AF-02 | FR-CMP-60; registry commands with agent-written descriptions (§4) |
| AF-03 | FR-CMP-62 (`llull guide` composites section, prompts) |
| AF-04 | FR-CMP-63; units in every param description (§4 param sketches) |
| AF-05 | plans in `validation/plans/` validate with `--validate` (VC-CMP-34) |
| AF-10, AF-12 | FR-CMP-64, §7.2 |
| AF-11 | FR-CMP-65, §7.1 |
| AF-13 | §8 determinism, TR-CMP-02 |
| AF-20, AF-30 | FR-CMP-20, FR-CMP-66 (`check_layup`, `check_laminate_rules` with `CMP_RULE_*`) |
| AF-21 | FR-CMP-41 (shear per node, counts), FR-CMP-51 (`ply_book_data`), FPF ratios instead of plots |
| AF-22 | `render_view isolate=<part> --save` in FUNCTIONAL §6.1 |
| AF-23 | `expected_results.json` `cli_by_vc`; agent driver |
| AF-31 | FR-CMP-67, `NamedDefault`; no allowable / locking-angle defaults |
| AF-32 | FR-CMP-68 material verification rule |
| AF-33, AF-36 | FR-CMP-69 |
| AF-34 | FR-CMP-71, `request_layup_waiver` + 09 PLM `record_approval` (TR-PLM-16) |
| AF-35 | FR-CMP-72, `provenance` |
| AF-40, AF-42 | §7 CLI bullet, §8 budgets |
| AF-41 | all composites computation is core / bundled OCC; no network |

## 8. Performance and robustness budgets

| Scenario | Budget | Approach |
| -------- | ------ | -------- |
| `analyze_laminate`, 200 plies, 4 loads | ≤ 5 ms | O(N) sums + 6×6 solve |
| `generate_plies_from_zones`, 200 plies, 3 zones | ≤ 2 s including derivation | polygon booleans per ply cached by (zone set, rank) |
| Drape on a hemisphere, ~17 k nodes, OCC | ≤ 500 ms | batched `projectOnFace`, closed form for spheres/planes/cylinders |
| DXF export, 200 plies | ≤ 1 s | streaming string builder |
| Document size | derived geometry not stored | `derivedEntityIds` |
| Robustness | no NaN in outputs | validated inputs, guarded `acos`/`sqrt`, singular-laminate rejection |
| Determinism | identical replay ids and values | fixed iteration order, no `Date.now`, no randomness |

## 9. Test strategy (mapped to VCs)

| Layer | Tests | VCs |
| ----- | ----- | --- |
| `tests/unit/composites/clt.test.ts` | Q, Q̄, ABD, constants, stresses against `clt_reference.json` (loaded as fixture) | VC-CMP-01..05 |
| `tests/unit/composites/failure.test.ts` | closed forms + table values | VC-CMP-06, 07 |
| `tests/unit/composites/notation.test.ts`, `rules.test.ts` | the 10 reference cases + config variants + parse errors | VC-CMP-08, 09 |
| `tests/unit/composites/zones.test.ts` | blending feasibility, ramp offsets, conflicts | VC-CMP-10, 11 |
| `tests/unit/composites/drape.sphere.test.ts` | sphere closed-form oracle (no kernel) vs `drape_reference.json`; Gauss-Bonnet residual; dart split + per-piece re-drape (rotated field) | VC-CMP-12, 13, 33 |
| `server/tests/occtDrape.test.ts` | same hemisphere through the OCC `projectOnFace` path; tolerance per VC | VC-CMP-12, 13 |
| `tests/unit/composites/flatten.test.ts` | cylinder / cone / frustum analytic | VC-CMP-14, 15 |
| `tests/unit/composites/exports.test.ts` | DXF → `import_dxf` → `measure_area`; laser spacing and winding | VC-CMP-16, 17 |
| `tests/unit/composites/*.purity.test.ts` | `is pure` for every mutating command; failure paths (happy + failure per NON-NEGOTIABLE 2) | VC-CMP-20 |
| `tests/golden/plans.ts` | add the 3 plans from `validation/plans/` (id-normalised snapshots + replay equality) | VC-CMP-10, 15, 20 |
| `tests/unit/contract/` | `toToolSchemas()` snapshot includes the toolset; plugin document validate/restore; guards reject edits to derived ply entities | VC-CMP-20, 21 |
| `tests/unit/composites/agentFirst.test.ts`, `tests/unit/contract/` | error codes (one failing plan per family), `unverified` propagation, named defaults, `reviewRequired`, waiver human gate with 09 PLM, units audit | VC-CMP-34..38 |
| production-gate agent driver | runs `cli_by_vc` from `expected_results.json` with `--json` and exit codes only | all |
| `server/tests/` + `desktop/tests/` | CLI `run` of the plans with `--kernel occt`; MCP `build_project` parity | VC-CMP-21 |
| `npm run quality` | timing of VC-CMP-22 on the reference machine | VC-CMP-22 |
| Validation scripts | `python3 generate_*.py --check` in CI (stdlib only) | all derived values |

Technical requirement ids cited by the validation pack (each points to the section that specifies it):

| Id | Requirement | Spec |
| -- | ----------- | ---- |
| TR-CMP-01 | Every mutating command is pure (returns a new document; `is pure` test) | §2 L3 |
| TR-CMP-02 | Step-scoped deterministic ids; plans replay to identical documents | §2 L8, §8 Determinism |
| TR-CMP-03 | Derived ply geometry is listed by `derivedEntityIds`, read-only via derivation guards, regenerated on load | §3, §6.1 |
| TR-CMP-30..36 | CLT and first-ply failure as specified: Q/Q̄/ABD/inverse/constants (30), bottom-to-top stacking and B sign convention (31), ply stresses (32), failure criteria (33), singular-laminate rejection (34), tolerances (35), units (36) | §5.2, §5.3, §5.9 |
| TR-CMP-40 | Kinematic drape on exact faces through optional `GeometryKernel` face queries read from `ctx.kernel` (`requiresKernel`); per-piece re-drape after darts/splices | §5.4, §5.5, §5.7 |
| TR-CMP-41 | Drape self-checks: sphere closed-form oracle, generator symmetry, Gauss-Bonnet residual | §5.4 |
| TR-CMP-60 | Generic DXF writer in `@lib/dxfWrite.ts`, flat-pattern DXF layout | §6.2 |
| TR-CMP-70 | UI, CLI and MCP reach the same registry commands with identical results | §7 |
| TR-CMP-80 | Performance budgets | §8 |
| TR-CMP-81 | Stable error and finding codes with path, ids and remediation | §7.1 |
| TR-CMP-82 | `check_layup` aggregate check, `NamedDefault` reporting, `reviewRequired`, waivers linked to 09 PLM approvals | §4, §7.2 |
| TR-CMP-83 | Material verification rule and `unverified` propagation; `provenance` on every query | §3, §7.2 |
| TR-CMP-84 | Units in every param description and result field; bounded output | §7.2 |

Coverage: `packages/domain-aero/src/**` is added to the 90/85/90/90 gate (NON-NEGOTIABLE 3, which today
names domain-aec; extend the gate config).

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (eng-weeks) |
| --------- | ------- | ---------- | ------------------ |
| M0 Foundations | `domain-aero` package + alias + plugin skeleton; `@lib/dxfWrite` move; `@lib/polygonBoolean` | — | 2 |
| M1 Laminate core (MVP) | materials, rosettes, notation, CLT, failure, rules, `analyze_laminate`, `check_laminate_rules` (no geometry) | M0 | 3 |
| M2 Parts and zones (MVP) | `create_composite_part` (planar faces any kernel; `faceGeometry` on OCC), zones, blending, ramps, core sample, mass, derived outlines, DXF flats for plane/cylinder/cone | M1, 01 KRN face naming | 4 |
| M3 Drape (V1) | kernel face queries (OCC), drape solver, producibility, darts/splices, draped flats | M2, 02 SRF (quality freeform faces) | 5 |
| M4 Shop data (V1) | laser projection, ply book (drawings), ply table CSV, per-ply solids + STEP explicit, FEA sections | M3, 05 FEA (consumer) | 4 |
| M5 AP242 composite (V2) | implicit export + validation properties, import; CAx-IF test | M4, 04 XCH | 6 |
| M6 V2 analysis | LaRC03, hygrothermal, optimiser (agent-assisted) | M1 | 4 |

The total from MVP to V1 is about 18 engineer-weeks. The cross-gap dependencies are 01 KRN (face naming),
02 SRF (freeform faces), 05 FEA (laminate consumer), 08 MAT (allowables library) and 04 XCH (AP242
infrastructure).

## 11. Open questions and decisions needed

1. **Q1 Package.** One `packages/domain-aero` for all aerospace plugins, or `packages/domain-composites`?
   Recommended: `domain-aero`, with one plugin per gap and toolset `composites`.
2. **Q2 Lamina material location.** Should lamina materials live in the composites model, or extend the core
   `Material` (08 MAT)? Recommended: plugin-owned `LaminaMaterial` with an optional link to a core
   `Material` for rendering. 08 MAT may later provide a shared allowables record.
3. **Q3 opencascade.js bindings.** Confirm `GeomAPI_ProjectPointOnSurf`, `BRepClass_FaceClassifier`,
   `BRepLProp_SLProps`, `BRepAdaptor_Surface` accessors and `BRepOffsetAPI_MakeThickSolid` are in the shipped
   build. Otherwise extend the custom build.
4. **Q4 Ply solids.** Should they be a new `ShapeRecipe` node (`ply_solid`, part of `recipeKey`) or a
   plugin-side mesh? Recommended: a recipe node, so STEP stays exact (KI5).
5. **Q5 UD drape.** The pin-jointed net is a fabric model. For UD tape, offer `projection` (rosette
   projection, no shear) as the default and kinematic as an option. Fibersim/CPD follow material-specific
   rules (to be checked against their documentation).
6. **Q6 Sign and stacking conventions.** Bottom to top from the tool side has been chosen (B sign pinned by
   VC-CMP-05). Confirm with users who are used to Jones's or Kaw's top-down numbering. The UI shows the
   convention.
7. **Q7 AP242 entity mapping.** Needs a full read of the CAx-IF composite rec practice v4.4 (only v4.3 metadata
   was reviewed). Assign to 04 XCH.
8. **Q8 Hemisphere numeric benchmark.** Obtain the published kinematic-drape peak shear from the 2022
   benchmark [R9] (full text) to add a quoted (provenance a) value next to the derived 51.9°.

## 12. References

- [R1] A. T. Nettles, Basic Mechanics of Laminated Composite Plates, NASA RP-1351 (1994): https://ntrs.nasa.gov/citations/19950009349 (accessed 2026-10)
- [R2] R. M. Jones, Mechanics of Composite Materials, 2nd ed., Taylor & Francis (1999), catalogue reference; formulas identical to [R1] (accessed 2026-10)
- [R3] pyfem documentation, Tsai-Wu module (default F12 = −0.5√(F11F22)): https://pyfem.readthedocs.io/en/latest/pyfem.materials.TsaiWu.html (accessed 2026-10)
- [R4] C. G. Dávila, P. P. Camanho, Failure Criteria for FRP Laminates in Plane Stress, NASA/TM-2003-212663: https://ntrs.nasa.gov/citations/20040001363 (accessed 2026-10)
- [R5] C. Mack, H. M. Taylor, J. Textile Inst. 47 (1956) T477, cited via Quilliot & Koko, ESAIM M2AN 29(7) 1995: https://www.numdam.org/item/M2AN_1995__29_7_765_0/ (accessed 2026-10)
- [R6] S. D. Howell, H. Ockendon, J. R. Ockendon, Draping woven sheets, ANZIAM J. 62 (2020): https://www.cambridge.org/core/journals/anziam-journal/article/draping-woven-sheets/199B59F4E830E1CBF976C993B4CF2FF3 (accessed 2026-10)
- [R7] É. Ghys, Euler and Chebyshev: from the sphere to the plane and backwards, arXiv:1608.02724: https://arxiv.org/pdf/1608.02724 (accessed 2026-10)
- [R8] Altair HyperWorks, Kinematic Draping Theory / Kinematic Drape Tool: https://help.altair.com/hwdesktop/hwx/topics/user_interface/kinematic_draping_approach_r.htm (accessed 2026-10)
- [R9] X. Sun et al., Dry Textile Forming Simulations: A Benchmarking Exercise, Front. Mater. 9:831820 (2022): https://www.frontiersin.org/journals/materials/articles/10.3389/fmats.2022.831820/full (accessed 2026-10)
- [R10] ASTM D6673-10 (withdrawn 2019): https://store.astm.org/d6673-10.html (accessed 2026-10)
- [R11] Dassault Systèmes partner solution, CATFiber LASER Projection: https://www.3ds.com/partners/products/100000000000429_PDT00000001833_CATFiber_LASER_Projection_CAA_V6_Apps/ (accessed 2026-10)
- [R12] McNeel wiki, Rhino with other programs: https://wiki.mcneel.com/rhino/rhinowithotherprogs (accessed 2026-10)
- [R13] MBx-IF (CAx-IF), Recommended Practices for Composite Materials v4.3: https://www.mbx-if.org/home/wp-content/uploads/2025/10/Rec_Pracs_Composites_V4.3.pdf (accessed 2026-10)
- [R14] MBx-IF, Composite Structure Validation Properties v1.0: https://www.mbx-if.org/home/wp-content/uploads/2026/06/rec_prac_val_prop_composite_v10.pdf (accessed 2026-10)
- [R15] Ansys ACP User's Guide, Oriented Selection Sets: https://ansyshelp.ansys.com/public/Views/Secured/corp/v252/en/acp_ug/acp_oes.html (accessed 2026-10)
- [R16] PTC Creo Composite Design, Draping Simulation: https://support.ptc.com/help/creo/creo_pma/r13/usascii/composite_design/about_draping_simulation.html (accessed 2026-10)

Material data sources (T300/5208, AS4/3501-6) and every other external fact: [`validation/sources.md`](validation/sources.md).
