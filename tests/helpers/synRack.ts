import { createEmptyDocument, DEFAULT_LAYER_ID, type CadDocument, type Entity, type Vec3 } from '@core/model/types';

/** SYN-RACK-v1 (docs/plant/09-plant-visualization-review/validation/data/synthetic_pipe_rack_benchmark.json): component count N(n). */
export const synRackCount = (bays: number): number => 227 * bays + 8 * Math.floor(bays / 4);

/** Bay counts of the four benchmark sizes: smoke, S, M, L. */
export const SYN_RACK_BAYS = [8, 44, 437, 4367] as const;

const AXIS_X: Vec3 = [0, Math.PI / 2, 0];
const BAY_PITCH = 6000;

interface Dn {
  readonly pipeRadius: number;
  readonly pipeZ: number;
  readonly flangeRadius: number;
  readonly flangeHeight: number;
  readonly flangeX: readonly [number, number];
  readonly studRadius: number;
  readonly studHeight: number;
  readonly boltCircle: number;
  readonly nutRadius: number;
  readonly nutHeight: number;
  readonly nutX: readonly [number, number];
  readonly valve: Vec3;
}

const DN100: Dn = {
  pipeRadius: 57.15,
  pipeZ: 6411.15,
  flangeRadius: 115,
  flangeHeight: 24,
  flangeX: [288, 312],
  studRadius: 8,
  studHeight: 90,
  boltCircle: 90,
  nutRadius: 13.85,
  nutHeight: 13,
  nutX: [269.5, 330.5],
  valve: [300, 230, 230],
};
const DN200: Dn = {
  pipeRadius: 109.55,
  pipeZ: 6463.55,
  flangeRadius: 172.5,
  flangeHeight: 30,
  flangeX: [285, 315],
  studRadius: 10,
  studHeight: 110,
  boltCircle: 140,
  nutRadius: 17.3,
  nutHeight: 16,
  nutX: [262, 338],
  valve: [420, 345, 345],
};

/**
 * The SYN-RACK-v1 pipe rack with `bays` bays as a document built directly (no commands: it holds up to 10^6 entities).
 * Each prototype carries its material class as `materialId`; `colourOf(pipeIndex)` sets the per-instance colour (a service colour).
 * @invariant order = creation order; ids `e<k>`; entity count = synRackCount(bays)
 */
export function synRackDocument(bays: number, colourOf: (pipeIndex: number) => string = () => '#c8553d'): CadDocument {
  const base = createEmptyDocument();
  const entities: Record<string, Entity> = {};
  const order: string[] = [];
  let next = 0;
  const common = (
    position: Vec3,
    rotation: Vec3,
    materialId: string,
    color: string,
  ): Pick<Entity, 'id' | 'position' | 'rotation' | 'layerId' | 'color' | 'materialId'> => {
    const id = `e${next++}`;
    order.push(id);
    return { id, position, rotation, layerId: DEFAULT_LAYER_ID, color, materialId };
  };
  const add = (entity: Entity): void => {
    entities[entity.id] = entity;
  };
  const box = (size: Vec3, position: Vec3, materialId: string, color = '#808080'): void =>
    add({ ...common(position, [0, 0, 0], materialId, color), kind: 'box', size });
  const cylinder = (radius: number, height: number, position: Vec3, materialId: string, color = '#808080'): void =>
    add({ ...common(position, AXIS_X, materialId, color), kind: 'cylinder', radius, height });
  for (let bay = 0; bay < bays; bay++) {
    const x = BAY_PITCH * bay;
    box([254, 254, 6000], [x, -3000, 3000], 'structural_steel');
    box([254, 254, 6000], [x, 3000, 3000], 'structural_steel');
    box([254, 6000, 254], [x, 0, 6127], 'structural_steel');
    for (let pipe = 0; pipe < 8; pipe++) {
      const dn = pipe < 4 ? DN100 : DN200;
      const y = -2100 + 600 * pipe;
      cylinder(dn.pipeRadius, 6000, [x + 3000, y, dn.pipeZ], 'carbon_steel_pipe', colourOf(pipe));
      box([300, 150, 100], [x, y, 6304], 'structural_steel');
      for (const flangeX of dn.flangeX) cylinder(dn.flangeRadius, dn.flangeHeight, [x + flangeX, y, dn.pipeZ], 'carbon_steel_pipe');
      for (let stud = 0; stud < 8; stud++) {
        const angle = (2 * Math.PI * stud) / 8;
        const cy = y + dn.boltCircle * Math.cos(angle);
        const cz = dn.pipeZ + dn.boltCircle * Math.sin(angle);
        cylinder(dn.studRadius, dn.studHeight, [x + 300, cy, cz], 'alloy_bolting');
        for (const nutX of dn.nutX) cylinder(dn.nutRadius, dn.nutHeight, [x + nutX, cy, cz], 'alloy_bolting');
      }
    }
    if (bay % 4 === 3)
      for (let pipe = 0; pipe < 8; pipe++)
        box(pipe < 4 ? DN100.valve : DN200.valve, [x + 4500, -2100 + 600 * pipe, pipe < 4 ? DN100.pipeZ : DN200.pipeZ], 'cast_steel_valve');
  }
  return { ...base, entities, order };
}
