/** Retired composites commands: `export_flat_patterns_dxf` -> `export_ply_flat_patterns_dxf` (no longer one letter from the sheet-metal tool). */

import type { RetiredCommandRewrite } from '@core/commands/types';
import { renameTo } from '../shared/retired';

export const compositesRetiredCommands: Readonly<Record<string, RetiredCommandRewrite>> = {
  export_flat_patterns_dxf: renameTo('export_ply_flat_patterns_dxf'),
};
