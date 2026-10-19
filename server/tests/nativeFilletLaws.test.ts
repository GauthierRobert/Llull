/**
 * SC-F3 on the native OCCT kernel: per-edge fillet radii (`fillet_edge edges`) and chord-length fillets. Uniform laws and chord sizing use the
 * single-size recipe every build reads and are checked against the closed form; differing radii emit `radii` (size 0 placeholder), which the
 * native kernel must read (solver/ Rust, native lane): until it does the command is a clean no-op, and this suite asserts exactly that, then
 * the analytic volume once the sidecar supports it. Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

const Q = 1 - Math.PI / 4;

describeNative('fillet_edge per-edge radii and chord sizing (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const block = (): { doc: ReturnType<typeof createEmptyDocument>; id: string } => {
    const made = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    return { doc: made.document, id: made.affected[0] as string };
  };
  const volume = (doc: ReturnType<typeof createEmptyDocument>, id: string): number =>
    ((execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }) ?? { volume: Number.NaN }).volume;

  it('equal radii given per edge round exactly like the shorthand: V = abc - 2 (1 - pi/4) r^2 h', () => {
    const { doc, id } = block();
    const result = execute(doc, 'fillet_edge', {
      id,
      edges: [
        { near: [10, 5, 0], size: 1.5 },
        { near: [-10, -5, 0], size: 1.5 },
      ],
    });
    expect(result.affected).toHaveLength(1);
    expect(volume(result.document, result.affected[0] as string)).toBeCloseTo(1000 - 2 * Q * 1.5 * 1.5 * 5, 3);
  });

  it('chord 2 sqrt 2 on right-angle edges = radius 2: V = abc - 4 (1 - pi/4) r^2 h', () => {
    const { doc, id } = block();
    const result = execute(doc, 'fillet_edge', {
      id,
      mode: 'chord',
      edgesNear: [
        [10, 5, 0],
        [-10, 5, 0],
        [10, -5, 0],
        [-10, -5, 0],
      ],
      radius: 2 * Math.SQRT2,
    });
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    expect(volume(result.document, result.affected[0] as string)).toBeCloseTo(1000 - 4 * Q * 4 * 5, 3);
  });

  it('differing radii: a clean no-op until the sidecar reads radii, the analytic volume after', () => {
    const { doc, id } = block();
    const result = execute(doc, 'fillet_edge', {
      id,
      edges: [
        { near: [10, 5, 0], size: 1 },
        { near: [-10, -5, 0], size: 2 },
      ],
    });
    if (result.affected.length === 0) {
      expect(result.document).toBe(doc);
      return;
    }
    expect(volume(result.document, result.affected[0] as string)).toBeCloseTo(1000 - Q * (1 + 4) * 5, 3);
  });
});
