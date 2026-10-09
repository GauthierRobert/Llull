/** Domain model — the single source of truth for a CAD document; changed only by commands. */

import type { MeshData } from '../geometry/kernel';
import type { ShapeRecipe } from '../geometry/shapeRecipe';
import type { BuildingModel } from './building';
import type { CivilModel } from './civil';
export type { MeshData };

export type EntityId = string;

export type Vec3 = readonly [number, number, number];

/** 2D coordinate in a local work plane. */
export type Vec2 = readonly [number, number];

export const DOCUMENT_UNITS = ['mm', 'cm', 'm', 'in', 'ft'] as const;

export type DocumentUnit = (typeof DOCUMENT_UNITS)[number];

export const SOLID_KINDS = [
  'box',
  'cylinder',
  'sphere',
  'extrusion',
  'mesh',
  'cone',
  'torus',
  'wedge',
  'pyramid',
  'revolution',
] as const;

export type SolidKind = (typeof SOLID_KINDS)[number];

/** 2D drafting kinds. Geometry is LOCAL to the work plane; BaseEntity.position places that plane in 3D. */
export const SHAPE2D_KINDS = [
  'line',
  'polyline',
  'arc',
  'circle',
  'rectangle',
  'point',
  'ellipse',
  'spline',
  'text',
  'dimension',
] as const;

export type Shape2DKind = (typeof SHAPE2D_KINDS)[number];

export type EntityKind = SolidKind | Shape2DKind | 'instance';

export interface BaseEntity {
  readonly id: EntityId;
  readonly kind: EntityKind;
  /** World-space origin (work-plane origin for 2D entities). */
  position: Vec3;
  /** Euler rotation in radians. */
  rotation: Vec3;
  layerId: string;
  /** Hex color, e.g. "#c8553d". */
  color: string;
  /** Set by `set_entity_name`. */
  name?: string;
  /** Set by `set_entity_name`; filtered by `find_entities`. */
  tags?: readonly string[];
  /** Key into `CadDocument.materials`; set by `assign_material`. */
  materialId?: string;
}

export interface BoxEntity extends BaseEntity {
  readonly kind: 'box';
  /** [width, height, depth]. */
  size: Vec3;
}

export interface CylinderEntity extends BaseEntity {
  readonly kind: 'cylinder';
  radius: number;
  height: number;
}

export interface SphereEntity extends BaseEntity {
  readonly kind: 'sphere';
  radius: number;
}

/** Closed XY polygon extruded along Z. */
export interface ExtrusionEntity extends BaseEntity {
  readonly kind: 'extrusion';
  profile: ReadonlyArray<readonly [number, number]>;
  depth: number;
}

/**
 * Triangle mesh in world space (`position` is [0,0,0]): boolean/fillet/chamfer results, imports, plugin geometry.
 * @invariant `brep`, when present, is the exact construction tree the kernel tessellated into `mesh`
 *   (before `position`/`rotation`); a command that rewrites `mesh` must rewrite or drop `brep`
 */
export interface MeshSolidEntity extends BaseEntity {
  readonly kind: 'mesh';
  mesh: MeshData;
  /** Exact shape recipe of a kernel result; absent for imported / triangle-only meshes. */
  brep?: ShapeRecipe;
}

/** Base circle in XY centered at `position`, apex at +Z. */
export interface ConeEntity extends BaseEntity {
  readonly kind: 'cone';
  radius: number;
  height: number;
}

/** Centered at `position`; valid when 0 < tubeRadius < ringRadius. */
export interface TorusEntity extends BaseEntity {
  readonly kind: 'torus';
  /** Major radius: center to tube center. */
  ringRadius: number;
  /** Minor radius: tube cross-section. */
  tubeRadius: number;
}

/** Right-triangular ramp: full height at z=0, tapering to zero at z=depth. `position` is the lower-front-left corner. */
export interface WedgeEntity extends BaseEntity {
  readonly kind: 'wedge';
  /** [width (X), height (Y), depth (Z)], all > 0. */
  size: Vec3;
}

/** Rectangular base centered at `position` (±baseWidth/2 in X, ±baseDepth/2 in Y), apex at +Z. */
export interface PyramidEntity extends BaseEntity {
  readonly kind: 'pyramid';
  baseWidth: number;
  baseDepth: number;
  height: number;
}

/**
 * Closed profile revolved about `axis` through `position`; profile points are [radialOffset, axialOffset].
 * @invariant profile.length >= 3
 * @invariant 0 < angle <= 2π
 * @invariant segments >= 3
 * @see revolve_profile
 */
