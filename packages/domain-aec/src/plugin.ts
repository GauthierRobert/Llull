/**
 * Building and industrial plugins: the AEC domain extends the CAD core through the plugin
 * contract — commands, the `building` MCP toolset, the derivation guard and the document extension
 * that validates the building model and re-derives its geometry on load.
 *
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import { buildingCommands, industrialCommands } from './index';
import { buildingDerivationGuard } from './derivationGuard';
import { buildingErrors } from './validate';
import { regenerateBuilding } from './evaluate';

function derivedEntityIds(doc: CadDocument): Set<string> {
  const ids = new Set<string>();
  for (const element of Object.values(doc.building?.elements ?? {})) {
    for (const id of element.entityIds) ids.add(id);
  }
  return ids;
}

/**
 * Re-derive the building geometry a v2 file omits and restore the saved draw order
 * (regeneration appends; saved positions win, new ids follow).
 * @invariant raw documents without a valid building model are returned unchanged
 */
function restore(raw: Record<string, unknown>): Record<string, unknown> {
  const building = raw['building'];
  if (building === undefined || buildingErrors(building).length > 0) return raw;
  const savedOrder = Array.isArray(raw['order']) ? (raw['order'] as string[]) : [];
  const base = raw as unknown as CadDocument;
  const regenerated = regenerateBuilding(
    { ...base, order: savedOrder.filter((id) => id in base.entities), selection: [] },
    base.building as NonNullable<CadDocument['building']>,
  );
  const present = savedOrder.filter((id) => id in regenerated.entities);
  const placed = new Set(present);
  const order = [...present, ...regenerated.order.filter((id) => !placed.has(id))];
  const selection = Array.isArray(raw['selection'])
    ? (raw['selection'] as string[]).filter((id) => id in regenerated.entities)
    : [];
  return {
    ...raw,
    entities: regenerated.entities,
    order,
    selection,
    building: regenerated.building,
    layers: regenerated.layers,
    layerOrder: regenerated.layerOrder,
  };
}

const buildingDocument: DocumentExtension = {
  validate: (raw) => (raw['building'] === undefined ? [] : buildingErrors(raw['building'])),
  derivedEntityIds,
  restore,
};

export const buildingPlugin: CadPlugin = {
  name: 'building',
  toolset: 'building',
  commands: buildingCommands,
  guards: [buildingDerivationGuard],
  document: buildingDocument,
};

export const industrialPlugin: CadPlugin = {
  name: 'industrial',
  toolset: 'building',
  commands: industrialCommands,
};
