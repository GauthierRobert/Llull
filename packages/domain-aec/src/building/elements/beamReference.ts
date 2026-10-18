/** Shared `reference` parameter: which level datum a beam `topOffset` is measured from. */

import { z } from '@core/commands/schema';

export const beamReferenceParam = z
  .enum(['levelTop', 'ffl'])
  .optional()
  .describe(
    'Datum of topOffset: "levelTop" = level elevation + level height (underside of the next floor), "ffl" = level finished floor ' +
      'elevation. The same reference and topOffset put add_beam and add_grid_beams at the same absolute elevation. ' +
      'Default differs by domain and is kept so existing documents replay unchanged: add_beam "levelTop" (concrete beam under the next slab), ' +
      'add_grid_beams "ffl" (steel framing referenced to finished floor). Pass reference explicitly to be unambiguous; the summary states the resolved elevation.',
  );
