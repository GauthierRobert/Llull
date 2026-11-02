/**
 * Pipe stress plugin (plant 07 PST): code rules as data and the closed-form quick checks (M1), toolset `pipestress`. The stress model slice
 * (`doc.plant.stress`) arrives with M3; the plugin has no document state yet.
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { pipeStressCommands } from './catalog';

export const pipeStressPlugin: CadPlugin = { name: 'pipeStress', toolset: 'pipestress', commands: pipeStressCommands };
