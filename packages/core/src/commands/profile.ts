import { type CadDocument, type Vec2, type Vec3, DEFAULT_LAYER_ID } from '../model/types';
import type { CurveSegment } from '../model/curve';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3, tolerant, untypedArray, colorField } from './schema';
import { axisVector, isValidAxis } from '../lib/axis';
import { ORIGIN, finiteVec3OrZero, len3 } from '../lib/vec3';
import { noop } from './noop';
import { MAX_PROFILE_POINTS, MAX_REVOLVE_SEGMENTS } from './limits';
import { newEntity } from './newEntity';
import { nextId } from '../lib/id';
import { compactNumber } from '../lib/compactNumber';
import {
  DEFAULT_SOLID_COLOR,
  EXTRUSION_COLOR,
  ROTATION_CONVENTION,
  commitSolid,
  rejectBadProfile,
  rejectZeroAreaProfile,
} from './geometryShared';
import { sketchLoop } from './sketchCurves';
import { mapSegment } from '../geometry/curveSegments';

/**
 * @command extrude_sketch
 * @pure
 * @layer core/commands
 * @affects creates 1 extrusion entity at the (first) source position; sources kept
 * @invariant depth > 0; resulting rotation = `rotation` param only (source rotation not inherited)
 * @invariant curved sources (arc, circle, ellipse, spline) store their exact `curves`
 * @failure missing id / unsupported or open source / pieces that do not close / depth <= 0 -> no-op
 */
export const extrudeSketch = defineCommand({
  name: 'extrude_sketch',
  description:
    'Extrude a closed 2D sketch into a 3D extrusion solid. Right-handed world frame, +Z up. ' +
    'Give `id` of one closed shape (circle, rectangle, ellipse, closed polyline, closed spline), or `ids` ' +
    'of several coplanar open pieces (line, arc, open polyline, open spline) that join end to end into ' +
    'one closed loop, in any order and direction. Curved boundaries are kept exact (true arcs and ' +
    'Bézier splines for the exact kernel and STEP export; the polygon is only the display tessellation). ' +
    'The solid is placed at the (first) source entity position and extends depth units along +Z ' +
    '(before the optional rotation); the source rotation is not inherited. Sources stay in the document.',
  params: z.object({
    id: z
      .string()
      .describe(
        'Id of one closed 2D shape: circle, rectangle, ellipse, closed polyline or closed spline. Use ids instead for a loop made of several pieces.',
      )
      .optional(),
    ids: z
      .array(z.string())
      .describe(
        'Ids of coplanar 2D pieces (line, arc, polyline, spline) that join end to end into one closed loop; order and direction do not matter. Alternative to id.',
      )
      .optional(),
    depth: z
      .number()
      .describe(
        'Extrusion depth in document units along +Z from the source entity position. Must be > 0.',
      ),
    rotation: z
      .array(z.number())
      .describe(
        `${ROTATION_CONVENTION} for the resulting extrusion solid. ` +
          'Matches rotate_entity convention. Defaults to [0, 0, 0]. ' +
          'If non-finite or not length-3 the rotation is ignored and [0,0,0] is used.',
      )
      .optional(),
  }),
  run: (doc, { id, ids, depth, rotation }): CommandResult => {
    const label = id ?? (ids ?? []).join(', ');
    if (depth <= 0)
      return noop(
        doc,
        `extrude_sketch: depth must be > 0 (got ${depth}); entity ${label} unchanged.`,
      );
    if (id !== undefined && ids !== undefined)
      return noop(doc, 'extrude_sketch: pass either id or ids, not both; no-op.');
    const sourceIds = ids ?? (id !== undefined ? [id] : []);
    if (sourceIds.length === 0)
      return noop(doc, 'extrude_sketch: give id (one closed shape) or ids (pieces of a loop).');
    if (sourceIds.length === 1) {
      const single = singleSourceIssue(doc, sourceIds[0] as string);
      if (single !== null) return noop(doc, `extrude_sketch: ${single}`);
    }
    const loop = sketchLoop(doc, sourceIds);
    if (typeof loop === 'string') return noop(doc, `extrude_sketch: ${loop}; no-op.`);
    const { profile } = loop;
    const flatProfile = rejectZeroAreaProfile(doc, 'extrude_sketch', profile);
    if (flatProfile) return flatProfile;

    const extId = nextId('ext');
    const extrusion = newEntity(
      'extrusion',
      extId,
      { profile, depth, ...exactCurves(loop.curves) },
      loop.origin,
      EXTRUSION_COLOR,
      { rotation: finiteVec3OrZero(rotation) },
    );
    const source =
      sourceIds.length === 1 ? `${doc.entities[label]?.kind} "${label}"` : `[${label}]`;
    return commitSolid(
      doc,
      extrusion,
      `extrude_sketch: created extrusion "${extId}" from ${source} (${profile.length}-point profile${curveNote(loop.curves)}, depth=${depth})`,
    );
  },
});

