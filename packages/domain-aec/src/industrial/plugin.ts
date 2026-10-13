/**
 * Industrial-steel plugin: portal frames, members, checks and fabrication commands, exposed in the `building` MCP toolset. Its elements
 * live in the building model, so the building plugin's guard and document extension cover them.
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { industrialCommands } from './catalog';

export const industrialPlugin: CadPlugin = { name: 'industrial', toolset: 'building', commands: industrialCommands };
