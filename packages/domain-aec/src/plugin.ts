/**
 * Building and industrial plugins: the AEC domain extends the CAD core through the plugin
 * contract — commands, the `building` MCP toolset, the derivation guard and the document extension
 * that validates the building model and re-derives its geometry on load.
 *
 * @layer domain-aec
 */

import type { CadPlugin } from '@core/plugins/plugin';
import { buildingCommands, industrialCommands } from './index';
import { buildingDerivationGuard } from './building/evaluate/integrity';
import { derivedModelExtension } from './shared/derived';
import { aecRetiredCommands } from './retired';
import { buildingErrors } from './building/validate';
import { regenerateBuilding } from './building/evaluate/evaluateElements';

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

export const industrialPlugin: CadPlugin = {
  name: 'industrial',
  toolset: 'building',
  commands: industrialCommands,
};
