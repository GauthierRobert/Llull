/**
 * Plant data plugin (plant 08 DAT), toolset `plant_data`: M1 the data core (hierarchy, classes + default process library, tag formats, tag registry,
 * `assign_plant_object`, `set_plant_properties`, `plant_data_table`, `check_plant_data`) in `doc.plant.data`. The tag registry is derived; the
 * existing tag fields of the model (equipment mark, pipe line number, routed line number, inline tags, tie-ins) are read and written through the object providers.
 */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { plantDataCatalog } from './catalog';
import { registerBuiltinProviders } from './providersBuiltin';
import { plantDataErrors } from './validate';

const plantDataDocument: DocumentExtension = {
  validate: (raw) => {
    const plant = raw['plant'];
    return isRecord(plant) ? plantDataErrors(plant['data']) : [];
  },
  derivedEntityIds: () => new Set(),
  restore: (raw) => raw,
};

export const plantDataPlugin: CadPlugin = {
  name: 'plant-data',
  toolset: 'plant_data',
  commands: plantDataCatalog,
  onInstall: registerBuiltinProviders,
  document: plantDataDocument,
};
