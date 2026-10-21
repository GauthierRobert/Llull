// Pure builders of the model highlight for structural-check and clash rows: the member's parts are selected and a beacon sits on it.

import type { BuildingModel } from '@aec/building/types';
import type { CadDocument, Vec3 } from '@core/model/types';
import { boundsCenter, entityBoundsInDoc, mergeBounds, type Bounds } from '@core/geometry/bounds';
import type { PanelFocus } from '@ui/store/focusStore';
import { isFailing, type ReportRow } from './structuralReport';
import { utilisationColor } from './utilisationColor';

function boundsOf(doc: CadDocument, entityIds: readonly string[]): Bounds | null {
  return entityIds.reduce<Bounds | null>((merged, id) => {
    const entity = doc.entities[id];
    if (entity === undefined) return merged;
    const next = entityBoundsInDoc(doc, entity);
    return merged === null ? next : mergeBounds(merged, next);
  }, null);
}

const elementEntities = (building: BuildingModel | undefined, elementId: string): readonly string[] =>
  building?.elements[elementId]?.entityIds ?? [];

export function memberFocus(doc: CadDocument, row: ReportRow): PanelFocus {
  const entityIds = elementEntities(doc.building, row.elementId);
  const bounds = boundsOf(doc, entityIds);
  const value = row.detail !== '' ? row.detail : `UR ${row.utilisation.toFixed(2)}`;
  return {
    key: `building:member:${row.key}`,
    label: `${row.label} · ${value}`,
    color: utilisationColor(row.utilisation, !isFailing(row)),
    entityIds: [...entityIds],
    markers: bounds === null ? [] : [{ position: boundsCenter(bounds), label: value }],
  };
}

export function clashFocus(doc: CadDocument, key: string, label: string, depthText: string, a: string, b: string): PanelFocus {
  const entityIds = [...elementEntities(doc.building, a), ...elementEntities(doc.building, b)];
  const first = boundsOf(doc, elementEntities(doc.building, a));
  const second = boundsOf(doc, elementEntities(doc.building, b));
  const centres: Vec3[] = [first, second].flatMap((bounds) => (bounds === null ? [] : [boundsCenter(bounds)]));
  const [p, q] = centres;
  const position: Vec3 | undefined =
    p === undefined ? undefined : q === undefined ? p : [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
  return {
    key: `building:clash:${key}`,
    label,
    color: '#ff4d4f',
    entityIds,
    markers: position === undefined ? [] : [{ position, label: depthText }],
  };
}