/** Legacy single-shape messages: missing, open, too short or a non-closable kind. */
function singleSourceIssue(doc: CadDocument, id: string): string | null {
  const source = doc.entities[id];
  if (!source) return `no entity with id "${id}".`;
  if ((source.kind === 'polyline' || source.kind === 'spline') && !source.closed)
    return `${source.kind} "${id}" is not closed; cannot extrude an open profile (pass several pieces in ids to close a loop).`;
  if (source.kind === 'polyline' && source.points.length < 3)
    return `polyline "${id}" has fewer than 3 points; not a valid closed profile.`;
  if (!CLOSED_SHAPE_KINDS.has(source.kind))
    return `entity "${id}" (kind="${source.kind}") is not a closed 2D profile. Use a circle, rectangle, ellipse, closed polyline or closed spline, or several pieces in ids.`;
  return null;
}

const CLOSED_SHAPE_KINDS: ReadonlySet<string> = new Set([
  'circle',
  'rectangle',
  'ellipse',
  'polyline',
  'spline',
]);

/** `{ curves }` when the loop has an arc or Bézier (a pure polygon needs no exact copy). */
function exactCurves(curves: ReadonlyArray<CurveSegment<Vec2>>): {
  curves?: ReadonlyArray<CurveSegment<Vec2>>;
} {
  return curves.some((segment) => segment.type !== 'line') ? { curves } : {};
}

function curveNote(curves: ReadonlyArray<CurveSegment<Vec2>>): string {
  const curved = curves.filter((segment) => segment.type !== 'line').length;
  return curved > 0 ? `, ${curved} exact curve segment(s)` : '';
}

/**
 * Unit Vec3 of a raw axis param ('x'|'y'|'z' or a finite 3-array), +Z when omitted (+Z-up document);
 * null when invalid or zero-length.
 */
function resolveAxis(raw: unknown): Vec3 | null {
  if (raw === undefined) return [0, 0, 1];
  if (!isValidAxis(raw)) return null;
  const [ax, ay, az] = axisVector(raw);
  const len = len3([ax, ay, az]);
  return len < 1e-10 ? null : [ax / len, ay / len, az / len];
}

/**
 * @command revolve_profile
 * @pure
 * @layer core/commands
 * @affects creates 1 revolution entity — surface of revolution from a closed 2D polygon profile
 * @invariant profile.length >= 3; angle in (0, 2π]; segments >= 3
 * @failure profile < 3 points or any point not a finite [x,y] pair -> no-op, affected:[]
 * @failure explicit id already in doc.entities -> no-op, affected:[]
 * @failure unknown layerId -> default layer
 * @failure angle <= 0 or non-finite -> no-op, affected:[]
 * @failure invalid axis (not 'x'/'y'/'z' and not a valid Vec3) -> no-op, affected:[]
 * @failure segments < 3 -> clamped to 3, no no-op
 */
