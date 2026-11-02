/**
 * The access graph (06 STA §5.7): nodes = grade and walkable surfaces, edges = ladders, stairs and surfaces that touch. Bounded (caps checked before
 * anything is allocated, coded refusal above), deterministic (model order, ids compared as text) and total (never throws).
 */

import type { CadDocument } from '@core/model/types';
import { MM_PER_UNIT } from '@core/model/units';
import { elementsOf, getBuilding } from '@aec/building/model';
import { connectorEdges } from './connectors';
import { boxesNear, ringsWithin } from './regions';
import { gradeNode, surfaceNodes } from './surfaces';
import {
  CONTACT_GAP_MM,
  CONTACT_Z_MM,
  GRADE_ID,
  GRAPH_LIMITS,
  type AccessEdge,
  type AccessGraph,
  type GraphRefusal,
  type SurfaceNode,
} from './types';

const touching = (a: SurfaceNode, b: SurfaceNode): boolean =>
  a.regions.some((x) => b.regions.some((y) => boxesNear(x.box, y.box, CONTACT_GAP_MM) && ringsWithin(x.outer, y.outer, CONTACT_GAP_MM)));

/** Pairs of surfaces whose tops differ by at most 20 mm and whose outlines touch or overlap (within 10 mm), plus the surfaces standing on grade. */
function contactEdges(nodes: readonly SurfaceNode[], gradeMm: number): AccessEdge[] | GraphRefusal {
  const edges: AccessEdge[] = [];
  const walkable = nodes.filter((node) => node.kind !== 'grade');
  for (const node of walkable)
    if (Math.abs(node.topMm - gradeMm) <= CONTACT_Z_MM)
      edges.push({
        id: `adjacent:${GRADE_ID}|${node.id}`,
        kind: 'adjacent',
        mark: `${GRADE_ID}|${node.mark}`,
        from: GRADE_ID,
        to: node.id,
        clearWidthMm: null,
        riseMm: 0,
      });
  // Sweep along x: a pair is a candidate when the boxes overlap within the gap and the tops are within the contact tolerance.
  const order = [...walkable].sort((a, b) => a.box[0] - b.box[0] || (a.id < b.id ? -1 : 1));
  let tests = 0;
  for (let i = 0; i < order.length; i++) {
    const a = order[i] as SurfaceNode;
    for (let j = i + 1; j < order.length; j++) {
      const b = order[j] as SurfaceNode;
      if (b.box[0] > a.box[2] + CONTACT_GAP_MM) break;
      if (Math.abs(a.topMm - b.topMm) > CONTACT_Z_MM || !boxesNear(a.box, b.box, CONTACT_GAP_MM)) continue;
      if (++tests > GRAPH_LIMITS.contactTests)
        return {
          code: 'STA_ACCESS_GRAPH_LIMIT',
          message: `more than ${GRAPH_LIMITS.contactTests} outline contact tests between walking surfaces`,
        };
      if (!touching(a, b)) continue;
      const [first, second] = a.id < b.id ? [a, b] : [b, a];
      edges.push({
        id: `adjacent:${first.id}|${second.id}`,
        kind: 'adjacent',
        mark: `${first.mark}|${second.mark}`,
        from: first.id,
        to: second.id,
        clearWidthMm: null,
        riseMm: 0,
      });
    }
  }
  return edges.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * Builds the graph of `doc`. Grade is the elevation of the lowest level (06 STA §5.7).
 * @failure no building level -> STA_NO_GRADE; more than the caps -> STA_ACCESS_GRAPH_LIMIT (nothing is allocated for the oversized part)
 */
export function buildAccessGraph(doc: CadDocument): AccessGraph | GraphRefusal {
  const building = getBuilding(doc);
  const levels = Object.values(building.levels);
  if (levels.length === 0) return { code: 'STA_NO_GRADE', message: 'the building has no level, so there is no grade to start from' };
  const rawSurfaces = elementsOf(building, 'slab').length + elementsOf(building, 'grating').length;
  if (rawSurfaces > GRAPH_LIMITS.rawSurfaces)
    return { code: 'STA_ACCESS_GRAPH_LIMIT', message: `${rawSurfaces} slabs and grating panels (limit ${GRAPH_LIMITS.rawSurfaces})` };
  const connectors =
    elementsOf(building, 'ladder').length + elementsOf(building, 'steelStair').length + elementsOf(building, 'stair').length;
  if (connectors > GRAPH_LIMITS.connectors)
    return { code: 'STA_ACCESS_GRAPH_LIMIT', message: `${connectors} ladders and stairs (limit ${GRAPH_LIMITS.connectors})` };
  const gradeMm = Math.min(...levels.map((level) => level.elevation)) * MM_PER_UNIT[doc.units];
  const nodes = [gradeNode(gradeMm), ...surfaceNodes(doc, building)];
  const { edges: connected, dangling } = connectorEdges(doc, building, nodes);
  const contacts = contactEdges(nodes, gradeMm);
  if ('code' in contacts) return contacts;
  return { nodes, edges: [...connected, ...contacts], dangling, gradeMm };
}
