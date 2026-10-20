/** Read helpers over `doc.plm`, the release-scope hash (via core's document_content_hash) and the human gate. */

import type { CadDocument } from '@core/model/types';
import type { PlmModel, PlmPolicy, Revision } from '@core/model/plm';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { getCommand } from '@core/commands/registry';
import { refusePlm } from './refusal';

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

/** Refusal of an agent caller on a human-only act (AF-34, TR-PLM-16); null for a human or an in-process caller. */
export function humanGateRefusal(
  doc: CadDocument,
  command: string,
  ctx: ExecutionContext | undefined,
  ids: readonly string[],
): CommandResult | null {
  if (ctx?.caller?.kind !== 'agent') return null;
  return refusePlm(
    doc,
    command,
    'PLM_HUMAN_GATE',
    `${command} is a human act (approval, classification, release or marking); an agent can prepare it but not do it`,
    ids,
  );
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
