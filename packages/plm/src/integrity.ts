/** Release integrity (FR-PLM-15/16, §5.5): recompute the hashes of released revisions; nothing is stored, every caller recomputes on demand. */

import type { CadDocument } from '@core/model/types';
import type { PlmModel } from '@plm/types';
import type { ExecutionContext } from '@core/commands/types';
import { sha256Hex } from '@lib/sha256';
import { scopeHash } from './state';

export type IntegrityStatus = 'ok' | 'mismatch';

const FROZEN = new Set(['released', 'superseded', 'obsolete']);

/**
 * Per released / superseded / obsolete revision: does its snapshot still hash to its recorded content hash, and, for the current revision
 * while it is released, does the live definition still hash to it.
 */
export function integrityOf(doc: CadDocument, plm: PlmModel, ctx?: ExecutionContext): Record<string, IntegrityStatus> {
  const result: Record<string, IntegrityStatus> = {};
  for (const label of plm.item.revisionOrder) {
    const revision = plm.item.revisions[label];
    if (revision === undefined || !FROZEN.has(revision.state)) continue;
    const snapshot = revision.snapshot;
    const snapshotOk =
      snapshot !== undefined &&
      (snapshot.kind === 'vault'
        ? snapshot.objectSha256 === revision.contentHash && (ctx?.objects?.has(snapshot.objectSha256) ?? true)
        : sha256Hex(snapshot.canonicalJson) === revision.contentHash);
    const liveOk = label !== plm.item.currentRevision || revision.state !== 'released' || scopeHash(doc, ctx) === revision.contentHash;
    result[label] = snapshotOk && liveOk ? 'ok' : 'mismatch';
  }
  return result;
}

/** Warning lines for `load_document` (TR-PLM-33), e.g. `release A content hash mismatch (expected 7e39…)`. */
export function integrityWarnings(doc: CadDocument): string[] {
  const plm = doc.plm;
  if (plm === undefined) return [];
  return Object.entries(integrityOf(doc, plm))
    .filter(([, status]) => status === 'mismatch')
    .map(
      ([label]) =>
        `release ${label} content hash mismatch (expected ${plm.item.revisions[label]?.contentHash?.slice(0, 8) ?? '?'}…); the revision stays locked`,
    );
}
