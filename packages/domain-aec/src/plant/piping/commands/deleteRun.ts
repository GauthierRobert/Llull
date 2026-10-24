import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import type { PipeRun } from '@aec/plant/types';
import { withoutRun } from '../derive';
import { getPiping, refuse } from '../model';
import { attachedRunIds, withDependents } from '../runLinks';
import { supportsByRun } from '../runSupports';
import { refuseDerivation, rederive, withRuns } from '../runUpdate';

/**
 * @affects removes 1 pipe run from plant.piping and all its derived part entities (affected: [runId]); with `cascade` also every run attached to it
 *   (branch runs, continuations); a deleted branch run leaves its header, which loses the branch point (tee / olet) and is re-derived; the pipe supports
 *   of the deleted runs are deleted with them (add_pipe_support runId) and named in the summary and in data.deletedSupports
 * @invariant the line and the ports (tie-ins, nozzles) stay; the ports it connected are free to route again
 * @failure unknown run -> RTE_UNKNOWN_RUN; another run is attached to it (a branch, or a run that continues from one of its ends) and no cascade ->
 *   RTE_HAS_BRANCHES
 */
export const deletePipeRun = defineCommand({
  name: 'delete_pipe_run',
  description:
    'Delete a routed pipe run (from route_pipe, auto_route_pipe or add_branch) and every derived part of it (pipe pieces, elbows, flanges, gaskets, ' +
    'valves, reducers, tees), freeing the tie-in points and nozzles it connected so the line can be re-routed. The pipe line and the ports stay. ' +
    'Deleting a branch run removes its branch point from the header, which is re-cut without the tee (an olet is removed). Refusals: ' +
    'RTE_UNKNOWN_RUN; RTE_HAS_BRANCHES when another run is attached to it (a branch, or a run that starts or ends at one of its ends): delete those ' +
    'first (ids in the result) or pass cascade: true to delete them with it. The pipe supports of the deleted runs (add_pipe_support runId) are deleted with them and listed in the summary (data.deletedSupports).',
  annotations: { destructive: true },
  params: z.object({
    runId: z.string().describe('Pipe run id (affected[0] of route_pipe / auto_route_pipe / add_branch).'),
    cascade: z
      .boolean()
      .optional()
      .describe('Also delete every run attached to it, branches and continuations, recursively. Default false.'),
  }),
  run: (doc, { runId, cascade = false }, ctx): CommandResult => {
    const piping = getPiping(doc);
    if (piping.runs[runId] === undefined) return refuse(doc, 'delete_pipe_run', 'RTE_UNKNOWN_RUN', `no pipe run "${runId}"`, [], ['runId']);
    const dependents = attachedRunIds(piping, runId);
    if (dependents.length > 0 && !cascade)
      return refuse(
        doc,
        'delete_pipe_run',
        'RTE_HAS_BRANCHES',
        `run(s) ${dependents.join(', ')} are attached to ${runId} (branches or continuations from its ends)`,
        [runId, ...dependents],
        ['runId'],
      );
    const doomed = cascade ? withDependents(piping, runId) : [runId];
    const gone = new Set(doomed);
    // A header that loses a branch run loses its branch point too.
    const headers = new Map<string, PipeRun>();
    for (const id of doomed) {
      const ref = (piping.runs[id] as PipeRun).start.ref;
      const header = ref?.kind === 'branch' && !gone.has(ref.runId) ? (headers.get(ref.runId) ?? piping.runs[ref.runId]) : undefined;
      if (header === undefined) continue;
      const { branches, ...rest } = header;
      const kept = (branches ?? []).filter((point) => point.branchRunId !== id);
      headers.set(header.id, kept.length === 0 ? rest : { ...rest, branches: kept });
    }
    const removed = doomed.reduce(withoutRun, doc);
    const result = headers.size === 0 ? null : rederive(withRuns(removed, [...headers.values()]), [...headers.keys()]);
    if (result !== null && !result.ok) return refuseDerivation(doc, 'delete_pipe_run', result, runId);
    const after = result === null ? removed : result.document;
    const carried = supportsByRun(doc);
    const supports = doomed.flatMap((id) => carried[id] ?? []);
    const dropped =
      supports.length === 0 ? null : execute(after, 'delete_building_element', { elementIds: supports.map((support) => support.id) }, ctx);
    if (dropped !== null && (dropped.rejected === true || dropped.document === after))
      return refuse(
        doc,
        'delete_pipe_run',
        dropped.error?.code ?? 'RTE_UNKNOWN_RUN',
        `its pipe supports could not be deleted: ${dropped.summary}`,
        supports.map((support) => support.id),
        ['runId'],
      );
    return {
      ...changed(
        dropped === null ? after : dropped.document,
        `delete_pipe_run: removed run ${runId}${doomed.length > 1 ? ` and ${doomed.length - 1} attached run(s) ${doomed.slice(1).join(', ')}` : ''}; its ports are free again${headers.size === 0 ? '' : `; header ${[...headers.keys()].join(', ')} re-derived without the branch`}${supports.length === 0 ? '' : `; deleted its ${supports.length} pipe support(s) ${supports.map((support) => support.mark).join(', ')}`}.`,
        [...doomed, ...supports.map((support) => support.id)],
      ),
      data: { deletedRuns: doomed, deletedSupports: supports.map((support) => support.id) },
    };
  },
});
