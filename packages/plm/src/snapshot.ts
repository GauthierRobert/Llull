/** Reading a revision's frozen definition, wherever it is kept: inline in the record, or as an object of the local vault (M3). */

import type { ExecutionContext } from '@core/commands/types';
import type { Revision } from '@plm/types';

/**
 * The exact canonical text of the snapshot of `revision`, or null when it is not readable here: no snapshot, or externalized and the vault object is not
 * reachable through `ctx.objects` (the port re-hashes what it returns, so a damaged object reads as null).
 */
export function snapshotText(revision: Revision, ctx: ExecutionContext | undefined): string | null {
  const snapshot = revision.snapshot;
  if (snapshot === undefined) return null;
  if (snapshot.kind === 'inline') return snapshot.canonicalJson;
  return ctx?.objects?.get(snapshot.objectSha256) ?? null;
}

/** Why a snapshot that exists cannot be read (for refusal summaries). */
export const unreadableSnapshot = (revision: Revision): string =>
  revision.snapshot?.kind === 'vault'
    ? `its snapshot is in the local vault (object ${revision.snapshot.objectSha256.slice(0, 12)}…) and no vault is reachable or the object is damaged`
    : 'it has no snapshot';
