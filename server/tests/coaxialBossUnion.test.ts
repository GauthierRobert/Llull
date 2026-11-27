/**
 * Regression of a union the exact kernel refused although it had succeeded (the 24-SPO-06 buffer stand of quality/drawings):
 * a boss coaxial with the cylindrical top of the body, of the same radius, overlapping it by 1.27 mm. The face merge that follows
 * a boolean (ShapeUpgrade_UnifySameDomain) used to run on the boolean result itself and edit edges shared with the operands;
 * when the merged solid came out invalid, the result kept as the fallback was already damaged and meshed open. The merge now
 * works on a copy (solver/crates/llull-kernel-occt/cpp/facade.cxx `boolean_op`).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, is3D } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';

const PLAN = path.resolve(__dirname, '../../quality/drawings/plans/ttt-24-SPO-06-Buffer_Stand.json');
/** Solid volume of the real part (quality/drawings/manifest.json: official mass 3.923 lb at 7800 kg/m³), mm³. */
const VOLUME = 228133.701;

describeNative('union of a boss coaxial with a cylindrical face of the body (native kernel)', () => {
  beforeAll(() => setGeometryKernel(createNativeTestKernel()), 120_000);

  it('rebuilds the buffer stand: every boolean of the plan returns a closed solid, at the volume of the real part', () => {
    const actions: unknown = JSON.parse(readFileSync(PLAN, 'utf8'));
    const built = execute(createEmptyDocument(), 'build_project', { actions });
    expect(built.summary).toMatch(/plan step\(s\) ok/);
    expect(built.summary).not.toMatch(/failed|rolled back|no usable mesh/);
    let volume = 0;
    for (const id of built.document.order) {
      const entity = built.document.entities[id];
      if (entity === undefined || !is3D(entity)) continue;
      volume += (execute(built.document, 'mass_properties', { entityId: id }).data as { volume: number } | undefined)?.volume ?? 0;
    }
    expect(Math.abs(volume - VOLUME) / VOLUME).toBeLessThan(0.005);
  }, 120_000);
});
