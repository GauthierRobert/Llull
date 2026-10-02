/**
 * Derivation guards: evaluated geometry that a definition element generated is read-only;
 * edit the source instead. Each guard inspects a command's before/after documents.
 *
 * @layer core/commands
 * @invariant a guard is pure and returns null when the edit is legal
 */

import type { CadDocument } from '../model/types';

export interface DerivationGuard {
  /** Short id of the definition domain, e.g. `building`. */
  readonly domain: string;
  /** Rejection summary tail when `next` edits geometry derived from the definition; else null. */
  check(previous: CadDocument, next: CadDocument): string | null;
}

/** First guard violation for a command result, formatted as the command's summary, else null. */
export function derivationViolation(
  guards: ReadonlyArray<DerivationGuard>,
  commandName: string,
  previous: CadDocument,
  next: CadDocument,
): string | null {
  if (next === previous) return null;
  for (const guard of guards) {
    const reason = guard.check(previous, next);
    if (reason !== null) return `${commandName} rejected: ${reason}`;
  }
  return null;
}
