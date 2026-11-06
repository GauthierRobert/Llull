import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, noop } from '@core/commands/noop';
import type { PipeRun, RunEnd } from '@aec/plant/types';
import { len3, sub3 } from '@lib/vec3';
import { getPiping, refuse } from '../model';
import { refuseDerivation, rederive, withRuns } from '../runUpdate';

/**
 * @affects sets or clears `cap` on 1 open end of 1 run (affected[0] = runId) and re-derives it: the spec's cap part is placed at that end (one `cap`
 *   part, its butt / socket / threaded weld to the last pipe piece, the pipe cut shorter by the cap length)
 * @invariant a run end with a port (tie-in, nozzle, run end, branch) is never capped; the cap row comes from the line spec's catalogues at the run size
 *   there (no row is guessed); the cap is exported as PCF CAP and IFC pipe fitting
 * @failure unknown run -> RTE_UNKNOWN_RUN; end connected to a port or to another run -> RTE_CAP_INVALID; spec without a cap row / length / connection
 *   rule -> RTE_SPEC_NO_COMPONENT / RTE_NO_CONNECTION_RULE (document unchanged); already in the requested state -> no-op
 */
export const setRunEndCap = defineCommand({
  name: 'set_run_end_cap',
  description:
    'Close an open end of a routed pipe run (route_pipe / auto_route_pipe / add_branch) with a cap from the line spec, or take the cap off again. The cap is ' +
    'the spec catalogue row of type "cap" at the run size at that end (list_piping_catalogs / resolve_component; the bundled catalogue has none, so the spec ' +
    'must name an imported catalogue with cap rows). The cap takes its row length along the run and joins the pipe by the spec connection rule of its end ' +
    'type (butt weld, socket weld or threaded): the last pipe piece is cut shorter by that length (and the weld gap or socket engagement). A capped end ' +
    'no longer shows as RTE_OPEN_END in check_piping. Only an open end can be capped: an end connected to a tie-in, nozzle, branch or another run is ' +
    'refused (RTE_CAP_INVALID). cap: false removes the cap. Returns the run id (affected[0]); data = { runId, end, capped, capKey?, capLengthMm?, dn }. ' +
    'Refusals: RTE_UNKNOWN_RUN, RTE_CAP_INVALID, and the derivation codes when the spec has no usable cap row (RTE_SPEC_NO_COMPONENT, ' +
    'RTE_NO_CONNECTION_RULE, RTE_LEG_TOO_SHORT: the cap does not fit its leg). Next: check_piping, piping_takeoff (counts the cap), export_pcf.',
  params: z.object({
    runId: z.string().describe('Pipe run id (affected[0] of route_pipe / auto_route_pipe / add_branch).'),
    end: z.enum(['start', 'end']).describe('Which end of the run: "start" (first point) or "end" (last point).'),
    cap: z.boolean().optional().describe('true (default) puts the spec cap on the end; false takes it off.'),
  }),
  run: (doc, { runId, end, cap = true }): CommandResult => {
    const piping = getPiping(doc);
    const run = piping.runs[runId];
    if (run === undefined) return refuse(doc, 'set_run_end_cap', 'RTE_UNKNOWN_RUN', `no pipe run "${runId}"`, [], ['runId']);
    const current = run[end];
    if ((current.cap === true) === cap)
      return noop(doc, `set_run_end_cap: the ${end} of run ${runId} is already ${cap ? 'capped' : 'uncapped'}.`);
    if (cap) {
      const joined = current.ref !== undefined || connectedRunId(piping.runs, runId, end) !== undefined;
      if (joined)
        return refuse(
          doc,
          'set_run_end_cap',
          'RTE_CAP_INVALID',
          `the ${end} of run ${runId} is connected (${current.ref === undefined ? `run ${connectedRunId(piping.runs, runId, end)} continues from it` : 'it has a port'}): only an open end takes a cap`,
          [runId],
          ['end'],
        );
    }
    const { cap: removed, ...bare } = current;
    void removed;
    const next: RunEnd = cap ? { ...bare, cap: true } : bare;
    const result = rederive(withRuns(doc, [{ ...run, [end]: next }]), [runId]);
    if (!result.ok) return refuseDerivation(doc, 'set_run_end_cap', result, runId);
    const derivation = result.derivations[runId];
    const point = current.point;
    const part = derivation?.parts.find(
      (candidate) =>
        candidate.kind === 'cap' && candidate.centre !== undefined && len3(sub3(candidate.centre, point)) < 1e-6 * (1 + len3(point)),
    );
    const length = part?.dims['length'];
    return {
      ...changed(
        result.document,
        cap
          ? `set_run_end_cap: capped the ${end} of run ${runId} with ${part?.catalogueKey ?? 'a spec cap'}${length === undefined ? '' : ` (length ${+length.toFixed(3)} mm)`}.`
          : `set_run_end_cap: removed the cap from the ${end} of run ${runId}.`,
        [runId],
      ),
      data: {
        runId,
        end,
        capped: cap,
        ...(cap && part !== undefined
          ? { capKey: part.catalogueKey, ...(length === undefined ? {} : { capLengthMm: length }), dn: part.dn }
          : {}),
      },
    };
  },
});

/** Id of a run whose start or end is connected to `end` of run `runId` (a continuation), if any. */
function connectedRunId(runs: Readonly<Record<string, PipeRun>>, runId: string, end: 'start' | 'end'): string | undefined {
  return Object.values(runs).find((other) =>
    [other.start.ref, other.end.ref].some((ref) => ref?.kind === 'runEnd' && ref.runId === runId && ref.end === end),
  )?.id;
}
