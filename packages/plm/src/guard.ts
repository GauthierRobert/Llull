/** The release lock (FR-PLM-05, §5.2): a derivation guard that refuses any change of the definition while its revision is not open. */

import type { CadDocument } from '@core/model/types';
import type { DerivationGuard, GuardRefusal } from '@core/commands/derivation';
import { commandError } from '@core/commands/noop';
import type { Revision } from '@core/model/plm';
import { getCommand } from '@core/commands/registry';
import { remediationOf } from './refusal';

/** Commands that replace the document wholesale (integrity is checked on load) or restore a released snapshot (checked by the command). */
const EXEMPT = new Set(['load_document', 'clear_document', 'restore_revision_snapshot']);

/** Top-level keys outside the release scope: view state and the PLM record itself. */
const OUTSIDE_SCOPE = new Set(['selection', 'camera', 'plm']);

/** The release-scope hash of `doc` (the registered document_content_hash query: derived entities and private values are outside it). */
function hashOf(doc: CadDocument): string | null {
  const data = getCommand('document_content_hash')?.run(doc, {}).data as { sha256?: string } | undefined;
  return data?.sha256 ?? null;
}

/**
 * Whether the release scope differs: reference comparison first (a handful of comparisons); only when some key was re-created, one content hash of each
 * document decides, so a command that regenerates the identical definition (replay_history of a released revision) is allowed.
 */
function scopeChanged(previous: CadDocument, next: CadDocument): boolean {
  const before = previous as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  const recreated = [...new Set([...Object.keys(before), ...Object.keys(after)])].some(
    (key) => !OUTSIDE_SCOPE.has(key) && before[key] !== after[key],
  );
  if (!recreated) return false;
  const [a, b] = [hashOf(previous), hashOf(next)];
  return a === null || b === null || a !== b;
}

const refusal = (
  code: 'PLM_LOCKED' | 'PLM_HISTORY_IMMUTABLE' | 'PLM_RECORD_REMOVED',
  reason: string,
  ids: readonly string[],
): GuardRefusal => ({ reason, error: commandError(code, remediationOf(code), ids) });

const FROZEN = new Set(['released', 'superseded', 'obsolete']);

/**
 * @invariant a command may change the definition only while the current revision is in_work (or cancelled), or when it opened that revision
 *   from a released one in the same result (revise-then-edit inside one build_project)
 * @invariant a released / superseded / obsolete revision keeps its content hash and snapshot; PLM data is removed only by load / clear
 */
export const releaseLockGuard: DerivationGuard = {
  domain: 'plm',
  check(previous, next, commandName) {
    if (EXEMPT.has(commandName)) return commandName === 'restore_revision_snapshot' ? historyRefusal(previous, next) : null;
    const before = previous.plm;
    if (before === undefined) return null;
    const after = next.plm;
    if (after === undefined) return refusal('PLM_RECORD_REMOVED', 'the PLM record cannot be removed', [before.item.partNumber]);
    const broken = historyRefusal(previous, next);
    if (broken !== null) return broken;
    const current = after.item.revisions[after.item.currentRevision];
    if (current === undefined) return null;
    const open = current.state === 'in_work' || current.state === 'cancelled';
    const previousCurrent = before.item.revisions[before.item.currentRevision];
    const sameRevision = current.label === before.item.currentRevision;
    const revisedFromFrozen =
      current.basedOn === before.item.currentRevision && previousCurrent !== undefined && FROZEN.has(previousCurrent.state);
    if (open && (sameRevision || revisedFromFrozen)) return null;
    if (!scopeChanged(previous, next)) return null;
    const hint = current.state === 'in_review' ? 'reject_review first' : 'open an ECO and revise_item';
    return refusal('PLM_LOCKED', `${after.item.partNumber} rev ${current.label} is ${current.state}; ${hint}`, [
      after.item.partNumber,
      current.label,
    ]);
  },
};

/**
 * Whether the frozen snapshot is kept: identical, or moved to the vault under its own content hash (`externalize_snapshots`, which checked the object).
 * A vault reference never goes back to different content.
 */
function sameSnapshot(before: Revision, after: Revision): boolean {
  const [a, b] = [before.snapshot, after.snapshot];
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === 'inline' && b.kind === 'inline') return a.canonicalJson === b.canonicalJson;
  if (a.kind === 'vault' && b.kind === 'vault') return a.objectSha256 === b.objectSha256;
  return a.kind === 'inline' && b.kind === 'vault' && b.objectSha256 === before.contentHash;
}

/** Released history is immutable: a frozen revision keeps its hash and snapshot and may not vanish. */
function historyRefusal(previous: CadDocument, next: CadDocument): GuardRefusal | null {
  const before = previous.plm?.item;
  const after = next.plm?.item;
  if (before === undefined || after === undefined) return null;
  for (const [label, revision] of Object.entries(before.revisions)) {
    if (!FROZEN.has(revision.state)) continue;
    const kept = after.revisions[label];
    if (kept === undefined || kept.contentHash !== revision.contentHash || !sameSnapshot(revision, kept))
      return refusal('PLM_HISTORY_IMMUTABLE', `${before.partNumber} rev ${label} history cannot change`, [before.partNumber, label]);
  }
  return null;
}
