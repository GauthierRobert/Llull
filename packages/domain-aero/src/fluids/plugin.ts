/** Fluids plugin (11 FLD): compressible flow, rocket nozzle performance and contour, rocket equation; commands under the `fluids` toolset. */

import type { CadPlugin } from '@core/plugins/plugin';
import { fluidsCommands } from './catalog';

export const fluidsPlugin: CadPlugin = { name: 'fluids', toolset: 'fluids', commands: fluidsCommands };
