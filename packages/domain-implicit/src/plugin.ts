/** Implicit plugin (05 IMP): field modelling and lattices; derived bodies are read-only mesh solids re-derived on load. */

import type { CadPlugin } from '@core/plugins/plugin';
import { implicitCommands } from './catalog';
import { implicitDocument, implicitGuard } from './document';

export const implicitPlugin: CadPlugin = {
  name: 'implicit',
  toolset: 'implicit',
  commands: implicitCommands,
  guards: [implicitGuard],
  document: implicitDocument,
};
