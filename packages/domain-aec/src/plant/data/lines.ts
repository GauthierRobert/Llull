/**
 * Process lines and their ends (plant 08 DAT §5.4, TR-DAT-08). A line object is an object of class `ProcessLine` or a subclass. Its `from` / `to` are
 * the properties of the object, else what the model object carries; an end resolves to a tag of the scope or of the model (or a nozzle `<tag>:<mark>`
 * of a tagged equipment), else to a named battery limit (`settings.batteryLimitPattern` or a tie-in point of kind battery_limit), else it is unresolved.
 */

import { elementsOf, getBuilding } from '@aec/building/model';
import type { CadDocument } from '@core/model/types';
import { isKindOf } from './classes';
import type { PlantDataModel, PlantObject } from './model';
import { allProviders, elementOf, foreignTagHolders } from './providers';
import { holdersOf, objectRegistry, objectScope } from './registry';

export const PROCESS_LINE_CLASS = 'ProcessLine';

export type EndStatus = 'resolved' | 'batteryLimit' | 'unresolved' | 'unset';

export const isProcessLine = (data: PlantDataModel, object: PlantObject): boolean => isKindOf(data, object.className, PROCESS_LINE_CLASS);

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

/** `from` / `to` of a line object: its own properties first, then the model object's fields. */
export function lineEnds(doc: CadDocument, object: PlantObject): { readonly from?: string; readonly to?: string } {
  const model = elementOf(doc, object.target);
  const fallback = model?.provider.ends?.(doc, model.element.id) ?? {};
  const from = text(object.properties['from']) ?? text(fallback.from);
  const to = text(object.properties['to']) ?? text(fallback.to);
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

function isBatteryLimit(doc: CadDocument, data: PlantDataModel, name: string): boolean {
  try {
    if (new RegExp(data.settings.batteryLimitPattern).test(name)) return true;
  } catch {
    // an invalid stored pattern declares no battery limit
  }
  return allProviders().some((provider) => provider.batteryLimits?.(doc).includes(name) ?? false);
}

const resolvesAsTag = (doc: CadDocument, data: PlantDataModel, line: PlantObject, name: string): boolean =>
  holdersOf(objectRegistry(data), objectScope(data, line), name).length > 0 || foreignTagHolders(doc, name).length > 0;

/** `<equipment tag>:<nozzle mark>` (03 EQP port id): the equipment resolves as a tag and carries a nozzle of that mark. */
function resolvesAsNozzle(doc: CadDocument, data: PlantDataModel, line: PlantObject, name: string): boolean {
  const split = /^(.+):([^:]+)$/.exec(name);
  if (split === null || !resolvesAsTag(doc, data, line, split[1] as string)) return false;
  return elementsOf(getBuilding(doc), 'equipment').some(
    (equipment) => equipment.mark === split[1] && (equipment.plant?.nozzles ?? []).some((nozzle) => nozzle.mark === split[2]),
  );
}

export function resolveEnd(doc: CadDocument, data: PlantDataModel, line: PlantObject, name: string | undefined): EndStatus {
  if (name === undefined) return 'unset';
  if (resolvesAsTag(doc, data, line, name) || resolvesAsNozzle(doc, data, line, name)) return 'resolved';
  return isBatteryLimit(doc, data, name) ? 'batteryLimit' : 'unresolved';
}
