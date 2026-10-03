import type { Entity, Vec2 } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, colorField, looseVec2 as vec2, looseVec3 as vec3 } from './schema';
import { nextId } from '../lib/id';
import { withEntity } from './entityOps';
import {
  DEFAULT_DRAW_COLOR,
  pointSeriesEntity,
  rejectTooFewPoints,
  workPlanePositionField,
} from './draw2dShared';

// ---------------------------------------------------------------------------
// draw_line
// ---------------------------------------------------------------------------

/**
 * @command draw_line
 * @pure
 * @layer core/commands
 * @affects creates 1 line entity
 * @invariant start and end are 2-element [x,y] arrays
 * @failure invalid start/end -> no-op, affected:[]
 */
export const drawLine = defineCommand({
  name: 'draw_line',
  description:
    'Draw a straight line segment defined by start and end points in the local 2D work plane. ' +
    'position places the work-plane origin in 3D space (default [0,0,0]).',
  params: z.object({
    start: vec2('Start point [x, y] in local 2D work-plane coordinates.'),
    end: vec2('End point [x, y] in local 2D work-plane coordinates.'),
    position: workPlanePositionField(),
    color: colorField(DEFAULT_DRAW_COLOR),
  }),
  run: (
    doc,
    { start, end, position = [0, 0, 0] as const, color = DEFAULT_DRAW_COLOR },
  ): CommandResult => {
    if (!Array.isArray(start) || start.length < 2 || !Array.isArray(end) || end.length < 2) {
      return {
        document: doc,
        summary: 'draw_line: start and end must each be [x, y] arrays.',
        affected: [],
      };
    }
    const id = nextId('line');
    const entity: Entity = {
      id,
      kind: 'line',
      start: [start[0]!, start[1]!] as Vec2,
      end: [end[0]!, end[1]!] as Vec2,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Drew line ${id} from [${start.join(', ')}] to [${end.join(', ')}].`,
      affected: [id],
    };
  },
});

// ---------------------------------------------------------------------------
// draw_polyline
// ---------------------------------------------------------------------------

/**
 * @command draw_polyline
 * @pure
 * @layer core/commands
 * @affects creates 1 polyline entity
 * @invariant points.length >= 2; each point is a 2-element [x,y] array
 * @failure fewer than 2 points -> no-op, affected:[]
 */
export const drawPolyline = defineCommand({
  name: 'draw_polyline',
  description:
    'Draw a connected sequence of line segments through an ordered list of 2D points in the local work plane. ' +
    'Requires at least 2 points. When closed=true the last point connects back to the first. ' +
    'A closed polyline can be fed to extrude_sketch to become a 3D solid.',
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
    { points, closed = false, position = [0, 0, 0] as const, color = DEFAULT_DRAW_COLOR },
  ): CommandResult => {
    const tooFew = rejectTooFewPoints(doc, 'draw_polyline', points);
    if (tooFew) return tooFew;
    const id = nextId('poly');
    const entity = pointSeriesEntity('polyline', id, points, closed, position, color);
    return {
      document: withEntity(doc, entity),
      summary: `Drew polyline ${id} with ${points.length} points${closed ? ' (closed)' : ''}.`,
      affected: [id],
    };
  },
});

// ---------------------------------------------------------------------------
// draw_arc
// ---------------------------------------------------------------------------

/**
 * @command draw_arc
 * @pure
 * @layer core/commands
 * @affects creates 1 arc entity
 * @invariant radius > 0
 * @failure radius <= 0 -> no-op, affected:[]
 */
export const drawArc = defineCommand({
  name: 'draw_arc',
  description:
    'Draw a circular arc in the local 2D work plane, defined by center, radius, and start/end angles in radians. ' +
    'Angles are measured counter-clockwise from the +X axis. radius must be > 0.',
  params: z.object({
    center: vec2('Center point [x, y] of the arc in local 2D work-plane coordinates.'),
    radius: z.number().describe('Arc radius. Must be greater than 0.'),
    startAngle: z
      .number()
      .describe(
        'Start angle in radians, measured counter-clockwise from the +X axis. E.g. 0 = rightmost point.',
      ),
    endAngle: z
      .number()
      .describe(
        'End angle in radians, measured counter-clockwise from the +X axis. Arc sweeps from startAngle to endAngle counter-clockwise.',
      ),
    position: workPlanePositionField(),
    color: colorField(DEFAULT_DRAW_COLOR),
  }),
  run: (
    doc,
    {
      center,
      radius,
      startAngle,
      endAngle,
      position = [0, 0, 0] as const,
      color = DEFAULT_DRAW_COLOR,
    },
  ): CommandResult => {
    if (radius <= 0) {
      return {
        document: doc,
        summary: `draw_arc: radius must be > 0 (got ${radius}).`,
        affected: [],
      };
    }
    const id = nextId('arc');
    const safeCenter: Vec2 = [center[0], center[1]];
    const entity: Entity = {
      id,
      kind: 'arc',
      center: safeCenter,
      radius,
      startAngle,
      endAngle,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Drew arc ${id} center [${safeCenter.join(', ')}] radius ${radius} from ${startAngle.toFixed(3)} to ${endAngle.toFixed(3)} rad.`,
      affected: [id],
    };
  },
});

