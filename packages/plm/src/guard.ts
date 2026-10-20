/** The release lock (FR-PLM-05, §5.2): a derivation guard that refuses any change of the definition while its revision is not open. */

import type { CadDocument } from '@core/model/types';
import type { DerivationGuard, GuardRefusal } from '@core/commands/derivation';
import { commandError } from '@core/commands/noop';
import { canonicalJson } from '@lib/canonicalJson';
import { remediationOf } from './refusal';

/** Commands that replace the document wholesale (integrity is checked on load) or restore a released snapshot (checked by the command). */
const EXEMPT = new Set(['load_document', 'clear_document', 'restore_revision_snapshot']);

/** Top-level keys outside the release scope: view state and the PLM record itself. */
const OUTSIDE_SCOPE = new Set(['selection', 'camera', 'plm']);

/** Whether any key of the release scope differs (by reference first, by canonical value when a command re-created an equal object). */
function scopeChanged(previous: CadDocument, next: CadDocument): boolean {
  const before = previous as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (OUTSIDE_SCOPE.has(key) || before[key] === after[key]) continue;
    if (canonicalJson(before[key]) !== canonicalJson(after[key])) return true;
  }
  return false;
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

/** Released history is immutable: a frozen revision keeps its hash and snapshot and may not vanish. */
function historyRefusal(previous: CadDocument, next: CadDocument): GuardRefusal | null {
  const before = previous.plm?.item;
  const after = next.plm?.item;
  if (before === undefined || after === undefined) return null;
  for (const [label, revision] of Object.entries(before.revisions)) {
    if (!FROZEN.has(revision.state)) continue;
    const kept = after.revisions[label];
    if (
      kept === undefined ||
      kept.contentHash !== revision.contentHash ||
      kept.snapshot?.canonicalJson !== revision.snapshot?.canonicalJson
    )
      return refusal('PLM_HISTORY_IMMUTABLE', `${before.partNumber} rev ${label} history cannot change`, [before.partNumber, label]);
  }
  return null;
}
