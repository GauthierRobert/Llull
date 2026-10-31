import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { formatLineNumber, unknownTokens } from '../authoring/lineNumber';
import { Draft, fail, findSheet, isFail, refuse } from '../authoring/refs';
import type { PidLine } from '../model';
import { getPid, withPid } from '../state';

/**
 * @affects plant.pid (the line number of every line in scope that has the fields the template needs)
 * @invariant order is deterministic: sheet order, then the start point's y, then x, then id; numbers are startSeq, startSeq + 1 ... over the renumbered lines; a line that lacks a needed field (dn, fluid, class, area, unit) is skipped and listed
 * @failure unknown template token -> PID_LINE_NUMBER_FORMAT; scope sheet unknown -> PID_SHEET_NOT_FOUND; a new number equals the number of a line left out -> PID_LINE_NUMBER_DUPLICATE; document unchanged
 */
export const renumberPidLines = defineCommand({
  name: 'renumber_pid_lines',
  description:
    'Give the lines of the P&ID fresh line numbers from a template, in a deterministic order (sheet order, then the start point y ascending, then x ascending). ' +
    '`format` is a template with tokens {dn} {fluid} {seq} {class} {area} {unit} (default: the project template, see set_pid_conventions, "{dn}-{fluid}-{seq}-{class}"); {seq} counts from `startSeq` ' +
    '(default 1) over the renumbered lines; {area} and {unit} read the text attributes "area" and "unit" of the line. A line without a field the template needs is skipped and listed in data.skipped. ' +
    '`scope` limits it to one sheet (number or id). Returns affected = the renumbered line ids; data = { renumbered: [{ id, from, to }], skipped: [{ id, missing }] }. ' +
    'Refusals (document unchanged): PID_LINE_NUMBER_FORMAT, PID_SHEET_NOT_FOUND, PID_LINE_NUMBER_DUPLICATE.',
  params: z.object({
    format: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Template, tokens {dn} {fluid} {seq} {class} {area} {unit}; default the project line-number template.'),
    startSeq: z.number().int().min(0).optional().describe('First sequence number (default 1).'),
    scope: z.string().min(1).optional().describe('Sheet number or id to renumber only that sheet (default: all sheets).'),
  }),
  run: (doc, params): CommandResult => {
    const name = 'renumber_pid_lines';
    const pid = getPid(doc);
    const format = params.format ?? pid.lineNumberFormat;
    const bad = unknownTokens(format);
    if (bad.length > 0)
      return refuse(doc, name, fail('PID_LINE_NUMBER_FORMAT', `unknown token(s) {${bad.join('}, {')}} in "${format}"`, ['format']));
    let scopeId: string | undefined;
    if (params.scope !== undefined) {
      const sheet = findSheet(pid, params.scope, 'scope');
      if (isFail(sheet)) return refuse(doc, name, sheet);
      scopeId = sheet.id;
    }
    const sheetRank = new Map(pid.sheetOrder.map((id, index) => [id, index]));
    const lines = pid.itemOrder
      .flatMap((id) => {
        const item = pid.items[id];
        return item?.kind === 'line' && (scopeId === undefined || item.sheetId === scopeId) ? [item] : [];
      })
      .sort(
        (a, b) =>
          (sheetRank.get(a.sheetId) ?? 0) - (sheetRank.get(b.sheetId) ?? 0) ||
          a.at[1] - b.at[1] ||
          a.at[0] - b.at[0] ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const renumbered: Array<{ line: PidLine; to: string }> = [];
    const skipped: Array<{ id: string; missing: string[] }> = [];
    let seq = params.startSeq ?? 1;
    for (const line of lines) {
      const made = formatLineNumber(format, line, seq);
      if ('missing' in made) skipped.push({ id: line.id, missing: made.missing });
      else {
        renumbered.push({ line, to: made.text });
        seq++;
      }
    }
    if (renumbered.length === 0)
      return noop(
        doc,
        `renumber_pid_lines: no line to renumber (${lines.length} in scope, ${skipped.length} lacking a field the template needs)`,
      );
    const changing = new Set(renumbered.map((r) => r.line.id));
    const kept = new Set(
      pid.itemOrder.flatMap((id) => {
        const item = pid.items[id];
        return item?.kind === 'line' && !changing.has(id) && item.lineNumber !== undefined ? [item.lineNumber] : [];
      }),
    );
    const clash = renumbered.find((r) => kept.has(r.to));
    if (clash !== undefined)
      return refuse(
        doc,
        name,
        fail(
          'PID_LINE_NUMBER_DUPLICATE',
          `the new number "${clash.to}" equals the number of a line that is not renumbered`,
          ['format'],
          [clash.line.id],
        ),
      );
    const unique = new Set(renumbered.map((r) => r.to));
    if (unique.size !== renumbered.length)
      return refuse(
        doc,
        name,
        fail('PID_LINE_NUMBER_DUPLICATE', `the template "${format}" gives the same number to two lines (add {seq})`, ['format']),
      );
    const draft = new Draft(pid);
    renumbered.forEach(({ line, to }) => draft.put({ ...line, lineNumber: to }));
    return {
      document: withPid(doc, draft.model()),
      summary: `renumber_pid_lines: ${renumbered.length} line(s) renumbered with "${format}" from ${params.startSeq ?? 1}${skipped.length > 0 ? `, ${skipped.length} skipped (missing fields)` : ''}`,
      affected: renumbered.map((r) => r.line.id),
      data: { renumbered: renumbered.map((r) => ({ id: r.line.id, from: r.line.lineNumber ?? null, to: r.to })), skipped },
    };
  },
});
