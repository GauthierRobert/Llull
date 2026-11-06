import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type ShapeRecipe } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type TessellationOptions } from '@core/geometry/kernel';
import { lowerRecipe, type RecipeLowering } from '@core/codegen/recipeLowering';
import { buildSurface } from '@aero/cfd/flowSurface';
import { fakeKernel, TETRA, type FakeKernel } from '../helpers/fakeKernel';

const PREVIOUS = { linearDeflection: 0.1, angularDeflection: 0.5 };
const requested: Array<TessellationOptions | undefined> = [];

function recordingKernel(honours: boolean): FakeKernel {
  requested.length = 0;
  return fakeKernel({
    boolean: TETRA,
    fillet: TETRA,
    topology: { faces: [], edges: [], volume: 1 } as never,
    honoursTessellationOptions: honours,
    tessellate: (native, options) => {
      requested.push(options);
      return native.mesh;
    },
  });
}

function resultDocument(): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [10, 10, 10] }).document;
  doc = execute(doc, 'add_box', { size: [4, 4, 4] }).document;
  return execute(doc, 'boolean', { op: 'subtract', a: 'box-1.1', b: 'box-2.1' }).document;
}

afterEach(() => setGeometryKernel(null));

describe('consumers that must keep the accuracy they had before the display mesh scaled', () => {
  it('the OpenSCAD / FreeCAD fallback triangles of a fillet are the kernel mesh at 0.1 / 0.5', () => {
    const kernel = recordingKernel(true);
    const box = { id: 'b', kind: 'box', position: [0, 0, 0], rotation: [0, 0, 0], size: [2, 2, 2] } as never;
    const recipe: ShapeRecipe = { op: 'fillet', source: { op: 'solid', entity: box }, edges: [0], size: 0.5 } as never;
    const lowering: RecipeLowering = {
      kernel,
      take: (preferred) => preferred,
      solid: () => ({ kind: 'mesh', positions: [] }) as never,
      base: () => ({}) as never,
    };
    lowerRecipe(recipe, lowering);
    expect(requested).toContainEqual(PREVIOUS);
    const ignoring = recordingKernel(false);
    lowerRecipe(recipe, { ...lowering, kernel: ignoring });
    expect(requested.every((options) => options === undefined)).toBe(true);
  });

  it('the flow surface of one kernel result is built from its kernel mesh at 0.1 / 0.5, of several from the kernel union at 0.1 / 0.5', () => {
    const kernel = recordingKernel(true);
    setGeometryKernel(kernel);
    const doc = resultDocument();
    const entity = Object.values(doc.entities).find((candidate) => candidate.kind === 'mesh');
    if (entity === undefined) throw new Error('no kernel result');
    requested.length = 0;
    buildSurface(doc, [{ entity, ownerId: entity.id }], kernel);
    expect(requested).toContainEqual(PREVIOUS);
    requested.length = 0;
    buildSurface(
      doc,
      [
        { entity, ownerId: 'a' },
        { entity, ownerId: 'b' },
      ],
      kernel,
    );
    expect(requested).toContainEqual(PREVIOUS);
    const ignoring = recordingKernel(false);
    buildSurface(doc, [{ entity, ownerId: entity.id }], ignoring);
    expect(requested.every((options) => options === undefined)).toBe(true);
  });

  it('check_machining reads the thickness mesh at 0.1 / 0.5', () => {
    const kernel = recordingKernel(true);
    setGeometryKernel(kernel);
    const doc = resultDocument();
    const id = doc.order[0] as string;
    requested.length = 0;
    execute(doc, 'check_machining', { id });
    expect(requested).toContainEqual(PREVIOUS);
  });
});
