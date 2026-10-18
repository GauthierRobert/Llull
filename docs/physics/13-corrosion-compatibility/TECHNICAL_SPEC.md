# PHY-13 — Corrosion & environmental compatibility — Technical spec

Gap id **COR** · Status: specification (no implementation) · Written 2026-10-15
Functional: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md)

---

## 1. Current state in llull

Verified in the repository on 2026-10-15.

| Area | File(s) | Today / after aerospace | Limit for corrosion checks |
| ---- | ------- | ----------------------- | -------------------------- |
| Material | `packages/core/src/model/types.ts` `Material`; `finish?: MaterialFinish` is a **procedural render texture** (carbon_twill, brushed, knurl…), not a protective finish | `materialId` on entities | no galvanic data, no surface treatment |
| 08 MAT record | `model/material.ts` `MaterialRecord` (designation, temper, productForm, `PropertyValue[]` with direction L/LT/ST) | fastener catalogue grammar has material and finish codes (08 FR-MAT-11; sample NAS1149 `…P` = cadmium plated) | no rule uses them |
| 08 fastener stacks | `@aero` `FastenerStack { layers[{entityId, thickness}], fastener, washers[{side}], nut }` (08 §3.4) | stack topology known | source of fastener contacts |
| Clash (AEC) | `packages/domain-aec/src/industrial/clash/clash.ts` `check_clashes` | oriented-box separating-axis test between **building** elements (pipes, equipment, members); skips intentional joints | building model only; reports penetration depth, no contact faces |
| Motion | `packages/core/src/commands/motion/motionStudy.ts` | optional AABB interference flags between instances per step | AABB only, instances only |
| Bounds | `packages/core/src/geometry/bounds.ts` `entityBoundsInDoc` (rotated entities: AABB of the rotated OBB, `oriented: true`); `geometry/instanceExpansion.ts` `expandInstance` | broad phase available | no narrow phase |
| Kernel | `geometry/kernel.ts` `GeometryKernel { supports, evaluate, tessellate, topology, exportStep }`; `geometry/shapeRecipe.ts` boolean `union \| subtract \| intersect` | interference volume = volume of an `intersect` recipe | no distance / contact-area query; 01 KRN adds `faceQuery` (incl. point→shape `distance`) and exact `massProperties` |
| Inspect | `commands/inspect/` `check_model`, `mass_properties`, `measure_*`, `find_entities` | `check_model` issues have `code` strings | no contact query |

No `galvanic`, `corrosion` or `contact` command exists (`grep -rliw "galvanic\|corrosion\|find_contacts" packages src server/src` → nothing).

## 2. Target architecture

### 2.1 Placement (proposal, pending README §5.1)

| Concern | Layer | Why |
| ------- | ----- | --- |
| `find_contacts` (generic "which solids touch / interfere") | **core** `packages/core/src/commands/inspect/contacts.ts`, registered in `inspect/catalog.ts`, toolset `measure` | Generic CAD query used by COR, PHY-06 contact set-up and assembly checks; not domain knowledge (L10 decision shortcut: generic capability) |
| Contact narrow phase (closed form) | `packages/core/src/geometry/contacts.ts` (pure) | geometry layer, below commands (L2 inside core) |
| Exact proximity | **addition to the 01 KRN kernel interface**: optional `GeometryKernel.proximity?: ProximityPort` (§3.4), OCC implementation in `packages/kernel-occt/src/occtProximity.ts` | Kernel only through `ctx.kernel` (L9); 01 KRN owns the interface |
| Property names `galvanicGroup`, `anodicIndex`, `sccClass` | **additions to the 08 MAT `MaterialPropertyName` list** | README §6.2 |
| Rule tables (anodic index, limits, 889D matrix, SCC classes, HE, remedies) | `packages/domain-physics/data/corrosion/*.json` + `sources.lock.json` | data, AF-30; plugin |
| Surface systems, isolations, environment | plugin document slice `physics.corrosion` via `DocumentExtension` | plugin data, never in core types |
| Commands `check_material_compatibility`, `list_compatibility_rules`, `assign_surface_system`, `declare_isolation`, `set_service_environment` | `@phys/corrosion/commands/`, `CadPlugin { name: 'corrosion', toolset: 'corrosion' }` | L10 |
| Fastener-stack contacts | read `doc.aero.stacks` (08 plugin data) as plain data; no `@aero` import | plugins compose through document data / `execute` |

