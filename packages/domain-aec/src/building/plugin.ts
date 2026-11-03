/**
 * Building plugin: the AEC domain extends the CAD core through the plugin contract — commands, the `building` toolset, the derivation
 * guard and the document extension that validates the building model and re-derives its geometry on load.
 */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { buildingCommands } from './catalog';
import { buildingDerivationGuard } from './evaluate/integrity';
import { derivedModelExtension } from '../shared/derived';
import { aecRetiredCommands } from '../retired';
import { buildingErrors } from './validate';
import { sealedBuilding } from './model';
import { regenerateBuilding } from './evaluate/evaluateElements';

const derivedBuilding = derivedModelExtension({
  key: 'building',
  owners: (building) => Object.values(building.elements),
  errors: buildingErrors,
  regenerate: regenerateBuilding,
});

/** The building uid (IFC GlobalId salt) is step-scoped and sealed by the first command's result, so replay re-mints it; see `sealedBuilding`. */
const buildingDocument: DocumentExtension = {
  ...derivedBuilding,
  reconcile: (_previous, next) => {
    const sealed = next.building === undefined ? undefined : sealedBuilding(next.building);
    return { document: sealed === undefined || sealed === next.building ? next : { ...next, building: sealed }, notes: [], affected: [] };
  },
};

export const buildingPlugin: CadPlugin = {
  name: 'building',
  toolset: 'building',
  commands: buildingCommands,
  guards: [buildingDerivationGuard],
  document: buildingDocument,
  retiredCommands: aecRetiredCommands,
};
