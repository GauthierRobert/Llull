import type { Entity, Vec3, Vec2 } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandResult } from './types';
import { formatNumber } from '../lib/format';
import { defineCommand, z, colorField, looseVec2 as vec2 } from './schema';
import { nextId } from '../lib/id';
import { finiteVec3OrZero } from '../lib/vec3';
import { MAX_CURVE_SAMPLES, MAX_SPLINE_CONTROL_POINTS } from './limits';
import { sampleInvolute } from './gears';
import {
  DEFAULT_DRAW_COLOR,
  pointSeriesEntity,
  rejectTooFewPoints,
  workPlanePositionField,
} from './draw2dShared';
import { withEntity } from './entityOps';
import { pointsExtent } from './sceneBounds';
import { noop } from './noop';

/**
 * @command draw_ellipse
 * @pure
 * @layer core/commands
 * @affects creates 1 ellipse entity
 * @invariant radiusX > 0 and radiusY > 0
 * @failure radiusX <= 0 or radiusY <= 0 -> no-op, affected:[]
 */
export const drawEllipse = defineCommand({
  name: 'draw_ellipse',
  description:
    'Draw an axis-aligned ellipse in the local 2D work plane, defined by center and semi-axis radii. ' +
    'radiusX is the half-width along the local X axis; radiusY is the half-height along the local Y axis. ' +
    'Both must be > 0. position places the work-plane origin in 3D space (default [0,0,0]).',
  params: z.object({
    center: vec2('Center point [x, y] of the ellipse in local 2D work-plane coordinates.'),
    radiusX: z
      .number()
      .describe('Semi-axis length along the local X axis (half-width). Must be greater than 0.'),
    radiusY: z
      .number()
      .describe('Semi-axis length along the local Y axis (half-height). Must be greater than 0.'),
    position: workPlanePositionField(),
    color: colorField(DEFAULT_DRAW_COLOR),
  }),
  run: (
    doc,
    { center, radiusX, radiusY, position = [0, 0, 0] as const, color = DEFAULT_DRAW_COLOR },
  ): CommandResult => {
    if (radiusX <= 0 || radiusY <= 0) {
      return noop(
        doc,
        `draw_ellipse: radiusX and radiusY must both be > 0 (got radiusX=${radiusX}, radiusY=${radiusY}).`,
      );
    }
    const id = nextId('ellipse');
    const safeCenter: Vec2 = [center[0], center[1]];
    const entity: Entity = {
      id,
      kind: 'ellipse',
      center: safeCenter,
      radiusX,
      radiusY,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Drew ellipse ${id} center [${safeCenter.join(', ')}] radiusX ${radiusX} radiusY ${radiusY}.`,
      affected: [id],
    };
  },
});

/**
 * @command draw_spline
 * @pure
 * @layer core/commands
 * @affects creates 1 spline entity
 * @invariant points.length >= 2; each point is a 2-element [x,y] array
 * @failure fewer than 2 points or more than MAX_SPLINE_CONTROL_POINTS -> no-op, affected:[]
 */
export const drawSpline = defineCommand({
  name: 'draw_spline',
  description:
    'Draw a Catmull-Rom interpolating spline through an ordered list of 2D through-points in the local work plane. ' +
    'The curve passes through every point (not a control polygon). Requires at least 2 points. ' +
    'When closed=true the spline loops back from the last point to the first. ' +
    'Centripetal Catmull-Rom parameterization is used; tessellation is performed by the renderer.',
  params: z.object({
    points: z
      .array(z.array(z.number()))
      .describe(
        'Ordered list of through-points in local 2D work-plane coordinates. ' +
          'Each point is [x, y]. Minimum 2 points required.',
      ),
    closed: z
      .boolean()
      .describe(
        'When true, the spline loops back from the last point to the first, forming a closed curve. Defaults to false.',
      )
      .optional(),
    position: workPlanePositionField(),
    color: colorField(DEFAULT_DRAW_COLOR),
  }),
  run: (
    doc,
    { points, closed = false, position = [0, 0, 0] as const, color = DEFAULT_DRAW_COLOR },
  ): CommandResult => {
    const tooFew = rejectTooFewPoints(doc, 'draw_spline', points);
    if (tooFew) return tooFew;
    if (points.length > MAX_SPLINE_CONTROL_POINTS) {
      return noop(
        doc,
        `draw_spline: ${points.length} points exceeds MAX_SPLINE_CONTROL_POINTS (${MAX_SPLINE_CONTROL_POINTS}).`,
      );
    }
    const id = nextId('spline');
    const entity = pointSeriesEntity('spline', id, points, closed, position, color);
    return {
      document: withEntity(doc, entity),
      summary: `Drew spline ${id} with ${points.length} points${closed ? ' (closed)' : ''}.`,
      affected: [id],
    };
  },
});

/**
 * @command draw_involute
 * @pure
 * @layer core/commands
 * @affects creates 1 open polyline entity tracing an involute curve
 * @invariant baseRadius > 0; samples >= 2; endAngle > startAngle; all numerics finite
 * @failure baseRadius <= 0, samples < 2, endAngle <= startAngle, or any non-finite numeric -> no-op, affected:[]
 */
export const drawInvolute = defineCommand({
  name: 'draw_involute',
  description:
    'Draw an open 2D involute curve sampled as a polyline in the local work plane. ' +
    'The involute of a circle: x(t) = baseRadius*(cos t + t*sin t), y(t) = baseRadius*(sin t − t*cos t). ' +
    'baseRadius is the base circle radius (must be > 0). ' +
    'startAngle and endAngle are the involute parameter t at the curve start and end (endAngle must be > startAngle). ' +
    'samples is the number of points on the curve (minimum 2; default 24). ' +
    'At t=0 the curve originates at (baseRadius, 0); radial distance from origin at t is baseRadius*sqrt(1+t²). ' +
    'The curve is open (not closed) and can be fed to other commands or used standalone as a reference curve. ' +
    'position is [x,y,z] world-space placement of the work-plane origin (default [0,0,0]). ' +
    'rotation is extrinsic XYZ Euler angles in radians (default [0,0,0]).',
  params: z.object({
    baseRadius: z
      .number()
      .describe(
        'Base circle radius of the involute. Must be > 0. ' +
          'Controls the curvature: smaller baseRadius gives a more tightly wound curve.',
      ),
    startAngle: z
      .number()
      .describe(
        'Involute parameter t at the start of the curve, in radians. Defaults to 0. ' +
          'At t=0 the curve starts at (baseRadius, 0). Must be < endAngle.',
      )
      .optional(),
    endAngle: z
      .number()
      .describe(
        'Involute parameter t at the end of the curve, in radians. Must be > startAngle. ' +
          'The radial distance from origin at the endpoint is baseRadius*sqrt(1 + endAngle²).',
      ),
    samples: z
      .number()
      .describe(
        'Number of points sampled along the curve (inclusive of both endpoints). ' +
          'Minimum 2. Default 24. Higher values give a smoother polyline.',
      )
      .optional(),
    position: workPlanePositionField(),
    rotation: z
      .array(z.number())
      .describe(
        'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz] for the work plane. Defaults to [0,0,0].',
      )
      .optional(),
    color: z
      .string()
      .describe('Hex color string, e.g. "#4a90d9". Defaults to "#4a90d9".')
      .optional(),
    name: z
      .string()
      .describe('Optional display name for the entity (shown in the scene tree).')
      .optional(),
  }),
  run: (
    doc,
    {
      baseRadius,
      startAngle = 0,
      endAngle,
      samples = 24,
      position = [0, 0, 0] as const,
      rotation = [0, 0, 0],
      color = DEFAULT_DRAW_COLOR,
      name,
    },
  ): CommandResult => {
    if (!Number.isFinite(baseRadius)) {
      return noop(doc, `draw_involute: baseRadius must be finite, got ${String(baseRadius)}.`);
    }
    if (!Number.isFinite(startAngle)) {
      return noop(doc, `draw_involute: startAngle must be finite, got ${String(startAngle)}.`);
    }
    if (!Number.isFinite(endAngle)) {
      return noop(doc, `draw_involute: endAngle must be finite, got ${String(endAngle)}.`);
    }
    if (!Number.isFinite(samples)) {
      return noop(doc, `draw_involute: samples must be finite, got ${String(samples)}.`);
    }

    if (baseRadius <= 0) {
      return noop(doc, `draw_involute: baseRadius must be > 0, got ${baseRadius}.`);
    }
    const samplesInt = Math.round(samples);
    if (samplesInt < 2 || samplesInt > MAX_CURVE_SAMPLES) {
      return noop(
        doc,
        `draw_involute: samples must be in [2, ${MAX_CURVE_SAMPLES}], got ${samples}.`,
      );
    }
    if (endAngle <= startAngle) {
      return noop(
        doc,
        `draw_involute: endAngle (${endAngle}) must be > startAngle (${startAngle}).`,
      );
    }

    const resolvedPos: Vec3 = finiteVec3OrZero(position);

    const resolvedRot: Vec3 = finiteVec3OrZero(rotation);

    const rawPoints = sampleInvolute(baseRadius, startAngle, endAngle, samplesInt);
    const pts: ReadonlyArray<Vec2> = rawPoints.map(([x, y]) => [x, y] as Vec2);

    const { minX, minY, maxX, maxY } = pointsExtent(pts);

    const id = nextId('inv');
    const entity: Entity = {
      id,
      kind: 'polyline',
      points: pts,
      closed: false,
      position: resolvedPos,
      rotation: resolvedRot,
      layerId: DEFAULT_LAYER_ID,
      color,
      ...(name !== undefined && name !== '' ? { name } : {}),
    };

    return {
      document: withEntity(doc, entity),
      summary:
        `Drew involute ${id}: baseRadius=${formatNumber(baseRadius)} t=[${formatNumber(startAngle)}, ${formatNumber(endAngle)}] ` +
        `samples=${samplesInt} AABB x=[${formatNumber(minX)}, ${formatNumber(maxX)}] y=[${formatNumber(minY)}, ${formatNumber(maxY)}].`,
      affected: [id],
    };
  },
});
