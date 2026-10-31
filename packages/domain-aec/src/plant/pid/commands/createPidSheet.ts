import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { unknownTokens } from '../authoring/lineNumber';
import { refusePid } from '../dexpi/codes';
import { PID_CONVENTIONS, PID_PAPERS, type PidModel } from '../model';
import { mintFree } from '../authoring/refs';
import { getPid, withPid } from '../state';

/**
 * @affects plant.pid (one new sheet; the slice is created on first use; convention / line-number format when given)
 * @invariant sheet numbers are unique; status draft, revision "0"; ids step-scoped
 * @failure number already used -> PID_SHEET_DUPLICATE; document unchanged
 */
export const createPidSheet = defineCommand({
  name: 'create_pid_sheet',
  description:
    'Create a P&ID sheet (doc.plant.pid) to draw on: the first step of any P&ID. Sheet coordinates are millimetres on the paper (origin lower left, +y up); ' +
    'the paper size A0..A4 only frames the sheet. Optionally sets the project convention (ISA-5.1 instrument bubbles or ISO-10628-2) and the line-number ' +
    'template (tokens {dn} {fluid} {seq} {class} {area} {unit}). Returns affected[0] = the sheet id (alias it with "as" in a plan and pass it as `sheet`). ' +
    'Refusal: PID_SHEET_DUPLICATE (number in use, document unchanged). Next: add_pid_equipment.',
  params: z.object({
    number: z.string().trim().min(1).describe('Unique sheet number, e.g. "PID-001".'),
    title: z.string().optional().describe('Sheet title shown in the title block (default empty).'),
    paper: z.enum(PID_PAPERS).optional().describe('Paper size A0..A4 (default A1).'),
    convention: z
      .enum(PID_CONVENTIONS)
      .optional()
      .describe('Project convention for the whole P&ID (default unchanged, ISA-5.1 for a new one).'),
    lineNumberFormat: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Line-number template, tokens {dn} {fluid} {seq} {class} {area} {unit}.'),
  }),
  run: (doc, params): CommandResult => {
    const pid = getPid(doc);
    if (Object.values(pid.sheets).some((sheet) => sheet.number === params.number))
      return refusePid(doc, 'create_pid_sheet', 'PID_SHEET_DUPLICATE', `a sheet numbered "${params.number}" exists`, [], ['number']);
    const bad = unknownTokens(params.lineNumberFormat ?? '');
    if (bad.length > 0)
      return refusePid(
        doc,
        'create_pid_sheet',
        'PID_LINE_NUMBER_FORMAT',
        `unknown token(s) {${bad.join('}, {')}} in the template`,
        [],
        ['lineNumberFormat'],
      );
    const id = mintFree(pid);
    const next: PidModel = {
      ...pid,
      ...(params.convention === undefined ? {} : { convention: params.convention }),
      ...(params.lineNumberFormat === undefined ? {} : { lineNumberFormat: params.lineNumberFormat }),
      sheets: {
        ...pid.sheets,
        [id]: { id, number: params.number, title: params.title ?? '', paper: params.paper ?? 'A1', revision: '0', status: 'draft' },
      },
      sheetOrder: [...pid.sheetOrder, id],
    };
    return {
      document: withPid(doc, next),
      summary: `create_pid_sheet: sheet ${params.number} (${id}), ${params.paper ?? 'A1'}, convention ${next.convention}`,
      affected: [id],
    };
  },
});