export interface RevolutionEntity extends BaseEntity {
  readonly kind: 'revolution';
  profile: ReadonlyArray<readonly [number, number]>;
  /** Unit vector in local entity space. */
  axis: Vec3;
  /** Sweep in radians; 2π = full revolution. */
  angle: number;
  /** Radial tessellation subdivisions. */
  segments: number;
}

export interface LineEntity extends BaseEntity {
  readonly kind: 'line';
  start: Vec2;
  end: Vec2;
}

export interface PolylineEntity extends BaseEntity {
  readonly kind: 'polyline';
  /** Minimum 2 points. */
  points: ReadonlyArray<Vec2>;
  closed: boolean;
}

export interface ArcEntity extends BaseEntity {
  readonly kind: 'arc';
  center: Vec2;
  radius: number;
  /** Radians, counter-clockwise from +X. */
  startAngle: number;
  endAngle: number;
}

export interface CircleEntity extends BaseEntity {
  readonly kind: 'circle';
  center: Vec2;
  radius: number;
}

/** Origin at the lower-left corner; width along +X, height along +Y. */
export interface RectangleEntity extends BaseEntity {
  readonly kind: 'rectangle';
  width: number;
  height: number;
}

/** Geometry is `position` alone. */
export interface PointEntity extends BaseEntity {
  readonly kind: 'point';
}

/** Axis-aligned in the local plane; semi-axes > 0. */
export interface EllipseEntity extends BaseEntity {
  readonly kind: 'ellipse';
  center: Vec2;
  radiusX: number;
  radiusY: number;
}

/** Centripetal Catmull-Rom through `points` (periodic when `closed`); no separate control polygon. */
export interface SplineEntity extends BaseEntity {
  readonly kind: 'spline';
  /** Minimum 2 points. */
  points: ReadonlyArray<Vec2>;
  closed: boolean;
}

/** Annotation anchored at `position`. */
export interface TextEntity extends BaseEntity {
  readonly kind: 'text';
  /** Non-empty. */
  content: string;
  /** Cap-height in model units, > 0. */
  height: number;
  /** Alignment relative to `position`. Default 'left'. */
  anchor?: 'left' | 'center' | 'right';
}

/**
 * Associative dimension; `entityIds` required count by `dimensionKind`:
 * linear/aligned 2 (line or point), radial 1 (circle/arc/ellipse), angular 3 (vertex point + 2 lines, or 3 points).
 * Dangling refs are flagged by check_model.
 */
export interface DimensionEntity extends BaseEntity {
  readonly kind: 'dimension';
  dimensionKind: 'linear' | 'aligned' | 'radial' | 'angular';
  entityIds: readonly string[];
  /** Perpendicular distance from measured geometry to the dimension line. Default 5. */
  offset?: number;
  /** Overrides CadDocument.displayPrecision. */
  precision?: number;
  /** Replaces the computed value text. */
  label?: string;
}

/**
 * Placed reference to a Component definition; geometry is never copied.
 * @invariant componentId exists in CadDocument.components
 * @see Component, create_component, insert_instance, explode_instance
 */
export interface InstanceEntity extends BaseEntity {
  readonly kind: 'instance';
  componentId: string;
  /** Per-axis scale about the component origin. Default [1,1,1]. */
  scale?: Vec3;
}

export type Entity =
  | BoxEntity
  | CylinderEntity
  | SphereEntity
  | ExtrusionEntity
  | MeshSolidEntity
  | ConeEntity
  | TorusEntity
  | WedgeEntity
  | PyramidEntity
  | RevolutionEntity
  | LineEntity
  | PolylineEntity
  | ArcEntity
  | CircleEntity
  | RectangleEntity
  | PointEntity
  | EllipseEntity
  | SplineEntity
  | TextEntity
  | DimensionEntity
  | InstanceEntity;

const SHAPE2D_KIND_SET: ReadonlySet<string> = new Set(SHAPE2D_KINDS);

export function is2D(e: Entity): boolean {
  return SHAPE2D_KIND_SET.has(e.kind);
}

export function is3D(e: Entity): boolean {
  return !SHAPE2D_KIND_SET.has(e.kind);
}

export interface Layer {
  readonly id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Hex tint for the UI, e.g. "#ff0000". */
  color?: string;
}

export interface CameraState {
  target: Vec3;
  /** Spherical orbit angles (radians) + distance. */
  azimuth: number;
  polar: number;
  distance: number;
}

