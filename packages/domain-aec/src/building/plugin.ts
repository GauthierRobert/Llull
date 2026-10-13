/**
 * Building plugin: the AEC domain extends the CAD core through the plugin contract — commands, the `building` MCP toolset, the derivation
 * guard and the document extension that validates the building model and re-derives its geometry on load.
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { buildingCommands } from './catalog';
import { buildingDerivationGuard } from './evaluate/integrity';
import { derivedModelExtension } from '../shared/derived';
import { aecRetiredCommands } from '../retired';
import { buildingErrors } from './validate';
import { regenerateBuilding } from './evaluate/evaluateElements';

const buildingDocument = derivedModelExtension({
  key: 'building',
  owners: (building) => Object.values(building.elements),
  errors: buildingErrors,
  regenerate: regenerateBuilding,
});

export const buildingPlugin: CadPlugin = {
  name: 'building',
  toolset: 'building',
  commands: buildingCommands,
  guards: [buildingDerivationGuard],
  document: buildingDocument,
  retiredCommands: aecRetiredCommands,
};
