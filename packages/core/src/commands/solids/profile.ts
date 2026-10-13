import type { CadDocument, Vec2, Vec3 } from '../../model/types';
import type { CurveSegment } from '../../model/curve';
import type { CommandResult } from '../types';
import { defineCommand, z, looseVec3, tolerant, untypedArray, colorField } from '../schema';
import { axisVector, isValidAxis } from '../../lib/axis';
import { ORIGIN, finiteVec3OrZero, len3 } from '../../lib/vec3';
import { noop } from '../noop';
import { MAX_PROFILE_POINTS, MAX_REVOLVE_SEGMENTS } from '../limits';
import { newEntity } from '../entity/newEntity';
import { nextId } from '../../lib/id';
import { compactNumber, fixedNumber } from '../../lib/compactNumber';
import {
  DEFAULT_SOLID_COLOR,
  EXTRUSION_COLOR,
  ROTATION_CONVENTION,
  commitSolid,
  rejectBadProfile,
  rejectZeroAreaProfile,
  resolveRotation,
  axisField,
  rotationField,
  existingLayerOrDefault,
  solidStyleFields,
  explicitIdOrNext,
  explicitIdTaken,
} from './shared';
import { sketchLoop } from './sketchCurves';
import { mapSegment } from '../../geometry/curveSegments';

/**
 * @command extrude_profile
 * @pure
 * @layer core/commands
 * @affects creates 1 extrusion entity; sources (id/ids) are kept
 * @invariant depth > 0; exactly one of profile (>= 3 finite [x,y] points), id, ids
 * @invariant sketch sources store their exact `curves` and sit at the (first) source position unless
 *   `position` is given; the source rotation is not inherited
 * @failure no/ambiguous source, profile < 3 points or non-finite, open/unsupported sketch, pieces
 *   that do not close, depth <= 0, zero-length axis -> no-op, affected:[]
 * @failure malformed rotation -> entity still created with rotation [0,0,0]
 */
