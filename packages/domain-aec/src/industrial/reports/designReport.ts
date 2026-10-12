/**
 * Result reporting shared by the iterative design commands (design_portal_frames, design_purlins).
 * @layer domain-aec
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { elementAffected } from '../../building/model';
import { failingRows, maxUtilisation } from '../common/utilisation';

const LIMITED_NOTE = 'largest available size reached for some elements';

interface UtilisationStats {
  maxUtilisation: number;
  failures: number;
}

/** Maximum utilisation and number of rows above 1. */
export function utilisationStats(rows: ReadonlyArray<{ utilisation: number }>): UtilisationStats {
  return {
    maxUtilisation: maxUtilisation(rows),
    failures: failingRows(rows).length,
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
  return report(
    doc,
    `Designed ${subject}: no change needed (max utilisation ${stats.maxUtilisation.toFixed(2)}${limited ? `; ${LIMITED_NOTE}` : ''}).`,
    { changes: [], ...stats },
  );
}

/** The result of a design that resized elements: `changed` ids are affected, `changes` and `stats` are the data. */
export function designResult(
  document: CadDocument,
  summary: string,
  changed: ReadonlySet<string>,
  changes: ReadonlyArray<string>,
  stats: UtilisationStats,
): CommandResult {
  return {
    document,
    summary,
    affected: elementAffected(document, [...changed]),
    data: { changes, ...stats },
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
