import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { getBuilding } from '@aec/building/model';
import { refuse } from '../../codes';
import { buildAccessGraph } from './accessGraph';
import { legsTo, routeIds, routeTree } from './search';
import { GRADE_ID, isRefusal } from './types';

const COMMAND = 'access_graph';

/**
 * @affects none: read-only query, answers in `data` { surfaces, connectors, dangling, unreachable, gradeElevationMm }
 * @invariant nodes in model order after grade; routes are the fewest legs from grade (connector ids and surface ids in walking order); deterministic and bounded
 * @failure no level -> STA_NO_GRADE; over the caps -> STA_ACCESS_GRAPH_LIMIT; an id that is not a surface or platform -> STA_UNKNOWN_ELEMENT
 */
export const accessGraph = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only access graph of the BUILDING model (the one check_reachability and the platform egress check of check_access search): nodes are grade (the lowest level) and the walking surfaces (floor slabs, loose grating panels, ' +
    'generated platforms and circular platforms as one node each); edges are fixed ladders, steel stairs and concrete stairs (an end meets a surface within 50 mm in height and 600 mm in plan) and surfaces whose tops differ by at most 20 mm and whose outlines touch (within 10 mm), ' +
    'plus surfaces standing on grade. Answers the surfaces (id, mark, kind, level, top, area, whether it connects to grade, the route from grade and its legs), the connectors (kind, id, from, to, clear width, rise) and the ladders / stairs that meet no surface at an end with the reason. ' +
    'Lengths are millimetres whatever the document units. Pass surfaceIds to list only those surfaces (a platform, slab or grating id).',
  params: z.object({
    surfaceIds: z
      .array(z.string())
      .optional()
      .describe('Only list these surfaces (slab, loose grating panel or platform assembly ids). Default: every surface.'),
  }),
  run: (doc, params): CommandResult => {
    const graph = buildAccessGraph(doc);
    if (isRefusal(graph)) return refuse(doc, COMMAND, graph.code, graph.message);
    const known = new Set(graph.nodes.map((node) => node.id));
    const unknown = (params.surfaceIds ?? []).filter((id) => !known.has(id) || id === GRADE_ID);
    if (unknown.length > 0)
      return refuse(doc, COMMAND, 'STA_UNKNOWN_ELEMENT', `no walking surface ${unknown.join(', ')}`, unknown, ['surfaceIds']);
    const building = getBuilding(doc);
    const tree = routeTree(graph);
    const wanted = params.surfaceIds === undefined ? undefined : new Set(params.surfaceIds);
    const surfaces = graph.nodes
      .filter((node) => node.id !== GRADE_ID && (wanted?.has(node.id) ?? true))
      .map((node) => {
        const legs = legsTo(tree, node.id);
        return {
          id: node.id,
          mark: node.mark,
          kind: node.kind,
          level: node.levelId === null ? null : (building.levels[node.levelId]?.name ?? node.levelId),
          topMm: node.topMm,
          areaM2: node.areaM2,
          members: node.members,
          connected: legs !== null,
          hops: legs?.length ?? null,
          route: legs === null ? null : routeIds(legs),
        };
      });
    const connectors = graph.edges.filter((edge) => edge.kind !== 'adjacent');
    const unreachable = graph.nodes.filter((node) => !tree.via.has(node.id)).map((node) => node.id);
    return report(
      doc,
      `${COMMAND}: ${graph.nodes.length - 1} surface(s), ${connectors.length} connector(s), ${graph.edges.length - connectors.length} contact(s); ` +
        `${unreachable.length} surface(s) without a route to grade${graph.dangling.length === 0 ? '' : `; ${graph.dangling.length} ladder/stair end(s) meet no surface`}.`,
      {
        gradeElevationMm: graph.gradeMm,
        surfaces,
        connectors,
        contacts: graph.edges.length - connectors.length,
        dangling: graph.dangling,
        unreachable,
      },
    );
  },
});
