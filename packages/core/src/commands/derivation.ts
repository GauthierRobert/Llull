/**
 * Derivation guards: evaluated geometry that a definition element generated is read-only; edit the source instead. Each guard inspects a
 * command's before/after documents (and the command name, so document-replacing commands can be exempted). The same hook serves other
 * result vetoes, e.g. the PLM release lock.
 * @invariant a guard is pure and returns null when the edit is legal
 */

import type { CadDocument } from '../model/types';
import type { CommandError } from './types';

/** A guard refusal with its own stable code (AF-11); a plain string refuses as `CMD_DERIVED_GEOMETRY`. */
export interface GuardRefusal {
  /** Rejection summary tail (after `<command> rejected: `). */
  readonly reason: string;
  readonly error: CommandError;
}

/** Commands that replace the whole document (a loaded file is checked on load; a restored snapshot by its command): reference guards exempt them. */
export const WHOLE_DOCUMENT_REPLACEMENTS: ReadonlySet<string> = new Set(['load_document', 'clear_document', 'restore_revision_snapshot']);

/** What a guard may know about the call (additive; guards that ignore it keep working). */
export interface GuardContext {
  /** True while history replay re-runs recorded steps: a reference guard added after the steps were recorded must not refuse them (L8). */
  readonly replaying: boolean;
}

export interface DerivationGuard {
  /** Short id of the definition domain, e.g. `building`. */
  readonly domain: string;
  /** Rejection summary tail when `next` edits geometry derived from the definition; else null. `commandName` is the command that produced `next`. */
  check(previous: CadDocument, next: CadDocument, commandName: string, context?: GuardContext): string | GuardRefusal | null;
}

/** First guard violation for a command result: its summary and (for coded guards) its error, else null. */
export function derivationViolation(
  guards: ReadonlyArray<DerivationGuard>,
  commandName: string,
  previous: CadDocument,
  next: CadDocument,
  context: GuardContext = { replaying: false },
): { readonly summary: string; readonly error: CommandError | null } | null {
  if (next === previous) return null;
  for (const guard of guards) {
    const refusal = guard.check(previous, next, commandName, context);
    if (refusal === null) continue;
    if (typeof refusal === 'string') return { summary: `${commandName} rejected: ${refusal}`, error: null };
    return { summary: `${commandName} rejected: ${refusal.reason}`, error: refusal.error };
  }
  return null;
}
