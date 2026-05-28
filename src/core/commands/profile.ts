/**
 * @command extrude_sketch
 * @command revolve_profile
 * @pure
 * @layer core/commands
 * @affects extrude_sketch: creates 1 extrusion entity from a closed 2D shape entity
 * @affects revolve_profile: creates 1 revolution entity — surface of revolution from a closed 2D polygon profile
 * @invariant extrude_sketch: source entity remains in document; only depth > 0 is accepted
 * @invariant revolve_profile: profile.length >= 3; angle in (0, 2π]; segments >= 3
 * @failure missing id -> no-op, affected:[]
 * @failure non-closed or non-2D entity -> no-op, affected:[]
 * @failure depth <= 0 -> no-op, affected:[]
 * @failure revolve_profile: profile < 3 points, angle <= 0, invalid axis -> no-op, affected:[]
 */

import type { CadDocument, Entity, ExtrusionEntity, RevolutionEntity, Vec3 } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';
import { rotatedEntityBounds } from './scene';

/**
 * Validate an optional rotation param (shared convention with geometry.ts).
 * Returns [0,0,0] if rotation is absent, not length-3, or contains non-finite values.
 */
function resolveRotation(rotation: unknown): Vec3 {
  if (!Array.isArray(rotation) || rotation.length !== 3) return [0, 0, 0];
  const [rx, ry, rz] = rotation as unknown[];
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rz)) return [0, 0, 0];
  return [rx as number, ry as number, rz as number];
}

/** Format an AABB for inclusion in a command summary. */
function boundsText(b: { min: Vec3; max: Vec3 }): string {
  const fmt = (v: number): string => parseFloat(v.toFixed(4)).toString();
  return `world AABB min [${b.min.map(fmt).join(', ')}] max [${b.max.map(fmt).join(', ')}]`;
}

/** Number of polygon segments used to approximate a circle. */
const CIRCLE_SEGMENTS = 32;

/** Helper: clone the document shallowly adding a new entity. */
function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}

// ---------------------------------------------------------------------------
// extrude_sketch
// ---------------------------------------------------------------------------

interface ExtrudeSketchParams {
  /** Id of the existing closed 2D shape entity to extrude (circle, rectangle, or closed polyline). */
  id: string;
  /** Extrusion depth in world units along Z. Must be > 0. */
  depth: number;
  /** Optional extrinsic XYZ Euler angles in RADIANS. Defaults to [0,0,0]. Malformed values are ignored. */
  rotation?: Vec3;
}

/**
 * @command extrude_sketch
 * @pure
 * Derives a polygon profile from the given closed 2D shape entity and builds a
 * new extrusion solid. The source entity is kept in the document (non-destructive).
 *
 * Profile derivation per kind:
 *   circle      → 32-segment regular polygon centred at entity.center
 *   rectangle   → 4 corners from lower-left origin (respects B1 convention)
 *   polyline    → its points when closed === true; no-op when open
 *   line / arc / open polyline / point / 3D solid → graceful no-op
 */
export const extrudeSketch: CommandDefinition<ExtrudeSketchParams> = {
  name: 'extrude_sketch',
  description:
    'Extrude a closed 2D shape entity (circle, rectangle, or closed polyline) into a 3D extrusion solid. ' +
    'Right-handed world frame, +Z up. The solid is placed at the source entity position and extends depth ' +
    'units along +Z. Keeps the source entity in the document. depth must be > 0.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Id of the closed 2D shape entity to extrude. Must be a circle, rectangle, or polyline with closed=true.',
      },
      depth: {
        type: 'number',
        description:
          'Extrusion depth in document units along +Z from the source entity position. Must be > 0.',
      },
      rotation: {
        type: 'array',
        description:
          'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz] for the resulting extrusion solid. ' +
          'Matches rotate_entity convention. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
        items: { type: 'number' },
      },
    },
    required: ['id', 'depth'],
  },
  run: (doc, { id, depth, rotation }): CommandResult => {
    // --- guard: depth ---
    if (typeof depth !== 'number' || depth <= 0) {
      return {
        document: doc,
        summary: `extrude_sketch: depth must be > 0 (got ${depth}); entity ${id} unchanged.`,
        affected: [],
      };
    }

    // --- guard: entity exists ---
    const source = doc.entities[id];
    if (!source) {
      return {
        document: doc,
        summary: `extrude_sketch: no entity with id "${id}".`,
        affected: [],
      };
    }

    // --- derive profile polygon ---
    let profile: ReadonlyArray<readonly [number, number]> | null = null;

    if (source.kind === 'circle') {
      const { center, radius } = source;
      const pts: Array<readonly [number, number]> = [];
      for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const angle = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
        pts.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
      }
      profile = pts;
    } else if (source.kind === 'rectangle') {
      const { width, height } = source;
      // lower-left origin (B1 convention); corners in CCW order
      profile = [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
      ];
    } else if (source.kind === 'polyline') {
      if (!source.closed) {
        return {
          document: doc,
          summary: `extrude_sketch: polyline "${id}" is not closed; cannot extrude an open profile.`,
          affected: [],
        };
      }
      if (source.points.length < 3) {
        return {
          document: doc,
          summary: `extrude_sketch: polyline "${id}" has fewer than 3 points; not a valid closed profile.`,
          affected: [],
        };
      }
      profile = source.points as ReadonlyArray<readonly [number, number]>;
    } else {
      // line, arc, point, 3D solids — not a closed 2D profile
      return {
        document: doc,
        summary: `extrude_sketch: entity "${id}" (kind="${source.kind}") is not a closed 2D profile. Use a circle, rectangle, or closed polyline.`,
        affected: [],
      };
    }

    // --- build new extrusion ---
    const extId = nextId('ext');
    const extrusion: ExtrusionEntity = {
      id: extId,
      kind: 'extrusion',
      profile,
      depth,
      position: [source.position[0], source.position[1], source.position[2]],
      rotation: resolveRotation(rotation),
      layerId: DEFAULT_LAYER_ID,
      color: '#c8553d',
    };

    const newDoc = withEntity(doc, extrusion);
    const b = rotatedEntityBounds(newDoc.entities[extId] as Entity);
    return {
      document: newDoc,
      summary: `extrude_sketch: created extrusion "${extId}" from ${source.kind} "${id}" (${profile.length}-point profile, depth=${depth}); ${boundsText(b)}.`,
      affected: [extId],
    };
  },
};

