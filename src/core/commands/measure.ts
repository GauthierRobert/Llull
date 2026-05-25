/**
 * Read-only measurement / query commands.
 *
 * None of these commands mutate the document. Each returns:
 *   - `document`: the SAME reference passed in (no copy, no mutation)
 *   - `affected`: [] always
 *   - `summary`: factual, with units read from doc.units / doc.displayPrecision
 *   - `data`: a typed record (never a bare primitive) so MCP structured content works
 *
 * @layer core/commands
 */

import type { Entity, Vec3 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { entityBounds } from './scene';
import type { Bounds } from './scene';
import { formatLength } from './units';

// ---------------------------------------------------------------------------
// Internal geometry helpers (pure, unexported)
// ---------------------------------------------------------------------------

function vec3Distance(a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Entity centroid: midpoint of its world-space AABB. */
function centroid(e: Entity): Vec3 {
  const b = entityBounds(e);
  return [
    (b.min[0] + b.max[0]) / 2,
    (b.min[1] + b.max[1]) / 2,
    (b.min[2] + b.max[2]) / 2,
  ];
}

function mergeBoundsLocal(a: Bounds, b: Bounds): Bounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

// ---------------------------------------------------------------------------
// 1. measure_distance
// ---------------------------------------------------------------------------

interface MeasureDistanceParams {
  /** First point as [x,y,z]. Use instead of entityId1 for point↔point or point↔entity measurement. */
  point1?: readonly [number, number, number];
  /** Second point as [x,y,z]. Use instead of entityId2 for point↔point or entity↔point measurement. */
  point2?: readonly [number, number, number];
  /** Id of the first entity. Use centroid of its bounding box when point1 is not provided. */
  entityId1?: string;
  /** Id of the second entity. Use centroid of its bounding box when point2 is not provided. */
  entityId2?: string;
}

interface MeasureDistanceData {
  distance: number;
  unit: string;
}

/**
 * @command measure_distance
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { distance: number, unit: string }
 * @failure missing entity id or neither point nor entity provided -> no-op, affected:[], no data
 */
export const measureDistance: CommandDefinition<MeasureDistanceParams> = {
  name: 'measure_distance',
  description:
    'Measure the straight-line distance between two locations. Each location may be a world-space ' +
    'point [x,y,z] (point1/point2) or an entity id (entityId1/entityId2, centroid used). ' +
    'Mix point and entity freely (e.g. point1 + entityId2). ' +
    'Returns data: { distance, unit } and a factual summary. Does not modify the document.',
  paramsSchema: {
    type: 'object',
    properties: {
      point1: {
        type: 'array',
        description: 'First world-space point [x, y, z]. Omit to use entityId1 centroid instead.',
        items: { type: 'number' },
      },
      point2: {
        type: 'array',
        description: 'Second world-space point [x, y, z]. Omit to use entityId2 centroid instead.',
        items: { type: 'number' },
      },
      entityId1: {
        type: 'string',
        description:
          'Id of the first entity. Its bounding-box centroid is used as the first location ' +
          'when point1 is not provided.',
      },
      entityId2: {
        type: 'string',
        description:
          'Id of the second entity. Its bounding-box centroid is used as the second location ' +
          'when point2 is not provided.',
      },
    },
    required: [],
  },
  run: (doc, { point1, point2, entityId1, entityId2 }): CommandResult => {
    // Resolve location A
    let locA: Vec3 | undefined;
    if (point1) {
      locA = [point1[0], point1[1], point1[2]];
    } else if (entityId1) {
      const e = doc.entities[entityId1];
      if (!e) {
        return { document: doc, summary: `measure_distance: entity '${entityId1}' not found.`, affected: [] };
      }
      locA = centroid(e);
    }

    // Resolve location B
    let locB: Vec3 | undefined;
    if (point2) {
      locB = [point2[0], point2[1], point2[2]];
    } else if (entityId2) {
      const e = doc.entities[entityId2];
      if (!e) {
        return { document: doc, summary: `measure_distance: entity '${entityId2}' not found.`, affected: [] };
      }
      locB = centroid(e);
    }

    if (!locA || !locB) {
      return {
        document: doc,
        summary:
          'measure_distance: provide two locations — each as a point [x,y,z] (point1/point2) ' +
          'or an entity id (entityId1/entityId2).',
        affected: [],
      };
    }

    const distance = vec3Distance(locA, locB);
    const data: MeasureDistanceData = { distance, unit: doc.units };
    return {
      document: doc,
      summary: `Distance = ${formatLength(doc, distance)}.`,
      affected: [],
      data,
    };
  },
};

// ---------------------------------------------------------------------------
// 2. measure_angle
// ---------------------------------------------------------------------------

interface MeasureAngleParams {
  /**
   * Three world-space points [vertex, arm1, arm2]. The angle is at vertex, between
   * the ray vertex→arm1 and the ray vertex→arm2.
   */
  points?: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
  /** Id of first line entity. The angle between this line and lineId2 is measured. */
  lineId1?: string;
  /** Id of second line entity. */
  lineId2?: string;
}

interface MeasureAngleData {
  degrees: number;
  radians: number;
}

/**
 * @command measure_angle
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { degrees: number, radians: number }
 * @failure degenerate vectors (zero-length) or missing entity ids -> no-op, affected:[], no data
 */
export const measureAngle: CommandDefinition<MeasureAngleParams> = {
  name: 'measure_angle',
  description:
    'Measure an angle. Provide either: (a) three world-space points as [[vx,vy,vz],[a1x,a1y,a1z],[a2x,a2y,a2z]] ' +
    'where the first point is the vertex and the angle is between the two rays vertex→arm1 and vertex→arm2; or ' +
    '(b) two line entity ids (lineId1, lineId2) to measure the angle between their direction vectors. ' +
    'Returns data: { degrees, radians }. Does not modify the document.',
  paramsSchema: {
    type: 'object',
    properties: {
      points: {
        type: 'array',
        description:
          'Three world-space points [[vx,vy,vz],[a1x,a1y,a1z],[a2x,a2y,a2z]]. ' +
          'First is the vertex; angle is measured between rays vertex→point[1] and vertex→point[2].',
        items: { type: 'array', items: { type: 'number' } },
      },
      lineId1: {
        type: 'string',
        description:
          "Id of the first 'line' entity. Used together with lineId2 to measure the angle between two lines.",
      },
      lineId2: {
        type: 'string',
        description: "Id of the second 'line' entity.",
      },
    },
    required: [],
  },
  run: (doc, { points, lineId1, lineId2 }): CommandResult => {
    let vA: Vec3, vB: Vec3;

    if (points) {
      if (points.length < 3) {
        return {
          document: doc,
          summary: 'measure_angle: points must be an array of exactly 3 [x,y,z] points.',
          affected: [],
        };
      }
      const [vertex, arm1, arm2] = points;
      vA = [arm1[0] - vertex[0], arm1[1] - vertex[1], arm1[2] - vertex[2]];
      vB = [arm2[0] - vertex[0], arm2[1] - vertex[1], arm2[2] - vertex[2]];
    } else if (lineId1 && lineId2) {
      const e1 = doc.entities[lineId1];
      const e2 = doc.entities[lineId2];
      if (!e1) {
        return { document: doc, summary: `measure_angle: entity '${lineId1}' not found.`, affected: [] };
      }
      if (!e2) {
        return { document: doc, summary: `measure_angle: entity '${lineId2}' not found.`, affected: [] };
      }
      if (e1.kind !== 'line') {
        return {
          document: doc,
          summary: `measure_angle: entity '${lineId1}' is kind '${e1.kind}', expected 'line'.`,
          affected: [],
        };
      }
      if (e2.kind !== 'line') {
        return {
          document: doc,
          summary: `measure_angle: entity '${lineId2}' is kind '${e2.kind}', expected 'line'.`,
          affected: [],
        };
      }
      vA = [e1.end[0] - e1.start[0], e1.end[1] - e1.start[1], 0];
      vB = [e2.end[0] - e2.start[0], e2.end[1] - e2.start[1], 0];
    } else {
      return {
        document: doc,
        summary:
          'measure_angle: provide either points (3 world-space points) or lineId1 + lineId2.',
        affected: [],
      };
    }

    const lenA = Math.sqrt(vA[0] * vA[0] + vA[1] * vA[1] + vA[2] * vA[2]);
    const lenB = Math.sqrt(vB[0] * vB[0] + vB[1] * vB[1] + vB[2] * vB[2]);
    if (lenA < 1e-12 || lenB < 1e-12) {
      return {
        document: doc,
        summary: 'measure_angle: degenerate vector (zero length) — cannot compute angle.',
        affected: [],
      };
    }

    const dot = vA[0] * vB[0] + vA[1] * vB[1] + vA[2] * vB[2];
    const radians = Math.acos(Math.max(-1, Math.min(1, dot / (lenA * lenB))));
    const degrees = (radians * 180) / Math.PI;
    const data: MeasureAngleData = { degrees, radians };
    return {
      document: doc,
      summary: `Angle = ${degrees.toFixed(doc.displayPrecision)}° (${radians.toFixed(doc.displayPrecision)} rad).`,
      affected: [],
      data,
    };
  },
};

// ---------------------------------------------------------------------------
// 3. measure_area
// ---------------------------------------------------------------------------

interface MeasureAreaParams {
  /** Id of a closed 2D shape entity (polyline with closed:true, rectangle, circle). */
  entityId?: string;
  /**
   * Explicit polygon points [[x,y], ...] in the local 2D plane. Must have >= 3 points.
   * The polygon is treated as closed (last point connects to first).
   */
  points?: ReadonlyArray<readonly [number, number]>;
}

interface MeasureAreaData {
  area: number;
  unit: string;
}

/** Shoelace formula for a polygon in 2D. Returns the absolute area. */
function polygonArea(pts: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum / 2);
}

/**
 * @command measure_area
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { area: number, unit: string } where unit is derived (e.g. "mm²")
 * @failure open profile, non-2D entity, < 3 points, or missing id -> no-op, affected:[], no data
 */
export const measureArea: CommandDefinition<MeasureAreaParams> = {
  name: 'measure_area',
  description:
    'Compute the area of a closed 2D shape. Provide either: (a) an entityId for a closed ' +
    "polyline, rectangle, or circle entity; or (b) an explicit polygon as points ([[x,y],...], >= 3 points). " +
    'Returns data: { area, unit } where unit is the squared document unit (e.g. "mm²"). ' +
    'Open polylines are rejected with an explanatory message. Does not modify the document.',
  paramsSchema: {
    type: 'object',
    properties: {
      entityId: {
        type: 'string',
        description:
          "Id of a closed 2D shape entity: 'polyline' (must have closed:true), 'rectangle', or 'circle'.",
      },
      points: {
        type: 'array',
        description:
          'Explicit polygon vertices [[x,y],...] in the local 2D plane. Must have at least 3 points. ' +
          'The polygon is implicitly closed (last → first).',
        items: { type: 'array', items: { type: 'number' } },
      },
    },
    required: [],
  },
  run: (doc, { entityId, points }): CommandResult => {
    const areaUnit = `${doc.units}²`;

    if (points) {
      if (points.length < 3) {
        return {
          document: doc,
          summary: `measure_area: points must have >= 3 vertices, got ${points.length}.`,
          affected: [],
        };
      }
      const area = polygonArea(points);
      const data: MeasureAreaData = { area, unit: areaUnit };
      return {
        document: doc,
        summary: `Area = ${area.toFixed(doc.displayPrecision)} ${areaUnit}.`,
        affected: [],
        data,
      };
    }

    if (!entityId) {
      return {
        document: doc,
        summary: 'measure_area: provide either entityId or points.',
        affected: [],
      };
    }

    const e = doc.entities[entityId];
    if (!e) {
      return { document: doc, summary: `measure_area: entity '${entityId}' not found.`, affected: [] };
    }

    let area: number;
    switch (e.kind) {
      case 'circle':
        area = Math.PI * e.radius * e.radius;
        break;
      case 'rectangle':
        area = e.width * e.height;
        break;
      case 'polyline': {
        if (!e.closed) {
          return {
            document: doc,
            summary: `measure_area: polyline '${entityId}' is not closed — cannot compute area.`,
            affected: [],
          };
        }
        if (e.points.length < 3) {
          return {
            document: doc,
            summary: `measure_area: polyline '${entityId}' has fewer than 3 points.`,
            affected: [],
          };
        }
        area = polygonArea(e.points);
        break;
      }
      default:
        return {
          document: doc,
          summary: `measure_area: entity '${entityId}' is kind '${e.kind}'; supported kinds are 'circle', 'rectangle', 'polyline'.`,
          affected: [],
        };
    }

    const data: MeasureAreaData = { area, unit: areaUnit };
    return {
      document: doc,
      summary: `Area of ${entityId} = ${area.toFixed(doc.displayPrecision)} ${areaUnit}.`,
      affected: [],
      data,
    };
  },
};

// ---------------------------------------------------------------------------
// 4. measure_perimeter
// ---------------------------------------------------------------------------

interface MeasurePerimeterParams {
  /** Id of a 2D shape entity: line, polyline, rectangle, circle, arc. */
  entityId: string;
}

interface MeasurePerimeterData {
  perimeter: number;
  unit: string;
}

/**
 * @command measure_perimeter
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { perimeter: number, unit: string }
 * @failure non-2D entity or missing id -> no-op, affected:[], no data
 */
export const measurePerimeter: CommandDefinition<MeasurePerimeterParams> = {
  name: 'measure_perimeter',
  description:
    "Compute the perimeter or total length of a 2D shape. Supported entity kinds: 'line' (segment length), " +
    "'polyline' (sum of segment lengths; closed polyline adds last→first segment), " +
    "'rectangle' (2*(width+height)), 'circle' (circumference 2πr), 'arc' (arc length r*|angle|). " +
    'Returns data: { perimeter, unit }. Does not modify the document.',
  paramsSchema: {
    type: 'object',
    properties: {
      entityId: {
        type: 'string',
        description:
          "Id of the 2D shape entity to measure. Supported kinds: 'line', 'polyline', 'rectangle', 'circle', 'arc'.",
      },
    },
    required: ['entityId'],
  },
  run: (doc, { entityId }): CommandResult => {
    const e = doc.entities[entityId];
    if (!e) {
      return { document: doc, summary: `measure_perimeter: entity '${entityId}' not found.`, affected: [] };
    }

    let perimeter: number;
    switch (e.kind) {
      case 'line': {
        const dx = e.end[0] - e.start[0];
        const dy = e.end[1] - e.start[1];
        perimeter = Math.sqrt(dx * dx + dy * dy);
        break;
      }
      case 'polyline': {
        perimeter = 0;
        const pts = e.points;
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i]!;
          const b = pts[i + 1]!;
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          perimeter += Math.sqrt(dx * dx + dy * dy);
        }
        if (e.closed && pts.length >= 2) {
          const last = pts[pts.length - 1]!;
          const first = pts[0]!;
          const dx = first[0] - last[0];
          const dy = first[1] - last[1];
          perimeter += Math.sqrt(dx * dx + dy * dy);
        }
        break;
      }
      case 'rectangle':
        perimeter = 2 * (e.width + e.height);
        break;
      case 'circle':
        perimeter = 2 * Math.PI * e.radius;
        break;
      case 'arc': {
        // Normalize angle span to [0, 2π].
        let span = e.endAngle - e.startAngle;
        if (span < 0) span += 2 * Math.PI;
        perimeter = e.radius * span;
        break;
      }
      default:
        return {
          document: doc,
          summary:
            `measure_perimeter: entity '${entityId}' is kind '${e.kind}'; ` +
            "supported kinds are 'line', 'polyline', 'rectangle', 'circle', 'arc'.",
          affected: [],
        };
    }

    const data: MeasurePerimeterData = { perimeter, unit: doc.units };
    return {
      document: doc,
      summary: `Perimeter of ${entityId} = ${formatLength(doc, perimeter)}.`,
      affected: [],
      data,
    };
  },
};

