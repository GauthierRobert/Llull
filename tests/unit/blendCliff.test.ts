/**
 * BLD cliff edges of fillet_faces (TECHNICAL_SPEC 13.28) over a scripted kernel: the recipe field, the parameter clashes, the recipe key and
 * validator (native values: server/tests/nativeBlendCliff.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity, type ShapeRecipe } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { FaceGraph } from '@core/geometry/kernelPorts';
import { recipeKey, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { scriptedKernel } from '../helpers/blendKernel';
import { expectPure } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

const apart = (): ReturnType<typeof scriptedKernel> =>
  scriptedKernel({ graph: { faces: [], edgeFaces: [], edgeConvexity: [] } as unknown as FaceGraph });
const box = (): { doc: CadDocument; id: string } => {
  const made = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  return { doc: made.document, id: made.affected[0] as string };
};
const setOf = (face: number): { near: Array<[number, number, number]> } => ({ near: [[face, 0, 0]] });
const brepOf = (doc: CadDocument, id: string): ShapeRecipe | undefined => (doc.entities[id] as MeshSolidEntity).brep;

describe('fillet_faces cliff', () => {
  it('cliff rides in the faceBlend node and is built from one planar face per set even when a shared edge exists', () => {
    const { doc, id } = box();
    const kernel = scriptedKernel();
    const run = (): ReturnType<typeof execute> =>
      execute(doc, 'fillet_faces', { id, facesA: setOf(0), facesB: setOf(1), radius: 2, cliff: 'B' }, { ...defaultContext(), kernel });
    const result = run();
    expect(result.affected).toHaveLength(1);
    expect(brepOf(result.document, result.affected[0] as string)).toMatchObject({ op: 'faceBlend', radius: 2, cliff: 'B' });
    expect(result.summary).toContain('cliff edge on facesB');
    expectPure(doc, run);
  });

  it('without cliff the node has no cliff field', () => {
    const { doc, id } = box();
    const result = execute(
      doc,
      'fillet_faces',
      { id, facesA: setOf(0), facesB: setOf(1), radius: 2 },
      { ...defaultContext(), kernel: apart() },
    );
    expect(brepOf(result.document, result.affected[0] as string)).not.toHaveProperty('cliff');
  });

  it('refuses a cliff with a varying size, a width, a hold line or a non-circular profile, by name, document unchanged', () => {
    const { doc, id } = box();
    const ctx = { ...defaultContext(), kernel: apart() };
    const base = { id, facesA: setOf(0), facesB: setOf(1), cliff: 'A' };
    for (const extra of [
      { radius: 2, radiusEnd: 3 },
      { width: 2 },
      { law: { expression: '2' } },
      { holdLine: { id: 'h', onFaces: 'A' } },
    ]) {
      const refused = execute(doc, 'fillet_faces', { ...base, ...extra }, ctx);
      expect(refused.document).toBe(doc);
      expect(refused.error).toMatchObject({ code: 'BLD_BLEND_PARAMS', paths: ['cliff'] });
    }
    const profiled = execute(doc, 'fillet_faces', { ...base, radius: 2, profile: { type: 'conic', rho: 0.5 } }, ctx);
    expect(profiled.error).toMatchObject({ code: 'BLD_BLEND_PARAMS', paths: ['profile'] });
    const bad = execute(doc, 'fillet_faces', { ...base, radius: 2, cliff: 'C' }, ctx);
    expect(bad.error?.code).toBe('CMD_INVALID_PARAMS');
  });

  it('a set that is not one planar face is BLD_FACE_BLEND_UNSUPPORTED at cliff', () => {
    const { doc, id } = box();
    const refused = execute(
      doc,
      'fillet_faces',
      {
        id,
        facesA: {
          near: [
            [0, 0, 0],
            [1, 0, 0],
          ],
        },
        facesB: setOf(2),
        radius: 2,
        cliff: 'A',
      },
      { ...defaultContext(), kernel: scriptedKernel() },
    );
    expect(refused.document).toBe(doc);
    expect(refused.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED', paths: ['cliff'] });
  });

  it('recipeKey separates the cliff; the validator accepts A / B with a circular section only', () => {
    const source: ShapeRecipe = { op: 'solid', entity: { id: 'b', kind: 'box' } as never };
    const base = { op: 'faceBlend', source, facesA: [0], facesB: [1], radius: 2 } as const;
    expect(new Set([recipeKey(base), recipeKey({ ...base, cliff: 'A' }), recipeKey({ ...base, cliff: 'B' })]).size).toBe(3);
    const leaf = (): string | null => null;
    expect(validateShapeRecipe({ ...base, cliff: 'A' }, leaf)).toBeNull();
    expect(validateShapeRecipe({ ...base, cliff: 'A', profile: { type: 'circular' } }, leaf)).toBeNull();
    expect(validateShapeRecipe({ ...base, cliff: 'C' }, leaf)).toContain('cliff must be');
    expect(validateShapeRecipe({ ...base, cliff: 'A', profile: { type: 'conic', rho: 0.5 } }, leaf)).toContain('circular section only');
  });
});
