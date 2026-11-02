/** Comparison of element definitions that ignores key order, evaluated entity ids and (optionally) the generation number. */

import type { BuildingElement } from '@aec/building/types';

/** JSON with object keys sorted, so two structurally equal values give the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** The definition of an element as text: everything but the entities generated from it (and the generation number when `ignoreGeneration`). */
export const definitionOf = (element: BuildingElement | undefined, ignoreGeneration: boolean): string =>
  canonical({ ...element, entityIds: [], ...(ignoreGeneration ? { generation: 0 } : {}) });
