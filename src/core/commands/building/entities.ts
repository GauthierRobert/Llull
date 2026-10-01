/**
 * Entity factory shared by the building evaluators: standard layers, material colours and the
 * common fields of every evaluated entity.
 * @layer core/commands/building
 * @pure
 */

import type { BoxEntity, Layer, MeshData, MeshSolidEntity, Vec3 } from '../../model/types';
import type { BimCategory, BuildingElement, MemberRole } from '../../model/building';

/** AIA / US National CAD Standard layer per category. */
export const CATEGORY_LAYER: Readonly<Record<BimCategory, { name: string; color: string }>> = {
  grid: { name: 'S-GRID', color: '#d04a4a' },
  wall: { name: 'A-WALL', color: '#8a8a8a' },
  door: { name: 'A-DOOR', color: '#8b5a2b' },
  window: { name: 'A-GLAZ', color: '#4a90c2' },
  slab: { name: 'S-SLAB', color: '#9a9a90' },
  column: { name: 'S-COLS', color: '#6d6d6d' },
  beam: { name: 'S-BEAM', color: '#7d8a96' },
  stair: { name: 'A-FLOR-STRS', color: '#a08060' },
  room: { name: 'A-AREA', color: '#3c8d5a' },
  member: { name: 'S-STEL', color: '#5b7a99' },
  footing: { name: 'S-FNDN', color: '#8f8a7e' },
  panel: { name: 'A-CLAD', color: '#7aa0b8' },
  equipment: { name: 'Q-EQPM', color: '#c27c2c' },
  pipe: { name: 'P-PIPE', color: '#2f9c8f' },
  tray: { name: 'E-TRAY', color: '#a07c2c' },
  plate: { name: 'S-CONN', color: '#5d6f80' },
};

/** Layer per steel member role (AIA structural sub-layers). */
export const MEMBER_LAYER: Readonly<Record<MemberRole, { name: string; color: string }>> = {
  column: { name: 'S-COLS', color: '#6d6d6d' },
  rafter: { name: 'S-BEAM', color: '#7d8a96' },
  beam: { name: 'S-BEAM', color: '#7d8a96' },
  brace: { name: 'S-BRAC', color: '#b5556a' },
  purlin: { name: 'S-JOIS', color: '#6f9d6a' },
  rail: { name: 'S-JOIS', color: '#6f9d6a' },
  crane: { name: 'S-CRAN', color: '#d39b2a' },
};

const LAYER_COLOR: ReadonlyMap<string, string> = new Map(
  [...Object.values(CATEGORY_LAYER), ...Object.values(MEMBER_LAYER)].map(({ name, color }) => [
    name,
    color,
  ]),
);

export function layerIdFor(category: BimCategory): string {
  return `layer-${CATEGORY_LAYER[category].name}`;
}

const MATERIAL_COLOR: Readonly<Record<string, string>> = {
  concrete: '#b4b2aa',
  masonry: '#b0623a',
  brick: '#b0623a',
  block: '#a7a39a',
  timber: '#c19a6b',
  wood: '#c19a6b',
  steel: '#7d8a96',
  s235: '#7d8a96',
  s275: '#7d8a96',
  s355: '#6e8296',
  galvanized: '#a9b4bd',
  glass: '#8ec9e8',
  gypsum: '#e6e2d8',
  drywall: '#e6e2d8',
  stone: '#9c968a',
  'steel-sheet': '#9fb3c4',
  'sandwich-panel': '#c9d3db',
};

export function colorForMaterial(material: string, fallback: string): string {
  return MATERIAL_COLOR[material.toLowerCase()] ?? fallback;
}

export interface EntityStub {
  readonly part: string;
  readonly label: string;
  /** Layer name override (default: the category layer). */
  readonly layer?: string;
}

export function base(
  element: BuildingElement,
  stub: EntityStub,
  position: Vec3,
  rotation: Vec3,
  color: string,
): {
  id: string;
  position: Vec3;
  rotation: Vec3;
  layerId: string;
  color: string;
  name: string;
  tags: string[];
} {
  return {
    id: `${element.id}:${stub.part}`,
    position,
    rotation,
    layerId: stub.layer !== undefined ? `layer-${stub.layer}` : layerIdFor(element.category),
    color,
    name: `${stub.label}`,
    tags: ['bim', element.category, `element:${element.id}`],
  };
}

export function orientedBox(
  element: BuildingElement,
  stub: EntityStub,
  center: Vec3,
  angle: number,
  size: Vec3,
  color: string,
): BoxEntity {
  return { ...base(element, stub, center, [0, 0, angle], color), kind: 'box', size };
}

/** A world-space mesh entity (position at the origin). */
export function meshEntity(
  element: BuildingElement,
  stub: EntityStub,
  mesh: MeshData,
  color: string,
): MeshSolidEntity {
  return { ...base(element, stub, [0, 0, 0], [0, 0, 0], color), kind: 'mesh', mesh };
}

/** Adds any layer referenced by `layerIds` that the document lacks (standard name + colour). */
export function ensureLayers(
  layers: Record<string, Layer>,
  layerOrder: string[],
  layerIds: Iterable<string>,
): { layers: Record<string, Layer>; layerOrder: string[] } {
  let nextLayers = layers;
  let nextOrder = layerOrder;
  for (const id of layerIds) {
    if (nextLayers[id]) continue;
    const name = id.replace(/^layer-/, '');
    const color = LAYER_COLOR.get(name) ?? '#8a8a8a';
    nextLayers = { ...nextLayers, [id]: { id, name, visible: true, locked: false, color } };
    nextOrder = [...nextOrder, id];
  }
  return { layers: nextLayers, layerOrder: nextOrder };
}