### 2.2 Technical requirements

| Id | Pri | Requirement | FR |
| -- | --- | ----------- | -- |
| TR-COR-01 | MUST | Broad phase: `entityBoundsInDoc` AABB per solid (instances expanded with `expandInstance`, each child with its world transform and material), inflated by `tolerance`; sort-and-sweep on x; O(N log N + k). Model-scale assemblies may use the native `llull-bvh` broad phase instead (§2.3); the candidate set must be identical | FR-COR-01, 02 |
| TR-COR-02 | MUST | Narrow phase dispatch: (a) both unrotated `box` ⇒ closed form §5.1; (b) kernel with `proximity` ⇒ exact §5.2; (c) kernel without `proximity` ⇒ interference volume from an `intersect` recipe + `distance` from 01 `faceQuery` samples, contact area `null`, `approximate: true`; (d) no kernel ⇒ AABB result `approximate: true`, kind `possible` | FR-COR-01, 02 |
| TR-COR-03 | MUST | Classification: `interference` (overlap volume > tol³), `face` (gap ≤ tol and contact area > tol²), `edge`, `vertex`, with `gapMm`, `areaMm2`, `volumeMm3` in document units plus unit suffix | FR-COR-01 |
| TR-COR-04 | MUST | Fastener stacks yield contacts `fastener↔layer[i]`, `layer[i]↔layer[i+1]`, `washer↔adjacent layer`, `nut↔washer` (or nut↔last layer), tagged `source: "stack"`; geometric duplicates are merged with the stack pair | FR-COR-03 |
| TR-COR-05 | MUST | Galvanic group resolution: surface system outer metallic layer → material `anodicIndex` override → material `galvanicGroup` → none (`COR_GROUP_MISSING`) | FR-COR-05, 15, 16 |
| TR-COR-06 | MUST | Anodic screening §5.3 with limits table; ties (Δ = limit) are compatible (≤) | FR-COR-05 |
| TR-COR-07 | SHOULD | 889D lookup §5.4 from `galvanic_889d_matrix.json` locked by sha256; missing table or cell ⇒ code | FR-COR-04 |
| TR-COR-08 | MUST | Exposed area per part: kernel surface area minus contact area (V1), or closed-form box area (MVP); Aa/Ac in data | FR-COR-07 |
| TR-COR-09 | MUST | CFRP rule: material is a 06 `LaminaMaterial` with carbon fibre form, or `galvanicGroup: graphite` ⇒ rule COR-R-04 against any aluminium group | FR-COR-08 |
| TR-COR-10 | MUST | Isolation lookup by unordered pair key or part id; matches any contact between the pair | FR-COR-09 |
| TR-COR-11 | SHOULD | HE: Ftu resolved through 08 (`basis` kept) ≥ threshold, surface system class `metallic_plating` or `acid_process` | FR-COR-10 |
| TR-COR-12 | SHOULD | SCC: key `(designation, temper, productForm?, direction)`; direction from 08 PropertyValue direction / part grain axis (06-like rosette not needed: an optional `grainAxis` per part in the slice); ST tensile stress from 05 results when current | FR-COR-11 |
| TR-COR-13 | MUST | Every item: `code`, `status`, `ruleId`, `ruleGrade`, `source`, `inputs`, `remedies[]`, `unverified`, `reviewRequired: true`, `reviewReason` | FR-COR-12, 17 |
| TR-COR-14 | MUST | Mutating commands pure, one FeatureStep each, ids step-scoped (`iso-<step>.<k>`), replay-identical | FR-COR-09, 15 |
| TR-COR-15 | MUST | Human gate: `accept_corrosion_item { itemKey, decision, justification, signature }` verifies a human-held signature through the 09 port; agent callers get `COR_HUMAN_GATE` | FR-COR-17 |

### 2.3 Stack amendment (RS1, 2026-10-18)

Decision [RS1](../../decisions/RS1-native-compute.md) step **RS-6** (medium for this pack) adds one option: for model-scale
assemblies the `find_contacts` **broad phase** can run on the shared Rust crate `llull-bvh` (`llull-compute geomq`, Rust CPU,
deterministic build), reached through the same injected batch port as PHY-21 (`GeometryQueryEngine`, PHY-21 TR-FPR-19). Only
candidate pairs come back. Unchanged: the TS sort-and-sweep stays the default and the reference; the exact phase stays OCC
(§5.2); closed forms stay TS; nothing in `packages/*` imports native code. Planned check: VC-COR-17.

