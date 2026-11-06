import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type TessellationOptions } from '@core/geometry/kernel';
import { sourceMeshOf } from '@core/commands/deform/sourceMesh';
import { loadTarget, isTarget } from '@core/commands/deform/target';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { fakeKernel, TETRA } from '../helpers/fakeKernel';

const requested: Array<TessellationOptions | undefined> = [];
const kernelOf = (honours: boolean): ReturnType<typeof fakeKernel> => {
  requested.length = 0;
  return fakeKernel({
    honoursTessellationOptions: honours,
    tessellate: (native, options) => {
      requested.push(options);
      return native.mesh;
    },
  });
};

afterEach(() => setGeometryKernel(null));

describe('deformation source meshes keep the accuracy they had before the display mesh scaled', () => {
  for (const honours of [true, false]) {
    it(`sourceMeshOf and loadTarget ask a kernel that ${honours ? 'honours' : 'ignores'} options for ${honours ? '0.1 / 0.5' : 'the display mesh'}`, () => {
      const expected = honours ? { linearDeflection: 0.1, angularDeflection: 0.5 } : undefined;
      const kernel = kernelOf(honours);
      setGeometryKernel(kernel);
      const doc = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] }).document;
      const entity = doc.entities['box-1.1'];
      if (entity === undefined) throw new Error('no box');
      requested.length = 0;
      expect(sourceMeshOf(kernel, recipeOf(entity), doc)?.indices.length).toBe(TETRA.indices.length);
      expect(requested).toEqual([expected]);
      const second = kernelOf(honours);
      const target = loadTarget(doc, 'test', 'box-1.1', { kernel: second } as never);
      expect(isTarget(target)).toBe(true);
      expect(requested).toEqual([expected]);
    });
  }
});
