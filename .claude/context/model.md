# CONTEXT: document & entity schema

Ground-truth reference for `src/core/model/types.ts`. Entities are constructed ONLY
inside `core/commands`.

## Primitives

```ts
type EntityId = string;
type Vec3 = readonly [number, number, number];
type SolidKind = 'box' | 'cylinder' | 'sphere' | 'extrusion';   // the 3D set
```

## Entities (discriminated union on `kind`)

```ts
interface BaseEntity {
  readonly id: EntityId;
  readonly kind: SolidKind;
  position: Vec3;        // world-space origin
  rotation: Vec3;        // Euler radians
  layerId: string;
  color: string;         // hex, e.g. '#c8553d'
}

BoxEntity        : kind:'box';       size: Vec3            // w,h,d
CylinderEntity   : kind:'cylinder';  radius: number; height: number
SphereEntity     : kind:'sphere';    radius: number
ExtrusionEntity  : kind:'extrusion'; profile: ReadonlyArray<readonly [number,number]>; depth: number

type Entity = BoxEntity | CylinderEntity | SphereEntity | ExtrusionEntity;
```

Adding a new solid = add a literal to `SolidKind`, add a `*Entity` interface, add it
to the `Entity` union, then add the command(s) that create/edit it. The viewport must
gain a renderer branch for the new `kind`.

## 2D shapes — PLANNED design (not yet in code; architecture L7)

llull is also a 2D drafting tool. 2D shapes live in the SAME document and command layer
as 3D solids. The model will extend like this (keep the shared `BaseEntity`):

```ts
type Vec2 = readonly [number, number];
type Shape2DKind = 'line' | 'polyline' | 'circle' | 'arc' | 'rectangle' | 'point' | 'text' | 'dimension';
type EntityKind = SolidKind | Shape2DKind;       // SolidKind stays the 3D set

// 2D geometry is LOCAL to the entity's work plane; BaseEntity.position places that
// plane in the shared 3D space (default plane z=0, normal +Z).
interface LineEntity      extends BaseEntity { readonly kind: 'line';      a: Vec2; b: Vec2; }
interface PolylineEntity  extends BaseEntity { readonly kind: 'polyline';  points: ReadonlyArray<Vec2>; closed: boolean; }
interface CircleEntity2D  extends BaseEntity { readonly kind: 'circle';    radius: number; }
interface ArcEntity       extends BaseEntity { readonly kind: 'arc';       radius: number; startAngle: number; endAngle: number; }
interface RectEntity      extends BaseEntity { readonly kind: 'rectangle'; width: number; height: number; }
interface PointEntity     extends BaseEntity { readonly kind: 'point'; }
interface TextEntity      extends BaseEntity { readonly kind: 'text';      value: string; height: number; }
interface DimensionEntity extends BaseEntity { readonly kind: 'dimension'; a: Vec2; b: Vec2; offset: number; }
// Entity union extends to include all of the above.
```

Rules:
- Add `is2D(kind): boolean` / `is3D(kind)` helpers in `model` for branching (viewport
  render, selection filters, view mode).
- `position` is the work-plane origin in 3D; `rotation` orients the plane. Introduce an
  explicit `plane`/work-plane type only when multi-plane sketching is needed.
- A closed `polyline`/profile is the input to `extrude_profile` (and later
  `revolve_profile`). `ExtrusionEntity.profile` already foreshadows this 2D→3D bridge.

## View mode — PLANNED
`CameraState`/the document gains a drafting view mode: orthographic top-down for 2D vs
the current 3D perspective orbit. View mode is presentation only — the entity bag is
shared between the two views.

## Document

```ts
interface CadDocument {
  entities: Record<EntityId, Entity>;
  order: EntityId[];           // z-order / creation order
  layers: Record<string, Layer>;
  layerOrder: string[];
  selection: EntityId[];
  camera: CameraState;
}

interface Layer { readonly id: string; name: string; visible: boolean; locked: boolean; }
interface CameraState { target: Vec3; azimuth: number; polar: number; distance: number; } // spherical orbit

const DEFAULT_LAYER_ID = 'layer-default';
createEmptyDocument(): CadDocument            // one default layer 'Layer 0', empty selection
```

## Parametric model — PLANNED design (architecture L8)

A full CAD stores the recipe, not just geometry. These extend `CadDocument`; keep them
OPTIONAL and incremental (v1 may omit them — history = the undo snapshot stack).

```ts
type ParamValue = number | string | boolean;
interface Parameter  { readonly id: string; name: string; value: ParamValue; expression?: string; unit?: string; }

type ConstraintKind =
  | 'coincident' | 'parallel' | 'perpendicular' | 'tangent' | 'concentric'
  | 'horizontal' | 'vertical' | 'equal'                       // geometric
  | 'distance' | 'angle' | 'radius';                          // dimensional (driving)
interface Constraint { readonly id: string; kind: ConstraintKind; entities: EntityId[]; value?: number; }

// A feature = a recorded command invocation that can be re-evaluated.
interface Feature    { readonly id: string; command: string; params: unknown; suppressed?: boolean; }

interface CadDocument {
  // ...existing fields...
  parameters?: Record<string, Parameter>;
  constraints?: Record<string, Constraint>;
  history?: Feature[];        // ordered feature tree; replaying it (re)builds `entities`
}
```

Rules:
- When `history` is present it is the SOURCE OF TRUTH; `entities` is a DERIVED cache
  produced by replaying `history` (constructive → evaluated). Editing a parameter or a
  feature re-evaluates downstream — done in the store/evaluator, not in each command.
- Constraints reference entities by id; a PURE solver (core/lib, unit-tested) positions
  geometry to satisfy them.
- Commands stay pure and keep the `CommandResult` contract — parametric is layered on top,
  never a rewrite of the command API. See the `parametric` skill.

## Query results — PLANNED (read-only commands)

Measurement/inspection tools don't mutate the document. Extend the result channel:

```ts
interface CommandResult {
  document: CadDocument;   // UNCHANGED for a query
  summary: string;         // factual, with units: "distance = 42.0 mm"
  affected: string[];      // [] for a query
  data?: unknown;          // structured measured value for programmatic agents
}
```

A query returns the unchanged document, `affected: []`, a human/AI `summary`, and the
value in `data`. See the `measure` skill (`measure_distance`, `volume_of`, ...).

## Invariants commands must preserve

- Every `entities[id].id === id` and `id ∈ order`.
- Every `entity.layerId ∈ layers`.
- `selection ⊆ keys(entities)`; deleting an entity removes it from `order` AND `selection`.
- `position`/`rotation` are length-3; `color` is a hex string.
- New entity default layer = `DEFAULT_LAYER_ID` unless a command specifies otherwise.