## 3. Data model

### 3.1 Contacts (core result type, `geometry/contacts.ts`)

```ts
export type ContactKind = 'interference' | 'face' | 'edge' | 'vertex' | 'possible';
export interface ContactPair {
  readonly a: string; readonly b: string;              // entity ids; instance children as "<instanceId>/<childId>"
  readonly kind: ContactKind;
  readonly gap: number; readonly area: number | null; readonly volume: number | null;   // document units
  readonly normal?: Vec3;                              // face contacts, from a toward b
  readonly materials: readonly [string | null, string | null];
  readonly source: 'closed_form' | 'kernel_exact' | 'kernel_partial' | 'aabb' | 'stack';
  readonly approximate: boolean;
}
```

### 3.2 Rule tables (plugin data, `data/corrosion/`)

```ts
export interface AnodicGroup { readonly id: string; readonly description: string; readonly anodicIndexV: number | null;
  readonly status: 'verified' | 'secondary' | 'tbd'; readonly source: string }
export interface AnodicLimit { readonly environment: 'harsh' | 'normal' | 'controlled'; readonly maxDifferenceV: number; readonly source: string }
export interface Galvanic889Matrix {                 // transcribed from MIL-STD-889D, sha256-locked
  readonly standard: 'MIL-STD-889D'; readonly transcribedBy: string; readonly checkedBy: string;
  readonly materials: readonly { readonly id: string; readonly description: string }[];
  readonly cells: Readonly<Record<string /* anode|cathode */, number /* mil/yr */>>;
  readonly compatibleBelowMilPerYear: number;       // 0.009 (S2, secondary)
}
export interface SccClassRow { readonly designation: string; readonly temper?: string; readonly productForm?: string;
  readonly direction?: 'L' | 'LT' | 'ST'; readonly table: 'I' | 'II' | 'III'; readonly standard: string; readonly locator: string }
```

Initial content = `validation/galvanic_anodic_index.csv`, `anodic_index_limits.csv`, `compatibility_rules.json`,
`scc_classes.json` (889D cells and SCC rows `tbd` until transcribed and reviewed).

### 3.3 Plugin document slice (`CadDocument.physics.corrosion`, via `DocumentExtension`)

```ts
export type SurfaceSystemClass = 'none' | 'anodize' | 'conversion_coating' | 'metallic_plating' | 'acid_process' | 'primer' | 'paint';
export interface SurfaceSystem {
  readonly id: string;                                 // "ss-<step>.<k>"
  readonly entityIds: readonly string[];
  readonly layers: readonly { readonly class: SurfaceSystemClass; readonly spec?: string; readonly galvanicGroup?: string }[];  // inner → outer
}
export interface Isolation {
  readonly id: string; readonly pair?: readonly [string, string]; readonly entityId?: string;
  readonly method: 'sealant_faying' | 'sealant_wet_install' | 'primer' | 'conversion_coating' | 'glass_isolation_ply' | 'isolating_washer_or_tape';
  readonly spec?: string; readonly note?: string;
  readonly accepted?: { readonly by: string; readonly signatureId: string };   // set only by the human gate
}
export interface CorrosionModel {
  readonly environment?: { readonly scheme: 'anodic_index' | 'mil_std_889d'; readonly value: 'harsh' | 'normal' | 'controlled' | 'artificial_seawater' };
  readonly surfaceSystems: Readonly<Record<string, SurfaceSystem>>;
  readonly isolations: Readonly<Record<string, Isolation>>;
  readonly grainAxes?: Readonly<Record<string /* entityId */, { readonly L: Vec3; readonly LT: Vec3 }>>;
  readonly acceptances: Readonly<Record<string /* itemKey */, { readonly decision: 'accepted' | 'rejected'; readonly signatureId: string }>>;
}
```

Document version: rides the aerospace v3 envelope; the optional `physics` slice is an addition listed for
`migrate2to3` (absent ⇒ empty), never its own migration (README §6.2).

### 3.4 Kernel proximity port (proposed addition to 01 KRN TR-KRN-90 family)

