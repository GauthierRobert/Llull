import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { unknownTokens } from '../authoring/lineNumber';
import { fail, refuse } from '../authoring/refs';
import { PID_CONVENTIONS, PID_TAG_FORMAT_KINDS, type PidModel, type PidTagFormat } from '../model';
import { tagPatternErrors } from '../patternSafety';
import { getPid, withPid } from '../state';

const tagFormatParam = z
  .union([
    z.null(),
    z.object({
      pattern: z
        .string()
        .min(1)
        .describe('Regular expression source a tag must match (at most 200 characters, no backreference or lookaround).'),
      separator: z.string().describe('Separator used when composing tags, e.g. "-".'),
    }),
  ])
  .optional();

/**
 * @affects plant.pid settings (convention, line-number template, tag formats per kind); no item changes
 * @invariant a tag format pattern passes the pattern safety rules (length, no backreference / lookaround / nested quantifier); tags are matched on at most 64 characters; null removes a format
 * @failure unknown template token -> PID_LINE_NUMBER_FORMAT; unsafe pattern -> PID_TAG_FORMAT; nothing to set -> PID_PARAM_INVALID; document unchanged
 */
export const setPidConventions = defineCommand({
  name: 'set_pid_conventions',
  description:
    'Set the project conventions of the P&ID: `convention` (ISA-5.1 or ISO-10628-2), `lineNumberFormat` (template with tokens {dn} {fluid} {seq} {class} {area} {unit}, e.g. ' +
    '"{dn}-{fluid}-{seq}-{class}"; used by renumber_pid_lines) and `tagFormats` (per kind equipment / instrument / valve: a regular expression every new tag of that kind must match, plus the separator ' +
    'used when composing; null removes the format). Existing items are not re-checked. Returns data = { convention, lineNumberFormat, tagFormats }. Refusals (document unchanged): PID_LINE_NUMBER_FORMAT, ' +
    'PID_TAG_FORMAT (unsafe or invalid pattern), PID_PARAM_INVALID (nothing to set).',
  params: z.object({
    convention: z.enum(PID_CONVENTIONS).optional().describe('ISA-5.1 (instrument bubbles) or ISO-10628-2.'),
    lineNumberFormat: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Line-number template, tokens {dn} {fluid} {seq} {class} {area} {unit}.'),
    tagFormats: z
      .object({
        equipment: tagFormatParam.describe('Format of equipment tags (null removes it).'),
        instrument: tagFormatParam.describe('Format of instrument tags (null removes it).'),
        valve: tagFormatParam.describe('Format of inline valve tags (null removes it).'),
      })
      .optional()
      .describe('Tag format per kind: { pattern, separator }, or null to remove the format; omitted kinds are unchanged.'),
  }),
  run: (doc, params): CommandResult => {
    const name = 'set_pid_conventions';
    const pid = getPid(doc);
    if (params.convention === undefined && params.lineNumberFormat === undefined && params.tagFormats === undefined)
      return refuse(doc, name, fail('PID_PARAM_INVALID', 'nothing to set: give convention, lineNumberFormat or tagFormats', []));
    if (params.lineNumberFormat !== undefined) {
      const bad = unknownTokens(params.lineNumberFormat);
      if (bad.length > 0)
        return refuse(
          doc,
          name,
          fail('PID_LINE_NUMBER_FORMAT', `unknown token(s) {${bad.join('}, {')}} in the line-number template`, ['lineNumberFormat']),
        );
    }
    const formats: Partial<Record<(typeof PID_TAG_FORMAT_KINDS)[number], PidTagFormat>> = { ...pid.tagFormats };
    for (const kind of PID_TAG_FORMAT_KINDS) {
      const wanted = params.tagFormats?.[kind];
      if (wanted === undefined) continue;
      if (wanted === null) delete formats[kind];
      else {
        const errors = tagPatternErrors(wanted.pattern, `tagFormats.${kind}.pattern`);
        if (errors.length > 0) return refuse(doc, name, fail('PID_TAG_FORMAT', errors.join('; '), [`tagFormats.${kind}.pattern`]));
        formats[kind] = { pattern: wanted.pattern, separator: wanted.separator };
      }
    }
    const next: PidModel = {
      ...pid,
      ...(params.convention === undefined ? {} : { convention: params.convention }),
      ...(params.lineNumberFormat === undefined ? {} : { lineNumberFormat: params.lineNumberFormat }),
      tagFormats: formats,
    };
    return {
      document: withPid(doc, next),
      summary: `set_pid_conventions: convention ${next.convention}, line-number template ${next.lineNumberFormat}, tag formats for ${Object.keys(formats).join(', ') || 'none'}`,
      affected: [],
      data: { convention: next.convention, lineNumberFormat: next.lineNumberFormat, tagFormats: formats },
    };
  },
});
