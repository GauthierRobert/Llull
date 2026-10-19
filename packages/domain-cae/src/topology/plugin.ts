/** Topology plugin (PHY-17): its own derived geometry (the iso-surface) and guard, so it is a plugin next to `cae` rather than part of it. */

import type { CadPlugin } from '@core/plugins/plugin';
import { topologyCommands } from './catalog';
import { topologyDocument, topologyGuard } from './guard';

export const topologyPlugin: CadPlugin = {
  name: 'topology',
  toolset: 'analysis',
  commands: topologyCommands,
  guards: [topologyGuard],
  document: topologyDocument,
};
