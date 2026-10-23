import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { withoutRun } from '../derive';
import { getPiping, refuse } from '../model';

/**
 * @affects removes 1 pipe run from plant.piping and all its derived part entities (affected: [runId])
 * @invariant the line and the ports (tie-ins, nozzles) stay; the ports it connected are free to route again
 * @failure unknown run -> RTE_UNKNOWN_RUN; another run continues from one of its ends -> RTE_HAS_BRANCHES
 */
export const deletePipeRun = defineCommand({
  name: 'delete_pipe_run',
  description:
    'Delete a routed pipe run (from route_pipe or auto_route_pipe) and every derived part of it (pipe pieces, elbows, flanges, gaskets), freeing ' +
    'the tie-in points and nozzles it connected so the line can be re-routed. The pipe line and the ports stay. Refusals: RTE_UNKNOWN_RUN; ' +
    'RTE_HAS_BRANCHES when another run starts or ends at one of its ends (delete that run first; ids in the result).',
  annotations: { destructive: true },
  params: z.object({ runId: z.string().describe('Pipe run id (affected[0] of route_pipe / auto_route_pipe).') }),
  run: (doc, { runId }): CommandResult => {
    const piping = getPiping(doc);
    if (piping.runs[runId] === undefined) return refuse(doc, 'delete_pipe_run', 'RTE_UNKNOWN_RUN', `no pipe run "${runId}"`, [], ['runId']);
    const dependents = piping.runOrder.filter((id) => {
      const run = piping.runs[id];
      return [run?.start.ref, run?.end.ref].some((ref) => ref?.kind === 'runEnd' && ref.runId === runId);
    });
    if (dependents.length > 0)
      return refuse(
        doc,
        'delete_pipe_run',
        'RTE_HAS_BRANCHES',
        `run(s) ${dependents.join(', ')} continue from the ends of ${runId}`,
        [runId, ...dependents],
        ['runId'],
      );
    return changed(withoutRun(doc, runId), `delete_pipe_run: removed run ${runId}; its ports are free again.`, [runId]);
  },
});
