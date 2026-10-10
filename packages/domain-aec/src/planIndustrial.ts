/**
 * @layer domain-aec
 */

import { shapeOf } from './industrial/equipmentShape';
import type { Vec2 } from '@core/model/types';
import type { BuildingElement, BuildingLevel } from '@core/model/building';
import { distance } from '@lib/polygon';
import { fromMm, getBuilding } from './model';
import { MEMBER_LAYER } from './entities';
import { sweepFrame } from './mesh';
import { findProfile, profileOutline } from './steel/profiles';
import { plateLayout } from './industrial/evaluateConnections';
import {
  type PlanPrimitive,
  type PlanSource,
  annotationText,
  layerName,
  thinLine,
} from './planModel';
import { columnPrimitive } from './planArchitectural';

/** Both edges of a plan polyline offset by ±`half` (mitred at the bends). */
function offsetPolyline(points: ReadonlyArray<Vec2>, half: number): Vec2[][] {
  const normalOf = (a: Vec2, b: Vec2): Vec2 => {
    const length = distance(a, b) || 1;
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
function rectangleAt(
  center: readonly [number, number, ...number[]],
  hx: number,
  hy: number,
  angle = 0,
): Vec2[] {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  return (
    [
      [-hx, -hy],
      [hx, -hy],
      [hx, hy],
      [-hx, hy],
    ] as const
  ).map(([x, y]): Vec2 => [center[0] + x * cos - y * sin, center[1] + x * sin + y * cos]);
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
  const flat = (point: readonly [number, number, ...number[]]): Vec2 => [point[0], point[1]];
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
      if (distance(a, b) < 1e-9) return [];
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
      const first = points[0];
      if (!first) return [];
      let [a, b, longest] = [first, first, -1];
      for (const p of points) {
        for (const q of points) {
          const separation = distance(p, q);
          if (separation > longest) [a, b, longest] = [p, q, separation];
        }
      }
      return [thinLine(layerName('panel'), a, b)];
    }
    case 'equipment': {
      const [length, width] = element.size;
      const rectangle = (hx: number, hy: number): Vec2[] =>
        rectangleAt(element.location, hx, hy, element.angle);
      const layer = layerName('equipment');
      const round = shapeOf(element) === 'vertical_vessel';
      const [cx, cy] = element.location;
      const arm = length / 2;
      const outline: PlanPrimitive[] = round
        ? [
            { type: 'circle', layer, style: 'thin', center: [cx, cy], radius: arm },
            thinLine(layer, [cx - arm / 2, cy], [cx + arm / 2, cy]),
            thinLine(layer, [cx, cy - arm / 2], [cx, cy + arm / 2]),
          ]
        : [{ type: 'polygon', layer, style: 'thin', points: rectangle(length / 2, width / 2) }];
      const zone: PlanPrimitive[] =
        element.clearance <= 0
          ? []
          : round
            ? [
                {
                  type: 'circle',
                  layer,
                  style: 'hidden',
                  center: [cx, cy],
                  radius: arm + element.clearance,
                },
              ]
            : [
                {
                  type: 'polygon',
                  layer,
                  style: 'hidden',
                  points: rectangle(length / 2 + element.clearance, width / 2 + element.clearance),
                },
              ];
      return [
        ...outline,
        ...zone,
        annotationText(
          layer,
          element.location,
          fromMm(doc, 250),
          `${element.mark} ${element.name}`,
        ),
      ];
    }
    case 'pipe': {
      const points = element.points.map(flat);
      const layer = layerName('pipe');
      const [a, b] = points;
      if (!a || !b) return [];
      return [
        { type: 'polyline', layer, style: 'thin', points },
        annotationText(
          layer,
          [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + fromMm(doc, 200)],
          fromMm(doc, 180),
          `${element.mark} ${element.service} Ø${element.diameter}`,
        ),
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
          (point, index, all) => index === 0 || distance(point, all[index - 1] ?? point) > 1e-9,
        );
      const layer = layerName('tray');
      const [a, b] = points;
      if (!a || !b) {
        const half = element.width / 2;
        if (!a) return [];
        return [
          {
            type: 'polygon',
            layer,
            style: 'thin',
            points: rectangleAt(a, half, half),
          },
        ];
      }
      return [
        ...offsetPolyline(points, element.width / 2).map(
          (side): PlanPrimitive => ({ type: 'polyline', layer, style: 'hidden', points: side }),
        ),
        annotationText(
          layer,
          [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + element.width / 2 + fromMm(doc, 150)],
          fromMm(doc, 180),
          `${element.mark} ${element.system} ${element.width}×${element.height}`,
        ),
      ];
    }
  }
}

/**
 * Cut symbol, on the plan of `level`, of a concrete or vertical steel column that belongs to ANOTHER
 * level but whose vertical extent crosses the plan cut (`level.elevation + cutHeight`).
 * @pure
 */
export function crossingColumnPrimitives(
  doc: PlanSource,
  element: BuildingElement,
  level: BuildingLevel,
  cutHeight: number,
): PlanPrimitive[] {
  if (element.category !== 'column' && element.category !== 'member') return [];
  const home = getBuilding(doc).levels[element.levelId];
  if (!home) return [];
  const relativeCut = level.elevation + cutHeight - home.elevation;
  if (element.category === 'column')
    return relativeCut >= 0 && relativeCut < element.height ? [columnPrimitive(element)] : [];
  if (element.role !== 'column') return [];
  const [dx, dy, dz] = [
    element.end[0] - element.start[0],
    element.end[1] - element.start[1],
    element.end[2] - element.start[2],
  ];
  const vertical = Math.abs(dz) > 0.9 * Math.hypot(dx, dy, dz);
  const crosses =
    Math.min(element.start[2], element.end[2]) <= relativeCut &&
    Math.max(element.start[2], element.end[2]) >= relativeCut;
  return vertical && crosses ? industrialPrimitives(doc, element, relativeCut) : [];
}
