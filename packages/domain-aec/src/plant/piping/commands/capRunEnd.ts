import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, noop } from '@core/commands/noop';
import type { PipeRun, RunEnd } from '@aec/plant/types';
import { len3, sub3 } from '@lib/vec3';
import { getPiping, refuse } from '../model';
import { refuseDerivation, rederive, withRuns } from '../runUpdate';

/**
 * @affects sets or clears the closure (`cap` or `blind`) on 1 open end of 1 run (affected[0] = runId) and re-derives it: the spec's cap part, or the blind flange with its flange set,
 *   gasket and bolts, is placed at that end (the pipe cut shorter by the closure's length)
 * @invariant a run end with a port (tie-in, nozzle, run end, branch) is never closed; an end has at most one closure; the rows come from the line spec's catalogues at the run
 *   size there (no row is guessed); a cap is exported as PCF CAP, a blind flange as FLANGE-BLIND (its flange set as FLANGE, GASKET, BOLT), both as IFC pipe fittings
 * @failure unknown run -> RTE_UNKNOWN_RUN; end connected to a port or to another run -> RTE_CAP_INVALID; spec without the row / length / thickness / connection
 *   rule -> RTE_SPEC_NO_COMPONENT / RTE_NO_CONNECTION_RULE (document unchanged); already in the requested state -> no-op
 */
export const setRunEndCap = defineCommand({
  name: 'set_run_end_cap',
  description:
    'Close an open end of a routed pipe run (route_pipe / auto_route_pipe / add_branch) with a cap or a blind flange from the line spec, or take the closure off again. ' +
    'closure "cap" (default): the spec catalogue row of type "cap" at the run size at that end (list_piping_catalogs / resolve_component; the bundled catalogue has none, so the spec ' +
    'must name an imported catalogue with cap rows); the cap takes its row length along the run and joins the pipe by the spec connection rule of its end ' +
    'type (butt weld, socket weld or threaded): the last pipe piece is cut shorter by that length (and the weld gap or socket engagement). ' +
    'closure "blindFlange": the flange the pipe end asks for (weld neck on a butt-weld pipe), its gasket and bolt set (the flange set of a flanged port) and the spec row of type "flangeBlind" ' +
    'of the same rating and facing, which needs a thickness; the run end point is the OUTER face of the blind, the pipe is cut back by blind thickness + gasket + flange length. ' +
    'A closed end no longer shows as RTE_OPEN_END in check_piping. Only an open end can be closed: an end connected to a tie-in, nozzle, branch or another run is ' +
    'refused (RTE_CAP_INVALID); asking for the other closure replaces the one there. cap: false removes the closure. Returns the run id (affected[0]); ' +
    'data = { runId, end, capped, closure?, capKey?, capLengthMm? (cap row length, or blind thickness), dn }. ' +
    'Refusals: RTE_UNKNOWN_RUN, RTE_CAP_INVALID, and the derivation codes when the spec has no usable row (RTE_SPEC_NO_COMPONENT, ' +
    'RTE_NO_CONNECTION_RULE, RTE_SEGMENT_TOO_SHORT: the closure does not fit its leg). Next: check_piping, piping_takeoff (counts it), export_pcf.',
  params: z.object({
    runId: z.string().describe('Pipe run id (affected[0] of route_pipe / auto_route_pipe / add_branch).'),
    end: z.enum(['start', 'end']).describe('Which end of the run: "start" (first point) or "end" (last point).'),
    cap: z.boolean().optional().describe('true (default) closes the end; false takes the closure off (cap or blind flange).'),
    closure: z
      .enum(['cap', 'blindFlange'])
      .optional()
      .describe(
        'What closes the end when cap is true: "cap" (default) or "blindFlange" (flange set + blind flange). Ignored with cap false.',
      ),
  }),
  run: (doc, { runId, end, cap = true, closure = 'cap' }): CommandResult => {
    const piping = getPiping(doc);
    const run = piping.runs[runId];
    if (run === undefined) return refuse(doc, 'set_run_end_cap', 'RTE_UNKNOWN_RUN', `no pipe run "${runId}"`, [], ['runId']);
    const current = run[end];
    const flag = closure === 'cap' ? 'cap' : 'blind';
    const closed = current.cap === true || current.blind === true;
    if (cap ? current[flag] === true : !closed)
      return noop(
        doc,
        `set_run_end_cap: the ${end} of run ${runId} is already ${cap ? (closure === 'cap' ? 'capped' : 'closed by a blind flange') : 'open'}.`,
      );
    if (cap) {
      const joined = current.ref !== undefined || connectedRunId(piping.runs, runId, end) !== undefined;
      if (joined)
        return refuse(
          doc,
          'set_run_end_cap',
          'RTE_CAP_INVALID',
          `the ${end} of run ${runId} is connected (${current.ref === undefined ? `run ${connectedRunId(piping.runs, runId, end)} continues from it` : 'it has a port'}): only an open end can be closed`,
          [runId],
          ['end'],
        );
    }
    const bare = withoutClosure(current);
    const next: RunEnd = cap ? { ...bare, [flag]: true } : bare;
    const result = rederive(withRuns(doc, [{ ...run, [end]: next }]), [runId]);
    if (!result.ok) return refuseDerivation(doc, 'set_run_end_cap', result, runId);
    const derivation = result.derivations[runId];
    const point = current.point;
    const at = (candidate: {
      centre?: readonly [number, number, number];
      ports: ReadonlyArray<{ position: readonly [number, number, number] }>;
    }): boolean =>
      [candidate.centre, ...candidate.ports.map((port) => port.position)].some(
        (position) => position !== undefined && len3(sub3(position as [number, number, number], point)) < 1e-6 * (1 + len3(point)),
      );
    const part = derivation?.parts.find((candidate) =>
      closure === 'cap' ? candidate.kind === 'cap' && at(candidate) : candidate.typeKey === 'flangeBlind' && at(candidate),
    );
    const length = part?.dims[closure === 'cap' ? 'length' : 'thickness'];
    const label = closure === 'cap' ? 'cap' : 'blind flange';
    return {
      ...changed(
        result.document,
        cap
          ? `set_run_end_cap: closed the ${end} of run ${runId} with ${part?.catalogueKey ?? `a spec ${label}`}${length === undefined ? '' : ` (${closure === 'cap' ? 'length' : 'thickness'} ${+length.toFixed(3)} mm)`}.`
          : `set_run_end_cap: removed the closure from the ${end} of run ${runId}.`,
        [runId],
      ),
      data: {
        runId,
        end,
        capped: cap,
        ...(cap ? { closure } : {}),
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

/** `end` without its closure flags. */
function withoutClosure(end: RunEnd): RunEnd {
  const { cap, blind, ...rest } = end;
  return cap === undefined && blind === undefined ? end : rest;
}
