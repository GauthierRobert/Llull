/**
 * Domain model — the single source of truth for a CAD document.
 *
 * Everything else in the app (UI, AI bridge, MCP server) reads and mutates
 * this model exclusively through the command layer. Nothing constructs or
 * edits entities directly outside of `core/commands`.
 */

import type { MeshData } from '../geometry/kernel';
export type { MeshData };

export type EntityId = string;

export type Vec3 = readonly [number, number, number];

/** Units of length used for display and measurement throughout the document. */
export type DocumentUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

/** 2D coordinate in a local work plane. */
export type Vec2 = readonly [number, number];

/** Primitive solids supported in v1. Extend this union to add new geometry. */
export type SolidKind = 'box' | 'cylinder' | 'sphere' | 'extrusion' | 'mesh' | 'cone' | 'torus' | 'wedge' | 'pyramid';

/** 2D drafting shape kinds. Geometry is LOCAL to the entity work plane; BaseEntity.position places that plane in 3D space. */
export type Shape2DKind = 'line' | 'polyline' | 'arc' | 'circle' | 'rectangle' | 'point' | 'ellipse' | 'spline' | 'text' | 'dimension';

/** All entity kinds — 3D solids and 2D shapes. */
export type EntityKind = SolidKind | Shape2DKind;

export interface BaseEntity {
  readonly id: EntityId;
  readonly kind: EntityKind;
  /** World-space position of the entity origin (work-plane origin for 2D entities). */
  position: Vec3;
  /** Euler rotation in radians. */
  rotation: Vec3;
  /** Layer this entity belongs to. */
  layerId: string;
  /** Hex color, e.g. "#c8553d". */
  color: string;
  /**
   * Optional human-readable name for the entity, set by `set_entity_name`.
   * Enables AI/MCP plans to reference entities by meaning rather than generated ids.
   */
  name?: string;
  /**
   * Optional semantic tags for the entity, set by `set_entity_name`.
   * Used by `find_entities` to filter by tag.
   * @example ['structural', 'visible']
   */
  tags?: readonly string[];
}

