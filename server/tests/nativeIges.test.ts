/**
 * Native IGES exchange (SC-D4): a box and a holed plate written with writeExchange (format iges, the export_iges path) and read back with
 * importShapes('iges') (the import_step_exact format iges path) keep their exact
 * volume (closed form, VC-KRN-04 tolerance 1e-4 relative). Skipped without the native binary.
 */

import { describe, expect, it } from 'vitest';
import type { ImportShapesOptions, ImportedShapes } from '@core/geometry/kernelPorts';
import { sha256Hex } from '@lib/sha256';
import { box, booleanRecipe, leaf, nativeKernelBinary } from './kernelTestSupport';
import { entity } from './nativeKernelCorpus';
import { nativeReferenceHarness } from './nativeReferenceSupport';

const harness = nativeReferenceHarness();
const OPTIONS: ImportShapesOptions = { precision: 0.01, maxTolerance: 1, heal: true, sew: true };

async function roundTrip(recipe: unknown): Promise<number> {
  const shape = { key: `k-${Math.random()}`, recipe };
  const iges = await harness.call('writeExchange', [
    {
      format: 'iges',
      unit: 'mm',
      products: [{ key: 'p', name: 'part', solids: [{ shape }] }],
      occurrences: [],
      igesMode: 'brep',
      header: { fileName: 'llull.igs', originatingSystem: 'llull', timestamp: '' },
    },
  ]);
  expect(typeof iges).toBe('string');
  expect(String(iges)).toContain('S      1');
  const imported = (await harness.call('importShapes', ['iges', iges, OPTIONS])) as ImportedShapes;
  expect(imported.solids).toHaveLength(1);
  const brep = imported.solids[0]?.brep ?? '';
  const sha256 = sha256Hex(brep);
  await harness.call('loadBlob', [sha256, brep]);
  const mass = (await harness.on('massProperties', { op: 'brep', blob: sha256, format: 'occt-brep-v1' })) as { volume: number };
  return mass.volume;
}

describe.skipIf(nativeKernelBinary === null)('native IGES export and import', () => {
  it('a 20 x 10 x 5 box survives the round trip', async () => {
    const volume = await roundTrip(leaf(box([0, 0, 0], [20, 10, 5])));
    expect(Math.abs(volume - 1000) / 1000).toBeLessThan(1e-4);
  });

  it('a plate with a through hole keeps V = abc - pi r^2 c', async () => {
    const plate = booleanRecipe('subtract', box([0, 0, 0], [20, 20, 4]), entity('cylinder', { radius: 3, height: 10 }));
    const volume = await roundTrip(plate);
    const expected = 20 * 20 * 4 - Math.PI * 9 * 4;
    expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-4);
  });
});
