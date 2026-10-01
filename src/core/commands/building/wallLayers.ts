/**
 * Wall build-ups (layered wall types): structure, insulation, membranes, finishes.
 * @layer core/commands/building
 */

import type { WallElement, WallLayer, WallLayerFunction } from '../../model/building';
import type { CommandDefinition, CommandResult } from '../types';
import { elementAffected, getBuilding, isFiniteNumber, noChange, withElement } from './model';
import { regenerateBuilding } from './evaluate';

export const WALL_LAYER_FUNCTIONS: ReadonlyArray<WallLayerFunction> = [
  'structure',
  'insulation',
  'membrane',
  'air',
  'finish',
];

/** @failure malformed layer list -> reason string */
export function parseWallLayers(value: unknown): WallLayer[] | string {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    return 'layers must be a list of 1–10 { material, thickness, function }';
  }
  const layers: WallLayer[] = [];
  for (const raw of value as unknown[]) {
    const layer = raw as Partial<Record<keyof WallLayer, unknown>>;
    const fn = layer.function ?? 'structure';
    if (
      typeof layer.material !== 'string' ||
      layer.material.trim() === '' ||
      !(isFiniteNumber(layer.thickness) && layer.thickness > 0) ||
      !WALL_LAYER_FUNCTIONS.includes(fn as WallLayerFunction)
    ) {
      return `each layer needs a material, a thickness > 0 and a function (${WALL_LAYER_FUNCTIONS.join(', ')})`;
    }
    layers.push({
      material: layer.material.trim(),
      thickness: layer.thickness,
      function: fn as WallLayerFunction,
    });
  }
  return layers;
}

/** Structural material of a build-up: the first structure layer, else the thickest layer. */
export function structuralMaterial(layers: ReadonlyArray<WallLayer>): string {
  const structure = layers.find((layer) => layer.function === 'structure');
  const thickest = [...layers].sort((a, b) => b.thickness - a.thickness)[0];
  return (structure ?? thickest)?.material ?? 'concrete';
}

/** Offsets across the wall (from its centreline, +left) of the boundaries between layers. */
export function layerBoundaries(wall: WallElement): number[] {
  const layers = wall.layers ?? [];
  const offsets: number[] = [];
  let across = -wall.thickness / 2;
  layers.slice(0, -1).forEach((layer) => {
    across += layer.thickness;
    offsets.push(across);
  });
  return offsets;
}

interface SetWallLayersParams {
  wallIds: string[];
  layers: WallLayer[] | null;
}

/**
 * @command set_wall_layers
 * @pure
 * @affects the walls' build-up, thickness and structural material
 * @failure unknown wall / malformed layers -> no-op
 */
export const setWallLayers: CommandDefinition<SetWallLayersParams> = {
  name: 'set_wall_layers',
  description:
    'Give walls a build-up (wall type), like Revit / ArchiCAD composite walls: layers listed from the ' +
    'right-hand face (looking from start to end — the exterior of a counter-clockwise perimeter) to the ' +
    'left-hand face, each { material, thickness, function: structure | insulation | membrane | air | ' +
    'finish }. Wall thickness becomes the sum; quantities are reported per layer material; plans show ' +
    'the layer lines; IFC gets a material layer set. layers: null removes the build-up.',
  paramsSchema: {
    type: 'object',
    properties: {
      wallIds: { type: 'array', items: { type: 'string' }, description: 'Wall ids.' },
      layers: {
        type: 'array',
        description:
          'Build-up, e.g. [{material:"brick",thickness:100,function:"finish"}, …], or null.',
        items: {
          type: 'object',
          properties: {
            material: { type: 'string', description: 'Layer material.' },
            thickness: { type: 'number', description: 'Layer thickness (> 0).' },
            function: {
              type: 'string',
              enum: [...WALL_LAYER_FUNCTIONS],
              description: 'Default structure.',
            },
          },
          required: ['material', 'thickness'],
        },
      },
    },
    required: ['wallIds', 'layers'],
  },
  run: (doc, { wallIds, layers }): CommandResult => {
    const building = getBuilding(doc);
    const walls = (Array.isArray(wallIds) ? wallIds : [])
      .map((id) => building.elements[id])
      .filter((element): element is WallElement => element?.category === 'wall');
    if (walls.length === 0 || walls.length !== (wallIds as unknown[]).length) {
      return noChange(doc, 'set_wall_layers failed: wallIds must list existing walls.');
    }
    if (layers === null) {
      let next = building;
      for (const wall of walls) {
        const bare: WallElement = { ...wall };
        delete bare.layers;
        next = withElement(next, bare);
      }
      const document = regenerateBuilding(doc, next);
      return {
        document,
        summary: `Removed the build-up of ${walls.map((wall) => wall.mark).join(', ')}.`,
        affected: elementAffected(
          document,
          walls.map((wall) => wall.id),
        ),
      };
    }
    const parsed = parseWallLayers(layers);
    if (typeof parsed === 'string') return noChange(doc, `set_wall_layers failed: ${parsed}.`);
    const thickness = parsed.reduce((sum, layer) => sum + layer.thickness, 0);
    const material = structuralMaterial(parsed);
    let next = building;
    for (const wall of walls)
      next = withElement(next, { ...wall, layers: parsed, thickness, material });
    const document = regenerateBuilding(doc, next);
    return {
      document,
      summary:
        `Set a ${parsed.length}-layer build-up (${thickness} total: ` +
        `${parsed.map((layer) => `${layer.thickness} ${layer.material}`).join(' + ')}) on ` +
        `${walls.map((wall) => wall.mark).join(', ')}.`,
      affected: elementAffected(
        document,
        walls.map((wall) => wall.id),
      ),
    };
  },
};
