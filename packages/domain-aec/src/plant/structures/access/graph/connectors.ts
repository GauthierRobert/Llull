/** Edges of the access graph from ladders and stairs (06 STA §5.7): each end meets a surface within 50 mm in height and 600 mm in plan. */

import type { CadDocument, Vec2 } from '@core/model/types';
import { MM_PER_UNIT } from '@core/model/units';
import { elementsOf } from '@aec/building/model';
import type { BuildingModel, LadderElement, StairElement, SteelStairElement } from '@aec/building/types';
import { flightPoint, stairFlights as concreteFlights, stairPoint } from '@aec/building/geometry/stairGeometry';
import { directionOf, layoutSteelStair } from '../../stair/steelStairLayout';
import { stairSizes } from '../../stair/steelStairMeasure';
import { distanceToRegion, boxesNear } from './regions';
import { CONNECT_REACH_MM, CONNECT_Z_MM, GRADE_ID, type AccessEdge, type DanglingConnector, type SurfaceNode } from './types';

/** Distance in plan from `point` to a node: 0 on grade, else to its nearest region. */
export function distanceToNode(point: Vec2, node: SurfaceNode): number {
  if (node.kind === 'grade') return 0;
  return Math.min(Infinity, ...node.regions.map((region) => distanceToRegion(point, region)));
}

/**
 * The node whose top is within `CONNECT_Z_MM` of `zMm` and whose plan lies within `CONNECT_REACH_MM` of `point`: the nearest, then grade, then the
 * lowest id. `skip` is a node that must not be returned (the other end of the connector).
 */
export function findSurface(nodes: readonly SurfaceNode[], point: Vec2, zMm: number, skip?: string): SurfaceNode | undefined {
  const reach = CONNECT_REACH_MM;
  const box = [point[0], point[1], point[0], point[1]] as const;
  let best: { node: SurfaceNode; distance: number } | undefined;
  for (const node of nodes) {
    if (node.id === skip || Math.abs(node.topMm - zMm) > CONNECT_Z_MM) continue;
    if (node.kind !== 'grade' && !boxesNear(node.box, box, reach)) continue;
    const distance = distanceToNode(point, node);
    if (distance > reach) continue;
    const closer = best === undefined || distance < best.distance - 1e-9;
    const tie =
      best !== undefined &&
      Math.abs(distance - best.distance) <= 1e-9 &&
      (node.id === GRADE_ID || (best.node.id !== GRADE_ID && node.id < best.node.id));
    if (closer || tie) best = { node, distance };
  }
  return best?.node;
}

interface Ends {
  readonly mark: string;
  readonly kind: 'ladder' | 'stair';
  readonly id: string;
  readonly bottom: { readonly point: Vec2; readonly zMm: number };
  readonly top: { readonly point: Vec2; readonly zMm: number };
  readonly clearWidthMm: number;
}

function connect(nodes: readonly SurfaceNode[], ends: Ends): AccessEdge | DanglingConnector {
  const dangling = (reason: string): DanglingConnector => ({ elementId: ends.id, mark: ends.mark, kind: ends.kind, reason });
  const from = findSurface(nodes, ends.bottom.point, ends.bottom.zMm);
  if (from === undefined)
    return dangling(`no walking surface within ${CONNECT_Z_MM} mm in height and ${CONNECT_REACH_MM} mm in plan of its foot`);
  const to = findSurface(nodes, ends.top.point, ends.top.zMm);
  if (to === undefined)
    return dangling(`no walking surface within ${CONNECT_Z_MM} mm in height and ${CONNECT_REACH_MM} mm in plan of its top`);
  if (to.id === from.id) return dangling(`both ends meet the same surface ${from.id}`);
  return {
    id: ends.id,
    kind: ends.kind === 'ladder' ? 'ladder' : 'stair',
    mark: ends.mark,
    from: from.id,
    to: to.id,
    clearWidthMm: ends.clearWidthMm,
    riseMm: ends.top.zMm - ends.bottom.zMm,
  };
}