/** Named membership list; members keep their kinds and positions. */
export interface EntityGroup {
  readonly id: string;
  name: string;
  /** All must exist in `entities`. */
  memberIds: EntityId[];
}

/**
 * Named parameter-expression overrides; activating one rewrites `CadDocument.parameters`
 * and replays history.
 * @see create_configuration, activate_configuration
 */
export interface Configuration {
  readonly name: string;
  /** Parameter name -> expression (same format as `Parameter.expression`). */
  parameterValues: Record<string, string>;
}

/** Named numeric parameter; `expression` (literal or reference, e.g. "width * 2") is the source of truth. */
export interface Parameter {
  readonly name: string;
  expression: string;
  /** Last successful evaluation. */
  value: number;
  /** Set when evaluation failed (unknown reference, cycle, parse error). */
  error?: string;
}

/** Declarative movement clips: the document declares motion, the viewport evaluates it per frame (no physics). */
export type AnimationChannel = 'rotation' | 'position';

/** 'spin' = constant velocity; 'oscillate' = sinusoidal back-and-forth. */
export type AnimationMode = 'spin' | 'oscillate';

export interface Animation {
  readonly id: string;
  /** Entity or group id, per `targetKind`. */
  targetId: EntityId;
  targetKind: 'entity' | 'group';
  channel: AnimationChannel;
  /** Rotation axle or translation direction; the player normalizes it. */
  axis: Vec3;
  mode: AnimationMode;
  /** spin only: rad/s (rotation) or units/s (position). */
  speed: number;
  /** oscillate only: radians (rotation) or units (position). */
  amplitude: number;
  /** oscillate only: Hz. */
  frequency: number;
  /** rotation only: world-space pivot; defaults to the target's position. */
  pivot?: Vec3;
  /** 'auto' runs under global Play; 'click' toggles on click. */
  trigger: 'auto' | 'click';
}

/**
 * One recorded command invocation; the history is the constructive recipe (architecture L8).
 * Suppressed steps are skipped on replay.
 */
export interface FeatureStep {
  /** `step-<n>` (`CadDocument.nextStepNumber`); legacy v1 files keep their old ids. */
  readonly id: string;
  /** Registry command name. */
  readonly name: string;
  readonly params: unknown;
  suppressed?: boolean;
  label?: string;
  /** `CommandResult.affected` at record time; legacy (v1) replay zips it with replayed ids to remap references. */
  affected?: readonly EntityId[];
}

/**
 * Named snapshot of a featureHistory, replayed additively with fresh ids.
 * @see save_recipe, instantiate_recipe
 */
export interface Recipe {
  readonly name: string;
  readonly steps: FeatureStep[];
  label?: string;
}

/**
 * Reusable definition: entities in component-local coordinates, referenced by `InstanceEntity`.
 * @invariant every id in `order` is a key in `entities`
 * @see InstanceEntity, create_component, insert_instance, explode_instance
 */
export interface Component {
  /** Minted by nextId('comp'). */
  readonly id: string;
  name: string;
  entities: Record<EntityId, Entity>;
  order: EntityId[];
}

/**
 * A point on an entity: its `position` when `kind` is absent, else a named sub-point of a
 * line, arc, or circle ('center' of a line is its midpoint).
 */
export type EntityRef =
  | { readonly entityId: string }
  | { readonly entityId: string; readonly kind: 'start' | 'end' | 'center' | 'mid' };

export const CONSTRAINT_KINDS = [
  'coincident',
  'parallel',
  'perpendicular',
  'tangent',
  'distance',
  'angle',
] as const;

export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

interface ConstraintBase<K extends ConstraintKind> {
  readonly id: string;
  readonly kind: K;
  readonly a: EntityRef;
  readonly b: EntityRef;
}

/** `value` is a literal or a parameter expression: distance in document units, angle in radians. */
interface ConstraintTarget {
  readonly value: number | string;
}

/** Solver-driven relation between entities `a` and `b` (see solve_constraints). */
export type Constraint =
  | ConstraintBase<'coincident'>
  | ConstraintBase<'parallel'>
  | ConstraintBase<'perpendicular'>
  | ConstraintBase<'tangent'>
  | (ConstraintBase<'distance'> & ConstraintTarget)
  | (ConstraintBase<'angle'> & ConstraintTarget);

/** An InstanceEntity and the frame of it a joint attaches to. */
export interface JointMateRef {
  readonly instanceId: string;
  /** Default 'origin'. */
  readonly frame?: 'origin' | 'axis-x' | 'axis-y' | 'axis-z';
}

