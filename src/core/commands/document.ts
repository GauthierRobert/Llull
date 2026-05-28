/**
 * @command clear_document
 * @pure
 * @layer core/commands
 * @affects nothing — deletions are not surfaced as affected ids; affected:[]
 * @invariant Preserved: units, camera, displayPrecision.
 *            Cleared by default: entities, order, selection, groups, parameters,
 *            animations, featureHistory, configurations, materials, recipes, components.
 *            When keepLayers=true: layers and layerOrder are also preserved.
 *            When keepLayers=false (default): layers and layerOrder are reset to the
 *            single default layer matching createEmptyDocument().
 * @failure Already-empty document → no-op with idempotent summary, affected:[].
 */

import type { CadDocument } from '../model/types';
import { createEmptyDocument } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';

interface ClearDocumentParams {
  keepLayers?: boolean;
}

export const clearDocument: CommandDefinition<ClearDocumentParams> = {
  name: 'clear_document',
  description:
    'Reset the working document to an empty state, removing all entities, groups, ' +
    'animations, parameters, configurations, materials, recipes, and components. ' +
    'Preserves units, camera, and displayPrecision so view framing survives. ' +
    'Set keepLayers=true to also preserve layers and the active layer scheme; ' +
    'by default layers are reset to a single default "Layer 0".',
  annotations: { destructive: true },
  paramsSchema: {
    type: 'object',
    properties: {
      keepLayers: {
        type: 'boolean',
        description:
          'When true, the document layers and layerOrder are preserved unchanged. ' +
          'Useful for serial iterations that share a layer scheme. ' +
          'Default: false — layers are reset to a single default "Layer 0".',
      },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const keepLayers = (params as ClearDocumentParams).keepLayers === true;

    const entityCount = Object.keys(doc.entities).length;
    const layerCount = Object.keys(doc.layers).length;

    // Idempotent: if already empty (and layers are either being kept or already at default)
    // return the same doc reference with a descriptive summary.
    const fresh = createEmptyDocument();
    const isEntitiesEmpty = entityCount === 0;
    const isGroupsEmpty = Object.keys(doc.groups).length === 0;
    const isParamsEmpty = Object.keys(doc.parameters).length === 0;
    const isAnimsEmpty = Object.keys(doc.animations).length === 0;
    const isHistoryEmpty = doc.featureHistory.length === 0;
    const isConfigsEmpty = Object.keys(doc.configurations).length === 0;
    const isMaterialsEmpty = Object.keys(doc.materials).length === 0;
    const isRecipesEmpty = Object.keys(doc.recipes).length === 0;
    const isComponentsEmpty = Object.keys(doc.components).length === 0;
    const isLayersDefault =
      layerCount === 1 &&
      doc.layerOrder.length === 1 &&
      doc.layerOrder[0] === fresh.layerOrder[0];

    const isAlreadyEmpty =
      isEntitiesEmpty &&
      isGroupsEmpty &&
      isParamsEmpty &&
      isAnimsEmpty &&
      isHistoryEmpty &&
      isConfigsEmpty &&
      isMaterialsEmpty &&
      isRecipesEmpty &&
      isComponentsEmpty &&
      (keepLayers || isLayersDefault);

    if (isAlreadyEmpty) {
      return {
        document: doc,
        summary: 'Document is already empty.',
        affected: [],
      };
    }

    const nextDoc: CadDocument = {
      ...doc,
      entities: {},
      order: [],
      selection: [],
      groups: {},
      parameters: {},
      animations: {},
      featureHistory: [],
      configurations: {},
      materials: {},
      recipes: {},
      components: {},
      ...(keepLayers
        ? {}
        : {
            layers: fresh.layers,
            layerOrder: fresh.layerOrder,
          }),
    };

    const layerPart = keepLayers
      ? `kept ${layerCount} layer${layerCount === 1 ? '' : 's'}`
      : `reset to default layer`;

    return {
      document: nextDoc,
      summary: `Cleared ${entityCount} entit${entityCount === 1 ? 'y' : 'ies'} and ${layerCount} layer${layerCount === 1 ? '' : 's'}; ${layerPart}; kept units (${doc.units}) and camera.`,
      affected: [],
    };
  },
};