export interface BoxEntity extends BaseEntity {
  readonly kind: 'box';
  size: Vec3; // width, height, depth
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

/** A 2D profile extruded along Z — the simplest path to "AutoCAD-like" modeling. */
export interface ExtrusionEntity extends BaseEntity {
  readonly kind: 'extrusion';
  /** Closed polygon in the XY plane. */
  profile: ReadonlyArray<readonly [number, number]>;
  depth: number;
}

/**
 * A boolean-operation result stored as an arbitrary triangle mesh.
 * `mesh` holds world-space geometry; `position` is [0,0,0] (mesh is already in world space).
 * Created exclusively by the boolean commands (`boolean_union`, `boolean_subtract`, `boolean_intersect`).
 * A4-ui is responsible for adding the viewport render branch for this kind.
 */
export interface MeshSolidEntity extends BaseEntity {
  readonly kind: 'mesh';
  /** World-space triangle mesh produced by a boolean kernel operation. */
  mesh: MeshData;
}

/**
 * A cone solid — circular base in the XY plane, apex above the base center along +Z.
 * `position` is the world-space center of the base circle.
 * `radius` is the base radius; `height` is the distance from base center to apex.
 * Both must be > 0.
 */
export interface ConeEntity extends BaseEntity {
  readonly kind: 'cone';
  /** Radius of the circular base. Must be > 0. */
  radius: number;
  /** Height from the base center to the apex along the local +Z axis. Must be > 0. */
  height: number;
}

/**
 * A torus (donut) solid centered at `position`.
 * `ringRadius` is the distance from the torus center to the center of the tube (the major radius).
 * `tubeRadius` is the radius of the circular tube cross-section (the minor radius).
 * Both must be > 0 and tubeRadius < ringRadius for a valid (non-self-intersecting) torus.
 */
export interface TorusEntity extends BaseEntity {
  readonly kind: 'torus';
  /** Distance from torus center to tube center (major radius). Must be > 0. */
  ringRadius: number;
  /** Radius of the tube cross-section (minor radius). Must be > 0. */
  tubeRadius: number;
}

/**
 * A wedge solid — a right-triangular prism (ramp shape).
 * `size` is [width, height, depth] of the enclosing box.
 * The wedge occupies the full box in X (width) and Z (depth) but is sloped in Y:
 * the front face (at z=0) has full height, the back face (at z=depth) tapers to zero height.
 * In other words, the slope cuts the top-rear corner: the solid has vertices at
 * (0,0,0), (width,0,0), (0,height,0), (width,height,0) on the front face and
 * (0,0,depth), (width,0,depth) on the back edge (height=0 at z=depth).
 * `position` is at the lower-front-left corner.
 * All three size components must be > 0.
 */
export interface WedgeEntity extends BaseEntity {
  readonly kind: 'wedge';
  /**
   * Bounding dimensions [width, height, depth].
   * width = extent along X; height = full height at the front face (z=0);
   * depth = extent along Z (the ramp direction). All must be > 0.
   */
  size: Vec3;
}

/**
 * A pyramid solid with a rectangular base and apex above the base center.
 * `position` is the world-space center of the rectangular base.
 * The base extends ±baseWidth/2 in X and ±baseDepth/2 in Y from `position`.
 * The apex is at (position[0], position[1], position[2]+height).
 * All three dimensions must be > 0.
 */
export interface PyramidEntity extends BaseEntity {
  readonly kind: 'pyramid';
  /** Width of the rectangular base (extent along X). Must be > 0. */
  baseWidth: number;
  /** Depth of the rectangular base (extent along Y). Must be > 0. */
  baseDepth: number;
  /** Height from the base center to the apex along the local +Z axis. Must be > 0. */
  height: number;
}

// ---------------------------------------------------------------------------
// 2D shape entities — geometry is LOCAL to the work plane (Vec2);
// BaseEntity.position places the plane origin in 3D space (default z=0, normal +Z).
// ---------------------------------------------------------------------------

/** A straight line segment defined by two endpoints in the local work plane. */
export interface LineEntity extends BaseEntity {
  readonly kind: 'line';
  /** Start point in local 2D work-plane coordinates. */
  start: Vec2;
  /** End point in local 2D work-plane coordinates. */
  end: Vec2;
}

/** An ordered sequence of connected line segments in the local work plane. */
export interface PolylineEntity extends BaseEntity {
  readonly kind: 'polyline';
  /** Ordered vertices in local 2D work-plane coordinates. Minimum 2 points. */
  points: ReadonlyArray<Vec2>;
  /** When true the last point connects back to the first, forming a closed loop. */
  closed: boolean;
}

/** A circular arc in the local work plane. */
export interface ArcEntity extends BaseEntity {
  readonly kind: 'arc';
  /** Center of the arc in local 2D work-plane coordinates. */
  center: Vec2;
  /** Arc radius. Must be > 0. */
  radius: number;
  /** Start angle in radians (measured counter-clockwise from +X). */
  startAngle: number;
  /** End angle in radians (measured counter-clockwise from +X). */
  endAngle: number;
}

/** A full circle in the local work plane. */
export interface CircleEntity extends BaseEntity {
  readonly kind: 'circle';
  /** Center of the circle in local 2D work-plane coordinates. */
  center: Vec2;
  /** Circle radius. Must be > 0. */
  radius: number;
}

/**
 * An axis-aligned rectangle in the local work plane.
 * Origin is at the lower-left corner; width extends along +X, height along +Y.
 */
export interface RectangleEntity extends BaseEntity {
  readonly kind: 'rectangle';
  /** Width along local X axis. Must be > 0. */
  width: number;
  /** Height along local Y axis. Must be > 0. */
  height: number;
}

/** A single point in the local work plane. Geometry is captured by BaseEntity.position. */
export interface PointEntity extends BaseEntity {
  readonly kind: 'point';
}

/**
 * An axis-aligned ellipse in the local work plane.
 * `center` is the ellipse center in local 2D coordinates.
 * `radiusX` and `radiusY` are the semi-axes along the local plane's X and Y axes respectively.
 * The entity `position`/`rotation` places the work plane in 3D space.
 * Both radii must be > 0.
 */
export interface EllipseEntity extends BaseEntity {
  readonly kind: 'ellipse';
  /** Center of the ellipse in local 2D work-plane coordinates. */
  center: Vec2;
  /** Semi-axis length along the local X axis. Must be > 0. */
  radiusX: number;
  /** Semi-axis length along the local Y axis. Must be > 0. */
  radiusY: number;
}

/**
 * A Catmull-Rom interpolating spline in the local work plane.
 * `points` are the through-points (the spline passes through each one).
 * Requires at least 2 points.
 * When `closed` is true, the curve loops back from the last point to the first.
 *
 * Convention for renderers (VS1): tessellate as a Catmull-Rom spline with
 * centripetal parameterization. The control points ARE the through-points;
 * no separate control polygon is stored. For closed splines, treat the point
 * array as periodic (wrap the first/last points).
 */
export interface SplineEntity extends BaseEntity {
  readonly kind: 'spline';
  /** Ordered through-points in local 2D work-plane coordinates. Minimum 2 points. */
  points: ReadonlyArray<Vec2>;
  /** When true the spline loops back from the last point to the first. */
  closed: boolean;
}

/**
 * An annotation text label placed in the document.
 * Geometry is anchored at `position` (world-space, same convention as other 2D entities: z=0 plane by default).
 * `content` is the displayed string; `height` is the cap-height in model units.
 * Optional `anchor` controls the horizontal alignment of the text relative to `position`:
 *   'left'   — position is the left edge of the first glyph (default)
 *   'center' — position is the horizontal midpoint of the text
 *   'right'  — position is the right edge of the last glyph
 * Optional `layer` is inherited from BaseEntity.layerId if omitted during creation.
 * Both `content` must be non-empty and `height` must be > 0.
 */
export interface TextEntity extends BaseEntity {
  readonly kind: 'text';
  /** The text string to display. Must not be empty. */
  content: string;
  /** Cap-height of the text in model units. Must be > 0. */
  height: number;
  /** Horizontal alignment of the text relative to `position`. Default: 'left'. */
  anchor?: 'left' | 'center' | 'right';
}

/**
 * An associative dimension annotation placed in the document.
 * `dimensionKind` controls the measurement type and the required `entityIds` count:
 *   - 'linear'  : measures the straight-line distance between two endpoints; `entityIds` = 2 (line/point entities)
 *   - 'aligned' : like linear but parallel to the segment between the two reference points; `entityIds` = 2
 *   - 'radial'  : measures the radius of a circle, arc, or ellipse; `entityIds` = 1 (circle/arc/ellipse entity)
 *   - 'angular' : measures the angle at the vertex of two line segments; `entityIds` = 3 (vertex point + 2 line entities, or 3 point entities)
 * `entityIds` contains references to existing document entities; the dimension updates if those entities move.
 * Optional `offset` is the perpendicular distance (in model units) from the measured geometry to the dimension line; default 5.
 * Optional `precision` overrides the document display precision (number of decimal places) for this dimension only.
 * Optional `label` replaces the computed numeric value with a custom string.
 */
export interface DimensionEntity extends BaseEntity {
  readonly kind: 'dimension';
  /** Controls how the measurement is computed and how many entityIds are required. */
  dimensionKind: 'linear' | 'aligned' | 'radial' | 'angular';
  /**
   * Ids of the referenced document entities.
   * linear/aligned: exactly 2 ids (line or point entities).
   * radial: exactly 1 id (circle, arc, or ellipse entity).
   * angular: exactly 3 ids (vertex point + 2 line entities, or 3 point entities).
   * All ids must exist in the document. Dangling refs are flagged by check_model.
   */
  entityIds: readonly string[];
  /** Perpendicular offset (model units) from the measured geometry to the dimension line. Default: 5. */
  offset?: number;
  /** Decimal precision override for this dimension; overrides CadDocument.displayPrecision when present. */
  precision?: number;
  /** Custom label overriding the computed numeric value. If absent, the value is computed at render time. */
  label?: string;
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
  | LineEntity
  | PolylineEntity
  | ArcEntity
  | CircleEntity
  | RectangleEntity
  | PointEntity
  | EllipseEntity
  | SplineEntity
  | TextEntity
  | DimensionEntity;

// ---------------------------------------------------------------------------
// Kind helpers
// ---------------------------------------------------------------------------

const SHAPE2D_KINDS: ReadonlySet<string> = new Set<Shape2DKind>([
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
]);

/** Returns true if the entity is a 2D drafting shape. */
export function is2D(e: Entity): boolean {
  return SHAPE2D_KINDS.has(e.kind);
}

/** Returns true if the entity is a 3D solid. */
export function is3D(e: Entity): boolean {
  return !SHAPE2D_KINDS.has(e.kind);
}

export interface Layer {
  readonly id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Optional hex color string used by the UI to tint layer contents, e.g. "#ff0000". */
  color?: string;
}

export interface CameraState {
  /** Orbit target. */
  target: Vec3;
  /** Spherical orbit angles (radians) + distance. */
  azimuth: number;
  polar: number;
  distance: number;
}

/**
 * A named group of entities. Groups are lightweight: they record membership but
 * do NOT change entity kinds or positions. The `groups` map in `CadDocument` is
 * the authoritative container; commands create/remove groups, members stay as-is.
 */
export interface EntityGroup {
  readonly id: string;
  /** Human-readable label, e.g. "Wheel assembly". */
  name: string;
  /** Ids of member entities. All must exist in `entities`. */
  memberIds: EntityId[];
}

/**
 * A named numeric parameter that can reference other parameters via expressions.
 *
 * `expression` is the source of truth (e.g. `"width * 2"` or a literal `"10"`).
 * `value` is the last successful evaluation result.
 * `error` is set when evaluation fails (unknown reference, cycle, parse error).
 * The shape is intentionally minimal and JSON-serializable.
 */
export interface Parameter {
  /** Human-readable name used in expressions, e.g. `"width"`. */
  readonly name: string;
  /**
   * The expression string that defines this parameter's value.
   * May be a numeric literal (`"10"`) or reference other parameters (`"width * 2"`).
   */
  expression: string;
  /** Last successfully evaluated numeric value. */
  value: number;
  /** Set to a descriptive message when evaluation failed; absent on success. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Animation — declarative movement clips (no physics). The document DECLARES
// motion (L8: the document is the recipe); the viewport player EVALUATES it
// per-frame (derived, not stored). Two profiles cover bike-mechanics motion:
//   - spin:      constant velocity (wheels, pedals, crank, gears)
//   - oscillate: sinusoidal back-and-forth (steering wobble, piston bob)
// Either an `entity` or a `group` can be the target, so a whole sub-assembly
// (e.g. a wheel + spokes) moves rigidly about a shared pivot.
// ---------------------------------------------------------------------------

/** Transform channel an animation drives. */
export type AnimationChannel = 'rotation' | 'position';

/** Motion profile: constant-velocity spin, or sinusoidal oscillation. */
export type AnimationMode = 'spin' | 'oscillate';

/** What runs the clip: global Play, or clicking the target in the viewport. */
export type AnimationTrigger = 'auto' | 'click';

/** Whether `targetId` names a single entity or a group of entities. */
export type AnimationTargetKind = 'entity' | 'group';

/**
 * A declarative movement clip. Pure JSON-serializable document data; the
 * viewport `AnimationPlayer` reads these and mutates three.js transforms each
 * frame (the document transform is never touched — animation is a render-time
 * overlay, like selection).
 */
export interface Animation {
  readonly id: string;
  /** Id of the entity or group to animate. */
  targetId: EntityId;
  /** Whether `targetId` names an entity or a group. */
  targetKind: AnimationTargetKind;
  /** Which transform channel to drive. */
  channel: AnimationChannel;
  /**
   * Direction the animation acts along: the rotation axle for `rotation`, or the
   * translation direction for `position`. Need not be unit-length — the player
   * normalizes it. e.g. [0,1,0] spins about the world Y axis.
   */
  axis: Vec3;
  /** 'spin' = constant velocity; 'oscillate' = sinusoidal back-and-forth. */
  mode: AnimationMode;
  /** spin only: angular velocity (rad/s) for rotation, or linear velocity (units/s) for position. */
  speed: number;
  /** oscillate only: peak amplitude — radians for rotation, units for position. */
  amplitude: number;
  /** oscillate only: cycles per second (Hz). */
  frequency: number;
  /** rotation only: world-space pivot; defaults to the target's position when omitted. */
  pivot?: Vec3;
  /** 'auto' runs under global Play; 'click' toggles when the target is clicked. */
  trigger: AnimationTrigger;
}

export interface CadDocument {
  entities: Record<EntityId, Entity>;
  /** Z-order / creation order of entity ids. */
  order: EntityId[];
  layers: Record<string, Layer>;
  layerOrder: string[];
  selection: EntityId[];
  camera: CameraState;
  /** Named entity groups. Keyed by group id. Initialized as {} in createEmptyDocument. */
  groups: Record<string, EntityGroup>;
  /** Unit of length for all geometry values in this document. Default: 'mm'. */
  units: DocumentUnit;
  /** Number of decimal places used when displaying/formatting length values. Default: 3. */
  displayPrecision: number;
  /**
   * Named numeric parameters. Keyed by parameter name.
   * Parameters may reference each other via expressions; the system maintains
   * topological evaluation order and marks cycles/unknown refs with `error`.
   * Initialized as {} in createEmptyDocument.
   */
  parameters: Record<string, Parameter>;
  /**
   * Declarative movement animations. Keyed by animation id.
   * The document only DECLARES motion; the viewport player evaluates it per
   * frame (no physics). Initialized as {} in createEmptyDocument.
   */
  animations: Record<string, Animation>;
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
      azimuth: Math.PI / 4,
      polar: Math.PI / 3,
      distance: 12,
    },
    groups: {},
    units: 'mm',
    displayPrecision: 3,
    parameters: {},
    animations: {},
  };
}
