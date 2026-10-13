/** Parameter schema shared by the alignment / road commands. */

import { z } from '@core/commands/schema';

export const alignmentIdParam = z.string().describe('Alignment id, e.g. "alignment-1".');