function ladderEnds(building: BuildingModel, ladder: LadderElement, factor: number): Ends | null {
  const level = building.levels[ladder.levelId];
  if (level === undefined) return null;
  const point: Vec2 = [ladder.base[0] * factor, ladder.base[1] * factor];
  const foot = (level.elevation + ladder.base[2]) * factor;
  return {
    id: ladder.id,
    mark: ladder.mark,
    kind: 'ladder',
    bottom: { point, zMm: foot },
    top: { point, zMm: foot + ladder.climbHeight * factor },
    clearWidthMm: ladder.clearWidth * factor,
  };
}

function steelStairEnds(doc: CadDocument, building: BuildingModel, stair: SteelStairElement, factor: number): Ends | null {
  const level = building.levels[stair.levelId];
  if (level === undefined) return null;
  const { forward } = directionOf(stair.angle);
  const run = layoutSteelStair(stair, stairSizes(doc, stair)).run;
  const foot = (level.elevation + stair.start[2]) * factor;
  return {
    id: stair.id,
    mark: stair.mark,
    kind: 'stair',
    bottom: { point: [stair.start[0] * factor, stair.start[1] * factor], zMm: foot },
    top: {
      point: [(stair.start[0] + forward[0] * run) * factor, (stair.start[1] + forward[1] * run) * factor],
      zMm: foot + stair.rise * factor,
    },
    clearWidthMm: stair.width * factor,
  };
}

function concreteStairEnds(building: BuildingModel, stair: StairElement, factor: number): Ends | null {
  const level = building.levels[stair.levelId];
  const flights = concreteFlights(stair);
  const last = flights[flights.length - 1];
  if (level === undefined || last === undefined) return null;
  const topLocal = flightPoint(last, last.risers * stair.treadDepth, 0);
  const top = stairPoint(stair, topLocal[0], topLocal[1]);
  return {
    id: stair.id,
    mark: stair.mark,
    kind: 'stair',
    bottom: { point: [stair.start[0] * factor, stair.start[1] * factor], zMm: level.elevation * factor },
    top: { point: [top[0] * factor, top[1] * factor], zMm: (level.elevation + stair.riserCount * stair.riserHeight) * factor },
    clearWidthMm: stair.width * factor,
  };
}

/** Ladders, steel stairs and concrete stairs as edges between the nodes, in model order; the ones that meet no surface at an end are `dangling`. */
export function connectorEdges(
  doc: CadDocument,
  building: BuildingModel,
  nodes: readonly SurfaceNode[],
): { edges: AccessEdge[]; dangling: DanglingConnector[] } {
  const factor = MM_PER_UNIT[doc.units];
  const edges: AccessEdge[] = [];
  const dangling: DanglingConnector[] = [];
  const ends: Array<{ id: string; mark: string; kind: 'ladder' | 'stair'; ends: Ends | null }> = [
    ...elementsOf(building, 'ladder').map((e) => ({
      id: e.id,
      mark: e.mark,
      kind: 'ladder' as const,
      ends: ladderEnds(building, e, factor),
    })),
    ...elementsOf(building, 'steelStair').map((e) => ({
      id: e.id,
      mark: e.mark,
      kind: 'stair' as const,
      ends: steelStairEnds(doc, building, e, factor),
    })),
    ...elementsOf(building, 'stair').map((e) => ({
      id: e.id,
      mark: e.mark,
      kind: 'stair' as const,
      ends: concreteStairEnds(building, e, factor),
    })),
  ];
  for (const item of ends) {
    const result =
      item.ends === null
        ? { elementId: item.id, mark: item.mark, kind: item.kind, reason: 'its level does not exist or it has no flight' }
        : connect(nodes, item.ends);
    if ('reason' in result) dangling.push(result);
    else edges.push(result);
  }
  return { edges, dangling };
}
