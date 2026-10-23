/** Display geometry of derived parts (02 RTE §5.11): revolution entities placed exactly on the part ports. */

import { describe, expect, it } from 'vitest';
import type { RevolutionEntity, Vec3 } from '@core/model/types';
import { applyEulerXYZ } from '@lib/eulerRotation';
import type { CadDocument } from '@core/model/types';
import { data } from '../../../helpers/commandAssertions';
import { partEntity } from '@aec/plant/piping/geometry';
import { deriveRun } from '@aec/plant/piping/routeParts';
import type { PipeLine, RoutedPart } from '@aec/plant/types';
import { routedPumpToVessel } from './rteFixtures';

const world = (entity: RevolutionEntity, local: Vec3): Vec3 => {
  const rotated = applyEulerXYZ(local, [0, 0, 0], entity.rotation);
  return [rotated[0] + entity.position[0], rotated[1] + entity.position[1], rotated[2] + entity.position[2]];
};
const near = (actual: readonly number[], expected: readonly number[], digits = 6): void =>
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, digits));

function parts(): { doc: CadDocument; parts: readonly RoutedPart[]; line: PipeLine; entities: Map<string, RevolutionEntity> } {
  const { doc, runId } = routedPumpToVessel();
  const derived = deriveRun(doc, doc.plant?.piping?.runs[runId] as never);
  if (!derived.ok) throw new Error(derived.message);
  const line = Object.values(doc.plant?.piping?.lines ?? {})[0] as PipeLine;
  const entities = new Map<string, RevolutionEntity>();
  for (const id of doc.plant?.piping?.entityIds[runId] ?? []) entities.set(id, doc.entities[id] as RevolutionEntity);
  return { doc, parts: derived.parts, line, entities };
}

describe('part display entities (SC-RTE-01)', () => {
  it('creates one revolution per drawable part, none for the bolt sets, on the layers P-PIPE / P-FITT / P-FLNG', () => {
    const { parts: all, entities } = parts();
    expect([...entities.keys()]).toEqual(all.filter((part) => part.kind !== 'boltSet').map((part) => part.id));
    const layers = new Map([...entities.values()].map((entity) => [entity.id.split('/')[1]?.replace(/-\d+$/, ''), entity.layerId]));
    expect(layers.get('pipe')).toBe('layer-P-PIPE');
    expect(layers.get('elbow')).toBe('layer-P-FITT');
    expect(layers.get('flange')).toBe('layer-P-FLNG');
    expect(layers.get('gasket')).toBe('layer-P-FLNG');
    for (const entity of entities.values()) expect(entity.kind).toBe('revolution');
  });

  it('places the pipe cylinder from its first port to its second (length = cut length, OD 114.3)', () => {
    const { entities, parts: all } = parts();
    const piece = all.find((part) => part.id.endsWith('/pipe-1')) as RoutedPart;
    const entity = entities.get(piece.id) as RevolutionEntity;
    near(entity.position, [0, 0, 1079]);
    near(world(entity, [0, 0, 1269]), [0, 0, 2348]);
    expect(entity.profile[1]?.[0]).toBeCloseTo(57.15, 9);
    expect(entity.profile[2]?.[1]).toBeCloseTo(1269, 9);
  });

  it('sweeps the elbow section from the first port to the second, tangent to both legs (arc radius 152)', () => {
    const { entities, parts: all } = parts();
    const elbow = all.find((part) => part.id.endsWith('/elbow-1')) as RoutedPart;
    const entity = entities.get(elbow.id) as RevolutionEntity;
    const radius = elbow.radius as number;
    expect(radius).toBeCloseTo(152, 9);
    expect(entity.angle).toBeCloseTo(Math.PI / 2, 12);
    // Section centre at the start of the sweep = first port (0,0,2348); at the end = second port (0,152,2500).
    near(world(entity, [radius, 0, 0]), [0, 0, 2348]);
    near(world(entity, [radius * Math.cos(entity.angle), radius * Math.sin(entity.angle), 0]), [0, 152, 2500]);
    // Axis of the bend = normal of the plane of the two legs (+Z then +Y): the X axis.
    near(
      world(entity, [0, 0, 1]).map((v, i) => v - entity.position[i]!),
      [-1, 0, 0],
    );
    expect(entity.segments).toBe(24);
  });

  it('gives the elbow the volume of a torus segment within the 16-gon section (VC-RTE-23: ratio 0.9745)', () => {
    const { doc, parts: all } = parts();
    const elbow = all.find((part) => part.id.endsWith('/elbow-1')) as RoutedPart;
    const volume = data<{ volume: number }>(doc, 'mass_properties', { entityId: elbow.id }).volume;
    const pappus = Math.PI * 57.15 ** 2 * 152 * (Math.PI / 2);
    expect(pappus).toBeCloseTo(2449885.6, -1);
    expect(volume / pappus).toBeGreaterThan(0.97);
    expect(volume / pappus).toBeLessThan(1.001);
  });

  it('places the flange hub from the face (z 1003) to the weld end (z 1079) and the gasket 3 mm thick on the nozzle face', () => {
    const { entities, parts: all } = parts();
    const flange = entities.get(all.find((part) => part.id.endsWith('/flange-1'))?.id as string) as RevolutionEntity;
    near(flange.position, [0, 0, 1003]);
    near(world(flange, [0, 0, 76]), [0, 0, 1079]);
    const outer = Math.max(...flange.profile.map(([r]) => r));
    expect(outer).toBeCloseTo(114.3, 9);
    const gasket = entities.get(all.find((part) => part.id.endsWith('/gasket-1'))?.id as string) as RevolutionEntity;
    near(gasket.position, [0, 0, 1000]);
    expect(gasket.profile[2]?.[1]).toBeCloseTo(3, 9);
  });

  it('places the vessel-side flange stack on the nozzle face, pointing into the pipe (-X)', () => {
    const { entities, parts: all } = parts();
    const flange = entities.get(all.find((part) => part.id.endsWith('/flange-2'))?.id as string) as RevolutionEntity;
    near(flange.position, [5997, 3000, 4000]);
    near(world(flange, [0, 0, 76]), [5921, 3000, 4000]);
  });

  it('returns null for parts without geometry', () => {
    const { parts: all, line } = parts();
    const bolts = all.find((part) => part.kind === 'boltSet') as RoutedPart;
    expect(partEntity(bolts, line)).toBeNull();
    expect(partEntity({ ...(all.find((part) => part.kind === 'pipe') as RoutedPart), ports: [] }, line)).toBeNull();
    const { radius, ...unbent } = all.find((part) => part.kind === 'elbow') as RoutedPart;
    expect(radius).toBeGreaterThan(0);
    expect(partEntity(unbent, line)).toBeNull();
    expect(partEntity({ ...(all.find((part) => part.kind === 'flange') as RoutedPart), ports: [] }, line)).toBeNull();
    expect(partEntity({ ...(all.find((part) => part.kind === 'gasket') as RoutedPart), ports: [] }, line)).toBeNull();
  });
});
