// Where a review finding sits on the model (pure): its parts (entity ids, or the entities of a rigid body) and a point — the first
// witness point (mm) when the check recorded one, else the centre of the parts. Drives the row highlight and the findings overlay.

import type { CadDocument, Vec3 } from '@core/model/types';
import { boundsCenter, entityBoundsInDoc, mergeBounds, type Bounds } from '@core/geometry/bounds';
import { fromMm } from '@core/model/units';
import type { PanelFocus } from '@ui/store/focusStore';
import { STATUS_GLYPH } from './checklist';
import type { Finding } from './findings';
import type { CheckStatus } from './reviewTypes';
import { findingTitle } from './checklist';

export const SEVERITY_COLORS: Readonly<Record<CheckStatus, string>> = {
  fail: '#ff4d4f',
  warn: '#ffb300',
  not_run: '#9e9e9e',
  pass: '#3ddc84',
};

export interface FindingLocation {
  readonly findingKey: string;
  readonly code: string;
  readonly status: CheckStatus;
  readonly entityIds: readonly string[];
  readonly position: Vec3 | null;
}

function entitiesOf(doc: CadDocument, ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap((id) => (doc.entities[id] !== undefined ? [id] : (doc.dynamics?.bodies[id]?.entityIds ?? []))))].filter(
    (id) => doc.entities[id] !== undefined,
  );
}

export function findingLocation(doc: CadDocument, { item }: Finding): FindingLocation {
  const entityIds = entitiesOf(doc, item.ids);
  const witness = item.witness?.pointsMm[0];
  const bounds = entityIds.reduce<Bounds | null>((merged, id) => {
    const entity = doc.entities[id];
    if (entity === undefined) return merged;
    const next = entityBoundsInDoc(doc, entity);
    return merged === null ? next : mergeBounds(merged, next);
  }, null);
  const position: Vec3 | null =
    witness !== undefined
      ? [fromMm(doc, witness[0]), fromMm(doc, witness[1]), fromMm(doc, witness[2])]
      : bounds === null
        ? null
        : boundsCenter(bounds);
  return { findingKey: item.findingKey, code: item.code, status: item.status, entityIds, position };
}

export function findingFocus(doc: CadDocument, finding: Finding): PanelFocus {
  const location = findingLocation(doc, finding);
  const title = `${STATUS_GLYPH[location.status]} ${findingTitle(location.code)}`;
  const label = `${title} (${location.code})`;
  return {
    key: `review:finding:${location.findingKey}`,
    label,
    color: SEVERITY_COLORS[location.status],
    entityIds: [...location.entityIds],
    markers: location.position === null ? [] : [{ position: location.position, label: title }],
  };
}
