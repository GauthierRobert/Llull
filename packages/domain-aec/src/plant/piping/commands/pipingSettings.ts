import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, noop } from '@core/commands/noop';
import type { PipeLine, PipingSettings } from '@aec/plant/types';
import { DEFAULT_LINE_NUMBER_TEMPLATE, PLACEHOLDERS, lineNumberTemplate, renderLineNumber, templateProblem } from '../lineNumber';
import { getPiping, refuse, withPiping } from '../model';

/**
 * @affects sets the line-number template of plant.piping.settings; renumbers the lines whose number followed the old template (their derived part names
 *   are rebuilt by the reconcile); explicit numbers are kept
 * @invariant the template needs {sequence}; only the placeholders dn, service, sequence, spec, insulationCode, insulationThickness; line numbers stay unique
 * @failure unusable template -> RTE_TEMPLATE_INVALID; two lines would get the same number -> RTE_DUPLICATE_LINE_NUMBER, nothing changes
 */
export const setPipingSettings = defineCommand({
  name: 'set_piping_settings',
  description:
    'Set the project settings of the piping plugin. lineNumberTemplate: how create_pipeline / update_pipeline build line numbers, with placeholders ' +
    `${PLACEHOLDERS.map((name) => `{${name}}`).join(', ')}, literal text, and optional groups [...] that disappear when a field inside is empty ` +
    `(default ${DEFAULT_LINE_NUMBER_TEMPLATE}: DN 80, service HO, sequence 4001, spec CS150, insulation H 50 mm gives 80-HO-4001-CS150-H50). The template ` +
    'needs {sequence} (it keeps numbers unique) and no placeholder twice. null restores the default. Lines whose number followed the old template are ' +
    'renumbered to the new one; explicit line numbers are kept and listed in data.keptExplicit. Returns data = { template { value, defaulted }, ' +
    'renumbered [{ lineId, from, to }], keptExplicit }. Refusals: RTE_TEMPLATE_INVALID (detail says why), RTE_DUPLICATE_LINE_NUMBER (two lines would ' +
    'get the same number; nothing changes). Next: create_pipeline, update_pipeline.',
  params: z.object({
    lineNumberTemplate: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'New line-number template, e.g. "{service}-{sequence}-{dn}-{spec}[-{insulationCode}]"; null restores the default; omit to keep.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const piping = getPiping(doc);
    const before = lineNumberTemplate(piping);
    const requested = params.lineNumberTemplate;
    if (requested === undefined) return noop(doc, `set_piping_settings: nothing to set (line-number template stays ${before.value}).`);
    const next = requested ?? DEFAULT_LINE_NUMBER_TEMPLATE;
    const problem = requested === null ? null : templateProblem(requested);
    if (problem !== null)
      return refuse(
        doc,
        'set_piping_settings',
        'RTE_TEMPLATE_INVALID',
        `line-number template "${requested}": ${problem}`,
        [],
        ['lineNumberTemplate'],
      );
    if (next === before.value) return noop(doc, `set_piping_settings: the line-number template is already ${next}.`);
    const lines: Record<string, PipeLine> = { ...piping.lines };
    const renumbered: Array<{ lineId: string; from: string; to: string }> = [];
    const keptExplicit: string[] = [];
    for (const id of piping.lineOrder) {
      const line = piping.lines[id] as PipeLine;
      if (line.lineNumber !== renderLineNumber(before.value, line)) {
        keptExplicit.push(id);
        continue;
      }
      const to = renderLineNumber(next, line);
      if (to !== line.lineNumber) {
        lines[id] = { ...line, lineNumber: to };
        renumbered.push({ lineId: id, from: line.lineNumber, to });
      }
    }
    const seen = new Map<string, string>();
    for (const id of piping.lineOrder) {
      const number = (lines[id] as PipeLine).lineNumber;
      const other = seen.get(number);
      if (other !== undefined)
        return refuse(
          doc,
          'set_piping_settings',
          'RTE_DUPLICATE_LINE_NUMBER',
          `the new template would give lines ${other} and ${id} the same number ${number}`,
          [other, id],
          ['lineNumberTemplate'],
        );
      seen.set(number, id);
    }
    const settings: PipingSettings = requested === null ? {} : { lineNumberTemplate: requested };
    const { settings: previous, ...rest } = piping;
    void previous;
    const stored = withPiping(doc, { ...rest, lines, ...(requested === null ? {} : { settings }) });
    return {
      ...changed(
        stored,
        `set_piping_settings: line-number template ${next}${requested === null ? ' (default)' : ''}; renumbered ${renumbered.length} line(s)${keptExplicit.length === 0 ? '' : `, kept ${keptExplicit.length} explicit number(s)`}.`,
        [...renumbered.map((entry) => entry.lineId)],
      ),
      data: { template: { value: next, defaulted: requested === null }, renumbered, keptExplicit },
    };
  },
});