// ---------------------------------------------------------------------------
// draw_circle
// ---------------------------------------------------------------------------

/**
 * @command draw_circle
 * @pure
 * @layer core/commands
 * @affects creates 1 circle entity
 * @invariant radius > 0
 * @failure radius <= 0 -> no-op, affected:[]
 */
export const drawCircle = defineCommand({
  name: 'draw_circle',
  description:
    'Draw a full circle in the local 2D work plane, defined by center and radius. radius must be > 0.',
  params: z.object({
    center: vec2('Center point [x, y] of the circle in local 2D work-plane coordinates.'),
    radius: z.number().describe('Circle radius. Must be greater than 0.'),
    position: workPlanePositionField(),
    color: colorField(DEFAULT_DRAW_COLOR),
  }),
  run: (
    doc,
    { center, radius, position = [0, 0, 0] as const, color = DEFAULT_DRAW_COLOR },
  ): CommandResult => {
    if (radius <= 0) {
      return {
        document: doc,
        summary: `draw_circle: radius must be > 0 (got ${radius}).`,
        affected: [],
      };
    }
    const id = nextId('circ');
    const safeCenter: Vec2 = [center[0], center[1]];
    const entity: Entity = {
      id,
      kind: 'circle',
      center: safeCenter,
      radius,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Drew circle ${id} center [${safeCenter.join(', ')}] radius ${radius}.`,
      affected: [id],
    };
  },
});

// ---------------------------------------------------------------------------
// draw_rectangle
// ---------------------------------------------------------------------------

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
  run: (
    doc,
    { width, height, position = [0, 0, 0] as const, color = DEFAULT_DRAW_COLOR },
  ): CommandResult => {
    if (width <= 0 || height <= 0) {
      return {
        document: doc,
        summary: `draw_rectangle: width and height must both be > 0 (got ${width}×${height}).`,
        affected: [],
      };
    }
    const id = nextId('rect');
    const entity: Entity = {
      id,
      kind: 'rectangle',
      width,
      height,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Drew rectangle ${id} ${width}×${height} at [${position.join(', ')}].`,
      affected: [id],
    };
  },
});

// ---------------------------------------------------------------------------
// draw_point
// ---------------------------------------------------------------------------

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
  run: (doc, { position = [0, 0, 0] as const, color = DEFAULT_DRAW_COLOR }): CommandResult => {
    const id = nextId('pt');
    const entity: Entity = {
      id,
      kind: 'point',
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Drew point ${id} at [${position.join(', ')}].`,
      affected: [id],
    };
  },
});
