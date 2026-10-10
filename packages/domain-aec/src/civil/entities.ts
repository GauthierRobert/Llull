/**
 * Entity factory for evaluated civil objects: US National CAD Standard civil layers and the common
 * fields (`<objectId>:<part>` ids, `civil` + `civil:<id>` tags).
 * @layer domain-aec/civil
 * @pure
 */

import type {
  LineEntity,
  MeshData,
  MeshSolidEntity,
  PointEntity,
  PolylineEntity,
  TextEntity,
  Vec2,
  Vec3,
} from '@core/model/types';
import type { CivilObject } from '@core/model/civil';

/** Civil layer name -> colour (NCS discipline C). */
export const CIVIL_LAYERS = {
  points: { name: 'C-TOPO-PNTS', color: '#c8553d' },
  tin: { name: 'C-TOPO-TINN', color: '#8d9b6a' },
  minor: { name: 'C-TOPO-MINR', color: '#a88b63' },
  major: { name: 'C-TOPO-MAJR', color: '#7a5a32' },
  grading: { name: 'C-GRAD', color: '#b9a27a' },
  daylight: { name: 'C-GRAD-DAYL', color: '#d07a2c' },
  centreline: { name: 'C-ROAD-CNTR', color: '#d04a4a' },
  stations: { name: 'C-ROAD-STAN', color: '#5a5a5a' },
  corridor: { name: 'C-ROAD', color: '#6b6b6b' },
  structures: { name: 'C-STRM-STRC', color: '#2f6f9c' },
  pipes: { name: 'C-STRM-PIPE', color: '#2f9c8f' },
  annotation: { name: 'C-ANNO-TEXT', color: '#3a3a3a' },
} as const;

export type CivilLayerKey = keyof typeof CIVIL_LAYERS;

export const CIVIL_LAYER_COLOR: ReadonlyMap<string, string> = new Map(
  Object.values(CIVIL_LAYERS).map(({ name, color }) => [`layer-${name}`, color]),
);

interface Common {
  id: string;
  position: Vec3;
  rotation: Vec3;
  layerId: string;
  color: string;
  name: string;
  tags: string[];
}

function common(
  object: CivilObject,
  part: string,
  label: string,
  layer: CivilLayerKey,
  position: Vec3,
  color?: string,
): Common {
  const spec = CIVIL_LAYERS[layer];
  return {
    id: `${object.id}:${part}`,
    position,
    rotation: [0, 0, 0],
    layerId: `layer-${spec.name}`,
    color: color ?? spec.color,
    name: label,
    tags: ['civil', object.category, `civil:${object.id}`],
  };
}

/** World-space triangle mesh. */
export function civilMesh(
  object: CivilObject,
  part: string,
  label: string,
  layer: CivilLayerKey,
  mesh: MeshData,
  color?: string,
): MeshSolidEntity {
  return { ...common(object, part, label, layer, [0, 0, 0], color), kind: 'mesh', mesh };
}

/** Plan polyline lying in the horizontal plane z = `elevation`. */
export function civilPolyline(
  object: CivilObject,
  part: string,
  label: string,
  layer: CivilLayerKey,
  points: ReadonlyArray<Vec2>,
  closed: boolean,
  elevation = 0,
): PolylineEntity {
  return {
    ...common(object, part, label, layer, [0, 0, elevation]),
    kind: 'polyline',
    points: points.map((point): Vec2 => [point[0], point[1]]),
    closed,
  };
}

export function civilLine(
  object: CivilObject,
  part: string,
  label: string,
  layer: CivilLayerKey,
  start: Vec2,
  end: Vec2,
  elevation = 0,
): LineEntity {
  return { ...common(object, part, label, layer, [0, 0, elevation]), kind: 'line', start, end };
}

export function civilPoint(
  object: CivilObject,
  part: string,
  label: string,
  layer: CivilLayerKey,
  position: Vec3,
): PointEntity {
  return { ...common(object, part, label, layer, position), kind: 'point' };
}

export function civilText(
  object: CivilObject,
  part: string,
  content: string,
  layer: CivilLayerKey,
  position: Vec3,
  height: number,
  rotation = 0,
): TextEntity {
  const base = common(object, part, content, layer, position);
  return { ...base, rotation: [0, 0, rotation], kind: 'text', content, height, anchor: 'center' };
}
