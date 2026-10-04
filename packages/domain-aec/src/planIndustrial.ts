/**
 * @layer domain-aec
 */

import type { Vec2 } from '@core/model/types';
import type { BuildingElement } from '@core/model/building';
import { fromMm, getBuilding } from './model';
import { MEMBER_LAYER } from './entities';
import { sweepFrame } from './mesh';
import { findProfile, profileOutline } from './steel/profiles';
import { plateLayout } from './industrial/evaluateConnections';
import { type PlanPrimitive, type PlanSource, layerName } from './planModel';

/** Both edges of a plan polyline offset by ±`half` (mitred at the bends). */
function offsetPolyline(points: ReadonlyArray<Vec2>, half: number): Vec2[][] {
  const normalOf = (a: Vec2, b: Vec2): Vec2 => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
  };
  return [1, -1].map((side) =>
    points.map((point, index): Vec2 => {
      const previous = points[index - 1];
      const next = points[index + 1];
      const before = previous ? normalOf(previous, point) : null;
      const after = next ? normalOf(point, next) : null;
      const [nx, ny] =
        before && after
          ? [before[0] + after[0], before[1] + after[1]]
          : ((before ?? after ?? [0, 0]) as Vec2);
      const along = before && after ? 1 + before[0] * after[0] + before[1] * after[1] : 1;
      const factor = (side * half) / (before && after ? Math.max(along, 0.2) : 1);
      return [point[0] + nx * factor, point[1] + ny * factor];
    }),
  );
}

/** Corners of a `2·hx × 2·hy` rectangle centred on `center`, rotated by `angle` (counter-clockwise). */
function rectangleAt(center: readonly number[], hx: number, hy: number, angle = 0): Vec2[] {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  return (
    [
      [-hx, -hy],
      [hx, -hy],
      [hx, hy],
      [-hx, hy],
    ] as const
  ).map(
    ([x, y]): Vec2 => [
      (center[0] as number) + x * cos - y * sin,
      (center[1] as number) + x * sin + y * cos,
    ],
  );
}