```ts
export interface ProximityPort {
  /** Minimum distance between two shapes and the witness points (OCC BRepExtrema_DistShapeShape). */
  minDistance(a: ShapeHandle, b: ShapeHandle): { readonly distance: number; readonly pointA: Vec3; readonly pointB: Vec3 } | null;
  /** Area of face pairs closer than tol (coincident planar/cylindrical faces): BRepAlgoAPI_Common of faces, BRepGProp::SurfaceProperties. */
  contactArea(a: ShapeHandle, b: ShapeHandle, tol: number): { readonly area: number; readonly normal?: Vec3 } | null;
  /** Volume of the boolean common (interference). */
  commonVolume(a: ShapeHandle, b: ShapeHandle): number | null;
}
export interface GeometryKernel { /* … */ readonly proximity?: ProximityPort }
```

OCC classes to add to the 01 KRN binding list: `BRepExtrema_DistShapeShape`, `BRepAlgoAPI_Common`,
`BRepGProp::VolumeProperties`, `BRepGProp::SurfaceProperties` (names from the OCCT public API; to verify in the
bundled opencascade.js build, as 08 did for its classes).

### 3.5 08 property-name additions

| Property | Value | Notes |
| -------- | ----- | ----- |
| `galvanicGroup` | string key (`aluminium_wrought_other` …), unit `-` | provenance required |
| `anodicIndex` | V | overrides the group value; its own source |
| `sccClass` | `{ table: 'I'\|'II'\|'III', direction?, standard, locator }` | structured PropertyValue payload (08 owns the shape) |

## 4. Commands

| Command | Where / kind | Params sketch | Tags |
| ------- | ------------ | ------------- | ---- |
| `find_contacts` | core inspect, query (`readOnly`, `idempotent`) | `{ entityIds?: string[], tolerance?: { value, unit }, includeStacks?: boolean (default true), nearMissFactor?: number }` | `@affects none; data = { pairs: ContactPair[], nearMisses[], tolerance: {value, unit, defaulted, source} }` `@invariant deterministic order (a < b, then kind); same doc back` `@failure unknown id → COR_ENTITY_NOT_FOUND; tolerance ≤ 0 → COR_TOLERANCE_INVALID` |
| `set_service_environment` | plugin, mutating | `{ scheme: 'anodic_index'\|'mil_std_889d', environment }` | `@affects physics.corrosion.environment` `@failure environment not valid for scheme → no-op COR_ENVIRONMENT_INVALID` |
| `assign_surface_system` | plugin, mutating | `{ entityIds, layers: [{class, spec?, galvanicGroup?}] }` | `@affects physics.corrosion.surfaceSystems` `@invariant one system per entity (replaces)` `@failure metallic_plating without galvanicGroup → COR_GROUP_MISSING; unknown entity → no-op` |
| `declare_isolation` | plugin, mutating | `{ pair?: [id, id], entityId?, method, spec?, note? }` | `@affects physics.corrosion.isolations` `@failure neither pair nor entityId → COR_ISOLATION_TARGET_MISSING` |
| `remove_isolation` | plugin, mutating | `{ id }` | `@affects physics.corrosion.isolations` |
| `list_compatibility_rules` | plugin, query | `{ ruleId? }` | returns rule rows with source, grade, status (AF-30, AF-35) |
| `check_material_compatibility` | plugin, query (AF-20; composes `find_contacts` via `execute`) | `{ entityIds?, tolerance?, scheme?: 'anodic_index'\|'mil_std_889d', heThreshold?: {value, unit} }` | `@affects none; data = { status, environment, items: CompatibilityItem[], counts }` `@invariant every contacting pair yields exactly one galvanic item; every part with a resolvable alloy yields SCC/HE items when rules apply` `@failure environment unset → COR_ENVIRONMENT_UNSET (exit 1)` |
| `accept_corrosion_item` | plugin, mutating, **human gate** | `{ itemKey, decision, justification, signature }` | `@affects physics.corrosion.acceptances` `@invariant signature verified through the 09 port` `@failure agent caller / invalid signature → COR_HUMAN_GATE` |

```ts
export interface CompatibilityItem {
  readonly key: string;                                // "galvanic:<a>|<b>", "scc:<id>", "he:<id>"
  readonly status: 'pass' | 'pass_isolated' | 'warn' | 'fail' | 'unknown';
  readonly code: string; readonly ruleId: string; readonly ruleGrade: 'A' | 'B' | 'C';
  readonly ids: readonly string[];
  readonly inputs: Record<string, unknown>;            // groups, indices, ΔV or mil/yr, areas, Ftu, temper, direction
  readonly remedies: readonly { readonly id: string; readonly spec: string; readonly source: string }[];
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: true; readonly reviewReason: string;
  readonly acceptance?: { readonly decision: 'accepted' | 'rejected'; readonly signatureId: string };
}
```

