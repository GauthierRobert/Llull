import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { refusePid } from '../dexpi/codes';
import { parseTag } from '../tags/parseTag';

/**
 * @affects nothing (read-only; pure function of `tag`)
 * @invariant ISA 5.1 grammar `letters sep loop suffix?` with the letter table of validation/data/isa51_letters.json; the result always names the convention used; grade B letters are flagged unverified
 * @failure shape fails -> PID_TAG_FORMAT; letters or symbols outside the table -> PID_TAG_NONSTANDARD (data carries the normalised tag, ok: false); no document is read
 */
export const parseInstrumentTag = defineCommand({
  name: 'parse_instrument_tag',
  description:
    'Decode an instrument tag with the ISA 5.1 letter table, read-only (no P&ID needed). Grammar: first letter (measured variable) + optional first-letter modifier (D differential, F ratio, Q totalize, S safety, ...) + succeeding letters ' +
    '(I indicate, C control, T transmit, S switch, A alarm, H / L / M after an alarm or switch = high / low / middle) + separator ("-", " " or none) + loop number (digits, optionally ".digits", e.g. 4712.01) + optional suffix letter (FV-101A). ' +
    'Examples: FIC-101, PDIC-205, TAHH-300, PI 4712.01. Returns data = { ok, tag (normalised), convention: "ISA-5.1", letters, firstLetter { letter, meaning }, modifier { letter, meaning } | null, ' +
    'functions [{ letter, role: readout | output, meaning }], functionModifiers [{ letter, meaning }], loop, separator, suffix, grade (A | B), unverified (true when a grade B letter is used), warnings [{ code, message }] }. ' +
    "Warnings: PID_TAG_USER_LETTER (user's-choice letter, define it in the project legend), PID_TAG_AMBIGUOUS_LETTERS (two readings, the shown one follows the grammar rules). " +
    'Refusals (ok: false, error.code): PID_TAG_FORMAT (no loop number, lowercase, bad shape, longer than 64 characters), PID_TAG_NONSTANDARD (letters outside ISA 5.1, e.g. limit marks "PIS+Z+A 275003"). Next: add_pid_instrument with the tag.',
  params: z.object({
    tag: z
      .string()
      .describe(
        'Instrument tag to decode, e.g. "FIC-101" or "PICSA 4712.02". The superscript plus is read as "+"; runs of spaces collapse.',
      ),
    convention: z
      .enum(['ISA-5.1'])
      .optional()
      .describe('Letter convention; only ISA-5.1 is available (default). The result always names the convention it used.'),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const parsed = parseTag(params.tag);
    if (parsed.ok)
      return report(
        doc,
        `parse_instrument_tag: ${parsed.tag} = ${parsed.firstLetter.meaning}${parsed.modifier === null ? '' : ` (${parsed.modifier.meaning})`}; ` +
          `${parsed.functions.map((f) => f.meaning).join(' + ') || 'no function letters'}${parsed.functionModifiers.map((m) => ` ${m.meaning}`).join('')}; loop ${parsed.loop}` +
          (parsed.warnings.length === 0 ? '' : `; warnings: ${parsed.warnings.map((w) => w.code).join(', ')}`),
        parsed,
      );
    return { ...refusePid(doc, 'parse_instrument_tag', parsed.code, parsed.message, [], ['tag']), data: parsed };
  },
});
