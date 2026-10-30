/**
 * FEA part geometry is built outside `execute` (server/src/fea/transports.ts): it goes through the same scan cap as commands (DES-7e, 01 DEF §16), so a large
 * imported mesh is never sewn by the exact kernel and the part falls back to its stored triangles; a small scan and a box still reach the kernel.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { guardedKernel, KERNEL_MESH_LEAF_CAP } from '@core/commands/kernelMeshGuard';
import type { GeometryKernel, ShapeHandle } from '@core/geometry/kernel';
import { meshLeafTriangles } from '@core/geometry/operandRecipe';
import { createEmptyDocument, type ShapeRecipe } from '@core/model/types';
import { icosphere, soup } from '../../tests/helpers/meshFixtures';
import { partGeometry } from '../src/fea/feaGeometry';

/** An 'occt' stand-in that records the scan size of every recipe it is asked to build and answers with a one-triangle shape. */
function recordingKernel(): { kernel: GeometryKernel; reached: number[] } {
  const reached: number[] = [];
  const kernel = {
    name: 'occt',
    supports: () => true,
    evaluate: (recipe: ShapeRecipe) => {
      reached.push(meshLeafTriangles(recipe));
      return {} as ShapeHandle;
    },
    exportStep: () => 'ISO-10303-21;',
    tessellate: () => ({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }),
    topology: () => null,
  } as unknown as GeometryKernel;
  return { kernel, reached };
}

function scanDocument(level: number): { doc: ReturnType<typeof createEmptyDocument>; id: string } {
  const imported = execute(createEmptyDocument(), 'import_mesh', { bodies: [{ positions: soup(icosphere(10, level)) }] });
  return { doc: imported.document, id: imported.affected[0] as string };
}

describe('FEA part geometry and the kernel scan cap (DES-7e)', () => {
  it('a scan above the cap never reaches the kernel: the part is its stored triangles', () => {
    const { kernel, reached } = recordingKernel();
    const { doc, id } = scanDocument(5);
    const part = partGeometry(doc, id, guardedKernel(kernel));
    expect(part).toMatchObject({ kind: 'stl' });
    expect(reached.filter((triangles) => triangles > KERNEL_MESH_LEAF_CAP)).toEqual([]);
  });

  it('a small scan and a box still go through the kernel (STEP)', () => {
    const { kernel, reached } = recordingKernel();
    const { doc, id } = scanDocument(2);
    expect(partGeometry(doc, id, guardedKernel(kernel))).toMatchObject({ kind: 'step' });
    const box = execute(doc, 'add_box', { size: [1, 1, 1] });
    expect(partGeometry(box.document, box.affected[0] as string, guardedKernel(kernel))).toMatchObject({ kind: 'step' });
    expect(reached).toEqual([320, 0]);
  });
});
