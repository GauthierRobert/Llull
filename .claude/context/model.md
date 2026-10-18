# CONTEXT: document & entity schema

Ground-truth reference for `packages/core/src/model/` (`@core/model/*`): `types.ts` (document,
entities), `building.ts` (AEC types). Entities are
constructed ONLY inside commands (core or a plugin).

## Primitives

```ts
type EntityId = string;
type Vec2 = readonly [number, number];          // local work-plane coordinates
type Vec3 = readonly [number, number, number];  // world, right-handed, +Z up
// Each union is derived from one `as const` array (the single source for types, zod enums
// and persistence validation): DOCUMENT_UNITS, SOLID_KINDS, SHAPE2D_KINDS, CONSTRAINT_KINDS.
type DocumentUnit = (typeof DOCUMENT_UNITS)[number];  // 'mm' | 'cm' | 'm' | 'in' | 'ft'
type SolidKind = (typeof SOLID_KINDS)[number];  // 'box' | 'cylinder' | 'sphere' | 'extrusion'
               // | 'mesh' | 'cone' | 'torus' | 'wedge' | 'pyramid' | 'revolution' | 'sweep' | 'loft'
               // | 'subdivision'
type Shape2DKind = (typeof SHAPE2D_KINDS)[number];  // 'line' | 'polyline' | 'arc' | 'circle'
               // | 'rectangle' | 'point' | 'ellipse' | 'spline' | 'text' | 'dimension' | 'image'
type EntityKind = SolidKind | Shape2DKind | 'instance';
```

## Entities (discriminated union on `kind`)

```ts
interface BaseEntity {
  readonly id: EntityId;
  readonly kind: EntityKind;
  position: Vec3;        // world origin (work-plane origin for 2D)
  rotation: Vec3;        // Euler radians
  layerId: string;
  color: string;         // hex, e.g. '#c8553d'
  name?: string; tags?: readonly string[]; materialId?: string;
}

// 3D
BoxEntity        'box'        size: Vec3
CylinderEntity   'cylinder'   radius; height
SphereEntity     'sphere'     radius
ExtrusionEntity  'extrusion'  profile: ReadonlyArray<[number, number]>; depth; curves?: CurveSegment<Vec2>[]  // exact boundary; profile = its tessellation
MeshSolidEntity  'mesh'       mesh: MeshData; brep?: ShapeRecipe  // kernel result: display mesh + exact construction tree
ConeEntity       'cone'       radius; height
TorusEntity      'torus'      ringRadius; tubeRadius
WedgeEntity      'wedge'      size: Vec3
PyramidEntity    'pyramid'    baseWidth; baseDepth; height
RevolutionEntity 'revolution' profile; axis: Vec3; angle; segments; curves?  // same rule as extrusion
SweepEntity      'sweep'      path: CurveSegment<Vec3>[] (local, open, G1); section: {shape:'circle'; radius; innerRadius?} | {shape:'profile'; profile; curves?}; stations?: {at; ring: Vec2[]}[]  // variable section
LoftEntity       'loft'       rings: Vec3[][] (local, SECTION_RING_POINTS each, aligned); ruled
SubdivisionEntity 'subdivision' vertices: Vec3[] (local cage); faces: number[][] (CCW from outside, closed); creases: [a, b][]; levels 0..4  // Catmull-Clark
// 2D (geometry LOCAL to the work plane placed by position/rotation; default z=0, normal +Z)
LineEntity       'line'       start: Vec2; end: Vec2
PolylineEntity   'polyline'   points: Vec2[]; closed
ArcEntity        'arc'        center: Vec2; radius; startAngle; endAngle
CircleEntity     'circle'     center: Vec2; radius
RectangleEntity  'rectangle'  width; height
PointEntity      'point'
EllipseEntity    'ellipse'    center: Vec2; radiusX; radiusY
SplineEntity     'spline'     points: Vec2[]; closed
TextEntity       'text'       content; height; anchor?
DimensionEntity  'dimension'  dimensionKind: 'linear'|'aligned'|'radial'|'diameter'|'angular'; entityIds; offset?; precision?; tolerance?; label?
ImageEntity      'image'      dataUrl (png/jpeg base64); pixelWidth/Height; width/height (units, lower-left at position); opacity; locked — raster underlay, pixel (0,0) = top-left (geometry/imageUnderlay.ts)
// CurveSegment<P> (model/curve.ts): {type:'line', points:[a,b]} | {type:'arc', points:[start,through,end]} | {type:'bezier', points:[p0,p1,p2,p3]}
// Assembly
InstanceEntity   'instance'   componentId; scale?: Vec3
```

