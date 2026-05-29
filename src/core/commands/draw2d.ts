/**
 * 2D drafting commands. Each is a pure function over the document.
 *
 * 2D geometry is LOCAL to the entity work plane (Vec2 coordinates).
 * BaseEntity.position places the work-plane origin in 3D space
 * (default plane: z=0, normal +Z).
 *
 * Spline convention: Catmull-Rom interpolating spline with centripetal
 * parameterization. `points` are through-points; the curve passes through
 * each one. For closed splines the point array is treated as periodic.
 * Tessellation is delegated to the viewport renderer (VS1).
 *
 * @layer core/commands
 */

import type { CadDocument, Entity, Vec3, Vec2 } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';
import { sampleInvolute } from './gears';

/** Clone the document shallowly with a new entity added. Keeps commands pure. */
function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}

// ---------------------------------------------------------------------------
// draw_line
// ---------------------------------------------------------------------------

interface DrawLineParams {
  start: Vec2;
  end: Vec2;
  position?: Vec3;
  color?: string;
}

/**
 * @command draw_line
 * @pure
 * @layer core/commands
 * @affects creates 1 line entity
 * @invariant start and end are 2-element [x,y] arrays
 * @failure invalid start/end -> no-op, affected:[]
 */
export const drawLine: CommandDefinition<DrawLineParams> = {
  name: 'draw_line',
  description:
    'Draw a straight line segment defined by start and end points in the local 2D work plane. ' +
    'position places the work-plane origin in 3D space (default [0,0,0]).',
  paramsSchema: {
    type: 'object',
    properties: {
      start: {
        type: 'array',
        description: 'Start point [x, y] in local 2D work-plane coordinates.',
        items: { type: 'number' },
      },
      end: {
        type: 'array',
        description: 'End point [x, y] in local 2D work-plane coordinates.',
        items: { type: 'number' },
      },
      position: {
        type: 'array',
        description: 'World-space position [x, y, z] of the work-plane origin. Defaults to [0,0,0].',
        items: { type: 'number' },
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#c8553d". Defaults to "#4a90d9".',
      },
    },
    required: ['start', 'end'],
  },
  run: (doc, { start, end, position = [0, 0, 0], color = '#4a90d9' }): CommandResult => {
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
};

// ---------------------------------------------------------------------------
// draw_polyline
// ---------------------------------------------------------------------------

interface DrawPolylineParams {
  points: ReadonlyArray<Vec2>;
  closed?: boolean;
  position?: Vec3;
  color?: string;
}

/**
 * @command draw_polyline
 * @pure
 * @layer core/commands
 * @affects creates 1 polyline entity
 * @invariant points.length >= 2; each point is a 2-element [x,y] array
 * @failure fewer than 2 points -> no-op, affected:[]
 */
export const drawPolyline: CommandDefinition<DrawPolylineParams> = {
  name: 'draw_polyline',
  description:
    'Draw a connected sequence of line segments through an ordered list of 2D points in the local work plane. ' +
    'Requires at least 2 points. When closed=true the last point connects back to the first. ' +
    'A closed polyline can be fed to extrude_sketch to become a 3D solid.',
  paramsSchema: {
    type: 'object',
    properties: {
      points: {
        type: 'array',
        description:
          'Ordered list of [x, y] vertices in local 2D work-plane coordinates. Minimum 2 points required.',
        items: { type: 'array', items: { type: 'number' } },
      },
      closed: {
        type: 'boolean',
        description:
          'When true, the last point connects back to the first point, forming a closed loop. Defaults to false.',
      },
      position: {
        type: 'array',
        description: 'World-space position [x, y, z] of the work-plane origin. Defaults to [0,0,0].',
        items: { type: 'number' },
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#c8553d". Defaults to "#4a90d9".',
      },
    },
    required: ['points'],
  },
  run: (doc, { points, closed = false, position = [0, 0, 0], color = '#4a90d9' }): CommandResult => {
    if (!Array.isArray(points) || points.length < 2) {
      return {
        document: doc,
        summary: `draw_polyline: requires at least 2 points (got ${Array.isArray(points) ? points.length : 0}).`,
        affected: [],
      };
    }
    const id = nextId('poly');
    const safePoints: ReadonlyArray<Vec2> = points.map(
      (p) => [(p as number[])[0] ?? 0, (p as number[])[1] ?? 0] as Vec2,
    );
    const entity: Entity = {
      id,
      kind: 'polyline',
      points: safePoints,
      closed,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Drew polyline ${id} with ${points.length} points${closed ? ' (closed)' : ''}.`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// draw_arc
// ---------------------------------------------------------------------------

interface DrawArcParams {
  center: Vec2;
  radius: number;
  startAngle: number;
  endAngle: number;
  position?: Vec3;
  color?: string;
}

/**
 * @command draw_arc
 * @pure
 * @layer core/commands
 * @affects creates 1 arc entity
 * @invariant radius > 0
 * @failure radius <= 0 -> no-op, affected:[]
 */
export const drawArc: CommandDefinition<DrawArcParams> = {
  name: 'draw_arc',
  description:
    'Draw a circular arc in the local 2D work plane, defined by center, radius, and start/end angles in radians. ' +
    'Angles are measured counter-clockwise from the +X axis. radius must be > 0.',
  paramsSchema: {
    type: 'object',
    properties: {
      center: {
        type: 'array',
        description: 'Center point [x, y] of the arc in local 2D work-plane coordinates.',
        items: { type: 'number' },
      },
      radius: {
        type: 'number',
        description: 'Arc radius. Must be greater than 0.',
      },
      startAngle: {
        type: 'number',
        description:
          'Start angle in radians, measured counter-clockwise from the +X axis. E.g. 0 = rightmost point.',
      },
      endAngle: {
        type: 'number',
        description:
          'End angle in radians, measured counter-clockwise from the +X axis. Arc sweeps from startAngle to endAngle counter-clockwise.',
      },
      position: {
        type: 'array',
        description: 'World-space position [x, y, z] of the work-plane origin. Defaults to [0,0,0].',
        items: { type: 'number' },
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#c8553d". Defaults to "#4a90d9".',
      },
    },
    required: ['center', 'radius', 'startAngle', 'endAngle'],
  },
  run: (
    doc,
    { center, radius, startAngle, endAngle, position = [0, 0, 0], color = '#4a90d9' },
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
};

// ---------------------------------------------------------------------------
// draw_circle
// ---------------------------------------------------------------------------

interface DrawCircleParams {
  center: Vec2;
  radius: number;
  position?: Vec3;
  color?: string;
}

/**
 * @command draw_circle
 * @pure
 * @layer core/commands
 * @affects creates 1 circle entity
 * @invariant radius > 0
 * @failure radius <= 0 -> no-op, affected:[]
 */
export const drawCircle: CommandDefinition<DrawCircleParams> = {
  name: 'draw_circle',
  description:
    'Draw a full circle in the local 2D work plane, defined by center and radius. radius must be > 0.',
  paramsSchema: {
    type: 'object',
    properties: {
      center: {
        type: 'array',
        description: 'Center point [x, y] of the circle in local 2D work-plane coordinates.',
        items: { type: 'number' },
      },
      radius: {
        type: 'number',
        description: 'Circle radius. Must be greater than 0.',
      },
      position: {
        type: 'array',
        description: 'World-space position [x, y, z] of the work-plane origin. Defaults to [0,0,0].',
        items: { type: 'number' },
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#c8553d". Defaults to "#4a90d9".',
      },
    },
    required: ['center', 'radius'],
  },
  run: (doc, { center, radius, position = [0, 0, 0], color = '#4a90d9' }): CommandResult => {
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
};

// ---------------------------------------------------------------------------
// draw_rectangle
// ---------------------------------------------------------------------------

interface DrawRectangleParams {
  width: number;
  height: number;
  position?: Vec3;
  color?: string;
}

/**
 * @command draw_rectangle
 * @pure
 * @layer core/commands
 * @affects creates 1 rectangle entity
 * @invariant width > 0 and height > 0
 * @failure width <= 0 or height <= 0 -> no-op, affected:[]
 */
export const drawRectangle: CommandDefinition<DrawRectangleParams> = {
  name: 'draw_rectangle',
  description:
    'Draw an axis-aligned rectangle in the local 2D work plane. ' +
    'The origin is at the lower-left corner; width extends along +X, height along +Y. ' +
    'position places the work-plane origin in 3D space. Both width and height must be > 0.',
  paramsSchema: {
    type: 'object',
    properties: {
      width: {
        type: 'number',
        description: 'Width of the rectangle along the local X axis. Must be greater than 0.',
      },
      height: {
        type: 'number',
        description: 'Height of the rectangle along the local Y axis. Must be greater than 0.',
      },
      position: {
        type: 'array',
        description: 'World-space position [x, y, z] of the work-plane origin (lower-left corner). Defaults to [0,0,0].',
        items: { type: 'number' },
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#c8553d". Defaults to "#4a90d9".',
      },
    },
    required: ['width', 'height'],
  },
  run: (doc, { width, height, position = [0, 0, 0], color = '#4a90d9' }): CommandResult => {
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
};

// ---------------------------------------------------------------------------
// draw_point
// ---------------------------------------------------------------------------

interface DrawPointParams {
  position?: Vec3;
  color?: string;
}

/**
 * @command draw_point
 * @pure
 * @layer core/commands
 * @affects creates 1 point entity
 * @invariant position is a 3-element [x,y,z] array (defaults to [0,0,0])
 */
export const drawPoint: CommandDefinition<DrawPointParams> = {
  name: 'draw_point',
  description:
    'Place a point marker at the given 3D world position. ' +
    'The point entity has no local 2D geometry — its position is the point location.',
  paramsSchema: {
    type: 'object',
    properties: {
      position: {
        type: 'array',
        description: 'World-space position [x, y, z] of the point. Defaults to [0,0,0].',
        items: { type: 'number' },
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#c8553d". Defaults to "#4a90d9".',
      },
    },
    required: [],
  },
  run: (doc, { position = [0, 0, 0], color = '#4a90d9' }): CommandResult => {
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
};

// ---------------------------------------------------------------------------
// draw_ellipse
// ---------------------------------------------------------------------------

interface DrawEllipseParams {
  center: Vec2;
  radiusX: number;
  radiusY: number;
  position?: Vec3;
  color?: string;
}

/**
 * @command draw_ellipse
 * @pure
 * @layer core/commands
 * @affects creates 1 ellipse entity
 * @invariant radiusX > 0 and radiusY > 0
 * @failure radiusX <= 0 or radiusY <= 0 -> no-op, affected:[]
 */
export const drawEllipse: CommandDefinition<DrawEllipseParams> = {
  name: 'draw_ellipse',
  description:
    'Draw an axis-aligned ellipse in the local 2D work plane, defined by center and semi-axis radii. ' +
    'radiusX is the half-width along the local X axis; radiusY is the half-height along the local Y axis. ' +
    'Both must be > 0. position places the work-plane origin in 3D space (default [0,0,0]).',
  paramsSchema: {
    type: 'object',
    properties: {
      center: {
        type: 'array',
        description: 'Center point [x, y] of the ellipse in local 2D work-plane coordinates.',
        items: { type: 'number' },
      },
      radiusX: {
        type: 'number',
        description: 'Semi-axis length along the local X axis (half-width). Must be greater than 0.',
      },
      radiusY: {
        type: 'number',
        description: 'Semi-axis length along the local Y axis (half-height). Must be greater than 0.',
      },
      position: {
        type: 'array',
        description: 'World-space position [x, y, z] of the work-plane origin. Defaults to [0,0,0].',
        items: { type: 'number' },
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#c8553d". Defaults to "#4a90d9".',
      },
    },
    required: ['center', 'radiusX', 'radiusY'],
  },
  run: (doc, { center, radiusX, radiusY, position = [0, 0, 0], color = '#4a90d9' }): CommandResult => {
    if (radiusX <= 0 || radiusY <= 0) {
      return {
        document: doc,
        summary: `draw_ellipse: radiusX and radiusY must both be > 0 (got radiusX=${radiusX}, radiusY=${radiusY}).`,
        affected: [],
      };
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
};

// ---------------------------------------------------------------------------
// draw_spline
// ---------------------------------------------------------------------------

interface DrawSplineParams {
  points: ReadonlyArray<Vec2>;
  closed?: boolean;
  position?: Vec3;
  color?: string;
}

/**
 * @command draw_spline
 * @pure
 * @layer core/commands
 * @affects creates 1 spline entity
 * @invariant points.length >= 2; each point is a 2-element [x,y] array
 * @failure fewer than 2 points -> no-op, affected:[]
 */
export const drawSpline: CommandDefinition<DrawSplineParams> = {
  name: 'draw_spline',
  description:
    'Draw a Catmull-Rom interpolating spline through an ordered list of 2D through-points in the local work plane. ' +
    'The curve passes through every point (not a control polygon). Requires at least 2 points. ' +
    'When closed=true the spline loops back from the last point to the first. ' +
    'Centripetal Catmull-Rom parameterization is used; tessellation is performed by the renderer.',
  paramsSchema: {
    type: 'object',
    properties: {
      points: {
        type: 'array',
        description:
          'Ordered list of through-points in local 2D work-plane coordinates. ' +
          'Each point is [x, y]. Minimum 2 points required.',
        items: { type: 'array', items: { type: 'number' } },
      },
      closed: {
        type: 'boolean',
        description:
          'When true, the spline loops back from the last point to the first, forming a closed curve. Defaults to false.',
      },
      position: {
        type: 'array',
        description: 'World-space position [x, y, z] of the work-plane origin. Defaults to [0,0,0].',
        items: { type: 'number' },
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#c8553d". Defaults to "#4a90d9".',
      },
    },
    required: ['points'],
  },
  run: (doc, { points, closed = false, position = [0, 0, 0], color = '#4a90d9' }): CommandResult => {
    if (!Array.isArray(points) || points.length < 2) {
      return {
        document: doc,
        summary: `draw_spline: requires at least 2 points (got ${Array.isArray(points) ? points.length : 0}).`,
        affected: [],
      };
    }
    const id = nextId('spline');
    const safePoints: ReadonlyArray<Vec2> = points.map(
      (p) => [(p as number[])[0] ?? 0, (p as number[])[1] ?? 0] as Vec2,
    );
    const entity: Entity = {
      id,
      kind: 'spline',
      points: safePoints,
      closed,
      position,
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color,
    };
    return {
      document: withEntity(doc, entity),
      summary: `Drew spline ${id} with ${safePoints.length} points${closed ? ' (closed)' : ''}.`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// draw_involute
// ---------------------------------------------------------------------------

interface DrawInvoluteParams {
  baseRadius: number;
  startAngle?: number;
  endAngle: number;
  samples?: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
  name?: string;
}

/** Format a number compactly for the summary string. */
function fmtN(v: number): string {
  return parseFloat(v.toFixed(4)).toString();
}

/**
 * @command draw_involute
 * @pure
 * @layer core/commands
 * @affects creates 1 open polyline entity tracing an involute curve
 * @invariant baseRadius > 0; samples >= 2; endAngle > startAngle; all numerics finite
 * @failure baseRadius <= 0, samples < 2, endAngle <= startAngle, or any non-finite numeric -> no-op, affected:[]
 */
export const drawInvolute: CommandDefinition<DrawInvoluteParams> = {
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
  paramsSchema: {
    type: 'object',
    properties: {
      baseRadius: {
        type: 'number',
        description:
          'Base circle radius of the involute. Must be > 0. ' +
          'Controls the curvature: smaller baseRadius gives a more tightly wound curve.',
      },
      startAngle: {
        type: 'number',
        description:
          'Involute parameter t at the start of the curve, in radians. Defaults to 0. ' +
          'At t=0 the curve starts at (baseRadius, 0). Must be < endAngle.',
      },
      endAngle: {
        type: 'number',
        description:
          'Involute parameter t at the end of the curve, in radians. Must be > startAngle. ' +
          'The radial distance from origin at the endpoint is baseRadius*sqrt(1 + endAngle²).',
      },
      samples: {
        type: 'number',
        description:
          'Number of points sampled along the curve (inclusive of both endpoints). ' +
          'Minimum 2. Default 24. Higher values give a smoother polyline.',
      },
      position: {
        type: 'array',
        description: 'World-space position [x, y, z] of the work-plane origin. Defaults to [0,0,0].',
        items: { type: 'number' },
      },
      rotation: {
        type: 'array',
        description:
          'Extrinsic XYZ Euler angles in RADIANS [rx, ry, rz] for the work plane. Defaults to [0,0,0].',
        items: { type: 'number' },
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#4a90d9". Defaults to "#4a90d9".',
      },
      name: {
        type: 'string',
        description: 'Optional display name for the entity (shown in the scene tree).',
      },
    },
    required: ['baseRadius', 'endAngle'],
  },
  run: (
    doc,
    {
      baseRadius,
      startAngle = 0,
      endAngle,
      samples = 24,
      position = [0, 0, 0],
      rotation = [0, 0, 0],
      color = '#4a90d9',
      name,
    },
  ): CommandResult => {
    // --- Validate all numerics are finite ---
    if (!Number.isFinite(baseRadius)) {
      return {
        document: doc,
        summary: `draw_involute: baseRadius must be finite, got ${String(baseRadius)}.`,
        affected: [],
      };
    }
    if (!Number.isFinite(startAngle)) {
      return {
        document: doc,
        summary: `draw_involute: startAngle must be finite, got ${String(startAngle)}.`,
        affected: [],
      };
    }
    if (!Number.isFinite(endAngle)) {
      return {
        document: doc,
        summary: `draw_involute: endAngle must be finite, got ${String(endAngle)}.`,
        affected: [],
      };
    }
    if (!Number.isFinite(samples)) {
      return {
        document: doc,
        summary: `draw_involute: samples must be finite, got ${String(samples)}.`,
        affected: [],
      };
    }

    // --- Validate domain ---
    if (baseRadius <= 0) {
      return {
        document: doc,
        summary: `draw_involute: baseRadius must be > 0, got ${baseRadius}.`,
        affected: [],
      };
    }
    const samplesInt = Math.round(samples);
    if (samplesInt < 2) {
      return {
        document: doc,
        summary: `draw_involute: samples must be >= 2, got ${samples}.`,
        affected: [],
      };
    }
    if (endAngle <= startAngle) {
      return {
        document: doc,
        summary: `draw_involute: endAngle (${endAngle}) must be > startAngle (${startAngle}).`,
        affected: [],
      };
    }

    // --- Resolve position/rotation (clamp non-finite to 0) ---
    const resolvedPos: Vec3 =
      Array.isArray(position) && position.length === 3 &&
      Number.isFinite((position as number[])[0]) &&
      Number.isFinite((position as number[])[1]) &&
      Number.isFinite((position as number[])[2])
        ? [(position as number[])[0]!, (position as number[])[1]!, (position as number[])[2]!]
        : [0, 0, 0];

    const resolvedRot: Vec3 =
      Array.isArray(rotation) && rotation.length === 3 &&
      Number.isFinite((rotation as number[])[0]) &&
      Number.isFinite((rotation as number[])[1]) &&
      Number.isFinite((rotation as number[])[2])
        ? [(rotation as number[])[0]!, (rotation as number[])[1]!, (rotation as number[])[2]!]
        : [0, 0, 0];

    // --- Sample the involute using the shared helper from gears.ts ---
    const rawPoints = sampleInvolute(baseRadius, startAngle, endAngle, samplesInt);
    const pts: ReadonlyArray<Vec2> = rawPoints.map(([x, y]) => [x, y] as Vec2);

    // --- Compute 2D AABB for summary ---
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    // --- Mint entity id and build open polyline ---
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
        `Drew involute ${id}: baseRadius=${fmtN(baseRadius)} t=[${fmtN(startAngle)}, ${fmtN(endAngle)}] ` +
        `samples=${samplesInt} AABB x=[${fmtN(minX)}, ${fmtN(maxX)}] y=[${fmtN(minY)}, ${fmtN(maxY)}].`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// draw_belt_around
// ---------------------------------------------------------------------------

/** One pulley/sprocket specification: center in local 2D frame + radius. */
interface PulleySpec {
  center: [number, number];
  radius: number;
}

interface DrawBeltAroundParams {
  pulleys: PulleySpec[];
  arcSamples?: number;
  position?: Vec3;
  rotation?: Vec3;
  color?: string;
  name?: string;
}

/**
 * Compute the two external tangent points for a pair of circles (same-side,
 * "open belt" convention).  Returns [tp1, tp2] on c1 and c2 respectively, on
 * the CCW outer envelope side (angle = θ + π/2 + α, where α = asin((r1−r2)/d)).
 *
 * Returns null when no external tangent exists (one circle inside the other).
 */
function externalTangentPoints(
  c1x: number, c1y: number, r1: number,
  c2x: number, c2y: number, r2: number,
): readonly [readonly [number, number], readonly [number, number]] | null {
  const dx = c2x - c1x;
  const dy = c2y - c1y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d === 0) return null;
  const sinAlphaRaw = (r1 - r2) / d;
  if (Math.abs(sinAlphaRaw) > 1) return null; // one inside the other
  const alpha = Math.asin(Math.max(-1, Math.min(1, sinAlphaRaw)));
  const theta = Math.atan2(dy, dx);
  // Top-side tangent (CCW outer envelope)
  const angle = theta + Math.PI / 2 + alpha;
  const tp1: readonly [number, number] = [
    c1x + r1 * Math.cos(angle),
    c1y + r1 * Math.sin(angle),
  ];
  const tp2: readonly [number, number] = [
    c2x + r2 * Math.cos(angle),
    c2y + r2 * Math.sin(angle),
  ];
  return [tp1, tp2] as const;
}

/**
 * Sample a CCW arc on a circle centred at (cx,cy) with radius r,
 * from startAngle to endAngle (both in radians, CCW positive).
 * The arc goes CCW from startAngle to endAngle, wrapping if necessary.
 * Returns `arcSamples` interior chord points (not including the start point;
 * the end point IS included).  This means the caller can safely concatenate
 * arrays without duplicating the join point.
 */
function sampleArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
  arcSamples: number,
): ReadonlyArray<readonly [number, number]> {
  // Normalise endAngle so it is > startAngle (CCW sweep)
  let sweep = endAngle - startAngle;
  while (sweep <= 0) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;

  const pts: Array<readonly [number, number]> = [];
  // Emit arcSamples points: skip i=0 (that's the tangent point already added),
  // include i=arcSamples (the outgoing tangent point on this pulley).
  for (let i = 1; i <= arcSamples; i++) {
    const t = startAngle + (sweep * i) / arcSamples;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}

/**
 * @command draw_belt_around
 * @pure
 * @layer core/commands
 * @affects creates 1 closed polyline entity tracing the belt/chain centerline
 * @invariant pulleys.length >= 2; each radius > 0; no coincident centers; no pulley inside another
 * @failure pulleys < 2, non-positive radius, non-finite inputs, coincident centers, pulley-inside-pulley -> no-op, affected:[]
 */
export const drawBeltAround: CommandDefinition<DrawBeltAroundParams> = {
  name: 'draw_belt_around',
  description:
    'Compute the closed centerline of a belt or chain wrapping ≥2 circular pulleys/sprockets ' +
    'and emit it as a single closed polyline entity. ' +
    'For each adjacent pair of pulleys the command computes the external common tangent (open-belt / ' +
    'same-direction rotation convention, CCW outer envelope), then samples the wrap arc on each pulley ' +
    'between the two tangent touch-points. The result is one `polyline` with `closed: true`. ' +
    'pulleys is an ordered array of {center:[x,y], radius} objects; the belt wraps them in that order ' +
    'and closes back to the first. ' +
    'arcSamples controls chord resolution per wrap arc (default 12, minimum 2). ' +
    'position/rotation place the entity in 3D world space (default [0,0,0]). ' +
    'Fails gracefully (no-op) when: fewer than 2 pulleys, non-positive or non-finite radius, ' +
    'non-finite center coordinates, coincident centers, or any pulley is contained inside another ' +
    '(no external tangent exists).',
  paramsSchema: {
    type: 'object',
    properties: {
      pulleys: {
        type: 'array',
        description:
          'Ordered list of pulleys the belt wraps around. Each entry is an object ' +
          '{ center: [x, y], radius: number } where center is a 2D point in the work plane ' +
          'and radius is a finite positive number. ' +
          'The belt wraps them in the given order and closes back to the first. Minimum 2 pulleys.',
        items: { type: 'object' },
      },
      arcSamples: {
        type: 'number',
        description:
          'Integer number of chord segments used to approximate each pulley wrap arc. ' +
          'Must be >= 2. Default 12. Higher values give smoother arcs.',
      },
      position: {
        type: 'array',
        description: 'World-space position [x, y, z] of the work-plane origin. Defaults to [0,0,0].',
        items: { type: 'number' },
      },
      rotation: {
        type: 'array',
        description:
          'Extrinsic XYZ Euler angles in radians [rx, ry, rz] for the work plane. Defaults to [0,0,0].',
        items: { type: 'number' },
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#4a90d9". Defaults to "#4a90d9".',
      },
      name: {
        type: 'string',
        description: 'Optional display name for the entity (shown in the scene tree).',
      },
    },
    required: ['pulleys'],
  },
  run: (
    doc,
    {
      pulleys,
      arcSamples = 12,
      position = [0, 0, 0],
      rotation = [0, 0, 0],
      color = '#4a90d9',
      name,
    },
  ): CommandResult => {
    // --- Validate pulleys array ---
    if (!Array.isArray(pulleys) || pulleys.length < 2) {
      return {
        document: doc,
        summary: `draw_belt_around: requires at least 2 pulleys (got ${Array.isArray(pulleys) ? pulleys.length : 0}).`,
        affected: [],
      };
    }

    // --- Validate arcSamples ---
    if (!Number.isFinite(arcSamples) || arcSamples < 2) {
      return {
        document: doc,
        summary: `draw_belt_around: arcSamples must be a finite number >= 2 (got ${String(arcSamples)}).`,
        affected: [],
      };
    }
    const samplesInt = Math.round(arcSamples);

    // --- Validate each pulley ---
    for (let i = 0; i < pulleys.length; i++) {
      const p = pulleys[i]!;
      if (!p || !Array.isArray(p.center) || p.center.length < 2) {
        return {
          document: doc,
          summary: `draw_belt_around: pulley[${i}] center must be a [x, y] array.`,
          affected: [],
        };
      }
      const [cx, cy] = p.center;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        return {
          document: doc,
          summary: `draw_belt_around: pulley[${i}] center contains non-finite coordinate (${cx}, ${cy}).`,
          affected: [],
        };
      }
      if (!Number.isFinite(p.radius) || p.radius <= 0) {
        return {
          document: doc,
          summary: `draw_belt_around: pulley[${i}] radius must be a finite positive number (got ${String(p.radius)}).`,
          affected: [],
        };
      }
    }

    // --- Check for coincident centers or pulley-inside-pulley ---
    const n = pulleys.length;
    for (let i = 0; i < n; i++) {
      const ni = (i + 1) % n;
      const p1 = pulleys[i]!;
      const p2 = pulleys[ni]!;
      const dx = p2.center[0]! - p1.center[0]!;
      const dy = p2.center[1]! - p1.center[1]!;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d === 0) {
        return {
          document: doc,
          summary: `draw_belt_around: pulleys[${i}] and pulleys[${ni}] have coincident centers.`,
          affected: [],
        };
      }
      if (d < Math.abs(p1.radius - p2.radius)) {
        return {
          document: doc,
          summary:
            `draw_belt_around: pulley[${ni}] is inside pulley[${i}] (d=${fmtN(d)} < |r1−r2|=${fmtN(Math.abs(p1.radius - p2.radius))}); no external tangent.`,
          affected: [],
        };
      }
    }

    // --- Compute belt loop ---
    // For each pair i→(i+1)%n, compute external tangent touch-points.
    // Then for each pulley, emit wrap arc from its incoming tp to its outgoing tp.

    // Gather per-pair tangent touch-points:
    // tangentPairs[i] = [outTP on pulleys[i], inTP on pulleys[(i+1)%n]]
    type TangentPair = readonly [readonly [number, number], readonly [number, number]];
    const tangentPairs: TangentPair[] = [];
    for (let i = 0; i < n; i++) {
      const ni = (i + 1) % n;
      const p1 = pulleys[i]!;
      const p2 = pulleys[ni]!;
      const result = externalTangentPoints(
        p1.center[0]!, p1.center[1]!, p1.radius,
        p2.center[0]!, p2.center[1]!, p2.radius,
      );
      if (result === null) {
        // Shouldn't happen since we checked above, but guard for safety
        return {
          document: doc,
          summary: `draw_belt_around: failed to compute tangent between pulleys[${i}] and pulleys[${ni}].`,
          affected: [],
        };
      }
      tangentPairs.push(result);
    }

    // Build the closed polyline points:
    // For each pulley i:
    //   1. Emit outgoing tangent point on pulley i (from tangentPairs[i][0])
    //   2. Emit the tangent line (implicit — just the start point; end is next arc's start)
    //   Actually: the loop is:
    //     outTP_i, [tangent line to] inTP_{i+1},
    //     arc on pulley_{i+1} from inTP_{i+1} to outTP_{i+1}
    // So we iterate: for i in 0..n-1:
    //   push outTP[i] (= tangentPairs[i][0])
    //   push arc samples on pulleys[(i+1)%n] from inAngle to outAngle
    //   (the end of the arc is outTP[(i+1)%n], which is tangentPairs[(i+1)%n][0])

    const points: Array<readonly [number, number]> = [];

    // Accumulate lengths for summary
    let totalLength = 0;

    for (let i = 0; i < n; i++) {
      const ni = (i + 1) % n;
      const outTP = tangentPairs[i]![0]; // outgoing TP on pulley i
      const inTP = tangentPairs[i]![1];  // incoming TP on pulley ni

      // 1. Outgoing tangent point on pulley i
      points.push(outTP);

      // 2. Tangent segment length: outTP → inTP
      const tdx = inTP[0] - outTP[0];
      const tdy = inTP[1] - outTP[1];
      totalLength += Math.sqrt(tdx * tdx + tdy * tdy);

      // 3. Wrap arc on pulley ni from inTP to its outgoing TP
      const pni = pulleys[ni]!;
      const outTPni = tangentPairs[ni]![0]; // outgoing TP on pulley ni

      const inAngle = Math.atan2(inTP[1] - pni.center[1]!, inTP[0] - pni.center[0]!);
      const outAngle = Math.atan2(outTPni[1] - pni.center[1]!, outTPni[0] - pni.center[0]!);

      const arcPts = sampleArc(pni.center[0]!, pni.center[1]!, pni.radius, inAngle, outAngle, samplesInt);
      for (const pt of arcPts) {
        points.push(pt);
      }

      // Arc length contribution
      let arcSweep = outAngle - inAngle;
      while (arcSweep <= 0) arcSweep += 2 * Math.PI;
      while (arcSweep > 2 * Math.PI) arcSweep -= 2 * Math.PI;
      totalLength += pni.radius * arcSweep;
    }

    // --- Resolve position / rotation ---
    const resolvedPos: Vec3 =
      Array.isArray(position) && position.length >= 3 &&
      Number.isFinite((position as number[])[0]) &&
      Number.isFinite((position as number[])[1]) &&
      Number.isFinite((position as number[])[2])
        ? [(position as number[])[0]!, (position as number[])[1]!, (position as number[])[2]!]
        : [0, 0, 0];

    const resolvedRot: Vec3 =
      Array.isArray(rotation) && rotation.length >= 3 &&
      Number.isFinite((rotation as number[])[0]) &&
      Number.isFinite((rotation as number[])[1]) &&
      Number.isFinite((rotation as number[])[2])
        ? [(rotation as number[])[0]!, (rotation as number[])[1]!, (rotation as number[])[2]!]
        : [0, 0, 0];

    // --- Compute AABB for summary ---
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    // --- Build entity ---
    const id = nextId('belt');
    const safePoints: ReadonlyArray<Vec2> = points.map(([x, y]) => [x, y] as Vec2);

    const entity: Entity = {
      id,
      kind: 'polyline',
      points: safePoints,
      closed: true,
      position: resolvedPos,
      rotation: resolvedRot,
      layerId: DEFAULT_LAYER_ID,
      color,
      ...(name !== undefined && name !== '' ? { name } : {}),
    };

    return {
      document: withEntity(doc, entity),
      summary:
        `Drew belt ${id}: ${n} pulleys, length ≈ ${fmtN(totalLength)}, ` +
        `bounds x=[${fmtN(minX)}, ${fmtN(maxX)}] y=[${fmtN(minY)}, ${fmtN(maxY)}].`,
      affected: [id],
    };
  },
};