## 5. Algorithms

### 5.1 Closed-form contacts (unrotated boxes)

Per axis k: signed overlap oₖ = min(maxAₖ, maxBₖ) − max(minAₖ, minBₖ). If all oₖ > tol ⇒ interference,
V = o₀o₁o₂. Else gap = max(0, −min oₖ); gap > tol ⇒ none. Otherwise count touching axes (oₖ ≤ tol): one ⇒
face, area = product of the two other overlaps, normal along the touching axis; two ⇒ edge; three ⇒ vertex.
Reference values: plate/block cases in `expected_results.json` VC-COR-01 (1800 mm² face, 900 mm³
interference, 100 mm² partial side face, edge-only, gap 0.05 within / 0.2 outside tol 0.1 mm).

### 5.2 Exact contacts (kernel)

For each candidate pair: `commonVolume > tol³` ⇒ interference; else `minDistance ≤ tol` ⇒ contact, then
`contactArea(tol)` gives the face area (0 ⇒ edge/vertex by witness-point topology, reported as `edge`).
Cylindrical shank-in-hole contacts from geometry are merged with stack contacts (TR-COR-04).
Tolerance default: 0.0025 mm (1e-4 in), the 08 §5.3 stack contact tolerance, reported `defaulted: true`.

### 5.3 Anodic-index screening (rule COR-R-02)

Groups g₁, g₂ with indices AI₁, AI₂ (V): anode = argmax AI; Δ = |AI₁ − AI₂|; compatible iff Δ ≤ limit(env).
Examples (B): 7075 (0.90) / Cd plate (0.95): Δ 0.05, Cd anodic, compatible in all; 7075 / Ti group (0.30):
Δ 0.60, incompatible even controlled (0.50); 2024 (0.75) / Ti: Δ 0.45, compatible only controlled
(VC-COR-02). Every item carries `rule: "anodic_index (non-889 rule of thumb)"` and warning
`COR_SCREENING_RULE_ONLY`.

### 5.4 MIL-STD-889D lookup (rule COR-R-01)

Cell (anode, cathode) → rate r (mil/yr); if the cell is empty, swap roles (the standard's convention, S2).
r < 0.009 mil/yr (= 0.2286 µm/yr) ⇒ compatible category 0; otherwise incompatible with r reported. The item
quotes the scope: 1:1 area, artificial seawater, not a risk rating, not a protection level (S2, S3). Missing
table ⇒ `COR_889_TABLE_MISSING`; missing material ⇒ `COR_889_MATERIAL_MISSING`.

### 5.5 Area ratio (rule COR-R-03)

Aa, Ac = exposed (wetted) areas = surface area − contact area of each member. Ratio Aa/Ac < 1 ⇒
`COR_SMALL_ANODE` (warning, directional rule, no numeric limit; a company limit can be supplied and is then
named). Closed-form check: 4500/13000 = 0.346154 (VC-COR-03).

### 5.6 SCC and HE

SCC row lookup exact on (designation, temper, form, direction) with fallbacks only to rows that state "all
directions"; Table I ⇒ pass, II ⇒ `COR_SCC_MODERATE` (warn), III ⇒ `COR_SCC_LOW_RESISTANCE` (fail until a human
acceptance), none ⇒ `COR_SCC_UNCLASSIFIED` (warn). HE: steel family, Ftu ≥ 180 ksi (1241.056 MPa) and a
`metallic_plating` / `acid_process` layer ⇒ `COR_HE_RISK` (VC-COR-05, 06).

### 5.7 Tolerances

Closed-form areas/volumes rel 1e-9; exact kernel areas rel 1e-6 (OCC); ΔV comparisons with an absolute guard
1e-12 V.

## 6. Interop & persistence

- Rule files: JSON/CSV in `packages/domain-physics/data/corrosion/`, `sources.lock.json` with sha256 of the
  transcribed 889D matrix and SCC table and the primary PDFs (as 08 TR-MAT-41). MIL-STD-889D and
  MSFC-STD-3029A are public US Government documents (licence flag `public-domain-us-gov` once the
  distribution statement is confirmed from the PDF, OQ-COR-02).
