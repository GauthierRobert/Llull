// Pure builder of the model highlight for a civil object row: its generated entities are selected and beacons mark its key places
// (alignment ends, manhole, pipe mid-point, the centre of a surface / platform / point group).

import type { CivilModel, CivilObject } from '@core/model/civil';
import type { CadDocument, Vec3 } from '@core/model/types';
import { boundsCenter, entityBoundsInDoc, mergeBounds, type Bounds } from '@core/geometry/bounds';
import type { FocusMarker, PanelFocus } from '@ui/store/focusStore';

const CIVIL_COLORS: Readonly<Record<CivilObject['category'], string>> = {
  pointGroup: '#ffd740',
  surface: '#8bc34a',
  platform: '#ff9100',
  alignment: '#40c4ff',
  manhole: '#e040fb',
  pipe: '#18ffff',
};

function entityCentre(doc: CadDocument, entityIds: readonly string[]): Vec3 | null {
  const bounds = entityIds.reduce<Bounds | null>((merged, id) => {
    const entity = doc.entities[id];
    if (entity === undefined) return merged;
    const next = entityBoundsInDoc(doc, entity);
    return merged === null ? next : mergeBounds(merged, next);
  }, null);
  return bounds === null ? null : boundsCenter(bounds);
}

function pipeMarkers(object: Extract<CivilObject, { category: 'pipe' }>, civil: CivilModel | undefined, label: string): FocusMarker[] {
  const from = civil?.objects[object.fromId];
  const to = civil?.objects[object.toId];
  if (from?.category !== 'manhole' || to?.category !== 'manhole') return [];
  return [
    {
      position: [
        (from.position[0] + to.position[0]) / 2,
        (from.position[1] + to.position[1]) / 2,
        (object.invertFrom + object.invertTo) / 2,
      ],
      label,
    },
  ];
}

function markersOf(doc: CadDocument, object: CivilObject, label: string): FocusMarker[] {
  switch (object.category) {
    case 'alignment': {
      const start = object.points[0];
      const end = object.points[object.points.length - 1];
      return [
        ...(start === undefined ? [] : [{ position: [start[0], start[1], 0] as Vec3, label: `${label} · start` }]),
        ...(end === undefined || end === start ? [] : [{ position: [end[0], end[1], 0] as Vec3, label: 'end' }]),
      ];
    }
    case 'manhole':
      return [{ position: [object.position[0], object.position[1], object.rimElevation], label }];
    case 'pipe':
      return pipeMarkers(object, doc.civil, label);
    default: {
      const centre = entityCentre(doc, object.entityIds);
      return centre === null ? [] : [{ position: centre, label }];
    }
  }
}

export function civilFocus(doc: CadDocument, object: CivilObject, detail?: string): PanelFocus {
  const label = detail !== undefined && detail !== '' ? `${object.name} · ${detail}` : object.name;
  return {
    key: `civil:${object.category}:${object.id}`,
    label,
    color: CIVIL_COLORS[object.category],
    entityIds: [...object.entityIds],
    markers: markersOf(doc, object, label),
  };
}