`is2D(e)` / `is3D(e)` branch on `kind`. New kind ⇒ add the literal to the `SOLID_KINDS` /
`SHAPE2D_KINDS` array (the unions, `is2D` and persistence validation derive from it), the
`*Entity` interface, the `Entity` union, the command(s) that create it, and a viewport render
branch.

## Document

```ts
interface CadDocument {
  entities: Record<EntityId, Entity>;  order: EntityId[];          // EVALUATED (render/export cache)
  layers: Record<string, Layer>;       layerOrder: string[];
  selection: EntityId[];               camera: CameraState;        // per-client view state
  groups: Record<string, EntityGroup>;
  units: DocumentUnit;                 displayPrecision: number;
  parameters: Record<string, Parameter>;        // { name, expression, value, error? }
  animations: Record<string, Animation>;
  featureHistory: FeatureStep[];                // the recipe (architecture L8)
  nextStepNumber?: number;                      // next step-<n>; absent ⇒ 1; never reused
  configurations: Record<string, Configuration>;
  materials: Record<string, Material>;
  recipes: Record<string, Recipe>;
  components: Record<string, Component>;
  constraints: Record<string, Constraint>;      constraintOrder: string[];
  joints: Record<string, Joint>;                jointOrder: string[];
  driveRelations: Record<string, DriveRelation>; driveRelationOrder: string[];
  building?: BuildingModel;                     // building plugin's constructive model
}

interface FeatureStep {
  readonly id: string;          // 'step-<n>' (step-scoped ids: '<prefix>-<n>.<k>')
  readonly name: string;        // registry command name
  readonly params: unknown;     // as passed; '=expr' strings resolve against parameters on replay
  suppressed?: boolean; label?: string;
  affected?: readonly EntityId[];
}

interface Layer { readonly id: string; name: string; visible: boolean; locked: boolean; color?: string }
interface CameraState { target: Vec3; azimuth: number; polar: number; distance: number } // spherical orbit
const DEFAULT_LAYER_ID = 'layer-default';
createEmptyDocument(): CadDocument   // one default layer 'Layer 0', every table empty
```

Constraint kinds: geometric `coincident | parallel | perpendicular | tangent`, dimensional
`distance | angle`; solved by the pure `solve_constraints` (`commands/parametric/constraintSolver.ts`).
Joints: `revolute | prismatic`.

## Constructive vs evaluated

The document is flat; `entities` + `order` are the evaluated part, everything else (parameters,
`featureHistory`, layers, materials, plugin data such as `building`) is the definition.

```ts
derivedEntityIds(doc): Set<string>   // @core/plugins/host — ids a plugin regenerates from its definition
```

- The definition is the source of truth; evaluated geometry is derivable (replay
  `featureHistory`, plugin derivers). Edit the definition, never derived geometry (derivation
  guards reject it).
- `CommandResult.data` carries query values; queries return the same doc and `affected: []`.

## Persistence (`commands/persistence/serialization.ts`)

Envelope `{ format: 'llull-document', version: 3, document }` (`serializeDocument(doc,
{ includeDerived? })` / `deserializeDocument(json)`, `load_document`). v2+ omits plugin-derived
entities (building) and re-derives them on load (`DocumentExtension.restore`); versions 1 and 2 are
still read and migrated (`migrate2to3`). v3 adds `kernelSettings` (kernel provenance + modelling
tolerances, stamped on save) and `blobs` (sha256-keyed healed B-rep / STEP payloads that `brep`
recipe leaves reference; checked on load: KRN_BLOB_MISSING / KRN_BLOB_HASH_MISMATCH).

## Invariants commands must preserve

- Every `entities[id].id === id` and `id ∈ order`.
- Every `entity.layerId ∈ layers`.
- `selection ⊆ keys(entities)`; deleting an entity removes it from `order` AND `selection`.
- `position`/`rotation` are length-3 finite numbers (execute rejects corrupt results); `color` is hex.
- New entity default layer = `DEFAULT_LAYER_ID` unless a command specifies otherwise.
- `affected` order is deterministic for the same doc + params.

## Building (AEC/BIM) — `CadDocument.building?`

Types in `packages/core/src/model/building.ts` (levels, elements, project info, cost rates).
Commands live in the building / industrial plugins (`packages/domain-aec/src`, `@aec/*`;
industrial in `industrial/`, steel profiles in `steel/`). They edit the model and call
`regenerateBuilding()` (`@aec/building/evaluate/evaluateElements`), which replaces the evaluated entities (ids
`<elementId>:<part>`, tag `bim`). No new entity kinds. Generated entities are read-only (building
derivation guard) and are not stored in v2 files. Guides: `docs/CONSTRUCTION.md`, `docs/INDUSTRIAL.md`.