interface JointBase<K extends string> {
  readonly id: string;
  readonly kind: K;
  readonly a: JointMateRef;
  readonly b: JointMateRef;
  /** 'x'|'y'|'z' shorthand or a unit Vec3. */
  axis: 'x' | 'y' | 'z' | Vec3;
}

/**
 * Instance `b` moves relative to `a`: revolute rotates by `angle` (radians) about `axis`,
 * prismatic slides by `displacement` (document units) along it.
 * @see add_joint, set_joint_value, evaluate_motion, bake_motion
 */
export type Joint =
  | (JointBase<'revolute'> & { angle: number })
  | (JointBase<'prismatic'> & { displacement: number });

export type JointKind = Joint['kind'];

/**
 * Couples joints: `driven = driver * ratio + offset` (gears, belts, linkages).
 * @invariant driver and driven exist in doc.joints, driver !== driven, drive graph is acyclic
 * @see add_drive_relation, delete_drive_relation, evaluate_motion
 */
export interface DriveRelation {
  readonly id: string;
  /** Driving joint id. */
  driver: string;
  /** Driven joint id. */
  driven: string;
  ratio: number;
  /** Default 0. */
  offset?: number;
}

/** Document units default to 'mm'; every map/list below is initialized empty by createEmptyDocument. */
export interface CadDocument {
  entities: Record<EntityId, Entity>;
  /** Z-order / creation order of entity ids. */
  order: EntityId[];
  layers: Record<string, Layer>;
  layerOrder: string[];
  selection: EntityId[];
  camera: CameraState;
  groups: Record<string, EntityGroup>;
  units: DocumentUnit;
  /** Decimal places for displayed lengths. Default 3. */
  displayPrecision: number;
  /** Keyed by parameter name; evaluated in topological order, cycles/unknown refs set `error`. */
  parameters: Record<string, Parameter>;
  animations: Record<string, Animation>;
  /**
   * Replayable command list: replaying non-suppressed steps from `createEmptyDocument()`
   * regenerates `entities` (architecture L8). `execute()` appends mutating commands;
   * history meta-commands only edit the list.
   */
  featureHistory: FeatureStep[];
  /** Next `step-<n>`; never reused so step-scoped entity ids stay unique. Absent = 1. */
  nextStepNumber?: number;
  /** Design table: variants of parameter expressions. */
  configurations: Record<string, Configuration>;
  /** Keyed by material name; referenced by `BaseEntity.materialId`. */
  materials: Record<string, Material>;
  recipes: Record<string, Recipe>;
  /** Keyed by component id. */
  components: Record<string, Component>;
  /** Keyed by constraint id; `constraintOrder` lists ids in creation order. */
  constraints: Record<string, Constraint>;
  constraintOrder: string[];
  /** Keyed by joint id; `jointOrder` lists ids in creation order. */
  joints: Record<string, Joint>;
  jointOrder: string[];
  /** Keyed by drive relation id; `driveRelationOrder` lists ids in creation order. */
  driveRelations: Record<string, DriveRelation>;
  driveRelationOrder: string[];
  /** Absent until the first building command. */
  building?: BuildingModel;
  /** Absent until the first civil (site / terrain / road / drainage) command. */
  civil?: CivilModel;
}

/**
 * Physical + PBR material. `density` is mass per (document unit)³ so mass = volume × density
 * (mm document: g/mm³, steel ≈ 0.00785). Replaced via `create_material`.
 * @invariant density > 0 and finite; color matches /^#[0-9a-fA-F]{6}$/; metalness, roughness in [0, 1]
 */
export interface Material {
  readonly name: string;
  density: number;
  color: string;
  metalness: number;
  roughness: number;
}

export const DEFAULT_LAYER_ID = 'layer-default';

export function createEmptyDocument(): CadDocument {
  return {
    entities: {},
    order: [],
    layers: {
      [DEFAULT_LAYER_ID]: {
        id: DEFAULT_LAYER_ID,
        name: 'Layer 0',
        visible: true,
        locked: false,
      },
    },
    layerOrder: [DEFAULT_LAYER_ID],
    selection: [],
    camera: {
      target: [0, 0, 0],
      azimuth: (3 * Math.PI) / 4,
      polar: Math.PI / 3,
      distance: 12,
    },
    groups: {},
    units: 'mm',
    displayPrecision: 3,
    parameters: {},
    animations: {},
    featureHistory: [],
    configurations: {},
    materials: {},
    recipes: {},
    components: {},
    constraints: {},
    constraintOrder: [],
    joints: {},
    jointOrder: [],
    driveRelations: {},
    driveRelationOrder: [],
  };
}
