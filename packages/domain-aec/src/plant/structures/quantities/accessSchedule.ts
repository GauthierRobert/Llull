/** Access schedule (06 STA M8): one row per walking surface with its level, top, area and the route to grade through the access graph. */

import type { CadDocument } from '@core/model/types';
import type { BuildingModel } from '@aec/building/types';
import { round } from '../../../shared/numeric';
import { buildAccessGraph } from '../access/graph/accessGraph';
import { disjointRoutes, legsTo, routeTree } from '../access/graph/search';
import { GRADE_ID, isRefusal } from '../access/graph/types';

type Row = Array<string | number>;

/** Largest number of independent routes the schedule counts (a second means of egress is 2). */
const SCHEDULE_ROUTES = 2;

/**
 * Surfaces of the access graph: mark, kind, level, top (mm), area (m2), legs to grade, route (marks), independent routes (up to 2).
 * @invariant a model the graph cannot handle gives one row naming the code, never an empty table
 */
export function accessScheduleRows(doc: CadDocument, building: BuildingModel): Row[] {
  const graph = buildAccessGraph(doc);
  if (isRefusal(graph)) return [[graph.code, graph.message, '', '', '', '', '', '']];
  const tree = routeTree(graph);
  const marks = new Map(graph.nodes.map((node) => [node.id, node.mark]));
  return graph.nodes
    .filter((node) => node.id !== GRADE_ID)
    .map((node) => {
      const legs = legsTo(tree, node.id);
      const route =
        legs === null
          ? 'NO ROUTE'
          : [
              GRADE_ID,
              ...legs.flatMap((leg) =>
                leg.edge.kind === 'adjacent' ? [marks.get(leg.to) ?? leg.to] : [leg.edge.mark, marks.get(leg.to) ?? leg.to],
              ),
            ].join(' > ');
      return [
        node.mark,
        node.kind,
        node.levelId === null ? '' : (building.levels[node.levelId]?.name ?? node.levelId),
        round(node.topMm, 1),
        round(node.areaM2, 3),
        legs === null ? '' : legs.length,
        route,
        legs === null ? 0 : disjointRoutes(graph, node.id, SCHEDULE_ROUTES),
      ];
    });
}
