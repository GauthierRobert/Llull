import type { Vec2 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z, colorField, looseVec2 as vec2, looseVec3 as vec3 } from '../schema';
import { nextId } from '../../lib/id';
import { ORIGIN } from '../../lib/vec3';
import { commitEntity } from '../entity/commitEntity';
import { newEntity } from '../entity/newEntity';
import { DEFAULT_DRAW_COLOR, drawPointSeries, workPlanePositionField } from './shared';
import { noop } from '../noop';

/**
 * @command draw_polyline
 * @pure
 * @layer core/commands
 * @affects creates 1 polyline entity, or 1 line entity for an open 2-point series
 * @invariant points.length >= 2; each point is a 2-element [x,y] array
 * @failure fewer than 2 points -> no-op, affected:[]
 */
export const drawPolyline = defineCommand({
  name: 'draw_polyline',
  description:
    'Draw a connected sequence of line segments through an ordered list of 2D points in the local work plane. ' +
    'Requires at least 2 points. When closed=true the last point connects back to the first. ' +
    'An OPEN series of exactly 2 points is a single straight segment and creates a `line` entity (id line-*); ' +
    'any other series creates a `polyline` entity (id poly-*). ' +
    'A closed polyline can be fed to extrude_profile (id/ids) to become a 3D solid.',
  params: z.object({
    points: z
      .array(z.array(z.number()))
      .describe(
        'Ordered list of [x, y] vertices in local 2D work-plane coordinates. Minimum 2 points required.',
      ),
    closed: z
      .boolean()
      .describe(
        'When true, the last point connects back to the first point, forming a closed loop. Defaults to false.',
      )
      .optional(),
    position: workPlanePositionField(),
    color: colorField(DEFAULT_DRAW_COLOR),
  }),
  run: (
    doc,
    { points, closed = false, position = ORIGIN, color = DEFAULT_DRAW_COLOR },
  ): CommandResult => {
    const [start, end] = points;
    if (points.length === 2 && !closed && start && end) {
      const id = nextId('line');
      const entity = newEntity(
        'line',
        id,
        { start: [start[0] ?? 0, start[1] ?? 0], end: [end[0] ?? 0, end[1] ?? 0] },
        position,
        color,
      );
      return commitEntity(
        doc,
        entity,
        `Drew line ${id} from [${start.join(', ')}] to [${end.join(', ')}].`,
      );
    }
    return drawPointSeries(doc, 'polyline', points, closed, position, color);
  },
});

/**
 * @command draw_arc
 * @pure
 * @layer core/commands
 * @affects creates 1 arc entity, or 1 circle entity when both angles are omitted
 * @invariant radius > 0; a sweep |endAngle - startAngle| > 2π is stored wrapped into (0, 2π] (the
 *   CCW sweep every consumer — render, measure, extrude — reads)
 * @failure radius <= 0, non-finite angles, or only one angle given -> no-op, affected:[]
 */
