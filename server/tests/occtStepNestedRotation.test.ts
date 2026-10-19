/** Live OpenCascade: a nested, obliquely rotated assembly exported to STEP re-imports at the same world centroid as the viewport path. */

import { it, expect } from 'vitest';
import { createEmptyDocument, type Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { liveKernels, describeNative } from './kernelTestSupport';

const kernels = liveKernels();
const ORIGIN: Vec3 = [0, 0, 0];

describeNative('occt export_step_exact nested oblique rotations', () => {
  it('re-imports each box at the world centroid mass_properties reports (relative error < 1e-6)', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [2, 3, 4], position: [5, 1, -2], rotation: [0.3, 0, 0] });
    const a = execute(box.document, 'create_component', { name: 'A', entityIds: [box.affected[0]!], componentId: 'comp-a' });
    const mid = execute(a.document, 'insert_instance', { componentId: 'comp-a', rotation: [0, 0.5, 0.7], position: [1, 2, 3] });
    const b = execute(mid.document, 'create_component', { name: 'B', entityIds: [mid.affected[0]!], componentId: 'comp-b' });
    const outer = execute(b.document, 'insert_instance', { componentId: 'comp-b', rotation: [0.4, -0.9, 0.2], position: [3, -1, 2] });
    const ctx = { ...defaultContext(), kernel: kernels.occt };

    const centroidOf = (doc: typeof outer.document, id: string): Vec3 =>
      (execute(doc, 'mass_properties', { entityId: id }, ctx).data as { centroid: Vec3 }).centroid;
    const shift = (v: Vec3, rotation: Vec3, position: Vec3): Vec3 => {
      const r = applyEulerXYZ(v, ORIGIN, rotation);
      return [r[0] + position[0], r[1] + position[1], r[2] + position[2]];
    };
    const inner = shift([5, 1, -2], [0, 0.5, 0.7], [1, 2, 3]);
    // Document order: instance of A at the origin, instance of B at the origin (holding the rotated A), the outer rotated B.
    const oracle: Vec3[] = [[5, 1, -2], inner, shift(inner, [0.4, -0.9, 0.2], [3, -1, 2])];

    const exported = execute(outer.document, 'export_step_exact', {}, ctx);
    const imported = execute(createEmptyDocument(), 'import_step_exact', { text: (exported.data as { step: string }).step }, ctx);
    expect(imported.affected).toHaveLength(3);
    oracle.forEach((expected, index) => {
      const viewport = centroidOf(outer.document, outer.document.order[index]!);
      const stepCentroid = centroidOf(imported.document, imported.affected[index]!);
      const scale = Math.max(1, ...expected.map(Math.abs));
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(viewport[k]! - expected[k]!) / scale).toBeLessThan(1e-6);
        expect(Math.abs(stepCentroid[k]! - expected[k]!) / scale).toBeLessThan(1e-6);
      }
    });
  }, 180_000);
});
