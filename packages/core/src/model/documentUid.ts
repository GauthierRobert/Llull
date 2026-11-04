import { jcsJson } from '../lib/jcs';
import { sha256Hex } from '../lib/sha256';
import type { HumanSignaturePort } from './analysis';
import type { CadDocument } from './types';

/**
 * `result` with a document uid when neither it nor `before` has one: sha256 prefix of the step number, command name and params of the command that
 * first changed the document.
 * @invariant minted once; a replay of the same plan re-mints the same value; never changes afterwards (history edits and regeneration carry it)
 */
export function sealDocumentUid(before: CadDocument, result: CadDocument, seed: { name: string; params: unknown }): CadDocument {
  if (result === before || before.uid !== undefined || result.uid !== undefined) return result;
  const step = before.nextStepNumber ?? 1;
  return { ...result, uid: sha256Hex(jcsJson({ step, name: seed.name, params: seed.params ?? null })).slice(0, 32) };
}

/** What a stored `uid` must look like (checked at load). */
export const DOCUMENT_UID_PATTERN = /^[0-9a-f]{32}$/;

/** The identity a human signature binds to: the document uid, or '' while the document has none (re-verified acts refuse a uid-less document; the others bind ''; sealing makes that unreachable after the first command). */
export const documentIdentity = (doc: CadDocument): string => doc.uid ?? '';

/**
 * `details` of a gated act with the document it is signed for (VIS-ID); every act that binds a document builds its details through here.
 * @invariant a signature covers `documentUid` (a uid string, or the document's): the same act in another document has another payload
 */
export const withDocumentUid = (details: Readonly<Record<string, unknown>>, document: CadDocument | string): Record<string, unknown> => ({
  documentUid: typeof document === 'string' ? document : documentIdentity(document),
  ...details,
});

/** Why a gated act refuses a document that has no uid yet (the signature would bind to nothing); every re-verified act uses this text. */
export const DOCUMENT_UNIDENTIFIED_TEXT = 'the document has no uid, so a human signature cannot be bound to it';

/** How a stored human signature stands against the document that holds it. */
export type BoundVerdict = 'ok' | 'foreign' | 'unbound' | 'invalid';

/**
 * Re-verify a stored signature that records the uid of the document it was made for (pure: nothing is spent).
 * @invariant 'unbound' = no recorded uid (made before signatures were bound to a document); 'invalid' = the signature does not verify for the recorded
 *   uid; 'foreign' = genuine, but for another document (the record was copied in); 'ok' = genuine for this document
 */
export function boundVerdict(
  port: HumanSignaturePort,
  signature: unknown,
  recordedUid: string | undefined,
  currentUid: string,
  payloadFor: (documentUid: string) => string,
): { readonly verdict: BoundVerdict; readonly signed: { readonly signer: string; readonly signatureId: string } | null } {
  if (recordedUid === undefined) return { verdict: 'unbound', signed: null };
  const signed = port.verify(signature, payloadFor(recordedUid));
  if (signed === null) return { verdict: 'invalid', signed };
  return { verdict: recordedUid === currentUid ? 'ok' : 'foreign', signed };
}
