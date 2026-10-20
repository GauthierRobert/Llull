/** Composites plugin (06 CMP): laminates, zones, plies and flat patterns; commands under the `manufacturing` toolset (ply cutting is manufacturing data). */

import type { CadPlugin } from '@core/plugins/plugin';
import { compositesCommands } from './catalog';
import { compositesDerivationGuard } from './derive';
import { compositesDocument } from './document';

export const compositesPlugin: CadPlugin = {
  name: 'composites',
  toolset: 'manufacturing',
  commands: compositesCommands,
  guards: [compositesDerivationGuard],
  document: compositesDocument,
};
