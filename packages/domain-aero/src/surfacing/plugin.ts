/** Surfacing plugin (02 SRF): airfoils and wings as exact NURBS geometry; commands under the `aerodynamics` toolset. */

import type { CadPlugin } from '@core/plugins/plugin';
import { aeroDocument } from './aeroDocument';
import { surfacingCommands } from './catalog';

export const surfacingPlugin: CadPlugin = {
  name: 'surfacing',
  toolset: 'aerodynamics',
  commands: surfacingCommands,
  document: aeroDocument,
};
