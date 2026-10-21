// Pure builder of the model highlight for a civil object row: its generated entities are selected and beacons mark its key places
// (alignment ends, manhole, pipe mid-point, every survey point of a group with its elevation, the high / low point of a surface, the
// centre of a platform).

import type { CivilModel, CivilObject } from '@aec/civil/types';
import type { CadDocument, Vec3 } from '@core/model/types';
import { toMetres } from '@core/model/units';
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

/** Beyond this many points a group is marked by its centre (one beacon per point would hide the model). */
const MAX_POINT_BEACONS = 40;

/** Levels read in metres whatever the document unit (civil convention). */
const elevationText = (doc: CadDocument, z: number): string => `${Number(toMetres(doc, z).toFixed(2))} m`;

function pointGroupMarkers(doc: CadDocument, object: Extract<CivilObject, { category: 'pointGroup' }>): FocusMarker[] {
  if (object.points.length === 0 || object.points.length > MAX_POINT_BEACONS) return [];
  return object.points.map((point) => ({ position: point.position, label: `${point.number} · ${elevationText(doc, point.position[2])}` }));
}

/** The highest and lowest survey point the surface is built from. */
function surfaceMarkers(doc: CadDocument, object: Extract<CivilObject, { category: 'surface' }>): FocusMarker[] {
  const points = [
    ...object.pointGroupIds.flatMap((id) => {
      const group = doc.civil?.objects[id];
      return group?.category === 'pointGroup' ? group.points.map((point) => point.position) : [];
    }),
    ...object.extraPoints,
  ];
  if (points.length === 0) return [];
  const high = points.reduce((best, point) => (point[2] > best[2] ? point : best));
  const low = points.reduce((best, point) => (point[2] < best[2] ? point : best));
  return [
    { position: high, label: `high ${elevationText(doc, high[2])}` },
    ...(low === high ? [] : [{ position: low, label: `low ${elevationText(doc, low[2])}` }]),
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
    case 'pointGroup': {
      const points = pointGroupMarkers(doc, object);
      if (points.length > 0) return points;
      const centre = entityCentre(doc, object.entityIds);
      return centre === null ? [] : [{ position: centre, label }];
    }
    case 'surface': {
      const extremes = surfaceMarkers(doc, object);
      if (extremes.length > 0) return extremes;
      const centre = entityCentre(doc, object.entityIds);
      return centre === null ? [] : [{ position: centre, label }];
    }
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
