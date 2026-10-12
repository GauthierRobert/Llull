/**
 * Parameter schema shared by the alignment / road commands.
 * @layer domain-aec/civil
 */

import { z } from '@core/commands/schema';

export const alignmentIdParam = z.string().describe('Alignment id, e.g. "alignment-1".');