// ---------------------------------------------------------------------------
// 5. measure_bounding_box
// ---------------------------------------------------------------------------

interface MeasureBoundingBoxParams {
  /**
   * Id of a single entity. Omit to use selection or whole document.
   * When present, entityId takes precedence over useSelection.
   */
  entityId?: string;
  /**
   * When true (and entityId is not provided), compute the combined AABB of the
   * current document selection. Falls back to the whole document when selection is empty.
   */
  useSelection?: boolean;
}

interface MeasureBoundingBoxData {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

/**
 * @command measure_bounding_box
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { min: Vec3, max: Vec3, size: Vec3 }
 * @failure missing entity id, empty document -> no-op, affected:[], no data
 */
export const measureBoundingBox: CommandDefinition<MeasureBoundingBoxParams> = {
  name: 'measure_bounding_box',
  description:
    'Compute the world-space axis-aligned bounding box (AABB). Three modes: ' +
    '(a) entityId — AABB of one entity; ' +
    '(b) useSelection:true — combined AABB of the current document selection; ' +
    '(c) no params (or useSelection:false) — combined AABB of the entire document. ' +
    'Returns data: { min:[x,y,z], max:[x,y,z], size:[w,h,d] }. Does not modify the document. ' +
    'Note: entity rotation is NOT applied to bounds (axis-aligned approximation).',
  paramsSchema: {
    type: 'object',
    properties: {
      entityId: {
        type: 'string',
        description:
          'Id of the entity whose bounding box to compute. Takes precedence over useSelection.',
      },
      useSelection: {
        type: 'boolean',
        description:
          'When true and entityId is not provided, compute the AABB of the current selection. ' +
          'Falls back to the whole document if the selection is empty.',
      },
    },
    required: [],
  },
  run: (doc, { entityId, useSelection }): CommandResult => {
    let bounds: Bounds | null = null;

    if (entityId) {
      const e = doc.entities[entityId];
      if (!e) {
        return {
          document: doc,
          summary: `measure_bounding_box: entity '${entityId}' not found.`,
          affected: [],
        };
      }
      bounds = entityBounds(e);
    } else {
      const ids =
        useSelection && doc.selection.length > 0 ? doc.selection : doc.order;

      for (const id of ids) {
        const e = doc.entities[id];
        if (!e) continue;
        const b = entityBounds(e);
        bounds = bounds ? mergeBoundsLocal(bounds, b) : b;
      }

      if (!bounds) {
        return {
          document: doc,
          summary: 'measure_bounding_box: document is empty — no bounds to compute.',
          affected: [],
        };
      }
    }

    const size: Vec3 = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ];
    const data: MeasureBoundingBoxData = { min: bounds.min, max: bounds.max, size };
    return {
      document: doc,
      summary:
        `Bounding box: min=${bounds.min.map((v) => formatLength(doc, v)).join(', ')}; ` +
        `max=${bounds.max.map((v) => formatLength(doc, v)).join(', ')}; ` +
        `size=${size.map((v) => formatLength(doc, v)).join(' × ')}.`,
      affected: [],
      data,
    };
  },
};

