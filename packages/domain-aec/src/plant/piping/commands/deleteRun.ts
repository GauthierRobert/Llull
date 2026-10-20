import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { getPiping, refuse, withPiping } from '../model';

/**
 * @affects removes 1 pipe run from plant.piping and its derived tube entity (affected: [runId])
 * @invariant the line and the tie-in points stay; the tie-ins it connected are free to route again
 * @failure unknown run -> RTE_UNKNOWN_RUN
 */
export const deletePipeRun = defineCommand({
  name: 'delete_pipe_run',
  description:
    'Delete a routed pipe run (from auto_route_pipe) and its tube geometry, freeing the tie-in points it connected so the line can be ' +
    're-routed. The pipe line and the tie-ins stay. Refusal: RTE_UNKNOWN_RUN.',
  annotations: { destructive: true },
  params: z.object({ runId: z.string().describe('Pipe run id (affected[0] of auto_route_pipe).') }),
  run: (doc, { runId }): CommandResult => {
    const piping = getPiping(doc);
    if (piping.runs[runId] === undefined) return refuse(doc, 'delete_pipe_run', 'RTE_UNKNOWN_RUN', `no pipe run "${runId}"`, [], ['runId']);
    const { [runId]: removedRun, ...runs } = piping.runs;
    const { [runId]: removedEntity, ...entities } = doc.entities;
    void removedRun;
    void removedEntity;
    const next = withPiping(
      { ...doc, entities, order: doc.order.filter((id) => id !== runId) },
      { ...piping, runs, runOrder: piping.runOrder.filter((id) => id !== runId) },
    );
    return changed(next, `delete_pipe_run: removed run ${runId}; its tie-in points are free again.`, [runId]);
  },
});
