/**
 * Piping fabrication plugin (plant 05 ISO), toolset `piping`: M1 the PCF reader / writer and the network port (`import_pcf`, `export_pcf`, `delete_pcf_line`);
 * the slice `doc.plant.fabrication` holds the imported lines (read-only data, no derived entities).
 */

import type { CadPlugin } from '@core/plugins/plugin';
import type { DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { fabricationCatalog } from './catalog';
import { fabricationErrors } from './validate';

const fabricationDocument: DocumentExtension = {
  validate: (raw) => {
    const plant = raw['plant'];
    return isRecord(plant) ? fabricationErrors(plant['fabrication']) : [];
  },
  derivedEntityIds: () => new Set(),
  restore: (raw) => raw,
};

export const pipingFabricationPlugin: CadPlugin = {
  name: 'piping-fabrication',
  toolset: 'piping',
  commands: fabricationCatalog,
  document: fabricationDocument,
};
