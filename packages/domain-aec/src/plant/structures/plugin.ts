/**
 * Plant structures plugin (plant 06 STA): access rules (ISO 14122, OSHA 1910) and `check_access` on the building model's stairs and slab
 * edges, toolset `plant_structures`. Elements live in the building model; the plugin has no document slice of its own yet.
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { structuresCommands } from './catalog';

export const structuresPlugin: CadPlugin = { name: 'plantStructures', toolset: 'plant_structures', commands: structuresCommands };
