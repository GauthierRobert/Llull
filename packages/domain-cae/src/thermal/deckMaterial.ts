/** `*CONDUCTIVITY` / `*SPECIFIC HEAT` / `*DENSITY` cards of one part's material. */

import { type DeckContext, type DeckSections } from '../decks/context';
import { commentText, linesText, num, row } from '../decks/format';
import type { ThermalSetup } from '@core/model/analysis';
import { caseTemperatureRange, propertiesNeeded, propertyTable, type PropertyTable, type ThermalProperty } from './material';

const HEAT_PROPERTY: Readonly<Record<ThermalProperty, { readonly keyword: string; readonly label: string }>> = {
  k: { keyword: '*CONDUCTIVITY', label: 'k' },
  cp: { keyword: '*SPECIFIC HEAT', label: 'cp' },
  density: { keyword: '*DENSITY', label: 'density' },
};

function cardLines(table: PropertyTable, scale: string): string[] {
  const { keyword, label } = HEAT_PROPERTY[table.property];
  const range = table.range === null ? 'constant' : `range=${num(table.range[0])}..${num(table.range[1])} ${scale} relTol=1e-3`;
  const origin = commentText(table.origin);
  const info = table.modelId === null ? origin : `${origin} coefficientsSha256=${commentText(table.coefficientsSha256 ?? '')}`;
  const header = `** ${label}: ${info} maxRelError=${num(table.maxRelError)} ${range}`;
  const notes =
    table.unverifiedReasons.length > 0 ? [`** ${label} unverified: ${commentText(table.unverifiedReasons.join('; '), 400)}`] : [];
  const data = table.constant !== null ? [row(table.constant)] : table.points.map(([temperature, value]) => row(value, temperature));
  return [header, ...notes, keyword, ...data];
}

export function propertyCards(ctx: DeckContext, thermal: ThermalSetup, entityId: string): DeckSections {
  const material = ctx.materialOf(entityId);
  const entity = Object.hasOwn(ctx.doc.entities, entityId) ? ctx.doc.entities[entityId] : undefined;
  const materialId = entity?.materialId ?? '';
  if (material === null) return { code: 'THM_MATERIAL_NO_K', message: `part '${entityId}' has no material`, ids: [entityId] };
  const required = caseTemperatureRange(thermal);
  const lines: string[] = [];
  for (const property of propertiesNeeded(ctx.analysis)) {
    const table = propertyTable({
      materialName: materialId,
      material,
      documentUnit: ctx.doc.units,
      property,
      scale: thermal.temperatureScale,
      unitSystem: ctx.unitSystem,
      required,
    });
    if ('code' in table) return { code: table.code, message: table.message, ids: [entityId, ...table.ids] };
    lines.push(...cardLines(table, thermal.temperatureScale));
  }
  return { text: linesText(lines) };
}