export const revolveProfile = defineCommand({
  name: 'revolve_profile',
  description:
    'Create a surface of revolution by rotating a closed 2D profile around an axis. ' +
    'Right-handed world frame, +Z up. ' +
    'Either pass profile, an array of [x, y] points where x is the radial offset from the axis and y is the axial offset ' +
    '(at least 3 points, implicitly closed), or profileIds: drawn 2D sketch entities (spline, arc, line, polyline, circle, ellipse) ' +
    'that form one closed loop, read in their sketch-plane coordinates (x = radial, y = axial). ' +
    'A sketched profile keeps its exact curves (smooth bell nozzles, domes, fillets) for the exact kernel and STEP export. ' +
    'axis controls the revolution axis: "x", "y", or "z" (shorthand), or a [dx,dy,dz] direction vector. ' +
    'Default axis is "z" (+Z up, the natural axis for a Z-up document). ' +
    'angle is the sweep in radians (default 2π for a full revolution; must be > 0). ' +
    'segments is the number of radial subdivisions (default 32, minimum 3). ' +
    'Stores a parametric revolution entity; tessellated as triangles in render_view and export_stl.',
  params: z.object({
    profile: untypedArray(
      'Closed polygon cross-section: array of [x, y] points. x = radial offset from the axis (≥ 0 for outward), ' +
        'y = axial offset along the axis. Minimum 3 points. The polygon is implicitly closed — ' +
        'do NOT repeat the first point at the end. Omit when profileIds is given.',
    ).optional(),
    profileIds: z
      .array(z.string())
      .describe(
        'Ids of coplanar 2D sketch entities forming one closed loop (one closed shape, or open pieces such as a spline ' +
          'plus lines that join end to end in any order). Their sketch-plane x is the radial offset, y the axial offset; ' +
          'curves are kept exact. Alternative to profile.',
      )
      .optional(),
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
      .int()
      .describe(
        'Number of radial subdivisions for tessellation. Integer; higher = smoother surface. Default: 32. Minimum: 3 (smaller values are raised to 3).',
      )
      .optional(),
    position: looseVec3(
      'World-space origin of the revolution axis [x, y, z] in document units. Default: [0, 0, 0].',
    ).optional(),
    rotation: tolerant(
      looseVec3(
        `${ROTATION_CONVENTION} applied after revolution. Default: [0, 0, 0]. ` +
          'Malformed or non-length-3 values are ignored and [0,0,0] is used.',
      ),
    ).optional(),
    layerId: z
      .string()
      .describe('Layer id to assign the entity to. Defaults to the document default layer.')
      .optional(),
    color: colorField(DEFAULT_SOLID_COLOR),
    id: z
      .string()
      .describe('Optional explicit entity id. If omitted a unique id is generated.')
      .optional(),
  }),
  run: (
    doc,
    {
      profile: rawProfile,
      profileIds,
      axis: rawAxis,
      angle: rawAngle,
      segments: rawSegments,
      position = ORIGIN,
      rotation,
      layerId,
      color = DEFAULT_SOLID_COLOR,
      id: explicitId,
    },
  ): CommandResult => {
    if (rawProfile !== undefined && profileIds !== undefined)
      return noop(doc, 'revolve_profile: pass either profile or profileIds, not both; no-op.');
    let profile: ReadonlyArray<readonly [number, number]> = rawProfile ?? [];
    let curves: ReadonlyArray<CurveSegment<Vec2>> = [];
    if (profileIds !== undefined) {
      const loop = sketchLoop(doc, profileIds);
      if (typeof loop === 'string') return noop(doc, `revolve_profile: ${loop}; no-op.`);
      const [dx, dy] = loop.planeOffset;
      const shift = ([x, y]: Vec2): Vec2 => [x + dx, y + dy];
      profile = loop.profile.map(shift);
      curves = loop.curves.map((segment) => mapSegment(segment, shift));
    }
    if (profile.length < 3) {
      return noop(
        doc,
        `revolve_profile: profile must be an array of at least 3 [x,y] points (got ${profile.length}); no-op.`,
      );
    }
    if (profile.length > MAX_PROFILE_POINTS) {
      return noop(
        doc,
        `revolve_profile: profile has ${profile.length} points, exceeding MAX_PROFILE_POINTS (${MAX_PROFILE_POINTS}); no-op.`,
      );
    }
    if (rawSegments !== undefined && rawSegments > MAX_REVOLVE_SEGMENTS) {
      return noop(
        doc,
        `revolve_profile: segments ${rawSegments} exceeds MAX_REVOLVE_SEGMENTS (${MAX_REVOLVE_SEGMENTS}); no-op.`,
      );
    }
    const badProfile = rejectBadProfile(doc, 'revolve_profile', profile);
    if (badProfile) return badProfile;
    const flatProfile = rejectZeroAreaProfile(doc, 'revolve_profile', profile);
    if (flatProfile) return flatProfile;
    if (
      explicitId !== undefined &&
      explicitId.length > 0 &&
      Object.hasOwn(doc.entities, explicitId)
    ) {
      return noop(
        doc,
        `revolve_profile: entity id "${explicitId}" already exists; choose another id or omit it; no-op.`,
      );
    }

    const TWO_PI = 2 * Math.PI;
    const angle = rawAngle ?? TWO_PI;
    if (angle <= 0) {
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

    const segments = Math.max(3, rawSegments ?? 32);

    const id = explicitId !== undefined && explicitId.length > 0 ? explicitId : nextId('rev');
    const entity = newEntity(
      'revolution',
      id,
      { profile, axis, angle: Math.min(angle, TWO_PI), segments, ...exactCurves(curves) },
      position,
      color,
      {
        rotation: finiteVec3OrZero(rotation),
        layerId:
          layerId !== undefined && Object.hasOwn(doc.layers, layerId) ? layerId : DEFAULT_LAYER_ID,
      },
    );

    const axisLabel =
      rawAxis === 'x' || rawAxis === 'y' || rawAxis === 'z'
        ? rawAxis
        : `[${axis.map((v) => parseFloat(v.toFixed(3))).join(', ')}]`;
    return commitSolid(
      doc,
      entity,
      `revolve_profile: created revolution "${id}" — ${profile.length}-point profile${curveNote(curves)}, axis=${axisLabel}, angle=${compactNumber(angle)} rad, segments=${segments}`,
    );
  },
});
