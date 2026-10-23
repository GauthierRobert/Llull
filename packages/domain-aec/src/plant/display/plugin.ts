/**
 * Plant display plugin (plant 09 VIS-M1): the entity property provider for building pipes / equipment and plant piping runs, and the service
 * colour schemes (ASME A13.1, ISO 14726). The generic display model, profiles, report and check live in core (`commands/display/`).
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { commandCatalog } from '@core/commands/schema';
import { plantEntityProperties } from './properties';
import { applyServiceColourScheme, listServiceColourSchemes } from './serviceColour';

export const plantDisplayPlugin: CadPlugin = {
  name: 'plant-display',
  toolset: 'review',
  commands: commandCatalog(listServiceColourSchemes, applyServiceColourScheme),
  entityProperties: plantEntityProperties,
};
