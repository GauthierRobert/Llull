/** Sheet-metal plugin (07 FTR): flats-and-bends parts, analytic flat patterns, bend checks; commands under the `manufacturing` toolset. */

import type { CadPlugin } from '@core/plugins/plugin';
import { sheetMetalCommands } from './catalog';
import { sheetMetalDerivationGuard, sheetMetalDocument } from './derive';

export const sheetMetalPlugin: CadPlugin = {
  name: 'sheetmetal',
  toolset: 'manufacturing',
  commands: sheetMetalCommands,
  guards: [sheetMetalDerivationGuard],
  document: sheetMetalDocument,
};
