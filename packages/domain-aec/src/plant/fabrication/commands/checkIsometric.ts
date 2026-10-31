import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { PAPER_SIZES } from '@core/model/sheet';
import { checkLine } from '../check';
import { refuseIso } from '../codes';
import { allLineIds } from '../lineNetwork';

/**
 * @affects none (query: returns the same document)
 * @invariant findings are data rows with a stable ISO_* code, severity, ids, paths and a one-line remediation, in line order then rule order; ok is true when no finding is an error; every unissued iso carries the info ISO_REVIEW_REQUIRED
 * @failure unknown lineId -> ISO_LINE_NOT_FOUND; no piping at all -> ISO_NO_PIPING; every problem of a line is a finding, not a refusal
 */
export const checkIsometric = defineCommand({
  name: 'check_isometric',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Check pipe lines for isometric and fabrication readiness; end every isometric job with it. Rules (code, severity): ISO_DISCONNECTED (error: components not reachable from the line start, or connection points closer than 1 mm that do not ' +
    'coincide), ISO_OPEN_END (warning: a line end without end flange, cap or plug, found by connectivity on imported and routed lines; legacy pipes use their from / to), ISO_SKEY_MISSING (error: a non-pipe component without isometric key), ' +
    'ISO_ITEM_CODE_MISSING (warning), ISO_WELDS_UNNUMBERED (warning; error with style final: run number_welds), ISO_SPOOL_TOO_LARGE / ISO_SPOOL_TOO_HEAVY (error: against set_fabrication_rules maxSpool*), ISO_CUT_LENGTH_SHORT ' +
    '(error: needs a stored weldGapMm), ISO_DIMENSION_MISMATCH (error: a dimension string that does not close, a guard), ISO_UNVERIFIED_CATALOGUE (warning, cannot be hidden), ISO_LEGACY_FITTINGS_DERIVED (warning: elbows derived from a polyline), ' +
    'ISO_SHEET_OVERFLOW (warning: too large for one sheet of the paper), ISO_FIELD_WELD_STALE (warning), ISO_REVIEW_REQUIRED (info: the iso is not issued; a human issues it). A line that cannot be read becomes an error finding with its own code. ' +
    'Returns data = { ok (no errors), lines: [lineId], issues: [{ lineId, code, severity, message, ids, paths, remediation }], counts: { error, warning, info, total } }. Refusals (document unchanged): ISO_LINE_NOT_FOUND, ISO_NO_PIPING.',
  params: z.object({
    lineId: z
      .string()
      .min(1)
      .optional()
      .describe('One line: routed line id, imported PCF line number or legacy pipe line number. Omit to check every line of the document.'),
    style: z
      .enum(['check', 'final'])
      .optional()
      .describe('Iso style the check is for: check (default; unnumbered welds are a warning) or final (unnumbered welds are an error).'),
    paper: z.enum(PAPER_SIZES).optional().describe('Paper the sheet-overflow rule is evaluated for (landscape ISO A0..A4). Default A3.'),
  }),
  run: (doc, params): CommandResult => {
    const all = allLineIds(doc);
    if (params.lineId !== undefined && !all.includes(params.lineId))
      return refuseIso(doc, 'check_isometric', 'ISO_LINE_NOT_FOUND', `no pipe line "${params.lineId}"`, [params.lineId], ['lineId']);
    const lineIds = params.lineId === undefined ? all : [params.lineId];
    if (lineIds.length === 0) return refuseIso(doc, 'check_isometric', 'ISO_NO_PIPING', 'the document has no piping');
    const options = { style: params.style ?? 'check', paper: params.paper ?? 'A3' } as const;
    const issues = lineIds.flatMap((lineId) => checkLine(doc, lineId, options));
    const counts = {
      error: issues.filter((issue) => issue.severity === 'error').length,
      warning: issues.filter((issue) => issue.severity === 'warning').length,
      info: issues.filter((issue) => issue.severity === 'info').length,
      total: issues.length,
    };
    const ok = counts.error === 0;
    const codes = [...new Set(issues.filter((issue) => issue.severity !== 'info').map((issue) => issue.code))];
    return report(
      doc,
      `check_isometric: ${lineIds.length} line(s): ${ok ? 'ok' : 'NOT ok'}; ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info${codes.length === 0 ? '' : `: ${codes.join(', ')}`}`,
      { ok, lines: lineIds, issues, counts },
    );
  },
});
