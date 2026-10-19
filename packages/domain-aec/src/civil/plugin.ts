/**
 * Civil / site-engineering plugin: its command catalog (catalog.ts), the `civil` toolset, the derivation guard and the document
 * extension that validates the civil model and re-derives its geometry on load.
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { civilDerivationGuard } from './integrity';
import { derivedModelExtension } from '../shared/derived';
import { civilErrors } from './validate';
import { regenerateCivil } from './evaluate';
import { civilCommands } from './catalog';

const civilDocument = derivedModelExtension({
  key: 'civil',
  owners: (civil) => Object.values(civil.objects),
  errors: civilErrors,
  seed: (civil) => ({ ...civil, objects: {} }),
  regenerate: regenerateCivil,
});

export const civilPlugin: CadPlugin = {
  name: 'civil',
  toolset: 'civil',
  commands: civilCommands,
  guards: [civilDerivationGuard],
  document: civilDocument,
};