// ---------------------------------------------------------------------------
// 6. measure_volume
// ---------------------------------------------------------------------------

interface MeasureVolumeParams {
  /** Id of a 3D solid entity (box, cylinder, sphere, extrusion, mesh). */
  entityId: string;
}

interface MeasureVolumeData {
  volume: number;
  unit: string;
}

/**
 * Signed-tetrahedra sum over an INDEXED triangle mesh — gives the solid volume.
 * Each triangle (A, B, C) contributes A · (B × C) to the scalar triple-product sum.
 * Summing over all `indices.length / 3` triangles and taking |sum| / 6 gives the volume.
 * Result is valid only for a closed, consistently-wound mesh (Manifold output satisfies this).
 *
 * `positions` is a deduplicated vertex buffer (flat [x0,y0,z0, x1,y1,z1, …]).
 * `indices` is the flat triangle index list ([i0,i1,i2, …], one triplet per triangle).
 *
 * Reference: "Efficient feature extraction for 2D/3D objects in mesh representation",
 * Cha Zhang & Tsuhan Chen, ICIP 2001.
 */
function meshVolume(positions: ReadonlyArray<number>, indices: ReadonlyArray<number>): number {
  let sum = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const ia = indices[t]! * 3, ib = indices[t + 1]! * 3, ic = indices[t + 2]! * 3;
    const ax = positions[ia]!,     ay = positions[ia + 1]!, az = positions[ia + 2]!;
    const bx = positions[ib]!,     by = positions[ib + 1]!, bz = positions[ib + 2]!;
    const cx = positions[ic]!,     cy = positions[ic + 1]!, cz = positions[ic + 2]!;
    // Scalar triple product A · (B × C)
    sum += ax * (by * cz - bz * cy)
         - ay * (bx * cz - bz * cx)
         + az * (bx * cy - by * cx);
  }
  return Math.abs(sum / 6);
}

