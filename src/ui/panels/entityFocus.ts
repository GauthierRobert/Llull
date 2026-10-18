// Builds the PanelFocus of a set of entities: they are selected by the focus mechanism and a beacon sits at the centre of their
// combined bounds with the overall size as its value pill.

import type { CadDocument, EntityId } from '@core/model/types';
import { boundsCenter, entityBoundsInDoc, mergeBounds, type Bounds } from '@core/geometry/bounds';
import { significantNumber } from '@lib/compactNumber';
import type { PanelFocus } from '@ui/store/focusStore';

export const DEFAULT_FOCUS_COLOR = '#5b9cff';

interface EntitiesFocusSpec {
  key: string;
  label: string;
  color?: string | null | undefined;
  ids: readonly EntityId[];
  /** Replaces the size pill (e.g. "7850 kg/m³"). */
  note?: string;
}

function combinedBounds(doc: CadDocument, ids: readonly EntityId[]): Bounds | null {
  let combined: Bounds | null = null;
  for (const id of ids) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (entity === undefined) continue;
    const bounds = entityBoundsInDoc(doc, entity);
    combined = combined === null ? bounds : mergeBounds(combined, bounds);
  }
  return combined;
}

/** "120 × 40 × 10 mm" (a flat 2D extent drops the zero axis). */
export function sizeLabel(bounds: Bounds, units: string): string {
  const spans = [0, 1, 2].map((axis) => (bounds.max[axis] ?? 0) - (bounds.min[axis] ?? 0));
  const shown = spans.filter((span) => span > 1e-9);
  if (shown.length === 0) return '';
  return `${shown.map((span) => significantNumber(span, 4)).join(' × ')} ${units}`;
}

export function entitiesFocus(doc: CadDocument, spec: EntitiesFocusSpec): PanelFocus {
  const ids = spec.ids.filter((id) => Object.hasOwn(doc.entities, id));
  const bounds = combinedBounds(doc, ids);
  const pill = spec.note ?? (bounds === null ? '' : sizeLabel(bounds, doc.units));
  return {
    key: spec.key,
    label: spec.label,
    color: spec.color ?? DEFAULT_FOCUS_COLOR,
    entityIds: ids,
    markers: bounds === null ? [] : [{ position: boundsCenter(bounds), ...(pill === '' ? {} : { label: pill }) }],
  };
}
