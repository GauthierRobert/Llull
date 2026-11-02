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
  // Replay starts from an empty slice: the issue ledger is kept so a recorded issue_isometric step re-applies its (already verified) human issue.
  replaySeed: (base) => {
    const issueLedger = base.plant?.fabrication?.issueLedger;
    return issueLedger === undefined || issueLedger.length === 0
      ? {}
      : { plant: { fabrication: { version: 1, pcfLines: {}, issueLedger } } };
  },
};

export const pipingFabricationPlugin: CadPlugin = {
  name: 'piping-fabrication',
  toolset: 'piping',
  commands: fabricationCatalog,
  document: fabricationDocument,
};