/**
 * @command measure_volume
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { volume: number, unit: string } where unit is derived (e.g. "mm³")
 * @failure non-solid entity or missing id -> no-op, affected:[], no data
 */
export const measureVolume: CommandDefinition<MeasureVolumeParams> = {
  name: 'measure_volume',
  description:
    "Compute the volume of a 3D solid entity. Supported kinds: 'box' (w×h×d), " +
    "'cylinder' (π r² h), 'sphere' (4/3 π r³), 'extrusion' (profile area × depth), " +
    "'mesh' (signed-tetrahedra sum — assumes closed, consistently wound mesh), " +
    "'cone' (π r² h / 3), 'torus' (2 π² · ringRadius · tubeRadius²), " +
    "'wedge' (w×h×d / 2 — half the enclosing box), " +
    "'pyramid' (baseWidth × baseDepth × height / 3). " +
    'Returns data: { volume, unit } where unit is the cubed document unit (e.g. "mm³"). ' +
    '2D shape entities are rejected. Does not modify the document.',
  paramsSchema: {
    type: 'object',
    properties: {
      entityId: {
        type: 'string',
        description:
          "Id of the 3D solid entity to measure. Supported kinds: 'box', 'cylinder', 'sphere', " +
          "'extrusion', 'mesh', 'cone', 'torus', 'wedge', 'pyramid'.",
      },
    },
    required: ['entityId'],
  },
  run: (doc, { entityId }): CommandResult => {
    const e = doc.entities[entityId];
    if (!e) {
      return { document: doc, summary: `measure_volume: entity '${entityId}' not found.`, affected: [] };
    }

    const volumeUnit = `${doc.units}³`;
    let volume: number;

    switch (e.kind) {
      case 'box':
        volume = e.size[0] * e.size[1] * e.size[2];
        break;
      case 'cylinder':
        volume = Math.PI * e.radius * e.radius * e.height;
        break;
      case 'sphere':
        volume = (4 / 3) * Math.PI * e.radius * e.radius * e.radius;
        break;
      case 'extrusion':
        volume = polygonArea(e.profile) * e.depth;
        break;
      case 'mesh':
        volume = meshVolume(e.mesh.positions, e.mesh.indices);
        break;
      case 'cone':
        // V = π r² h / 3
        volume = (Math.PI * e.radius * e.radius * e.height) / 3;
        break;
      case 'torus':
        // V = 2 π² · ringRadius · tubeRadius²
        volume = 2 * Math.PI * Math.PI * e.ringRadius * e.tubeRadius * e.tubeRadius;
        break;
      case 'wedge':
        // Right-triangular prism: half the enclosing box volume
        volume = (e.size[0] * e.size[1] * e.size[2]) / 2;
        break;
      case 'pyramid':
        // V = baseWidth × baseDepth × height / 3
        volume = (e.baseWidth * e.baseDepth * e.height) / 3;
        break;
      default:
        return {
          document: doc,
          summary:
            `measure_volume: entity '${entityId}' is kind '${e.kind}'; ` +
            "supported kinds are 'box', 'cylinder', 'sphere', 'extrusion', 'mesh', 'cone', 'torus', 'wedge', 'pyramid'.",
          affected: [],
        };
    }

    const data: MeasureVolumeData = { volume, unit: volumeUnit };
    return {
      document: doc,
      summary: `Volume of ${entityId} = ${volume.toFixed(doc.displayPrecision)} ${volumeUnit}.`,
      affected: [],
      data,
    };
  },
};

