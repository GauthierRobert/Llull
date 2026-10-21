/** Aerodynamics plugin (10 AER): standard atmosphere, airfoils, wings, drag, cycling power; commands under the `aerodynamics` toolset. */

import type { CadPlugin } from '@core/plugins/plugin';
import { aerodynamicsCommands } from './catalog';
import { aerodynamicsRetiredCommands } from './retired';

export const aerodynamicsPlugin: CadPlugin = {
  name: 'aerodynamics',
  toolset: 'aerodynamics',
  commands: aerodynamicsCommands,
  retiredCommands: aerodynamicsRetiredCommands,
};
