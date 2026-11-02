/**
 * Plant data plugin (plant 08 DAT), toolset `plant_data`: M1 (M2 adds plant_report, export_plant_data) the data core (hierarchy, classes + default process library, tag formats, tag registry,
 * `assign_plant_object`, `set_plant_properties`, `plant_data_table`, `check_plant_data`) in `doc.plant.data`; M6 adds `set_deliverable_status` and `export_handover` (deliverables are carried across a history replay). The tag registry is derived; the
 * existing tag fields of the model (equipment mark, pipe line number, routed line number, inline tags, tie-ins) are read and written through the object providers.
 */

import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { plantDataCatalog } from './catalog';
import { getPlantData, own, withPlantData } from './model';
import { registerBuiltinProviders } from './providersBuiltin';
import { plantDataErrors } from './validate';

const plantDataDocument: DocumentExtension = {
  validate: (raw) => {
    const plant = raw['plant'];
    return isRecord(plant) ? plantDataErrors(plant['data']) : [];
  },
  derivedEntityIds: () => new Set(),
  restore: (raw) => raw,
  afterLoad: (doc) =>
    Object.values(getPlantData(doc).deliverables ?? {}).flatMap((deliverable) =>
      deliverable.revisions
        .filter((revision) => revision.hierarchyId !== undefined && own(getPlantData(doc).hierarchy, revision.hierarchyId) === undefined)
        .map(
          (revision) =>
            `plant deliverable ${deliverable.id} revision ${revision.label} is scoped to hierarchy node ${revision.hierarchyId}, which no longer exists (a regenerate dropped it): its content cannot be re-checked`,
        ),
    ),
  carry: (prev, next) => {
    const deliverables = prev.plant?.data?.deliverables;
    return deliverables === undefined ? next : withPlantData(next, { ...getPlantData(next), deliverables });
  },
};

export const plantDataPlugin: CadPlugin = {
  name: 'plant-data',
  toolset: 'plant_data',
  commands: plantDataCatalog,
  onInstall: registerBuiltinProviders,
  document: plantDataDocument,
};
