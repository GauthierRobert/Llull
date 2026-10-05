/**
 * Oriented boxes of building elements (swept members, pipes, trays, curved walls, equipment, solids) and their SAT overlap.
 * @layer domain-aec
 * @pure
 */

import type { CadDocument, Vec2, Vec3 } from '@core/model/types';
import type { BuildingElement, BuildingLevel, BuildingModel } from '@core/model/building';
import { fromMm } from '../model';
import { sweepFrame } from '../mesh';
import { distance } from '@lib/polygon';
import { cross3, dot3, scale3, sub3 } from '@lib/vec3';
import { midpoint } from '../vec3';
import { findProfile } from '../steel/profiles';
import { atLevel } from './evaluate';
import { arcPoints, curvedWallArc, curvedWallBand } from '../curvedWallGeometry';
import { supportShape } from './supportParts';

/** Oriented box: centre, orthonormal axes and half sizes along them. */
export interface OrientedBox {
  readonly center: Vec3;
  readonly axes: readonly [Vec3, Vec3, Vec3];
  readonly half: Vec3;
}

/**
 * Penetration depth of two oriented boxes along their best separating axis (≤ 0 when apart).
 * @pure
 */
export function boxOverlap(a: OrientedBox, b: OrientedBox): number {
  const axes: Vec3[] = [...a.axes, ...b.axes];
  for (const u of a.axes)
    for (const v of b.axes) {
      const axis = cross3(u, v);
      const length = Math.hypot(...axis);
      if (length > 1e-9) axes.push([axis[0] / length, axis[1] / length, axis[2] / length]);
    }
  const delta = sub3(b.center, a.center);
  const radius = (box: OrientedBox, axis: Vec3): number =>
    box.half[0] * Math.abs(dot3(box.axes[0], axis)) +
    box.half[1] * Math.abs(dot3(box.axes[1], axis)) +
    box.half[2] * Math.abs(dot3(box.axes[2], axis));
  let depth = Infinity;
  for (const axis of axes) {
    const overlap = radius(a, axis) + radius(b, axis) - Math.abs(dot3(delta, axis));
    if (overlap <= 0) return overlap;
    depth = Math.min(depth, overlap);
  }
  return depth;
}

function zRotated(angle: number): readonly [Vec3, Vec3, Vec3] {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  return [
    [cos, sin, 0],
    [-sin, cos, 0],
    [0, 0, 1],
  ];
}

/** One oriented box per segment of a swept polyline (constant half section). */
function polylineBoxes(
  level: BuildingLevel,
  points: ReadonlyArray<Vec3>,
  halfWidth: number,
  halfDepth: number,
): OrientedBox[] {
  const boxes: OrientedBox[] = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const start = atLevel(level, points[index] as Vec3);
    const end = atLevel(level, points[index + 1] as Vec3);
    const frame = sweepFrame(start, end);
    if (!frame) continue;
    boxes.push({
      center: midpoint(start, end),
      axes: [frame.u, frame.v, frame.d],
      half: [halfWidth, halfDepth, frame.length / 2],
    });
  }
  return boxes;
}

/** Oriented boxes of an element's solid parts (empty for categories not checked). */
export function elementBoxes(
  doc: CadDocument,
  building: BuildingModel,
  element: BuildingElement,
): OrientedBox[] {
  const level = 'levelId' in element ? building.levels[element.levelId] : undefined;
  switch (element.category) {
    case 'member': {
      const profile = findProfile(element.profile);
      if (!level || !profile) return [];
      const [start, end] = [atLevel(level, element.start), atLevel(level, element.end)];
      const frame = sweepFrame(start, end, element.roll);
      if (!frame) return [];
      return [
        {
          center: midpoint(start, end),
          axes: [frame.u, frame.v, frame.d],
          half: [fromMm(doc, profile.b) / 2, fromMm(doc, profile.h) / 2, frame.length / 2],
        },
      ];
    }
    case 'pipe':
      return level
        ? polylineBoxes(level, element.points, element.diameter / 2, element.diameter / 2)
        : [];
    case 'tray':
      return level
        ? polylineBoxes(level, element.points, element.width / 2, element.height / 2)
        : [];
    case 'pipeSupport': {
      const pipe = building.elements[element.pipeId];
      if (!level || pipe?.category !== 'pipe') return [];
      const { angle, parts } = supportShape(doc, element, pipe);
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
      return parts.map((part): OrientedBox => {
        const half: Vec3 =
          part.kind === 'box'
            ? [part.size[0] / 2, part.size[1] / 2, part.size[2] / 2]
            : [part.radius, part.radius, part.height / 2];
        return {
          center: [
            element.position[0] - sin * part.across,
            element.position[1] + cos * part.across,
            level.elevation + part.z,
          ],
          axes: zRotated(angle),
          half,
        };
      });
    }
    case 'curvedWall': {
      const arc = curvedWallArc(element);
      if (!level || !arc || !curvedWallBand(element)) return [];
      const points = arcPoints(arc, arc.radius);
      const z = level.elevation + element.baseOffset + element.height / 2;
      return points.slice(1).map((point, index): OrientedBox => {
        const previous = points[index] as Vec2;
        const angle = Math.atan2(point[1] - previous[1], point[0] - previous[0]);
        return {
          center: [(point[0] + previous[0]) / 2, (point[1] + previous[1]) / 2, z],
          axes: zRotated(angle),
          half: [distance(previous, point) / 2, element.thickness / 2, element.height / 2],
        };
      });
    }
    case 'equipment': {
      if (!level) return [];
      const [length, width, height] = element.size;
      return [
        {
          center: [element.location[0], element.location[1], level.elevation + height / 2],
          axes: zRotated(element.angle),
          half: [length / 2, width / 2, height / 2],
        },
      ];
    }
    case 'wall':
    case 'column':
    case 'beam':
    case 'stair':
      return element.entityIds.flatMap((id) => {
        const entity = doc.entities[id];
        if (entity?.kind === 'box') {
          return [
            {
              center: entity.position,
              axes: zRotated(entity.rotation[2]),
              half: scale3(entity.size, 0.5),
            },
          ];
        }
        if (entity?.kind === 'cylinder') {
          return [
            {
              center: entity.position,
              axes: zRotated(0),
              half: [entity.radius, entity.radius, entity.height / 2] as Vec3,
            },
          ];
        }
        return [];
      });
    default:
      return [];
  }
}
