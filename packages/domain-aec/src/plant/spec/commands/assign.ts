/** `assign_pipe_spec` (plant 01 PSC M3): bind building pipe elements to a spec revision and size; also the sweep that moves pipes to the newest approved revision. */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { fromMm } from '@core/model/units';
import type { PipeElement } from '../../../building/types';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { elementsOf, getBuilding, withElement } from '../../../building/model';
import { refuse } from '../../catalog/codes';
import { bindPipe, isBound, type Bound } from '../binding';

const PIPE_ID_PATTERN = /^[\w.-]+$/;

/**
 * @affects building.elements[pipe].spec / .diameter / .dn for each selected pipe element (the pipe is regenerated at the spec outside diameter)
 * @invariant all or nothing: every selected pipe resolves or none changes; the spec decides OD, wall and schedule (a given schedule is only an assertion); size defaults to the pipe's current binding, else its dn; without revision the newest approved revision is used (the newest draft when none is approved, with a PSC_SPEC_NOT_APPROVED warning)
 * @failure neither or both of pipeId / line, unknown pipe or line -> PSC_PIPE_UNKNOWN; unknown spec -> PSC_SPEC_UNKNOWN; no size -> PSC_SIZE_UNKNOWN; size not in the spec -> PSC_SIZE_OUT_OF_RANGE / PSC_NO_COMPONENT; schedule differs -> PSC_SCHEDULE_UNKNOWN
 */
export const assignPipeSpec = defineCommand({
  name: 'assign_pipe_spec',
  description:
    'Bind pipe element(s) made by add_pipe_run to a piping spec: the pipe gets the spec revision, the nominal size, the outside diameter, wall and schedule that the spec selects ' +
    '(a pipe component of the spec at that size, via its catalogue), and the pipe is redrawn at that outside diameter. Select either one pipe (`pipeId`) or every pipe of a line number (`line`). ' +
    'Size: give `nps` (inch designation, e.g. "2-1/2" or 2.5) or `dn`; when omitted, each pipe keeps the size of its current binding (so re-running the command moves pipes to the newest approved revision, ' +
    'the sweep that clears PSC_SPEC_REVISION_STALE) or falls back to its own dn. `revision` defaults to the newest approved revision of the spec (the newest draft when none is approved; ' +
    'data.warnings then lists PSC_SPEC_NOT_APPROVED). `schedule` is only an assertion: the spec decides, a different schedule is refused (PSC_SCHEDULE_UNKNOWN). All pipes resolve or none changes. ' +
    'Returns data { specId, revision, pipes: [{ pipeId, nps, schedule, outsideDiameterMm, wallMm, verified }], warnings }. Next: check_pipe_spec scope "document", pipe_section_properties pipeId.',
  params: z.object({
    pipeId: z.string().regex(PIPE_ID_PATTERN).describe('Id of one pipe element (e.g. "pipe-1"). Give this or line.').optional(),
    line: z.string().min(1).describe('Line number: every pipe element with this line number is assigned. Give this or pipeId.').optional(),
    specId: z.string().min(1).describe('Spec id (list_pipe_specs).'),
    revision: z.number().int().positive().describe('Spec revision. Default: the newest approved revision.').optional(),
    nps: z
      .union([z.string(), z.number()])
      .describe('Nominal pipe size in inches, e.g. "2-1/2" or 2.5. Give this or dn, or neither to keep each pipe current size.')
      .optional(),
    dn: z.union([z.string(), z.number()]).describe('Nominal diameter DN, e.g. 100. Give this or nps.').optional(),
    schedule: z.string().describe('Expected schedule, e.g. "40": refused when the spec selects another one at this size.').optional(),
  }),
  run: (doc, { pipeId, line, specId, revision, nps, dn, schedule }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[], paths: readonly string[]): CommandResult =>
      refuse(doc, 'assign_pipe_spec', code, message, ids, paths);
    if ((pipeId === undefined) === (line === undefined))
      return fail('PSC_PIPE_UNKNOWN', 'give exactly one of pipeId or line', [], ['pipeId']);
    if (nps !== undefined && dn !== undefined) return fail('PSC_SIZE_UNKNOWN', 'give nps or dn, not both', [], ['nps']);
    const building = getBuilding(doc);
    const pipes: PipeElement[] =
      pipeId !== undefined
        ? elementsOf(building, 'pipe').filter((pipe) => pipe.id === pipeId)
        : elementsOf(building, 'pipe').filter((pipe) => pipe.line === line);
    if (pipes.length === 0)
      return fail(
        'PSC_PIPE_UNKNOWN',
        pipeId !== undefined ? `no pipe element "${pipeId}"` : `no pipe element with line number "${line}"`,
        [],
        [pipeId !== undefined ? 'pipeId' : 'line'],
      );
    const bound: Array<{ pipe: PipeElement; bound: Bound }> = [];
    for (const pipe of pipes) {
      const size = nps !== undefined || dn !== undefined ? { nps, dn } : pipe.spec !== undefined ? { nps: pipe.spec.nps } : { dn: pipe.dn };
      if (size.nps === undefined && size.dn === undefined)
        return fail('PSC_SIZE_UNKNOWN', `pipe ${pipe.id} has no binding and no dn: give nps or dn`, [pipe.id], ['nps']);
      const outcome = bindPipe(doc, 'assign_pipe_spec', { specId, revision, schedule, ...size });
      if (!isBound(outcome)) return outcome;
      bound.push({ pipe, bound: outcome });
    }
    let edited = building;
    for (const { pipe, bound: result } of bound) {
      const { dn: pairedDn, binding } = result;
      const next: PipeElement = { ...pipe, diameter: fromMm(doc, binding.odMm), spec: binding };
      if (pairedDn === null) delete next.dn;
      else next.dn = pairedDn;
      edited = withElement(edited, next);
    }
    const warnings = [...new Map(bound.flatMap(({ bound: result }) => result.warnings).map((entry) => [entry.code, entry])).values()];
    const first = (bound[0] as (typeof bound)[number]).bound;
    return commitBuilding(
      doc,
      edited,
      pipes.map((pipe) => pipe.id),
      `Assigned spec ${first.spec.id} r${first.spec.revision} (${first.spec.status}) to ${pipes.length} pipe(s): ${bound
        .map(
          ({ pipe, bound: result }) =>
            `${pipe.id} NPS ${result.binding.nps}${result.binding.schedule === undefined ? '' : ` sch ${result.binding.schedule}`} Ø${result.binding.odMm} x ${result.binding.wallMm} mm`,
        )
        .join('; ')}.${warnings.length === 0 ? '' : ` Warnings: ${warnings.map((entry) => entry.code).join(', ')}.`}`,
      {
        specId: first.spec.id,
        revision: first.spec.revision,
        pipes: bound.map(({ pipe, bound: result }) => ({
          pipeId: pipe.id,
          nps: result.binding.nps,
          ...(result.binding.schedule === undefined ? {} : { schedule: result.binding.schedule }),
          outsideDiameterMm: result.binding.odMm,
          wallMm: result.binding.wallMm,
          verified: result.binding.verified,
        })),
        ...(warnings.length === 0 ? {} : { warnings }),
      },
    );
  },
});
