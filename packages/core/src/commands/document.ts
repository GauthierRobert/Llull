/**
 * @command clear_document
 * @pure
 * @layer core/commands
 * @affects nothing surfaced; affected:[]
 * @invariant keeps units, camera, displayPrecision; resets layers to the default unless keepLayers
 * @failure already-empty document -> no-op, affected:[]
 */

import type { CadDocument } from '../model/types';
import { createEmptyDocument } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { noop } from './noop';

export const clearDocument = defineCommand({
  name: 'clear_document',
  description:
    'Reset the working document to an empty state, removing all entities, groups, ' +
    'animations, parameters, configurations, materials, recipes, components, constraints, joints, ' +
    'and drive relations. ' +
    'Preserves units, camera, and displayPrecision so view framing survives. ' +
    'Set keepLayers=true to also preserve layers and the active layer scheme; ' +
    'by default layers are reset to a single default "Layer 0".',
  annotations: { destructive: true },
  params: z.object({
    keepLayers: z
      .boolean()
      .optional()
      .describe(
        'When true, the document layers and layerOrder are preserved unchanged. ' +
          'Useful for serial iterations that share a layer scheme. ' +
          'Default: false — layers are reset to a single default "Layer 0".',
      ),
  }),
  run: (doc, params): CommandResult => {
    const keepLayers = params.keepLayers === true;

    const entityCount = Object.keys(doc.entities).length;
    const layerCount = Object.keys(doc.layers).length;

    const fresh = createEmptyDocument();
    const isLayersDefault =
      layerCount === 1 && doc.layerOrder.length === 1 && doc.layerOrder[0] === fresh.layerOrder[0];
    const isAlreadyEmpty =
      [
        doc.entities,
        doc.groups,
        doc.parameters,
        doc.animations,
        doc.configurations,
        doc.materials,
        doc.recipes,
        doc.components,
        doc.constraints,
        doc.joints,
        doc.driveRelations,
      ].every((table) => Object.keys(table).length === 0) &&
      doc.featureHistory.length === 0 &&
      doc.building === undefined &&
      (keepLayers || isLayersDefault);

    if (isAlreadyEmpty) {
      return noop(doc, 'Document is already empty.');
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
      constraints: {},
      constraintOrder: [],
      joints: {},
      jointOrder: [],
      driveRelations: {},
      driveRelationOrder: [],
      ...(keepLayers
        ? {}
        : {
            layers: fresh.layers,
            layerOrder: fresh.layerOrder,
          }),
    };
    delete nextDoc.building;

    const layerPart = keepLayers
      ? `kept ${layerCount} layer${layerCount === 1 ? '' : 's'}`
      : `reset to default layer`;

    return {
      document: nextDoc,
      summary: `Cleared ${entityCount} entit${entityCount === 1 ? 'y' : 'ies'} and ${layerCount} layer${layerCount === 1 ? '' : 's'}; ${layerPart}; kept units (${doc.units}) and camera.`,
      affected: [],
    };
  },
});
