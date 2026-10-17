/** Fastener plugin (08 MAT): catalogues, part-number decoding, grip selection and stack insertion; commands under the `fasteners` toolset. */

import type { CadPlugin } from '@core/plugins/plugin';
import { fastenerCommands } from './catalog';

export const fastenersPlugin: CadPlugin = {
  name: 'fasteners',
  toolset: 'fasteners',
  commands: fastenerCommands,
};
