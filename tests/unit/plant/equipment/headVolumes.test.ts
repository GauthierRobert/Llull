import { describe, expect, it } from 'vitest';
import jones from '../../../../docs/plant/03-parametric-equipment/validation/data/tank_head_volumes_jones.json';
import { resolveHead, type HeadShape } from '@aec/plant/equipment/geometry/heads';
import { horizontalVolume, verticalVolume } from '@aec/plant/equipment/geometry/partialVolume';

/** Jones rows are in inches and US gallons (1 gal = 231 in3); everything here runs in metres. */
const IN = 0.0254;
const GALLON_M3 = 231 * IN ** 3;

interface JonesCase {
  id: string;
  D: number;
  a?: number;
  f?: number;
  k?: number;
  L?: number;
  h: number;
  V_gal: number;
}

function shapeOf(row: JonesCase): HeadShape {
  const radius = (row.D * IN) / 2;
  if (row.id.includes('E-')) return { kind: 'ellipsoidal', depth: (row.a ?? 0) * IN };
  if (row.id.startsWith('J-VS')) return { kind: 'spherical', depth: (row.a ?? 0) * IN };
  if (row.id.includes('C-')) return { kind: 'conical', depth: (row.a ?? 0) * IN };
  const head = resolveHead(
    { type: 'torispherical', crownRadius: (row.f ?? 0) * row.D * IN, knuckleRadius: (row.k ?? 0) * row.D * IN },
    radius,
    'h',
  );
  if ('error' in head) throw new Error(head.error);
  return head.shape;
}

const rows = jones.cases as JonesCase[];

describe('VC-EQP-01 vertical partial volumes (Jones, bottom head only)', () => {
  for (const row of rows.filter((r) => r.id.startsWith('J-V'))) {
    it(`${row.id} h=${row.h}`, () => {
      const radius = (row.D * IN) / 2;
      const bottom = shapeOf(row);
      const volume = verticalVolume(radius, 100, bottom, { kind: 'flat', depth: 0 }, row.h * IN);
      expect(Math.abs(volume / GALLON_M3 / row.V_gal - 1)).toBeLessThan(1e-9);
    });
  }

  it('is continuous across the head / cylinder / top-head boundaries', () => {
    const radius = 0.75;
    const head: HeadShape = { kind: 'ellipsoidal', depth: 0.375 };
    const at = (h: number): number => verticalVolume(radius, 2, head, head, h);
    const step = 1e-9;
    for (const boundary of [0.375, 2.375]) expect(Math.abs(at(boundary + step) - at(boundary - step))).toBeLessThan(1e-8);
    expect(at(2.75)).toBeCloseTo(Math.PI * radius * radius * 2 + 2 * ((Math.PI * 1.5 ** 2 * 0.375) / 6), 12);
  });
});

describe('VC-EQP-02 horizontal partial volumes (Jones, two identical heads)', () => {
  for (const row of rows.filter((r) => r.id.startsWith('J-H'))) {
    const torispherical = row.id.startsWith('J-HT');
    const partial = row.h < row.D;
    it(`${row.id} h=${row.h}${torispherical && partial ? ' (V1: no closed form, refused)' : ''}`, () => {
      const radius = (row.D * IN) / 2;
      const head = shapeOf(row);
      const volume = horizontalVolume(radius, (row.L ?? 0) * IN, head, head, row.h * IN);
      if (torispherical && partial) {
        expect(volume).toBeNull();
        return;
      }
      expect(volume).not.toBeNull();
      expect(Math.abs((volume ?? 0) / GALLON_M3 / row.V_gal - 1)).toBeLessThan(1e-9);
    });
  }

  it('hemispherical heads reuse the ellipsoidal form; a non-hemispherical spherical cap has no horizontal closed form', () => {
    const hemi = resolveHead({ type: 'hemispherical' }, 1, 'h');
    if ('error' in hemi) throw new Error(hemi.error);
    const full = horizontalVolume(1, 3, hemi.shape, hemi.shape, 1);
    expect(full).toBeCloseTo((Math.PI * 3) / 2 + (2 / 3) * Math.PI * 1, 12);
    expect(horizontalVolume(1, 3, { kind: 'spherical', depth: 0.5 }, hemi.shape, 1)).toBeNull();
  });

  it('flat heads add nothing and an empty vessel is empty', () => {
    const flat: HeadShape = { kind: 'flat', depth: 0 };
    expect(horizontalVolume(1, 3, flat, flat, 2)).toBeCloseTo(Math.PI * 3, 12);
    expect(horizontalVolume(1, 3, flat, flat, 0)).toBeCloseTo(0, 12);
  });
});