- Report: `--save corrosion.csv` columns: key, status, code, a, b, materials, surface systems, rule, grade, Δ or
  rate, remedies, acceptance.
- STEP: no mapping (finish callouts belong to 03 GDT notes / AP242 PMI, out of scope).

## 7. Surfaces and codes

CLI: registry commands only (AF-01); `llull guide` gains a corrosion section (schemes, environments, why
anodic index is screening only). MCP toolsets: `measure` (`find_contacts`), `corrosion` (rest). UI: contact
overlay and acceptance dialog (human gate).

### 7.1 Stable codes (AF-11)

| Code | Severity | When | Ids | Remediation |
| ---- | -------- | ---- | --- | ----------- |
| `COR_ENTITY_NOT_FOUND` | error | unknown id | id | `find_entities` |
| `COR_TOLERANCE_INVALID` | error | tolerance ≤ 0 or unit not a length | param | positive length |
| `COR_ENVIRONMENT_UNSET` | error | check without environment | — | `set_service_environment` |
| `COR_ENVIRONMENT_INVALID` | error | value not valid for the scheme | param | see `list_compatibility_rules` |
| `COR_MATERIAL_MISSING` | unknown | contacting part without material | entity | `assign_material` |
| `COR_GROUP_MISSING` | unknown | material/plating without galvanic group | material | `set_material_property galvanicGroup=…` |
| `COR_GROUP_VALUE_MISSING` | unknown | group has no anodic index (graphite) | group | use 889D or the CFRP rule |
| `COR_GALVANIC_INCOMPATIBLE` | fail | Δ > limit or 889D rate ≥ threshold | pair | isolate (remedies) or change material |
| `COR_SCREENING_RULE_ONLY` | warning | verdict from anodic index | pair | transcribe/use 889D for flight hardware |
| `COR_889_TABLE_MISSING` | unknown | 889D scheme without a transcribed matrix | — | import the reviewed matrix |
| `COR_889_MATERIAL_MISSING` | unknown | material not in the matrix | material | map the material to an 889D row |
| `COR_SMALL_ANODE` | warning | anode exposed area < cathode area | pair | make the fastener/small part cathodic or isolate |
| `COR_CFRP_ALUMINIUM` | fail | carbon composite on aluminium, no isolation | pair | glass ply / sealant / primer, `declare_isolation` |
| `COR_ISOLATION_TARGET_MISSING` | error | `declare_isolation` without target | — | give `pair` or `entityId` |
| `COR_HE_RISK` | warning | high-strength steel with plating / acid process | entity | plating process control and bake per company spec |
| `COR_SCC_MODERATE` | warning | Table II | entity | approval per MSFC-STD-3029A |
| `COR_SCC_LOW_RESISTANCE` | fail | Table III | entity | change temper (e.g. overaged) or obtain approval |
| `COR_SCC_UNCLASSIFIED` | warning | no SCC row | entity | transcribe the row / classify |
| `COR_CONTACT_APPROXIMATE` | info | AABB or partial kernel path | pair | run on the desktop OCC kernel |
| `COR_VALUE_UNVERIFIED` | warning (not suppressible) | B-grade rule value or typical material data used | rule / material | verify against the primary source |
| `COR_HUMAN_GATE` | error | acceptance attempted by an agent / no valid signature | item | ask the qualified reviewer |

### 7.2 Agent-first compliance

AF-01–05: registry commands, units in params (`tolerance {value, unit}`), plans in `validation/plans/`. AF-10/12/13:
`data` shapes §3–4, CSV via `--save`, deterministic pair order. AF-11: §7.1. AF-20: `check_material_compatibility`.
AF-21: contact areas, ΔV, rates and area ratios as numbers. AF-22: `render_view` with contact overlay (V1).
AF-30: rule tables with sources. AF-31: tolerance and HE threshold named. AF-32/33: `unverified`, `reviewRequired`
on every item. AF-34: `accept_corrosion_item` human gate. AF-35/36: `inputs`, rule id, source; plain summary.
AF-41/42: offline; mutating commands pure (dry-run).

## 8. Performance budgets

