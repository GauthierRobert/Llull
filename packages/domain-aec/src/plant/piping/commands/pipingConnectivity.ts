import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { buildGraph, pathBetween, selectRuns } from '../graph';
import { getPiping, refuse } from '../model';

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant derived afresh from the stored runs; the graph joins parts through their joints and through ports that meet (same point, opposite
 *   directions); an open end is a part port connected to nothing
 * @failure unknown line -> RTE_UNKNOWN_LINE; from / to that is neither a part nor a port, or only one of them -> RTE_UNKNOWN_PORT
 */
export const pipingConnectivity = defineCommand({
  name: 'piping_connectivity',
  description:
    'Query: the connectivity graph of routed pipe: nodes (every derived part, and the tie-ins / equipment nozzles that runs attach to), edges (joints between ' +
    'parts, attachments of a part to a port, olets welded to their header piece), openEnds (part ports connected to nothing: free run ends, unused ' +
    'tee outlets), components (connected groups of node ids), and mismatches (connected ports that disagree in size, ' +
    'rating, facing or end type). Give lineIds to limit it (attached branch and continuation runs are included); from + to (a port id such as ' +
    '"P-101:N2" or a tie-in id, or a part id) adds data.path, the shortest chain of node ids between them or null when they are not connected. ' +
    'data = { nodes, edges, openEnds, components, mismatches, path?, brokenRuns }; a run that no longer derives is listed in brokenRuns and left out. ' +
    'Does not modify the document. Refusals: RTE_UNKNOWN_LINE, RTE_UNKNOWN_PORT. Next: check_piping for the issues, route_pipe to connect an open end.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    lineIds: z.array(z.string()).optional().describe('Line ids to include (affected[0] of create_pipeline). Omit for every line.'),
    from: z.string().optional().describe('Path start: port id (tie-in id, "<tag>:<mark>") or part id. Give with `to`.'),
    to: z.string().optional().describe('Path end: port id or part id. Give with `from`.'),
  }),
  run: (doc, params): CommandResult => {
    const piping = getPiping(doc);
    const unknown = (params.lineIds ?? []).filter((id) => piping.lines[id] === undefined);
    if (unknown.length > 0)
      return refuse(doc, 'piping_connectivity', 'RTE_UNKNOWN_LINE', `no pipe line ${unknown.map((id) => `"${id}"`).join(', ')}`, unknown, [
        'lineIds',
      ]);
    const selection = selectRuns(doc, params.lineIds);
    const graph = buildGraph(doc, selection.graphRuns);
    let path: string[] | null | undefined;
    if (params.from !== undefined || params.to !== undefined) {
      const missing = [params.from, params.to].filter((id) => id === undefined || (!graph.parts.has(id) && !graph.externals.has(id)));
      if (missing.length > 0 || params.from === undefined || params.to === undefined)
        return refuse(
          doc,
          'piping_connectivity',
          'RTE_UNKNOWN_PORT',
          params.from === undefined || params.to === undefined
            ? 'give both from and to to get a path'
            : `from / to must be a port id or a part id of the selected runs (${missing.join(', ')} is neither)`,
          [params.from ?? '', params.to ?? ''].filter((id) => id !== ''),
          ['from', 'to'],
        );
      path = pathBetween(graph, params.from, params.to);
    }
    const nodes = [
      ...[...graph.parts.values()].map(({ part, runId, lineId }) => ({
        id: part.id,
        kind: 'part',
        partKind: part.kind,
        typeKey: part.typeKey,
        dn: part.dn,
        ...(part.dn2 === undefined ? {} : { dn2: part.dn2 }),
        runId,
        lineId,
      })),
      ...[...graph.externals.values()]
        .filter((port) => graph.attached.has(port.id))
        .map((port) => ({ id: port.id, kind: 'port', portKind: port.kind, tag: port.tag, dn: port.spec.dn, endType: port.spec.endType })),
    ];
    const brokenRuns = selection.broken.map(({ runId, failure }) => ({ runId, code: failure.code, message: failure.message }));
    return report(
      doc,
      `piping_connectivity: ${graph.parts.size} part(s), ${graph.edges.length} connection(s), ${graph.components.length} connected group(s), ${graph.openEnds.length} open end(s)` +
        `${graph.mismatches.length === 0 ? '' : `, ${graph.mismatches.length} mismatch(es)`}${brokenRuns.length === 0 ? '' : `, ${brokenRuns.length} broken run(s) left out`}` +
        `${path === undefined ? '' : path === null ? `; no path from ${params.from} to ${params.to}` : `; path of ${path.length} node(s)`}.`,
      {
        nodes,
        edges: graph.edges,
        openEnds: graph.openEnds,
        components: graph.components,
        mismatches: graph.mismatches,
        ...(path === undefined ? {} : { path }),
        runs: selection.runIds,
        brokenRuns,
      },
    );
  },
});
