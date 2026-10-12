/**
 * @layer server/tests
 * Live OpenCascade: blend_union welds swept / lofted bike-frame tubes into ONE exact solid with
 * filleted joints, fillet_edge varies a radius along an edge, and
 * the Manifold kernel refuses blends gracefully.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type CadDocument, type MeshSolidEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { type GeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createNodeOcctKernel } from '../src/occtNode';

let occt: GeometryKernel;

beforeAll(async () => {
  occt = await createNodeOcctKernel();
  setGeometryKernel(occt);
}, 120_000);
afterAll(() => setGeometryKernel(null));

/** Bottom bracket shell (r 22) + tapered down tube + oval seat tube, both ending inside the shell. */
function frameJunction(): CadDocument {
  return execute(createEmptyDocument(), 'build_project', {
    actions: [
      {
        command: 'add_cylinder',
        params: { radius: 22, height: 70, rotation: [Math.PI / 2, 0, 0] },
      },
      {
        command: 'sweep_profile',
        params: {
          path: [
            [0, 0, 0],
            [300, 0, 250],
          ],
          stations: [
            { at: 0, radiusX: 16, radiusY: 19 },
            { at: 1, radius: 15 },
          ],
        },
      },
      {
        command: 'sweep_profile',
        params: {
          path: [
            [0, 0, 0],
            [-80, 0, 300],
          ],
          stations: [
            { at: 0, radiusX: 14, radiusY: 17 },
            { at: 1, radiusX: 13, radiusY: 15 },
          ],
        },
      },
    ],
  }).document;
}

function solidsAndVolume(doc: CadDocument, id: string): { solids: number; volume: number } {
  const entity = doc.entities[id] as MeshSolidEntity;
  const shape = occt.evaluate(entity.brep as NonNullable<MeshSolidEntity['brep']>);
  const topology = shape === null ? null : occt.topology(shape);
  return { solids: topology?.solids ?? 0, volume: topology?.volume ?? 0 };
}

describe('blend_union on the live OCC kernel', () => {
  it('welds the frame junction into one solid with filleted joints', () => {
    const doc = frameJunction();
    const plain = execute(doc, 'boolean', { op: 'union', a: doc.order[0], b: doc.order[1] });
    expect(plain.affected).toHaveLength(1);
    const blended = execute(doc, 'blend_union', { ids: doc.order, radius: 6 });
    expect(blended.affected, blended.summary).toHaveLength(1);
    expect(blended.document.order).toHaveLength(1);
    const { solids, volume } = solidsAndVolume(blended.document, blended.affected[0] as string);
    expect(solids).toBe(1);
    expect(volume).toBeGreaterThan(0);
    expect(blended.summary).toContain('welded 3 solids');
    const step = execute(blended.document, 'export_step_exact', {}).data as { step: string };
    expect(step.step).toMatch(/B_SPLINE_SURFACE|SURFACE_OF_REVOLUTION|TOROIDAL_SURFACE/);
  });

  it('fillet_edge varies the radius along a box edge', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [40, 40, 40] });
    const rounded = execute(box.document, 'fillet_edge', {
      id: box.affected[0],
      edgeIndices: [0],
      radius: 2,
      radiusEnd: 10,
    });
    expect(rounded.affected, rounded.summary).toHaveLength(1);
    const { volume } = solidsAndVolume(rounded.document, rounded.affected[0] as string);
    expect(volume).toBeLessThan(40 ** 3);
    expect(volume).toBeGreaterThan(40 ** 3 - 40 * 10 * 10);
  });

  it('the Manifold kernel refuses blends without touching the document', async () => {
    setGeometryKernel(await createManifoldKernel());
    try {
      const doc = frameJunction();
      const result = execute(doc, 'blend_union', { ids: doc.order, radius: 6 });
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('cannot fillet joints');
    } finally {
      setGeometryKernel(occt);
    }
  });
});
