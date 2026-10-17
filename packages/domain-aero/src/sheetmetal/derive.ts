/** Folded solids are derived from the part graph: omitted from saved files, re-derived on load, and read-only (architecture L8). */

import { DEFAULT_LAYER_ID, type CadDocument, type Entity } from '@core/model/types';
import type { SheetMetalModel, SheetMetalPart } from '@core/model/sheetMetal';
import type { DerivationGuard } from '@core/commands/derivation';
import type { DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { foldPart } from './fold';
import { sheetMetalErrors } from './validate';

const nativeParts = (model: SheetMetalModel | undefined): SheetMetalPart[] =>
  Object.values(model?.parts ?? {}).filter((part) => part.sourceEntity === undefined);

/** Folded solids (one mesh entity per native part, id = part id) regenerate from the part graph. */
export const sheetMetalDocument: DocumentExtension = {
  validate: (raw) => (raw['sheetMetal'] === undefined ? [] : sheetMetalErrors(raw['sheetMetal'])),
  derivedEntityIds: (doc) => new Set(nativeParts(doc.sheetMetal).map((part) => part.id)),
  restore: (raw) => {
    const saved = raw['sheetMetal'];
    if (saved === undefined || sheetMetalErrors(saved).length > 0 || !isRecord(raw['entities']) || !Array.isArray(raw['order'])) return raw;
    const model = saved as SheetMetalModel;
    const layers = isRecord(raw['layers']) ? raw['layers'] : {};
    const layerId = layers[DEFAULT_LAYER_ID] !== undefined ? DEFAULT_LAYER_ID : (Object.keys(layers)[0] ?? DEFAULT_LAYER_ID);
    const entities: Record<string, unknown> = { ...raw['entities'] };
    const order = [...(raw['order'] as string[])];
    try {
      for (const part of nativeParts(model)) {
        const rule = model.rules[part.rule];
        const folded = rule === undefined ? null : foldPart(part, rule);
        if (folded === null) continue;
        entities[part.id] = { ...folded, layerId };
        if (!order.includes(part.id)) order.push(part.id);
      }
    } catch {
      return raw;
    }
    return { ...raw, entities, order };
  },
};

const sameEntity = (a: Entity | undefined, b: Entity | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

/** Folded solids change only through sheet-metal commands (those replace `sheetMetal`). */
export const sheetMetalDerivationGuard: DerivationGuard = {
  domain: 'sheetmetal',
  check(previous: CadDocument, next: CadDocument) {
    if (next.sheetMetal !== previous.sheetMetal || next.entities === previous.entities) return null;
    const edited = nativeParts(previous.sheetMetal)
      .map((part) => part.id)
      .filter((id) => !sameEntity(previous.entities[id], next.entities[id]));
    if (edited.length === 0) return null;
    return (
      `it would edit the folded solid of sheet-metal part(s) ${edited.join(', ')}. ` +
      'Edit the part instead (add_flange, add_joggle, add_sheet_cutout, add_relief) — derived geometry is read-only.'
    );
  },
};