export const extrudeProfile = defineCommand({
  name: 'extrude_profile',
  description:
    'Extrude a closed 2D profile along +Z into an extrusion solid. Right-handed world frame, +Z up. ' +
    'Give EXACTLY ONE source: `profile` (inline array of [x, y] points, at least 3, implicitly closed, ' +
    'placed at `position`, default [0,0,0]); OR `id` of one closed drawn shape (circle, rectangle, ellipse, ' +
    'closed polyline, closed spline); OR `ids` of several coplanar open pieces (line, arc, open polyline, ' +
    'open spline) that join end to end into one closed loop, in any order and direction. A drawn sketch ' +
    'keeps its curved boundaries exact (true arcs and Bézier splines for the exact kernel and STEP export; ' +
    'the polygon is only the display tessellation), is placed at the (first) source entity position ' +
    '(override with `position`), does not inherit the source rotation, and stays in the document. ' +
    'The solid spans from the position along +Z for depth units (depth must be > 0). ' +
    'Orientation: pass EITHER rotation (Euler radians) OR axis [dx,dy,dz] = the extrusion direction ' +
    '(the profile plane normal; local +Z maps to it). axis wins when both are given; the derived Euler angles are stored.',
  params: z.object({
    profile: untypedArray(
      'Inline closed loop: array of [x, y] points in the XY plane of the profile (at least 3, do not repeat ' +
        'the first point). Omit when id or ids is given.',
    ).optional(),
    id: z
      .string()
      .describe(
        'Id of one closed 2D shape: circle, rectangle, ellipse, closed polyline or closed spline. Use ids instead for a loop made of several pieces.',
      )
      .optional(),
    ids: z
      .array(z.string())
      .describe(
        'Ids of coplanar 2D pieces (line, arc, polyline, spline) that join end to end into one closed loop; order and direction do not matter. Alternative to id and profile.',
      )
      .optional(),
    depth: z.number().describe('Extrusion depth in document units along +Z from the position. Must be > 0.'),
    position: looseVec3(
      'World-space origin of the profile plane [x, y, z] in document units. Defaults to [0, 0, 0] for an ' +
        'inline profile and to the (first) source entity position for id/ids.',
    ).optional(),
    rotation: rotationField(),
    axis: axisField('is the extrusion direction (local +Z)'),
    color: colorField(EXTRUSION_COLOR),
  }),
  run: (doc, { profile, id, ids, depth, position, rotation, axis, color = EXTRUSION_COLOR }) => {
    const sources = [profile, id, ids].filter((source) => source !== undefined).length;
    if (sources === 0)
      return noop(doc, 'extrude_profile: give profile (inline points), id (one closed shape) or ids (pieces of a loop); no-op.');
    if (sources > 1) return noop(doc, 'extrude_profile: pass only one of profile, id or ids, not both; no-op.');
    if (profile !== undefined) {
      const rejected = rejectInlineProfile(doc, profile, depth);
      if (rejected) return rejected;
      return extrusionResult(doc, {
        profile,
        depth,
        position: position ?? ORIGIN,
        rotation,
        axis,
        color,
        describe: () => `Extruded a ${profile.length}-point profile by ${depth}`,
      });
    }
    const label = id ?? (ids ?? []).join(', ');
    if (depth <= 0) return noop(doc, `extrude_profile: depth must be > 0 (got ${depth}); entity ${label} unchanged.`);
    const sourceIds = ids ?? (id !== undefined ? [id] : []);
    if (sourceIds.length === 0) return noop(doc, 'extrude_profile: ids must not be empty.');
    if (sourceIds.length === 1) {
      const single = singleSourceIssue(doc, sourceIds[0] as string);
      if (single !== null) return noop(doc, `extrude_profile: ${single}`);
    }
    const loop = sketchLoop(doc, sourceIds);
    if (typeof loop === 'string') return noop(doc, `extrude_profile: ${loop}; no-op.`);
    const flatProfile = rejectZeroAreaProfile(doc, 'extrude_profile', loop.profile);
    if (flatProfile) return flatProfile;
    const source = sourceIds.length === 1 ? `${doc.entities[label]?.kind} "${label}"` : `[${label}]`;
    return extrusionResult(doc, {
      profile: loop.profile,
      depth,
      position: position ?? loop.origin,
      rotation,
      axis,
      color,
      curves: loop.curves,
      describe: (extId) =>
        `extrude_profile: created extrusion "${extId}" from ${source} (${loop.profile.length}-point profile${curveNote(loop.curves)}, depth=${depth})`,
    });
  },
});

function rejectInlineProfile(doc: CadDocument, profile: ReadonlyArray<readonly [number, number]>, depth: number): CommandResult | null {
  if (profile.length < 3) return noop(doc, `extrude_profile: profile must be an array of at least 3 [x,y] points; no-op.`);
  if (profile.length > MAX_PROFILE_POINTS)
    return noop(doc, `extrude_profile: profile has ${profile.length} points, exceeding MAX_PROFILE_POINTS (${MAX_PROFILE_POINTS}); no-op.`);
  const badProfile = rejectBadProfile(doc, 'extrude_profile', profile);
  if (badProfile) return badProfile;
  const flatProfile = rejectZeroAreaProfile(doc, 'extrude_profile', profile);
  if (flatProfile) return flatProfile;
  if (depth <= 0) return noop(doc, `extrude_profile: depth must be a finite number > 0 (got ${String(depth)}); no-op.`);
  return null;
}

