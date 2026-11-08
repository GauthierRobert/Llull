/** Material-selection plugin (PHY-12): Ashby performance indices, ranking, substitution what-if and checks, under the `materials` toolset. No document slice: every command is read-only. */

import type { CadPlugin } from '@core/plugins/plugin';
import { selectionCommands } from './catalog';

export const selectionPlugin: CadPlugin = { name: 'physics-selection', toolset: 'materials', commands: selectionCommands };
