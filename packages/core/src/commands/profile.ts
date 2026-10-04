import type { ExtrusionEntity, RevolutionEntity, Vec3 } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3, tolerant, untypedArray } from './schema';
import { ORIGIN } from '../lib/vec3';
import { noop } from './noop';
import { nextId } from '../lib/id';
import { commitSolid, resolveRotation } from './geometryShared';

/** Number of polygon segments used to approximate a circle. */
const CIRCLE_SEGMENTS = 32;

/**
 * @command extrude_sketch
 * @pure
 * Derives a polygon profile from the given closed 2D shape entity and builds a
 * new extrusion solid. The source entity is kept in the document (non-destructive).
 *
 * Profile derivation per kind:
 *   circle      → 32-segment regular polygon centred at entity.center
 *   rectangle   → 4 corners from the lower-left origin (RectangleEntity convention)
 *   polyline    → its points when closed === true; no-op when open
 *   line / arc / open polyline / point / 3D solid → graceful no-op
 */
export const extrudeSketch = defineCommand({
  name: 'extrude_sketch',
  description:
    'Extrude a closed 2D shape entity (circle, rectangle, or closed polyline) into a 3D extrusion solid. ' +
    'Right-handed world frame, +Z up. The solid is placed at the source entity position and extends depth ' +
    'units along +Z. Keeps the source entity in the document. depth must be > 0.',
  params: z.object({
    id: z
      .string()
      .describe(
        'Id of the closed 2D shape entity to extrude. Must be a circle, rectangle, or polyline with closed=true.',
      ),
    depth: z
      .number()
      .describe(
        'Extrusion depth in document units along +Z from the source entity position. Must be > 0.',
      ),
    rotation: z
      .array(z.number())
      .describe(
        'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz] for the resulting extrusion solid. ' +
          'Matches rotate_entity convention. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
      )
      .optional(),
  }),
  run: (doc, { id, depth, rotation }): CommandResult => {
    if (depth <= 0) {
      return noop(doc, `extrude_sketch: depth must be > 0 (got ${depth}); entity ${id} unchanged.`);
    }

    const source = doc.entities[id];
    if (!source) {
      return noop(doc, `extrude_sketch: no entity with id "${id}".`);
    }

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
      // lower-left origin (RectangleEntity convention); corners in CCW order
      profile = [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
      ];
    } else if (source.kind === 'polyline') {
      if (!source.closed) {
        return noop(
          doc,
          `extrude_sketch: polyline "${id}" is not closed; cannot extrude an open profile.`,
        );
      }
      if (source.points.length < 3) {
        return noop(
          doc,
          `extrude_sketch: polyline "${id}" has fewer than 3 points; not a valid closed profile.`,
        );
      }
      profile = source.points as ReadonlyArray<readonly [number, number]>;
    } else {
      // line, arc, point, 3D solids — not a closed 2D profile
      return noop(
        doc,
        `extrude_sketch: entity "${id}" (kind="${source.kind}") is not a closed 2D profile. Use a circle, rectangle, or closed polyline.`,
      );
    }

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

    return commitSolid(
      doc,
      extrusion,
      `extrude_sketch: created extrusion "${extId}" from ${source.kind} "${id}" (${profile.length}-point profile, depth=${depth})`,
    );
  },
});

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
export const revolveProfile = defineCommand({
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
  params: z.object({
    profile: untypedArray(
      'Closed polygon cross-section: array of [x, y] points. x = radial offset from the axis (≥ 0 for outward), ' +
        'y = axial offset along the axis. Minimum 3 points. The polygon is implicitly closed — ' +
        'do NOT repeat the first point at the end.',
    ),
    axis: z
      .union([z.string(), z.array(z.number())])
      .describe(
        'Revolution axis. Use "x", "y", or "z" for the principal axes, or pass a [dx, dy, dz] array ' +
          'for an arbitrary direction (it will be normalised). Default: "z" (natural +Z-up axis).',
      )
      .optional(),
    angle: z
      .number()
      .describe(
        'Sweep angle in radians. Must be > 0. Default: 2π (full 360° revolution). ' +
          'Use π for a half-revolution, π/2 for a quarter, etc.',
      )
      .optional(),
    segments: z
      .number()
      .describe(
        'Number of radial subdivisions for tessellation. Higher = smoother surface. Default: 32. Minimum: 3.',
      )
      .optional(),
    position: looseVec3(
      'World-space origin of the revolution axis [x, y, z] in document units. Default: [0, 0, 0].',
    ).optional(),
    rotation: tolerant(
      looseVec3(
        'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz] applied after revolution. Default: [0, 0, 0]. ' +
          'Malformed or non-length-3 values are ignored and [0,0,0] is used.',
      ),
    ).optional(),
    layerId: z
      .string()
      .describe('Layer id to assign the entity to. Defaults to the document default layer.')
      .optional(),
    color: z.string().describe('Hex color string, e.g. "#c8553d". Default: "#6b8f9c".').optional(),
    id: z
      .string()
      .describe('Optional explicit entity id. If omitted a unique id is generated.')
      .optional(),
  }),
  run: (
    doc,
    {
      profile,
      axis: rawAxis,
      angle: rawAngle,
      segments: rawSegments,
      position = ORIGIN,
      rotation,
      layerId,
      color = '#6b8f9c',
      id: explicitId,
    },
  ): CommandResult => {
    if (profile.length < 3) {
      return noop(
        doc,
        `revolve_profile: profile must be an array of at least 3 [x,y] points (got ${profile.length}); no-op.`,
      );
    }

    const TWO_PI = 2 * Math.PI;
    const angle = rawAngle !== undefined ? rawAngle : TWO_PI;
    if (!Number.isFinite(angle) || angle <= 0) {
      return noop(
        doc,
        `revolve_profile: angle must be a finite number > 0 (got ${String(angle)}); no-op.`,
      );
    }

    const axis = resolveAxis(rawAxis);
    if (axis === null) {
      return noop(
        doc,
        `revolve_profile: axis must be 'x', 'y', 'z', or a [dx,dy,dz] direction array (got ${JSON.stringify(rawAxis)}); no-op.`,
      );
    }

    const segments = Math.max(
      3,
      Math.round(
        typeof rawSegments === 'number' && Number.isFinite(rawSegments) ? rawSegments : 32,
      ),
    );

    const resolvedLayerId =
      typeof layerId === 'string' && doc.layers[layerId] !== undefined
        ? layerId
        : (Object.keys(doc.layers)[0] ?? 'layer-default');

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

    const axisLabel =
      rawAxis === 'x' || rawAxis === 'y' || rawAxis === 'z'
        ? rawAxis
        : `[${axis.map((v) => parseFloat(v.toFixed(3))).join(', ')}]`;
    return commitSolid(
      doc,
      entity,
      `revolve_profile: created revolution "${id}" — ${profile.length}-point profile, axis=${axisLabel}, angle=${parseFloat(angle.toFixed(4))} rad, segments=${segments}`,
    );
  },
});