// ---------------------------------------------------------------------------
// revolve_profile
// ---------------------------------------------------------------------------

/**
 * Normalise a raw axis param to a unit Vec3, or return null if invalid.
 * Accepts 'x'|'y'|'z' shorthand strings or a [number,number,number] array.
 * Default axis when omitted: +Z ([0,0,1]) per the document +Z-up convention.
 */
function resolveAxis(raw: unknown): Vec3 | null {
  if (raw === undefined || raw === null) return [0, 0, 1]; // default: Z-axis
  if (raw === 'x') return [1, 0, 0];
  if (raw === 'y') return [0, 1, 0];
  if (raw === 'z') return [0, 0, 1];
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [ax, ay, az] = raw as unknown[];
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) return null;
  const len = Math.sqrt((ax as number) ** 2 + (ay as number) ** 2 + (az as number) ** 2);
  if (len < 1e-10) return null;
  return [(ax as number) / len, (ay as number) / len, (az as number) / len];
}

interface RevolveProfileParams {
  /**
   * Array of [x, y] points forming the generating cross-section. Must be a closed polygon
   * (first point need not equal last — the command treats the polygon as implicitly closed).
   * Minimum 3 points. x is the radial offset from the revolution axis; y is the axial offset.
   */
  profile: ReadonlyArray<readonly [number, number]>;
  /**
   * Revolution axis. One of 'x', 'y', 'z' (shorthand) or a [dx, dy, dz] unit-vector array.
   * Default: 'z' (+Z, the natural axis for a Z-up document).
   */
  axis?: string | Vec3;
  /** Sweep angle in radians. Default: 2π (full revolution). Must be > 0 and ≤ 2π. */
  angle?: number;
  /** Number of radial subdivisions for tessellation. Default: 32. Minimum: 3. */
  segments?: number;
  /** World-space position of the revolution-axis origin [x, y, z]. Default: [0, 0, 0]. */
  position?: Vec3;
  /** Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz]. Default: [0, 0, 0]. */
  rotation?: Vec3;
  /** Optional layer id. Defaults to the document default layer. */
  layerId?: string;
  /** Hex color string, e.g. "#c8553d". Default: "#6b8f9c". */
  color?: string;
  /** Optional explicit entity id. If absent a unique id is generated. */
  id?: string;
}

/**
 * @command revolve_profile
 * @pure
 * @layer core/commands
 * @affects creates 1 revolution entity — surface of revolution from a closed 2D polygon profile
 * @invariant profile.length >= 3; angle in (0, 2π]; segments >= 3
 * @failure profile < 3 points -> no-op, affected:[]
 * @failure angle <= 0 or non-finite -> no-op, affected:[]
 * @failure invalid axis (not 'x'/'y'/'z' and not a valid Vec3) -> no-op, affected:[]
 * @failure segments < 3 -> clamped to 3, no no-op
 */