| Operation | Budget |
| --------- | ------ |
| `find_contacts` 1,000 unrotated boxes (closed form) | ≤ 2 s (sweep and prune) |
| `find_contacts` 200 exact OCC solids, ~400 candidate pairs | ≤ 30 s, cached by recipeKey pair |
| `check_material_compatibility` on 10⁴ fastener stacks (stack contacts, no geometry) | ≤ 1 s |
| `find_contacts` broad phase, model-scale assembly on `llull-bvh` (RS1) | size and wall time TBD — measure (VC-COR-17) |

## 9. Test strategy

| Level | Location | Covers |
| ----- | -------- | ------ |
| Unit (core) | `tests/unit/inspect/contacts.test.ts` | VC-COR-01 closed-form cases, instance expansion, determinism, `is pure` |
| Unit (plugin) | `tests/unit/physics/corrosion/*.test.ts` | screening VC-COR-02, area ratio VC-COR-03, thresholds VC-COR-04/05, HE VC-COR-06, CFRP and isolation VC-COR-07/08, missing data VC-COR-09…11, stack contacts VC-COR-12 |
| Contract | `tests/unit/contract/` | toolsets, schema snapshot, `DocumentExtension` validate/restore round trip |
| Server (OCC) | `server/tests/occtProximity.test.ts` | exact area/volume = closed form on boxes (rel 1e-6); rotated boxes |
| Golden | `tests/golden/plans.ts` | `galvanic_plate_check` plan, id-normalised |
| Quality gate | `npm run quality` | `generate_corrosion_reference.py --check`; rule files hash-locked |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| M1 | core `find_contacts` closed form + AABB + instances | — | 3 d |
| M2 | plugin slice, environment, surface systems, isolations, anodic screening, CFRP, area ratio, check command, codes | M1; 08 M2 (records) | 5 d |
| M3 | stack contacts | 08 M6 | 1 d |
| M4 | kernel proximity port (OCC) | 01 KRN M2/M10 | 4 d |
| M5 | 889D matrix transcription + review + lookup; SCC table transcription + lookup; HE | human access to the standards; M2 | 5 d (+ reviewer time) |
| M6 | human-gate acceptance (09 port), CSV report | 09 | 2 d |
| RS-6 | optional native broad phase on `llull-bvh` through the PHY-21 port, VC-COR-17 | M1, PHY-21 RS-6 row, RS-0 | 2 d (share of RS1 RS-6) |

MVP (M1–M3) ≈ 9 d; V1 (M4–M6) ≈ 11 d.

## 11. Open questions

| Id | Question | Proposed default |
| -- | -------- | ---------------- |
| OQ-COR-01 | Should `find_contacts` live in core (generic, proposed) or in `@phys`? PHY-06 contact set-up also needs it. | Core inspect |
| OQ-COR-02 | Distribution statement of MIL-STD-889D and MSFC-STD-3029A PDFs (public release?) before bundling transcriptions | Confirm from the PDFs; until then user-imported |
| OQ-COR-03 | Is an organic coating (primer/paint) ever counted as isolation automatically? | No; only by `declare_isolation` |
| OQ-COR-04 | Area-ratio numeric limit: none found in sources | Directional warning only; company limit optional |
| OQ-COR-05 | Default HE threshold: 180 ksi (NAS672 scope) vs 220 ksi (historical Cd restriction) | 180 ksi (more conservative), named |
| OQ-COR-06 | Graphite anodic index sign convention (Misumi +0.25) | Not used; CFRP rule instead |
| OQ-COR-07 | Environment zones in V2: region volumes or per-part tags? | Per-part tags first |

## 12. References

See FUNCTIONAL_SPEC §11 [R1]–[R15] and `validation/sources.md` [S1]–[S19]. Additionally:

- [T1] 01 KRN TECHNICAL_SPEC §5.9 `FaceQueryPort` (kernel interface owner) — `docs/aerospace/01-exact-brep-kernel/TECHNICAL_SPEC.md`
- [T2] 08 MAT TECHNICAL_SPEC §3.4 `FastenerStack`, §5.3 contact tolerance — `docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md`
- [RS1] Native compute programme — [`../../decisions/RS1-native-compute.md`](../../decisions/RS1-native-compute.md) (step RS-6)
- [T3] Open CASCADE Technology reference (BRepExtrema_DistShapeShape, BRepAlgoAPI_Common, BRepGProp) — https://dev.opencascade.org/doc/refman/html/ (not fetched; class names to verify against the bundled build)