export const drawArc = defineCommand({
  name: 'draw_arc',
  description:
    'Draw a circular arc or a full circle in the local 2D work plane, defined by center and radius (and start/end angles in radians for an arc). ' +
    'Angles are measured counter-clockwise from the +X axis. radius must be > 0. ' +
    'The arc sweeps CCW from startAngle to endAngle (endAngle < startAngle wraps around CCW); a sweep larger ' +
    'than 2π is wrapped into (0, 2π] and the summary says so. OMIT BOTH startAngle and endAngle to draw a full ' +
    'circle (a `circle` entity, id circ-*); give both for an `arc` entity (id arc-*).',
  params: z.object({
    center: vec2('Center point [x, y] of the arc in local 2D work-plane coordinates.'),
    radius: z.number().describe('Arc radius. Must be greater than 0.'),
    startAngle: z
      .number()
      .describe(
        'Start angle in radians, measured counter-clockwise from the +X axis. E.g. 0 = rightmost point. Omit together with endAngle for a full circle.',
      )
      .optional(),
    endAngle: z
      .number()
      .describe(
        'End angle in radians, measured counter-clockwise from the +X axis. Arc sweeps from startAngle to endAngle counter-clockwise. Omit together with startAngle for a full circle.',
      )
      .optional(),
    position: workPlanePositionField(),
    color: colorField(DEFAULT_DRAW_COLOR),
  }),
  run: (
    doc,
    { center, radius, startAngle, endAngle, position = ORIGIN, color = DEFAULT_DRAW_COLOR },
  ): CommandResult => {
    if (radius <= 0) return noop(doc, `draw_arc: radius must be > 0 (got ${radius}).`);
    if (startAngle === undefined && endAngle === undefined) {
      const circleId = nextId('circ');
      const circleCenter: Vec2 = [center[0], center[1]];
      const circle = newEntity(
        'circle',
        circleId,
        { center: circleCenter, radius },
        position,
        color,
      );
      return commitEntity(
        doc,
        circle,
        `Drew circle ${circleId} center [${circleCenter.join(', ')}] radius ${radius}.`,
      );
    }
    if (startAngle === undefined || endAngle === undefined)
      return noop(doc, 'draw_arc: give both startAngle and endAngle (arc) or neither (circle).');
    if (!Number.isFinite(startAngle) || !Number.isFinite(endAngle))
      return noop(doc, 'draw_arc: startAngle and endAngle must be finite numbers.');
    const tau = 2 * Math.PI;
    const span = endAngle - startAngle;
    const wrapped = Math.abs(span) > tau + 1e-9;
    const rest = ((span % tau) + tau) % tau;
    // A whole number of turns (up to float noise) is a full circle, never a near-zero sliver.
    const end = wrapped ? startAngle + (rest < 1e-6 || tau - rest < 1e-6 ? tau : rest) : endAngle;
    const id = nextId('arc');
    const safeCenter: Vec2 = [center[0], center[1]];
    const entity = newEntity(
      'arc',
      id,
      { center: safeCenter, radius, startAngle, endAngle: end },
      position,
      color,
    );
    return commitEntity(
      doc,
      entity,
      `Drew arc ${id} center [${safeCenter.join(', ')}] radius ${radius} from ${startAngle.toFixed(3)} to ${end.toFixed(3)} rad.` +
        (wrapped
          ? ` The requested sweep ${span.toFixed(3)} rad exceeded 2π: wrapped to ${(end - startAngle).toFixed(3)} rad CCW.`
          : ''),
    );
  },
});

/**
 * @command draw_rectangle
 * @pure
 * @layer core/commands
 * @affects creates 1 rectangle entity
 * @invariant width > 0 and height > 0
 * @failure width <= 0 or height <= 0 -> no-op, affected:[]
 */
export const drawRectangle = defineCommand({
  name: 'draw_rectangle',
  description:
    'Draw an axis-aligned rectangle in the local 2D work plane. ' +
    'The origin is at the lower-left corner; width extends along +X, height along +Y. ' +
    'position places the work-plane origin in 3D space. Both width and height must be > 0.',
  params: z.object({
    width: z
      .number()
      .describe('Width of the rectangle along the local X axis. Must be greater than 0.'),
    height: z
      .number()
      .describe('Height of the rectangle along the local Y axis. Must be greater than 0.'),
    position: vec3(
      'World-space position [x, y, z] of the work-plane origin (lower-left corner). Defaults to [0,0,0].',
    ).optional(),
    color: colorField(DEFAULT_DRAW_COLOR),
  }),
  run: (doc, { width, height, position = ORIGIN, color = DEFAULT_DRAW_COLOR }): CommandResult => {
    if (width <= 0 || height <= 0) {
      return noop(
        doc,
        `draw_rectangle: width and height must both be > 0 (got ${width}×${height}).`,
      );
    }
    const id = nextId('rect');
    const entity = newEntity('rectangle', id, { width, height }, position, color);
    return commitEntity(
      doc,
      entity,
      `Drew rectangle ${id} ${width}×${height} at [${position.join(', ')}].`,
    );
  },
});

/**
 * @command draw_point
 * @pure
 * @layer core/commands
 * @affects creates 1 point entity
 * @invariant position is a 3-element [x,y,z] array (defaults to [0,0,0])
 */
export const drawPoint = defineCommand({
  name: 'draw_point',
  description:
    'Place a point marker at the given 3D world position. ' +
    'The point entity has no local 2D geometry — its position is the point location.',
  params: z.object({
    position: vec3('World-space position [x, y, z] of the point. Defaults to [0,0,0].').optional(),
    color: colorField(DEFAULT_DRAW_COLOR),
  }),
  run: (doc, { position = ORIGIN, color = DEFAULT_DRAW_COLOR }): CommandResult => {
    const id = nextId('pt');
    const entity = newEntity('point', id, {}, position, color);
    return commitEntity(doc, entity, `Drew point ${id} at [${position.join(', ')}].`);
  },
});
