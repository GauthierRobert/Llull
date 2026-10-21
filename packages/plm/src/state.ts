/** Read helpers over `doc.plm`, the release-scope hash (via core's document_content_hash) and the human gate. */

import type { CadDocument } from '@core/model/types';
import type { PlmModel, PlmPolicy, Revision } from '@plm/types';
import type { ExecutionContext } from '@core/commands/types';
import { getCommand } from '@core/commands/registry';

export const DEFAULT_POLICY: PlmPolicy = {
  requireChangeOrder: true,
  requireIndependentChecker: true,
  requiredApprovalRoles: ['design-authority', 'checker'],
  humanSignatureRequired: true,
  requireMarking: false,
};

export const NOT_MANAGED = 'this document is not a managed item';

export const currentRevisionOf = (plm: PlmModel): Revision | undefined => plm.item.revisions[plm.item.currentRevision];

/** `<PN> rev <label>` for summaries. */
export const revisionText = (plm: PlmModel, label: string = plm.item.currentRevision): string => `${plm.item.partNumber} rev ${label}`;

/** The release-scope hash and canonical text of `doc`, through the registered `document_content_hash` query. */
export function scopeOf(doc: CadDocument, ctx?: ExecutionContext): { readonly sha256: string; readonly canonicalJson: string } {
  const lookup = ctx?.registry ?? getCommand;
  const run = lookup('document_content_hash')?.run;
  if (run === undefined) throw new Error('document_content_hash is not registered');
  const data = run(doc, { includeCanonical: true }, ctx).data as { sha256: string; canonicalJson: string };
  return { sha256: data.sha256, canonicalJson: data.canonicalJson };
}

/** Hash of the current release scope only (no canonical text kept by the caller). */
export const scopeHash = (doc: CadDocument, ctx?: ExecutionContext): string => scopeOf(doc, ctx).sha256;

/** Whether the definition changed since the current revision's last iteration checkpoint (derived, never stored). */
export function isDirty(doc: CadDocument, plm: PlmModel, ctx?: ExecutionContext): boolean {
  const last = currentRevisionOf(plm)?.iterations.at(-1);
  return last === undefined || last.contentHash !== scopeHash(doc, ctx);
}

/** Append-only state change record. */
export function stateChange(
  from: Revision['state'] | null,
  to: Revision['state'],
  at: string | undefined,
  by: string | undefined,
  reason?: string,
): Revision['stateHistory'][number] {
  return {
    from,
    to,
    ...(at !== undefined ? { at } : {}),
    ...(by !== undefined ? { by } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}
