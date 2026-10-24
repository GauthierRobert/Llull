import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { checkPipingModel } from '../checks';
import { getPiping, refuse } from '../model';

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant derived afresh from the stored runs and the current spec; a run that does not derive is an error issue with its code, never a refusal;
 *   no limit is built in (handwheel height, weld spacing): the parameter or the named default is reported in data.limits
 * @failure unknown line -> RTE_UNKNOWN_LINE
 */
export const checkPiping = defineCommand({
  name: 'check_piping',
  description:
    'Query: check the routed pipe of some lines (all lines when lineIds is omitted; branch and continuation runs attached to them are included) ' +
    'and list what a piping designer would raise. data = { status "pass" | "warn" | "fail", issues [{ code, severity "error" | "warning" | "info", ' +
    'ids, paths, message, detail, remediation }], counts { errors, warnings, infos, byCode }, unverified, reviewRequired, lineIds, runIds, partCount, ' +
    'limits }. Codes: RTE_OPEN_END (a part port connected to nothing: a free run end, an unused tee outlet), RTE_DISCONNECTED_PORT (info; tie-in or nozzle ' +
    'with no run, only when lineIds is omitted), RTE_FITTING_TO_FITTING (zero-length piece), RTE_WELD_SPACING (pipe piece shorter than minWeldSpacing, ' +
    'default max(4 t, 50 mm), named in detail), RTE_SIZE_MISMATCH / RTE_RATING_MISMATCH / RTE_FACING_MISMATCH / RTE_END_TYPE_MISMATCH (two connected ' +
    'ports disagree), RTE_FROM_TO_MISMATCH (line from / to text names equipment the runs do not reach), RTE_DUPLICATE_LINE_NUMBER, RTE_SPEC_UNVERIFIED ' +
    '(spec not approved or catalogue rows not grade A; cannot be hidden), RTE_STUB_IN_REVIEW (reviewRequired), RTE_ADVERSE_SLOPE (a leg rises when its declared slope, or the line slope, says it falls; or the reverse), RTE_FLAT_ON_SLOPED_LINE (a horizontal leg on a line or leg that declares a slope: it does not drain), RTE_POCKET (a low point after a fall or a high point after a rise with no branch leaving down as a drain or up as a vent between the two legs; both legs must declare a slope; ' +
    'or detail.kind "eccentric-invert-step": a flat-on-top eccentric reducer steps the pipe bottom up on a line declared to fall), RTE_NONSTANDARD_FITTING (a trimmed 90 elbow or pipe bend: ' +
    'a reviewer accepts it), RTE_ECCENTRIC_OFFSET (the offset of an eccentric reducer is taken up by the next leg only within the angle tolerance; the sideways residual is dropped), ' +
    'RTE_VALVE_OPERATOR_HEIGHT (handwheel centre higher above its level than maxHandwheelCentreHeight; skipped without that limit, which has no code value and is yours to give), ' +
    'RTE_VALVE_OPERATOR_CLASH (the operator envelope of a valve, from its catalogue row: handwheel disc, gear box, actuator along the stem direction, penetrates a pipe part, ' +
    'insulation or building solid deeper than clashToleranceMm; ids = [valve, other]), and the ' +
    'RTE_* derivation code of a run that no longer derives (an error issue: moved port, missing spec row, leg too short). Does not modify the document. ' +
    'Refusal: RTE_UNKNOWN_LINE. Next: fix the issues with route_pipe / insert_inline_component / delete_pipe_run, or accept the warnings.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    lineIds: z.array(z.string()).optional().describe('Line ids to check (affected[0] of create_pipeline). Omit for every line.'),
    maxHandwheelCentreHeight: z
      .number()
      .positive()
      .optional()
      .describe(
        'Highest allowed valve handwheel centre above its reference level (the highest building level at or below it, else z = 0), mm. Omit to skip the check.',
      ),
    minWeldSpacing: z
      .number()
      .positive()
      .optional()
      .describe('Shortest allowed pipe piece between welds, mm. Default max(4 t, 50 mm) of the piece wall t, named in each issue.'),
    clashToleranceMm: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Deepest penetration of a valve operator envelope into another body that RTE_VALVE_OPERATOR_CLASH ignores, mm. Default 5 (check_clashes).',
      ),
    include: z.array(z.string()).optional().describe('Report only these issue codes, e.g. ["RTE_OPEN_END"].'),
  }),
  run: (doc, params): CommandResult => {
    const piping = getPiping(doc);
    const unknown = (params.lineIds ?? []).filter((id) => piping.lines[id] === undefined);
    if (unknown.length > 0)
      return refuse(doc, 'check_piping', 'RTE_UNKNOWN_LINE', `no pipe line ${unknown.map((id) => `"${id}"`).join(', ')}`, unknown, [
        'lineIds',
      ]);
    const result = checkPipingModel(doc, params);
    const codes = Object.entries(result.counts.byCode)
      .map(([code, count]) => `${code} x${count}`)
      .join(', ');
    return report(
      doc,
      `check_piping: ${result.status} on ${result.lineIds.length} line(s), ${result.runIds.length} run(s), ${result.partCount} part(s): ${result.counts.errors} error(s), ` +
        `${result.counts.warnings} warning(s), ${result.counts.infos} info${codes === '' ? '' : ` (${codes})`}${result.unverified ? '; unverified' : ''}.`,
      result,
    );
  },
});
