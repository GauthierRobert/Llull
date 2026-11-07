/**
 * A human signature is a param named `confirmation` (and only that): `withoutConfirmations` strips it from the history, the command log and live sync.
 * A command that takes a signature under another name writes it verbatim into the saved document, and a replay re-submits it. This finds such
 * commands from their schema (a param, at any depth, described as a human signature) and fails for any not in KNOWN_OFFENDERS (board task FIX-SIG-REST).
 */
import { describe, expect, it } from 'vitest';
import { toToolSchemas } from '@core/commands/registry';
import { isRecord } from '@lib/isRecord';

/** Commands that still take the signature under another name (none since FIX-SIG-REST); each listed one is asserted to STILL offend (ratchet): fix it, then delete it. */
const KNOWN_OFFENDERS: readonly string[] = [];

const SIGNATURE_PARAM = /human signature object/i;

/** Dotted paths of the params of `schema` whose description says it carries a human signature. */
function signatureParams(schema: unknown, at: string, found: string[]): string[] {
  if (!isRecord(schema)) return found;
  if (typeof schema['description'] === 'string' && SIGNATURE_PARAM.test(schema['description']) && at !== '') found.push(at);
  const properties = schema['properties'];
  if (isRecord(properties))
    for (const [key, value] of Object.entries(properties)) signatureParams(value, at === '' ? key : `${at}.${key}`, found);
  signatureParams(schema['items'], at === '' ? '[]' : `${at}[]`, found);
  return found;
}

describe('human signature params are named confirmation', () => {
  const offenders = toToolSchemas()
    .filter((tool) => signatureParams(tool.input_schema, '', []).some((path) => path.split('.').at(-1) !== 'confirmation'))
    .map((tool) => tool.name)
    .sort();

  it('no command outside KNOWN_OFFENDERS takes a human signature under another name', () => {
    expect(offenders.filter((name) => !KNOWN_OFFENDERS.includes(name))).toEqual([]);
  });

  it('every known offender still offends (fixed ones leave the list)', () => {
    expect(KNOWN_OFFENDERS.filter((name) => !offenders.includes(name))).toEqual([]);
  });

  it('the check sees the gates that do it right (dispose_fit_result, accept_verification_exception)', () => {
    const named = new Set(
      toToolSchemas()
        .filter((tool) => signatureParams(tool.input_schema, '', []).length > 0)
        .map((tool) => tool.name),
    );
    expect(named.has('dispose_fit_result')).toBe(true);
    expect(named.has('accept_verification_exception')).toBe(true);
  });
});
