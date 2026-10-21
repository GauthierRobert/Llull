/** Flow plugin (12 CFD): flow cases, geometry preparation and checks; commands under the `flow` toolset (palette group "Flow"). */

import type { CadPlugin } from '@core/plugins/plugin';
import { cfdCommands } from './catalog';
import { cfdDocument } from './document';
import { cfdRetiredCommands } from './retired';

export const cfdPlugin: CadPlugin = {
  name: 'cfd',
  toolset: 'flow',
  commands: cfdCommands,
  document: cfdDocument,
  retiredCommands: cfdRetiredCommands,
};
