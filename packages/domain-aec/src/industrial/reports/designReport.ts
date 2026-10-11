/**
 * Result reporting shared by the iterative design commands (design_portal_frames, design_purlins).
 * @layer domain-aec
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';

const LIMITED_NOTE = 'largest available size reached for some elements';

interface UtilisationStats {
  maxUtilisation: number;
  failures: number;
}

/** Maximum utilisation and number of rows above 1. */
export function utilisationStats(rows: ReadonlyArray<{ utilisation: number }>): UtilisationStats {
  return {
    maxUtilisation: Math.max(0, ...rows.map((row) => row.utilisation)),
    failures: rows.filter((row) => row.utilisation > 1).length,
  };
}

/**
 * The "nothing to resize" result: unchanged document, empty `affected`.
 * @failure never changes the document
 */
export function noChangeResult(
  doc: CadDocument,
  subject: string,
  rows: ReadonlyArray<{ utilisation: number }>,
  limited: boolean,
): CommandResult {
  const stats = utilisationStats(rows);
  return {
    document: doc,
    summary: `Designed ${subject}: no change needed (max utilisation ${stats.maxUtilisation.toFixed(2)}${limited ? `; ${LIMITED_NOTE}` : ''}).`,
    affected: [],
    data: { changes: [], ...stats },
  };
}

/** Tail of the changed-design summary: "Max utilisation now x[, n <noun> still failing][ (limited)].". */
export function finalUtilisationText(
  stats: UtilisationStats,
  failingNoun: string,
  limited: boolean,
): string {
  return (
    `Max utilisation now ${stats.maxUtilisation.toFixed(2)}` +
    `${stats.failures > 0 ? `, ${stats.failures} ${failingNoun} still failing` : ''}` +
    `${limited ? ` (${LIMITED_NOTE})` : ''}.`
  );
}
