/**
 * Evaluates a road alignment: centreline, station ticks + labels, curve annotations, and (with a
 * profile and road section) the corridor mesh, side slopes and daylight lines.
 * @layer domain-aec/civil
 * @pure
 */

import type { Entity, Vec2 } from '@core/model/types';
import type { AlignmentObject } from '@core/model/civil';
import { civilLine, civilPoint, civilPolyline, civilText } from './entities';
import {
  centrelinePoints,
  elementPointAt,
  endStation,
  horizontalElements,
  pointAtStation,
} from './alignmentGeometry';
import { evaluateCorridor } from './corridorMesh';
import { formatStation } from './model';
import { labelHeight, type CivilContext } from './context';
import { toMetres } from '../model';

/** Station ticks drawn per alignment at most; the tick spacing grows to stay under it. */
export const MAX_STATION_TICKS = 500;

function stationTicks(context: CivilContext, alignment: AlignmentObject): Entity[] {
  const start = alignment.startStation;
  const end = endStation(alignment);
  const count = Math.floor((end - start) / alignment.stationInterval + 1e-9) + 1;
  const stride = Math.max(1, Math.ceil(count / MAX_STATION_TICKS));
  const height = labelHeight(context.doc);
  const entities: Entity[] = [];
  for (let k = 0; k < count; k += stride) {
    const station = start + k * alignment.stationInterval;
    const placed = pointAtStation(alignment, station);
    if (!placed) continue;
    const label = formatStation(toMetres(context.doc, station));
    const nx = -Math.sin(placed.direction);
    const ny = Math.cos(placed.direction);
    const [x, y] = placed.point;
    entities.push(
      civilLine(
        alignment,
        `t${k}`,
        `${alignment.name} ${label}`,
        'stations',
        [x - nx * height, y - ny * height],
        [x + nx * height, y + ny * height],
      ),
      civilText(
        alignment,
        `t${k}_label`,
        label,
        'stations',
        [x + nx * height * 2.5, y + ny * height * 2.5, 0],
        height,
        normaliseAngle(placed.direction),
      ),
    );
  }
  return entities;
}

function normaliseAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a < -Math.PI / 2) a += Math.PI;
  return a;
}

function spiralAnnotations(
  context: CivilContext,
  alignment: AlignmentObject,
  elements: ReturnType<typeof horizontalElements>,
): Entity[] {
  const height = labelHeight(context.doc);
  const station = (s: number): string => formatStation(toMetres(context.doc, s));
  const entities: Entity[] = [];
  let index = 0;
  for (const element of elements) {
    if (element.kind !== 'spiral') continue;
    const j = index++;
    const entry = element.radiusStart === Infinity;
    const at = (p: Vec2): [number, number, number] => [p[0], p[1] + height * 2, 0];
    entities.push(
      civilText(
        alignment,
        `sp${j}_start`,
        `${entry ? 'TS' : 'CS'} ${station(element.startStation)}`,
        'annotation',
        at(element.start),
        height,
      ),
      civilText(
        alignment,
        `sp${j}_end`,
        `${entry ? 'SC' : 'ST'} ${station(element.startStation + element.length)}`,
        'annotation',
        at(element.end),
        height,
      ),
    );
  }
  return entities;
}

function curveAnnotations(context: CivilContext, alignment: AlignmentObject): Entity[] {
  const height = labelHeight(context.doc);
  const elements = horizontalElements(alignment);
  const entities: Entity[] = [];
  let index = 0;
  elements.forEach((element, position) => {
    if (element.kind !== 'arc') return;
    const i = index++;
    const transition =
      elements[position - 1]?.kind === 'spiral' || elements[position + 1]?.kind === 'spiral';
    const mid = elementPointAt(element, element.startStation + element.length / 2).point;
    const outward = (p: Vec2): Vec2 => {
      const length = Math.hypot(p[0] - element.center[0], p[1] - element.center[1]);
      return [
        p[0] + ((p[0] - element.center[0]) / length) * height * 2,
        p[1] + ((p[1] - element.center[1]) / length) * height * 2,
      ];
    };
    const station = (s: number): string => formatStation(toMetres(context.doc, s));
    const place = (p: Vec2): [number, number, number] => [...outward(p), 0];
    entities.push(
      civilPoint(alignment, `pi${i}`, `${alignment.name} PI`, 'centreline', [
        element.pi[0],
        element.pi[1],
        0,
      ]),
      ...(transition
        ? []
        : [
            civilText(
              alignment,
              `pc${i}`,
              `PC ${station(element.startStation)}`,
              'annotation',
              place(element.start),
              height,
            ),
            civilText(
              alignment,
              `pt${i}`,
              `PT ${station(element.startStation + element.length)}`,
              'annotation',
              place(element.end),
              height,
            ),
          ]),
      civilText(
        alignment,
        `r${i}`,
        `R=${Number(toMetres(context.doc, element.radius).toFixed(2))}`,
        'annotation',
        place(mid),
        height,
      ),
    );
  });
  return [...entities, ...spiralAnnotations(context, alignment, elements)];
}

export function evaluateAlignment(context: CivilContext, alignment: AlignmentObject): Entity[] {
  const points = centrelinePoints(alignment);
  if (points.length < 2) return [];
  return [
    civilPolyline(
      alignment,
      'centreline',
      `${alignment.name} centreline`,
      'centreline',
      points,
      false,
      0,
    ),
    ...stationTicks(context, alignment),
    ...curveAnnotations(context, alignment),
    ...evaluateCorridor(context, alignment),
  ];
}
