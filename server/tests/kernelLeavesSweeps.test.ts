/** kernelLeaves / kernelSheets for sweeps and lofts (SWG): `sheetSolid` nodes with the capability, rings / pipe fallbacks without it. Pure: no sidecar needed. */
import { expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type LoftEntity, type SweepEntity } from '@core/model/types';
import type { SheetSolidRecipe } from '@core/model/sheetSolid';
import { validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { nativeLeaf } from '../src/native/kernelLeaves';
import { sheetSolidOf } from '../src/native/kernelSheets';

const native = (entity: SweepEntity, wire = {}): Record<string, unknown> =>
  (nativeLeaf(entity, wire) as unknown as { native: Record<string, unknown> }).native;

const sheet = (entity: SweepEntity | LoftEntity, wire: object): SheetSolidRecipe | null =>
  sheetSolidOf(entity, wire) as SheetSolidRecipe | null;

function sweep(params: Record<string, unknown>, doc = createEmptyDocument()): SweepEntity {
  const result = execute(doc, 'sweep_profile', params);
  expect(result.affected, result.summary).toHaveLength(1);
  return result.document.entities[result.affected[0] as string] as SweepEntity;
}

const bar = [
  [0, 0, 0],
  [0, 0, 50],
];
const square = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

it('a station sweep with an explicit blend becomes a sheetSolid node, and keeps its (blended) rings without the capability', () => {
  const tapered = sweep({
    path: bar,
    stations: [
      { at: 0, radius: 10 },
      { at: 1, radius: 5 },
    ],
    stationBlend: 'linear',
  });
  const node = sheet(tapered, { sheetSolid: true });
  expect(node?.op).toBe('sheetSolid');
  expect(node?.faces.length).toBeGreaterThan(0);
  expect(node?.caps).toBe(2);
  expect(sheet(tapered, {})).toBeNull();
  const rings = native(tapered)['rings'] as number[][];
  expect(rings.length).toBeGreaterThan(8);
});

it('laws and frame modes without the capability are refused (empty payload) rather than built as a plain pipe', () => {
  const twisted = sweep({ path: bar, section: square, twistTurns: 1 });
  expect(native(twisted)).toEqual({});
  expect(native(twisted, { sheetSolid: true })).toEqual({});
  const node = sheet(twisted, { sheetSolid: true });
  expect(node).not.toBeNull();
  expect(node?.position).toEqual(twisted.position);
  expect(node?.rotation).toEqual(twisted.rotation);
  expect(node?.name).toBe(twisted.id);
  expect(validateShapeRecipe(node)).toBeNull();
});

it('a bored helical tube falls back to the exact helix spine', () => {
  const helix = execute(createEmptyDocument(), 'add_helix', { radius: 20, pitch: 10, turns: 2 });
  const bored = sweep({ pathId: helix.affected[0], radius: 2, innerRadius: 1 }, helix.document);
  expect(sheet(bored, { sheetSolid: true, helixEdge: true })).toBeNull();
  const payload = native(bored, { sheetSolid: true, helixEdge: true });
  expect((payload['helix'] as number[]).length).toBe(15);
});

it('a bored round section with a law is a sheetSolid node with the faces of its bore and no pipe-shell attempt', () => {
  const bored = sweep({ path: bar, radius: 4, innerRadius: 2, scale: { type: 'linear', start: 1, end: 0.5 } });
  const node = sheet(bored, { sheetSolid: true, pipeShell: true });
  expect(node?.bore?.length).toBeGreaterThan(0);
  expect(node?.bore?.length).toBe(node?.faces.length);
  expect(node?.pipeShell).toBeUndefined();
  expect(validateShapeRecipe(node)).toBeNull();
});

it('a solid round section with a scale law carries a pipe-shell attempt only with its capability; a closed path has no caps', () => {
  const tapered = sweep({ path: bar, radius: 4, scale: { type: 'linear', start: 1, end: 0.5 } });
  expect(sheet(tapered, { sheetSolid: true })?.pipeShell).toBeUndefined();
  const shell = sheet(tapered, { sheetSolid: true, pipeShell: true })?.pipeShell;
  expect(shell?.circle).toMatchObject({ radius: 4 });
  expect(shell?.law?.length).toBe(66);
  expect(shell?.mode).toBe(0);
  const ring = sweep({
    path: [
      [30, 0, 0],
      [0, 30, 0],
      [-30, 0, 0],
      [0, -30, 0],
    ],
    closed: true,
    bendRadius: 20,
    radius: 2,
    scale: { type: 'constant', value: 1 },
  });
  expect(sheet(ring, { sheetSolid: true })?.caps).toBe(0);
});

it('a mitred sweep and a plain pipe are never sheetSolid nodes', () => {
  const mitred = sweep({
    path: [
      [0, 0, 0],
      [50, 0, 0],
      [50, 50, 0],
    ],
    corners: 'miter',
    radius: 3,
  });
  expect(sheet(mitred, { sheetSolid: true, pipeShell: true })).toBeNull();
  const pipe = sweep({ path: bar, radius: 3 });
  expect(sheet(pipe, { sheetSolid: true })).toBeNull();
});

it('a loft with exact faces is a sheetSolid node cut at its knots; a plain ring loft is not', () => {
  const at = (z: number): Record<string, unknown> => ({ section: square, center: [0, 0, z] });
  const advanced = execute(createEmptyDocument(), 'loft_sections', { sections: [at(0), at(50)], ruled: true, alignment: 'none' });
  const loft = advanced.document.entities[advanced.affected[0] as string] as LoftEntity;
  const node = sheet(loft, { sheetSolid: true });
  expect(node?.faces.length).toBeGreaterThanOrEqual(4);
  expect(node?.caps).toBe(loft.caps ?? 2);
  expect(sheet(loft, {})).toBeNull();
  expect(sheetSolidOf({ ...loft, faces: undefined } as unknown as LoftEntity, { sheetSolid: true })).toBeNull();
});