// ---------------------------------------------------------------------------
// 7. mass_properties
// ---------------------------------------------------------------------------

interface MassPropertiesParams {
  /** Id of a 3D solid entity. */
  entityId: string;
  /**
   * Material density in g/mm³ (grams per cubic millimetre).
   * The document unit is assumed to be mm for the volume basis; adjust density
   * accordingly when the document uses other units.
   * @example 0.00785 for steel, 0.0027 for aluminium
   */
  density: number;
}

interface MassPropertiesData {
  volume: number;
  density: number;
  mass: number;
  unit: string;
}

/**
 * @command mass_properties
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { volume, density, mass, unit }
 * @failure non-solid entity, missing id, or density <= 0 -> no-op, affected:[], no data
 *
 * Density is a command param — no material model is stored on entities (planned Wave 3).
 * Unit assumption: density is in g/(document-unit)³ so that mass = volume × density in grams.
 */
export const massProperties: CommandDefinition<MassPropertiesParams> = {
  name: 'mass_properties',
  description:
    "Compute the mass of a 3D solid from its volume and a caller-supplied density. " +
    "Supported entity kinds: 'box', 'cylinder', 'sphere', 'extrusion', 'mesh'. " +
    "The density parameter is in g/(document-unit)³ — e.g. for a document in mm, density is g/mm³ " +
    "(steel ≈ 0.00785, aluminium ≈ 0.0027, PLA plastic ≈ 0.00124). " +
    "Density is NOT stored on the entity; pass it each time (Wave 3 will add a material model). " +
    "Returns data: { volume, density, mass, unit } where unit describes the mass unit (grams). " +
    "Does not modify the document.",
  paramsSchema: {
    type: 'object',
    properties: {
      entityId: {
        type: 'string',
        description:
          "Id of the 3D solid entity to compute mass for. Supported kinds: 'box', 'cylinder', 'sphere', 'extrusion', 'mesh'.",
      },
      density: {
        type: 'number',
        description:
          'Material density in g/(document-unit)³. Must be > 0. ' +
          'Examples for a mm document: steel ≈ 0.00785, aluminium ≈ 0.0027, PLA ≈ 0.00124.',
      },
    },
    required: ['entityId', 'density'],
  },
  run: (doc, { entityId, density }): CommandResult => {
    if (typeof density !== 'number' || density <= 0) {
      return {
        document: doc,
        summary: `mass_properties: density must be > 0, got ${String(density)}.`,
        affected: [],
      };
    }

    const e = doc.entities[entityId];
    if (!e) {
      return { document: doc, summary: `mass_properties: entity '${entityId}' not found.`, affected: [] };
    }

    const volumeResult = measureVolume.run(doc, { entityId });
    if (!volumeResult.data) {
      // measureVolume returned a no-op — propagate its summary.
      return { document: doc, summary: volumeResult.summary, affected: [] };
    }

    const { volume } = volumeResult.data as MeasureVolumeData;
    const mass = volume * density;
    const data: MassPropertiesData = { volume, density, mass, unit: 'g' };
    return {
      document: doc,
      summary:
        `Mass of ${entityId}: volume=${volume.toFixed(doc.displayPrecision)} ${doc.units}³, ` +
        `density=${density} g/${doc.units}³, mass=${mass.toFixed(doc.displayPrecision)} g.`,
      affected: [],
      data,
    };
  },
};
