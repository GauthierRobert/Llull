import type { CadDocument } from '../model/types';
import type { CommandResult } from './types';
import { MAX_BATCH_IDS } from './limits';

type BatchIds =
  | { readonly ok: true; readonly existing: string[]; readonly missing: string[] }
  | { readonly ok: false; readonly result: CommandResult };

/**
 * Validate and split the `ids` of a batch command (`delete_entities`, `move_entities`).
 *
 * @pure
 * @param emptyDetail summary text (after `<command>: `) used when `ids` is empty or malformed
 * @failure empty/malformed, > MAX_BATCH_IDS, or no listed entity exists -> `{ ok: false, result }` no-op
 * @invariant `existing` and `missing` are de-duplicated, in first-seen order
 */
export function resolveBatchIds(
  doc: CadDocument,
  command: string,
  ids: readonly unknown[],
  emptyDetail: string,
): BatchIds {
  const fail = (summary: string): BatchIds => ({
    ok: false,
    result: { document: doc, summary: `${command}: ${summary}`, affected: [] },
  });
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
    return fail(emptyDetail);
  }
  if (ids.length > MAX_BATCH_IDS) {
    return fail(`${ids.length} ids exceeds MAX_BATCH_IDS (${MAX_BATCH_IDS}).`);
  }
  const unique = [...new Set(ids as string[])];
  const existing = unique.filter((id) => Object.hasOwn(doc.entities, id));
  const missing = unique.filter((id) => !Object.hasOwn(doc.entities, id));
  if (existing.length === 0) {
    return fail(`no listed entity exists (missing: [${missing.join(', ')}]).`);
  }
  return { ok: true, existing, missing };
}
