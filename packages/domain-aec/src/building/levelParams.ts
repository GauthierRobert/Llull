/**
 * Shared `levelId` parameter schemas.
 * @layer domain-aec
 */

import { z } from '@core/commands/schema';

/** For commands that create elements (`resolveLevel`: a default level is created when none exists). */
export const levelIdParam = z
  .string()
  .optional()
  .describe('Level id. Default: the active level (a "Level 0" is created if none).');

/** For commands that require an existing level (`existingLevelId`: checks, exports, joints, plates). */
export const existingLevelIdParam = z
  .string()
  .optional()
  .describe('Level id. Default: the active level.');
