/**
 * @affects nothing surfaced; affected:[]
 * @invariant exhaustive by construction: the result is `createEmptyDocument()` plus ONLY the keys in KEPT_KEYS (view and document settings), so a
 *   new document slice is cleared by default and never needs listing here
 * @invariant keeps units, camera, displayPrecision, kernelSettings (modeling tolerances) and nextStepNumber (step-scoped ids are never reused);
 *   resets layers to the default unless keepLayers
 * @invariant clears plm too: the PLM release lock deliberately exempts clear_document ("PLM data is removed only by load / clear"); the
 *   audit record of a document is not a setting
 * @failure already-empty document (every non-kept slice empty or absent) -> no-op, affected:[]
 */

import { type CadDocument, createEmptyDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { noop, report } from '../noop';

/** Keys carried over from the cleared document; everything else comes from `createEmptyDocument()`. */
const KEPT_KEYS = [
  'camera',
  'units',
  'displayPrecision',
  'kernelSettings',
  'nextStepNumber',
] as const satisfies readonly (keyof CadDocument)[];
const LAYER_KEYS = ['layers', 'layerOrder'] as const satisfies readonly (keyof CadDocument)[];
const NOT_COMPARED: ReadonlySet<string> = new Set<string>([...KEPT_KEYS, ...LAYER_KEYS]);

/** Whether `value` holds nothing beyond `blank` (its `createEmptyDocument()` counterpart): an absent slice, or an array / record of the blank's size. */
function isBlank(value: unknown, blank: unknown): boolean {
  if (value === undefined || value === blank) return true;
  if (blank === undefined || typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return Array.isArray(blank) && value.length === blank.length;
  return typeof blank === 'object' && blank !== null && Object.keys(value).length === Object.keys(blank).length;
}

function isAlreadyEmpty(doc: CadDocument, fresh: CadDocument, keepLayers: boolean): boolean {
  const current = doc as unknown as Record<string, unknown>;
  const blank = fresh as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(current), ...Object.keys(blank)]);
  const slicesEmpty = [...keys].every((key) => NOT_COMPARED.has(key) || isBlank(current[key], blank[key]));
  const layersDefault = doc.layerOrder.length === 1 && doc.layerOrder[0] === fresh.layerOrder[0] && Object.keys(doc.layers).length === 1;
  return slicesEmpty && (keepLayers || layersDefault);
}

export const clearDocument = defineCommand({
  name: 'clear_document',
  description:
    'Reset the working document to an empty state, removing all entities, groups, ' +
    'animations, parameters, configurations, materials, recipes, components, constraints, joints, drive relations and every domain slice ' +
    '(building, civil, analysis, aero, exchange, PLM record, ...). ' +
    'Preserves units, camera, displayPrecision and kernelSettings (modeling tolerances) so view framing and tolerances survive. ' +
    'Set keepLayers=true to also preserve layers and the active layer scheme; ' +
    'by default layers are reset to a single default "Layer 0".',
  annotations: { destructive: true },
  params: z.object({
    keepLayers: z
      .boolean()
      .optional()
      .describe(
        'When true, the document layers and layerOrder are preserved unchanged. ' +
          'Useful for serial iterations that share a layer scheme. Default: false — layers are reset to a single default "Layer 0".',
      ),
  }),
  run: (doc, params): CommandResult => {
    const keepLayers = params.keepLayers === true;
    const entityCount = Object.keys(doc.entities).length;
    const layerCount = Object.keys(doc.layers).length;
    const fresh = createEmptyDocument();
    if (isAlreadyEmpty(doc, fresh, keepLayers)) return noop(doc, 'Document is already empty.');
    const kept = Object.fromEntries(
      [...KEPT_KEYS, ...(keepLayers ? LAYER_KEYS : [])].flatMap((key) => (doc[key] === undefined ? [] : [[key, doc[key]]])),
    );
    const nextDoc: CadDocument = { ...fresh, ...kept };
    const layerPart = keepLayers ? `kept ${layerCount} layer${layerCount === 1 ? '' : 's'}` : `reset to default layer`;
    return report(
      nextDoc,
      `Cleared ${entityCount} entit${entityCount === 1 ? 'y' : 'ies'} and ${layerCount} layer${layerCount === 1 ? '' : 's'}; ${layerPart}; kept units (${doc.units}) and camera.`,
    );
  },
});
