/**
 * split_face_by_curves on two different faces (native OCCT kernel): every split step used to end with UnifySameDomain whose keep set held only that step's tool edges, so the dividing edge
 * of an earlier split (two halves of one face) was merged back. A line across the top face and one across the bottom face of a box, in one command or one per command, must leave 8 faces.
 */

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

vi.setConfig({ testTimeout: 280_000 });
type Row = Record<string, unknown>;
type Run = ReturnType<typeof execute>;

describeNativeWhen({ capabilities: ['deform'], label: 'split keep' })(
  'split_face_by_curves keeps the earlier splits (native OCCT kernel)',
  () => {
    let kernel: IsolatedKernel;
    beforeAll(() => {
      kernel = createNativeTestKernel();
      setGeometryKernel(kernel);
    }, 120_000);
    afterAll(() => {
      setGeometryKernel(null);
      kernel.dispose();
    });

    const must = (doc: CadDocument, name: string, params: Row): Run => {
      const result = execute(doc, name, params);
      expect(result.rejected, result.summary).toBeUndefined();
      return result;
    };
    /** A box 60 x 40 x 10 with a line across its top face (along x, at y = 0) and one across its bottom face (along y, at x = 0). */
    const scene = (): { doc: CadDocument; id: string; ids: string[] } => {
      const box = must({ ...createEmptyDocument(), units: 'mm' }, 'add_box', { size: [60, 40, 10] });
      const id = box.affected[0] as string;
      const top = must(box.document, 'create_curve_on_face', {
        id,
        face: { faceNear: [10, 10, 5] },
        mode: 'geodesic',
        from: [-30, 0, 5],
        to: [30, 0, 5],
      });
      const bottom = must(top.document, 'create_curve_on_face', {
        id,
        face: { faceNear: [10, 10, -5] },
        mode: 'geodesic',
        from: [0, -20, -5],
        to: [0, 20, -5],
      });
      return { doc: bottom.document, id, ids: [top.affected[0] as string, bottom.affected[0] as string] };
    };

    it('two curves on two faces in one command divide both: 6 -> 8 faces, the volume unchanged', () => {
      const { doc, id, ids } = scene();
      const done = must(doc, 'split_face_by_curves', { id, curveIds: ids });
      const data = done.data as { facesBefore: number; facesAfter: number; volumeBefore: number; volumeAfter: number };
      expect([data.facesBefore, data.facesAfter]).toEqual([6, 8]);
      expect(Math.abs(data.volumeAfter / data.volumeBefore - 1)).toBeLessThan(1e-9);
    });

    it('one curve per command: the second command divides its face and keeps the first split (8 faces, not WRP_SPLIT_NO_EFFECT)', () => {
      const { doc, id, ids } = scene();
      const first = must(doc, 'split_face_by_curves', { id, curveIds: [ids[0]] });
      const second = must(first.document, 'split_face_by_curves', { id: first.affected[0], curveIds: [ids[1]] });
      expect((second.data as { facesAfter: number }).facesAfter).toBe(8);
    });

    it('two curves on the same face still divide it into four, and a split never merges faces that were distinct in the source', () => {
      const box = must({ ...createEmptyDocument(), units: 'mm' }, 'add_box', { size: [60, 40, 10] });
      const id = box.affected[0] as string;
      const a = must(box.document, 'create_curve_on_face', {
        id,
        face: { faceNear: [10, 10, 5] },
        mode: 'geodesic',
        from: [-30, 0, 5],
        to: [30, 0, 5],
      });
      const b = must(a.document, 'create_curve_on_face', {
        id,
        face: { faceNear: [10, 10, 5] },
        mode: 'geodesic',
        from: [0, -20, 5],
        to: [0, 20, 5],
      });
      const done = must(b.document, 'split_face_by_curves', { id, curveIds: [a.affected[0], b.affected[0]] });
      expect((done.data as { facesAfter: number }).facesAfter).toBe(9);
    });
  },
);
