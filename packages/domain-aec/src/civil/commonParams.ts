/**
 * Parameter schema shared by the civil edit commands.
 * @layer domain-aec/civil
 */

import { z } from '@core/commands/schema';

export const newNameParam = z.string().optional().describe('New name.');
