/**
 * Load parameters shared by check_purlins and design_purlins.
 * @layer domain-aec
 */

import { z } from '@core/commands/schema';
import { existingLevelIdParam } from '../levelParams';

export const PURLIN_LOAD_SHAPE = {
  windPressure: z
    .number()
    .optional()
    .describe(
      'Peak velocity pressure qp, kN/m² (EN 1991-1-4, e.g. 0.6-1.0), >= 0. Default 0.6. 0 = no wind.',
    ),
  snowLoad: z.number().optional().describe('Roof snow load on plan, kN/m², >= 0. Default 0.8.'),
  roofDeadLoad: z
    .number()
    .optional()
    .describe(
      'Roof build-up dead load carried by the purlins (sheeting, insulation, services) per m² of roof, kN/m², >= 0. Purlin self-weight is added automatically. Default 0.3.',
    ),
  levelId: existingLevelIdParam,
};