/** Plan symbols of industrial elements (cut at `cutHeight` above the level). */
export function industrialPrimitives(
  doc: PlanSource,
  element: Extract<
    BuildingElement,
    { category: 'member' | 'footing' | 'panel' | 'equipment' | 'pipe' | 'tray' | 'plate' }
  >,
  cutHeight: number,
): PlanPrimitive[] {
  const flat = (point: readonly number[]): Vec2 => [point[0] as number, point[1] as number];
  switch (element.category) {
    case 'member': {
      const layer = MEMBER_LAYER[element.role].name;
      const frame = sweepFrame(element.start, element.end, element.roll);
      const profile = findProfile(element.profile);
      if (!frame || !profile) return [];
      const [low, high] = [
        Math.min(element.start[2], element.end[2]),
        Math.max(element.start[2], element.end[2]),
      ];
      if (Math.abs(frame.d[2]) > 0.9 && low <= cutHeight && high >= cutHeight) {
        const factor = fromMm(doc, 1);
        const section = (points: ReadonlyArray<Vec2>): Vec2[] =>
          points.map(
            ([x, y]): Vec2 => [
              element.start[0] + (frame.u[0] * x + frame.v[0] * y) * factor,
              element.start[1] + (frame.u[1] * x + frame.v[1] * y) * factor,
            ],
          );
        const { outer, holes } = profileOutline(profile);
        return [
          {
            type: 'polygon',
            layer,
            style: 'cut',
            points: section(outer),
            fill: 'solid',
            holes: holes.map(section),
          },
          ...holes.map(
            (hole): PlanPrimitive => ({
              type: 'polygon',
              layer,
              style: 'thin',
              points: section(hole),
            }),
          ),
        ];
      }
      // Roof framing (purlins, rafters, roof bracing) and side rails belong to the roof / elevation drawings.
      if (element.role === 'purlin' || element.role === 'rafter' || element.role === 'rail')
        return [];
      if (element.role === 'brace' && low > 2 * cutHeight) return [];
      const [a, b] = [flat(element.start), flat(element.end)];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) return [];
      return [{ type: 'line', layer, style: 'hidden', a, b }];
    }
    case 'footing': {
      const points = rectangleAt(element.location, element.width / 2, element.length / 2);
      return [{ type: 'polygon', layer: layerName('footing'), style: 'hidden', points }];
    }
    case 'panel': {
      if (element.role !== 'wall') return [];
      // A wall panel seen from above is a line: its two plan points farthest apart.
      const points = element.corners.map(flat);
      let [a, b, longest] = [points[0] as Vec2, points[0] as Vec2, -1];
      for (const p of points) {
        for (const q of points) {
          const distance = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (distance > longest) [a, b, longest] = [p, q, distance];
        }
      }
      return [{ type: 'line', layer: layerName('panel'), style: 'thin', a, b }];
    }
    case 'equipment': {
      const [length, width] = element.size;
      const rectangle = (hx: number, hy: number): Vec2[] =>
        rectangleAt(element.location, hx, hy, element.angle);
      const layer = layerName('equipment');
      return [
        { type: 'polygon', layer, style: 'thin', points: rectangle(length / 2, width / 2) },
        ...(element.clearance > 0
          ? [
              {
                type: 'polygon',
                layer,
                style: 'hidden',
                points: rectangle(length / 2 + element.clearance, width / 2 + element.clearance),
              } as PlanPrimitive,
            ]
          : []),
        {
          type: 'text',
          layer,
          style: 'annotation',
          at: element.location,
          height: fromMm(doc, 250),
          content: `${element.mark} ${element.name}`,
        },
      ];
    }
    case 'pipe': {
      const points = element.points.map(flat);
      const layer = layerName('pipe');
      const [a, b] = [points[0] as Vec2, points[1] as Vec2];
      return [
        { type: 'polyline', layer, style: 'thin', points },
        {
          type: 'text',
          layer,
          style: 'annotation',
          at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + fromMm(doc, 200)],
          height: fromMm(doc, 180),
          content: `${element.mark} ${element.service} Ø${element.diameter}`,
        },
      ];
    }
    case 'plate': {
      const building = getBuilding(doc);
      const member = building.elements[element.memberId];
      const level = building.levels[element.levelId];
      const layout =
        member?.category === 'member' && level ? plateLayout(doc, element, member, level) : null;
      if (!layout) return [];
      const layer = layerName('plate');
      return [
        {
          type: 'polygon',
          layer,
          style: 'thin',
          points: rectangleAt(layout.center, element.length / 2, element.width / 2, layout.angle),
        },
        ...layout.bolts.map(
          (center): PlanPrimitive => ({
            type: 'circle',
            layer,
            style: 'thin',
            center,
            radius: element.boltDiameter / 2,
          }),
        ),
      ];
    }
    case 'tray': {
      // Vertical risers collapse to one plan point: keep distinct consecutive points only.
      const points = element.points
        .map(flat)
        .filter(
          (point, index, all) =>
            index === 0 ||
            Math.hypot(
              point[0] - (all[index - 1] as Vec2)[0],
              point[1] - (all[index - 1] as Vec2)[1],
            ) > 1e-9,
        );
      const layer = layerName('tray');
      if (points.length < 2) {
        const half = element.width / 2;
        return [
          {
            type: 'polygon',
            layer,
            style: 'thin',
            points: rectangleAt(points[0] as Vec2, half, half),
          },
        ];
      }
      const [a, b] = [points[0] as Vec2, points[1] as Vec2];
      return [
        ...offsetPolyline(points, element.width / 2).map(
          (side): PlanPrimitive => ({ type: 'polyline', layer, style: 'hidden', points: side }),
        ),
        {
          type: 'text',
          layer,
          style: 'annotation',
          at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + element.width / 2 + fromMm(doc, 150)],
          height: fromMm(doc, 180),
          content: `${element.mark} ${element.system} ${element.width}×${element.height}`,
        },
      ];
    }
  }
}
