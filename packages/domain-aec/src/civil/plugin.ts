/**
 * Civil / site-engineering plugin: its command catalog (catalog.ts), the `civil` toolset, the derivation guard and the document
 * extension that validates the civil model and re-derives its geometry on load.
 */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { civilDerivationGuard } from './integrity';
import { derivedModelExtension } from '../shared/derived';
import { civilErrors } from './validate';
import { regenerateCivil } from './evaluate';
import { civilCommands } from './catalog';

const derivedCivil = derivedModelExtension({
  key: 'civil',
  owners: (civil) => Object.values(civil.objects),
  errors: civilErrors,
  seed: (civil) => ({ ...civil, objects: {} }),
  regenerate: regenerateCivil,
});

/** The tint depends on the site ground and the units: re-derive when either changed under an active tint. */
const civilDocument: DocumentExtension = {
  ...derivedCivil,
  reconcile: (previous, next) => {
    const civil = next.civil;
    const changed = previous.units !== next.units || previous.siteContext?.groundElevation !== next.siteContext?.groundElevation;
    if (civil === undefined || (civil.terrainTint ?? 'none') === 'none' || !changed) return { document: next, notes: [], affected: [] };
    const document = regenerateCivil(next, civil);
    return { document, notes: [], affected: Object.values(document.civil?.objects ?? {}).flatMap((object) => object.entityIds) };
  },
};

export const civilPlugin: CadPlugin = {
  name: 'civil',
  toolset: 'civil',
  commands: civilCommands,
  guards: [civilDerivationGuard],
  document: civilDocument,
};
