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
export type SolidKind = 'box' | 'cylinder' | 'sphere' | 'extrusion' | 'mesh';

/** 2D drafting shape kinds. Geometry is LOCAL to the entity work plane; BaseEntity.position places that plane in 3D space. */
export type Shape2DKind = 'line' | 'polyline' | 'arc' | 'circle' | 'rectangle' | 'point' | 'ellipse' | 'spline';

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

export type Entity =
  | BoxEntity
  | CylinderEntity
  | SphereEntity
  | ExtrusionEntity
  | MeshSolidEntity
  | LineEntity
  | PolylineEntity
  | ArcEntity
  | CircleEntity
  | RectangleEntity
  | PointEntity
  | EllipseEntity
  | SplineEntity;

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
  };
}
