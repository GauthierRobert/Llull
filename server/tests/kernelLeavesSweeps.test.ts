/** kernelLeaves for sweeps (SWG): fitted faces with the capability, rings / pipe fallbacks without it. Pure: no sidecar needed. */
import { expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type SweepEntity } from '@core/model/types';
import { nativeLeaf } from '../src/native/kernelLeaves';

const native = (entity: SweepEntity, wire = {}): Record<string, unknown> =>
  (nativeLeaf(entity, wire) as unknown as { native: Record<string, unknown> }).native;

function sweep(params: Record<string, unknown>, doc = createEmptyDocument()): SweepEntity {
  const result = execute(doc, 'sweep_profile', params);
  return result.document.entities[result.affected[0] as string] as SweepEntity;
}

const bar = [
  [0, 0, 0],
  [0, 0, 50],
];

it('a station sweep with an explicit blend keeps its (blended) rings when fitted faces are unavailable', () => {
  const tapered = sweep({
    path: bar,
    stations: [
      { at: 0, radius: 10 },
      { at: 1, radius: 5 },
    ],
    stationBlend: 'linear',
  });
  expect(native(tapered, { sheetSolid: true })['faces']).toBeDefined();
  const rings = native(tapered)['rings'] as number[][];
  expect(rings.length).toBeGreaterThan(8);
});

it('laws and frame modes without the capability are refused (empty payload) rather than built as a plain pipe', () => {
  const twisted = sweep({
    path: bar,
    section: [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ],
    twistTurns: 1,
  });
  expect(native(twisted)).toEqual({});
  expect(native(twisted, { sheetSolid: true })['faces']).toBeDefined();
});

it('a bored helical tube falls back to the exact helix spine', () => {
  const helix = execute(createEmptyDocument(), 'add_helix', { radius: 20, pitch: 10, turns: 2 });
  const bored = sweep({ pathId: helix.affected[0], radius: 2, innerRadius: 1 }, helix.document);
  const payload = native(bored, { sheetSolid: true, helixEdge: true });
  expect(payload['faces']).toBeUndefined();
  expect((payload['helix'] as number[]).length).toBe(15);
});