function extrusionResult(
  doc: CadDocument,
  extrusion: {
    readonly profile: ReadonlyArray<readonly [number, number]>;
    readonly depth: number;
    readonly position: Vec3;
    readonly rotation: unknown;
    readonly axis: unknown;
    readonly color: string;
    readonly curves?: ReadonlyArray<CurveSegment<Vec2>>;
    readonly describe: (id: string) => string;
  },
): CommandResult {
  const resolved = resolveRotation(extrusion.axis, extrusion.rotation);
  if (resolved.error !== undefined) return noop(doc, `extrude_profile: ${resolved.error}; no-op.`);
  const id = nextId('ext');
  const entity = newEntity(
    'extrusion',
    id,
    {
      profile: extrusion.profile,
      depth: extrusion.depth,
      ...exactCurves(extrusion.curves ?? []),
    },
    extrusion.position,
    extrusion.color,
    { rotation: resolved.rotation },
  );
  return commitSolid(doc, entity, extrusion.describe(id));
}

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

const CLOSED_SHAPE_KINDS: ReadonlySet<string> = new Set(['circle', 'rectangle', 'ellipse', 'polyline', 'spline']);

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
    position: looseVec3('World-space origin of the revolution axis [x, y, z] in document units. Default: [0, 0, 0].').optional(),
    rotation: tolerant(
      looseVec3(
        `${ROTATION_CONVENTION} applied after revolution. Default: [0, 0, 0]. ` +
          'Malformed or non-length-3 values are ignored and [0,0,0] is used.',
      ),
    ).optional(),
    ...solidStyleFields(),
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
      return noop(doc, `revolve_profile: profile must be an array of at least 3 [x,y] points (got ${profile.length}); no-op.`);
    }
    if (profile.length > MAX_PROFILE_POINTS) {
      return noop(
        doc,
        `revolve_profile: profile has ${profile.length} points, exceeding MAX_PROFILE_POINTS (${MAX_PROFILE_POINTS}); no-op.`,
      );
    }
    if (rawSegments !== undefined && rawSegments > MAX_REVOLVE_SEGMENTS) {
      return noop(doc, `revolve_profile: segments ${rawSegments} exceeds MAX_REVOLVE_SEGMENTS (${MAX_REVOLVE_SEGMENTS}); no-op.`);
    }
    const badProfile = rejectBadProfile(doc, 'revolve_profile', profile);
    if (badProfile) return badProfile;
    const flatProfile = rejectZeroAreaProfile(doc, 'revolve_profile', profile);
    if (flatProfile) return flatProfile;
    if (explicitIdTaken(doc, explicitId)) {
      return noop(doc, `revolve_profile: entity id "${explicitId}" already exists; choose another id or omit it; no-op.`);
    }

    const TWO_PI = 2 * Math.PI;
    const angle = rawAngle ?? TWO_PI;
    if (angle <= 0) {
      return noop(doc, `revolve_profile: angle must be a finite number > 0 (got ${String(angle)}); no-op.`);
    }

    const axis = resolveAxis(rawAxis);
    if (axis === null) {
      return noop(
        doc,
        `revolve_profile: axis must be 'x', 'y', 'z', or a [dx,dy,dz] direction array (got ${JSON.stringify(rawAxis)}); no-op.`,
      );
    }

    const segments = Math.max(3, rawSegments ?? 32);

    const id = explicitIdOrNext(explicitId, 'rev');
    const entity = newEntity(
      'revolution',
      id,
      { profile, axis, angle: Math.min(angle, TWO_PI), segments, ...exactCurves(curves) },
      position,
      color,
      {
        rotation: finiteVec3OrZero(rotation),
        layerId: existingLayerOrDefault(doc, layerId),
      },
    );

    const axisLabel =
      rawAxis === 'x' || rawAxis === 'y' || rawAxis === 'z' ? rawAxis : `[${axis.map((v) => fixedNumber(v, 3)).join(', ')}]`;
    return commitSolid(
      doc,
      entity,
      `revolve_profile: created revolution "${id}" — ${profile.length}-point profile${curveNote(curves)}, axis=${axisLabel}, angle=${compactNumber(angle)} rad, segments=${segments}`,
    );
  },
});
