/**
 * The design-language plugin (toolset `design`): `.lld` text as the document recipe. Removable: only the composition root imports it.
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { commandCatalog } from '@core/commands/schema';
import { applyDesign, checkDesign, designSource, exportDesign } from './commands';
import { describeDesignSyntax } from './syntax';

export const designPlugin: CadPlugin = {
  name: 'design',
  toolset: 'design',
  commands: commandCatalog(applyDesign, designSource, checkDesign, exportDesign, describeDesignSyntax),
};
