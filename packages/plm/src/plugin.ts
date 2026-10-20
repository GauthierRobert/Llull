/** PLM plugin (09): managed item, revisions, release lock, change control, effectivity, signatures; commands under the `plm` toolset. */

import type { CadPlugin } from '@core/plugins/plugin';
import { plmCommands } from './catalog';
import { plmDocument } from './document';
import { releaseLockGuard } from './guard';

export const plmPlugin: CadPlugin = {
  name: 'plm',
  toolset: 'plm',
  commands: plmCommands,
  guards: [releaseLockGuard],
  document: plmDocument,
};
