/**
 * Civil / site-engineering plugin: survey, terrain, earthworks, roads and drainage commands, the
 * `civil` MCP toolset, the derivation guard and the document extension that validates the civil
 * model and re-derives its geometry on load.
 * @layer domain-aec/civil
 */

import type { CadDocument } from '@core/model/types';
import type { CivilModel } from '@core/model/civil';
import type { CadPlugin, DocumentExtension } from '@core/plugins/plugin';
import type { CommandDefinition } from '@core/commands/types';
import { civilDerivationGuard } from './integrity';
import { civilErrors } from './validate';
import { regenerateCivil } from './evaluate';
import { createSurface, importSurveyPoints, updateSurface } from './surveyCommands';
import { surfaceElevation, surfaceReport } from './surfaceQueries';
import { importSurveyDxf } from './surveyDxf';
import { deleteCivilObject, describeCivil } from './civilCommands';
import { earthworksCommands } from './earthworksCommands';
import { roadCommands } from './roadCommands';
import { drainageCommands } from './drainageCommands';
import { civilExchangeCommands } from './exchangeCommands';
import { crsCommands } from './crsCommands';
import { civilSheetCommands } from './civilSheetCommands';

function derivedEntityIds(doc: CadDocument): Set<string> {
  const ids = new Set<string>();
  for (const object of Object.values(doc.civil?.objects ?? {})) {
    for (const id of object.entityIds) ids.add(id);
  }
  return ids;
}

/**
 * Re-derive the civil geometry a v2 file omits (saved order first, new ids after).
 * @invariant raw documents without a valid civil model are returned unchanged
 */
function restore(raw: Record<string, unknown>): Record<string, unknown> {
  const civil = raw['civil'];
  if (civil === undefined || civilErrors(civil).length > 0) return raw;
  const savedOrder = Array.isArray(raw['order']) ? (raw['order'] as string[]) : [];
  const base = raw as unknown as CadDocument;
  const stale = new Set(
    Object.values((civil as CivilModel).objects).flatMap((object) => object.entityIds),
  );
  let regenerated: CadDocument;
  try {
    regenerated = regenerateCivil(
      {
        ...base,
        order: savedOrder.filter((id) => id in base.entities && !stale.has(id)),
        selection: [],
        civil: { ...(civil as CivilModel), objects: {} },
      },
      civil as CivilModel,
    );
  } catch {
    // Validation reports the problem; never let a corrupt file throw out of load.
    return raw;
  }
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
    civil: regenerated.civil,
    layers: regenerated.layers,
    layerOrder: regenerated.layerOrder,
  };
}

const civilDocument: DocumentExtension = {
  validate: (raw) => (raw['civil'] === undefined ? [] : civilErrors(raw['civil'])),
  derivedEntityIds,
  restore,
};

/** Civil / site-engineering commands. */
export const civilCommands = [
  importSurveyPoints,
  importSurveyDxf,
  createSurface,
  updateSurface,
  surfaceElevation,
  surfaceReport,
  describeCivil,
  deleteCivilObject,
  ...earthworksCommands,
  ...roadCommands,
  ...drainageCommands,
  ...civilExchangeCommands,
  ...crsCommands,
  ...civilSheetCommands,
] as ReadonlyArray<CommandDefinition<unknown>>;

export const civilPlugin: CadPlugin = {
  name: 'civil',
  toolset: 'civil',
  commands: civilCommands,
  guards: [civilDerivationGuard],
  document: civilDocument,
};
