/**
 * The catalogue row of a spectacle (figure-8) blind (plant 01 PSC / 02 RTE): read ONLY from the spec's catalogues (a user-imported `spectacleBlind` family; the bundled
 * catalogue has none). Needs `thickness`, `discDiameterClosed`, `discDiameterOpen`, `webLength` (`handleLength` is optional); nothing is invented.
 * @failure no row -> RTE_SPEC_NO_COMPONENT naming the spectacle blind; a missing or non-positive dimension -> RTE_SPEC_NO_COMPONENT naming it
 */

import { fail, type DerivationFailure } from './deriveTypes';
import type { FlangeSet } from './flangeSet';
import type { Env } from './routeEnv';
import { isMiss, type CatalogueRow } from './specLookup';

export const SPECTACLE_BLIND = 'spectacleBlind';

export type SpectacleState = 'open' | 'closed';

/** The row dimensions every spectacle blind needs (the handle is optional). */
const REQUIRED_DIMS = ['thickness', 'discDiameterClosed', 'discDiameterOpen', 'webLength'] as const;

/**
 * The spectacle blind row of size `dn` for the rating / facing of `set`, with its dimensions checked.
 * @failure no row -> its miss (RTE_SPEC_NO_COMPONENT naming the spectacle blind); a missing or non-positive dimension -> RTE_SPEC_NO_COMPONENT naming it
 */
export function spectacleRow(
  env: Env,
  dn: number,
  set: FlangeSet,
  ids: readonly string[],
  paths: readonly string[],
): CatalogueRow | DerivationFailure {
  const row = env.lookup.component({
    types: [SPECTACLE_BLIND],
    dn,
    ...(set.flange.rating === undefined ? {} : { rating: set.flange.rating }),
    ...(set.flange.facing === undefined ? {} : { facing: set.flange.facing }),
  });
  if (isMiss(row))
    return fail(
      row.miss,
      `spectacle blind at DN${dn}: ${row.detail} (import a catalogue with a spectacleBlind family, none is bundled)`,
      [...row.ids, ...ids],
      paths,
      { dn },
    );
  const lacking = REQUIRED_DIMS.filter((name) => !((row.dims[name] ?? 0) > 0));
  if (lacking.length > 0)
    return fail(
      'RTE_SPEC_NO_COMPONENT',
      `spectacle blind row ${row.key} lacks ${lacking.join(', ')} (${row.source}): the row must give thickness, discDiameterClosed, discDiameterOpen and webLength`,
      [row.key, ...ids],
      paths,
      { missing: lacking },
    );
  return row;
}