export const revolveProfile: CommandDefinition<RevolveProfileParams> = {
  name: 'revolve_profile',
  description:
    'Create a surface of revolution by rotating a closed 2D polygon profile around an axis. ' +
    'Right-handed world frame, +Z up. ' +
    'profile is an array of [x, y] points where x is the radial offset from the axis and y is the axial offset. ' +
    'At least 3 points required. The polygon is treated as implicitly closed. ' +
    'axis controls the revolution axis: "x", "y", or "z" (shorthand), or a [dx,dy,dz] direction vector. ' +
    'Default axis is "z" (+Z up, the natural axis for a Z-up document). ' +
    'angle is the sweep in radians (default 2π for a full revolution; must be > 0). ' +
    'segments is the number of radial subdivisions (default 32, minimum 3). ' +
    'Stores a parametric revolution entity; tessellated as triangles in render_view and export_stl.',
  paramsSchema: {
    type: 'object',
    properties: {
      profile: {
        type: 'array',
        description:
          'Closed polygon cross-section: array of [x, y] points. x = radial offset from the axis (≥ 0 for outward), ' +
          'y = axial offset along the axis. Minimum 3 points. The polygon is implicitly closed — ' +
          'do NOT repeat the first point at the end.',
      },
      axis: {
        type: 'string',
        description:
          'Revolution axis. Use "x", "y", or "z" for the principal axes, or pass a [dx, dy, dz] array ' +
          'for an arbitrary direction (it will be normalised). Default: "z" (natural +Z-up axis).',
      },
      angle: {
        type: 'number',
        description:
          'Sweep angle in radians. Must be > 0. Default: 2π (full 360° revolution). ' +
          'Use π for a half-revolution, π/2 for a quarter, etc.',
      },
      segments: {
        type: 'number',
        description:
          'Number of radial subdivisions for tessellation. Higher = smoother surface. Default: 32. Minimum: 3.',
      },
      position: {
        type: 'array',
        description:
          'World-space origin of the revolution axis [x, y, z] in document units. Default: [0, 0, 0].',
        items: { type: 'number' },
      },
      rotation: {
        type: 'array',
        description:
          'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz] applied after revolution. Default: [0, 0, 0]. ' +
          'Malformed or non-length-3 values are ignored and [0,0,0] is used.',
        items: { type: 'number' },
      },
      layerId: {
        type: 'string',
        description: 'Layer id to assign the entity to. Defaults to the document default layer.',
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#c8553d". Default: "#6b8f9c".',
      },
      id: {
        type: 'string',
        description: 'Optional explicit entity id. If omitted a unique id is generated.',
      },
    },
    required: ['profile'],
  },
  run: (
    doc,
    {
      profile,
      axis: rawAxis,
      angle: rawAngle,
      segments: rawSegments,
      position = [0, 0, 0],
      rotation,
      layerId,
      color = '#6b8f9c',
      id: explicitId,
    },
  ): CommandResult => {
    // --- guard: profile ---
    if (!Array.isArray(profile) || profile.length < 3) {
      return {
        document: doc,
        summary: `revolve_profile: profile must be an array of at least 3 [x,y] points (got ${Array.isArray(profile) ? profile.length : 'non-array'}); no-op.`,
        affected: [],
      };
    }

    // --- guard: angle ---
    const TWO_PI = 2 * Math.PI;
    const angle = rawAngle !== undefined ? rawAngle : TWO_PI;
    if (!Number.isFinite(angle) || angle <= 0) {
      return {
        document: doc,
        summary: `revolve_profile: angle must be a finite number > 0 (got ${String(angle)}); no-op.`,
        affected: [],
      };
    }

    // --- guard: axis ---
    const axis = resolveAxis(rawAxis);
    if (axis === null) {
      return {
        document: doc,
        summary: `revolve_profile: axis must be 'x', 'y', 'z', or a [dx,dy,dz] direction array (got ${JSON.stringify(rawAxis)}); no-op.`,
        affected: [],
      };
    }

    // --- segments: clamp to minimum 3 ---
    const segments = Math.max(3, Math.round(typeof rawSegments === 'number' && Number.isFinite(rawSegments) ? rawSegments : 32));

    // --- resolve layer ---
    const resolvedLayerId =
      typeof layerId === 'string' && doc.layers[layerId] !== undefined
        ? layerId
        : Object.keys(doc.layers)[0] ?? 'layer-default';

    // --- build entity ---
    const id = typeof explicitId === 'string' && explicitId.length > 0 ? explicitId : nextId('rev');
    const entity: RevolutionEntity = {
      id,
      kind: 'revolution',
      profile,
      axis,
      angle: Math.min(angle, TWO_PI),
      segments,
      position,
      rotation: resolveRotation(rotation),
      layerId: resolvedLayerId,
      color,
    };

    const newDoc = withEntity(doc, entity);
    const b = rotatedEntityBounds(newDoc.entities[id] as Entity);
    const fmt = (v: number): string => parseFloat(v.toFixed(4)).toString();
    const boundsStr = `world AABB min [${b.min.map(fmt).join(', ')}] max [${b.max.map(fmt).join(', ')}]`;
    const axisLabel = rawAxis === 'x' || rawAxis === 'y' || rawAxis === 'z'
      ? rawAxis
      : `[${axis.map((v) => parseFloat(v.toFixed(3))).join(', ')}]`;
    return {
      document: newDoc,
      summary: `revolve_profile: created revolution "${id}" — ${profile.length}-point profile, axis=${axisLabel}, angle=${parseFloat(angle.toFixed(4))} rad, segments=${segments}; ${boundsStr}.`,
      affected: [id],
    };
  },
};
