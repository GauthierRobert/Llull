import { jcsJson } from '../lib/jcs';
import { sha256Hex } from '../lib/sha256';
import type { CadDocument } from './types';

/**
 * `result` with a document uid when neither it nor `before` has one: sha256 prefix of the step number, command name and params of the command that
 * first changed the document.
 * @invariant minted once; a replay of the same plan re-mints the same value; never changes afterwards (history edits and regeneration carry it)
 */
export function withDocumentUid(before: CadDocument, result: CadDocument, seed: { name: string; params: unknown }): CadDocument {
  if (result === before || before.uid !== undefined || result.uid !== undefined) return result;
  const step = before.nextStepNumber ?? 1;
  return { ...result, uid: sha256Hex(jcsJson({ step, name: seed.name, params: seed.params ?? null })).slice(0, 32) };
}

/** The identity a human signature binds to: the document uid, or '' while the document has none. */
export const documentIdentity = (doc: CadDocument): string => doc.uid ?? '';
