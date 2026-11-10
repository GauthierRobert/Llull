/** The PHY-16 layered-beam oracle against the pack's generated CSV (VC-PRC-30.a, .b, .d, .e) and the Timoshenko bimetal form. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { layeredBeam } from '../../../helpers/layeredBeam';

const CSV = path.resolve(__dirname, '../../../../docs/physics/16-process-physics/validation/layered_eigenstrain.csv');
const rows = readFileSync(CSV, 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => line.split(','));

const INPUT = { substrate: 4, E: 200000, count: 10, thickness: 0.2, strain: -0.002 };

describe('layered beam oracle', () => {
  const beam = layeredBeam(INPUT);

  it('reproduces the pack CSV per layer, the total and the substrate release to 1e-9 relative', () => {
    for (let i = 0; i < 10; i++) {
      expect(beam.increments[i]).toBeCloseTo(Number(rows[i]?.[1]), 15);
      expect(Math.abs((beam.increments[i] ?? 0) / Number(rows[i]?.[1]) - 1)).toBeLessThan(1e-9);
    }
    expect(Math.abs(beam.total / Number(rows[9]?.[2]) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(beam.release / Number(rows[10]?.[1]) - 1)).toBeLessThan(1e-9);
  });

  it('gives the Timoshenko bimetal curvature for one layer on the substrate (equal moduli)', () => {
    const t1 = 4;
    const t2 = 0.2;
    const timoshenko =
      (6 * INPUT.strain * t1 * t2 * (t1 + t2)) / (t1 ** 4 + 4 * t1 ** 3 * t2 + 6 * t1 ** 2 * t2 ** 2 + 4 * t1 * t2 ** 3 + t2 ** 4);
    expect(Math.abs((beam.increments[0] ?? 0) / timoshenko - 1)).toBeLessThan(1e-12);
  });

  it('differs from depositing the whole deposit at once by the layering factor 2.07 (VC-PRC-30.e)', () => {
    const once = layeredBeam({ ...INPUT, count: 1, thickness: 2 }).total;
    expect(once).toBeCloseTo(-4.44444444444e-4, 12);
    expect(beam.total / once).toBeCloseTo(2.07, 2);
  });
});
