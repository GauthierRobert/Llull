/** 01 DEF M4: `deform_jacobian_map`, the per-vertex det J of a deformation on the deformed body (the colour map of the viewport). Mesh path. */

import { afterEach, describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { WORLD_Z, addBox, dataOf, installKernel, meshEntity } from './harness';

afterEach(() => setGeometryKernel(null));

interface JacobianMap {
  readonly positions: number[];
  readonly indices: number[];
  readonly determinant: number[];
  readonly min: number | null;
  readonly max: number | null;
  readonly folded: number;
  readonly floor: number;
}

async function deformed(name: string, params: Record<string, unknown>): Promise<{ doc: CadDocument; id: string }> {
  await installKernel('none');
  const { doc, id } = addBox([10, 10, 100]);
  const made = execute(doc, name, { id, frame: WORLD_Z, output: { tolerance: 0.01 }, ...params });
  expect(made.error, made.summary).toBeUndefined();
  return { doc: made.document, id: made.affected[0] as string };
}

describe('deform_jacobian_map', () => {
  it('a twist keeps volume: det J is 1 at every vertex, and the vertices are those of the deformed body', async () => {
    const { doc, id } = await deformed('twist_body', { angleDeg: 40 });
    const result = execute(doc, 'deform_jacobian_map', { id });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf<JacobianMap>(result);
    expect(data.determinant.length).toBe(data.positions.length / 3);
    expect(data.determinant.length).toBeGreaterThan(8);
    for (const det of data.determinant) expect(det).toBeCloseTo(1, 9);
    expect(data.folded).toBe(0);
    expect(data.floor).toBe(1e-6);
    const stored = meshEntity(doc, id).mesh;
    expect(data.indices).toEqual(Array.from(stored.indices));
    expect(data.positions).toEqual(Array.from(stored.positions));
    expect(result.summary).toContain('0 folded');
  });

  it('a stretch of 2 over the whole body: det J is 2 along the stretched span (1 only at the translated end)', async () => {
    const { doc, id } = await deformed('stretch_body', { factor: 2 });
    const data = dataOf<JacobianMap>(execute(doc, 'deform_jacobian_map', { id }));
    expect(data.max).toBeCloseTo(2, 9);
    for (const det of data.determinant) expect([1, 2].some((expected) => Math.abs(det - expected) < 1e-9)).toBe(true);
  });

  it('a taper to 0.5 compresses toward the apex: det J falls from 1 at the base to 0.25 at the end, never below the floor', async () => {
    const { doc, id } = await deformed('taper_body', { scaleEnd: 0.5, region: { start: 0, end: 100 } });
    const data = dataOf<JacobianMap>(execute(doc, 'deform_jacobian_map', { id }));
    expect(data.max).toBeCloseTo(1, 6);
    expect(data.min).toBeCloseTo(0.25, 6);
    expect(data.folded).toBe(0);
  });

  it('flags the folded vertices of a recipe whose bend radius is smaller than the body: det J <= 0 there', async () => {
    const { doc, id } = await deformed('bend_body', { radius: 400, angleDeg: 14 });
    const entity = meshEntity(doc, id);
    if (entity.brep?.op !== 'deform' || entity.brep.law.kind !== 'bend') throw new Error('bend node expected');
    const folding: CadDocument = {
      ...doc,
      entities: { ...doc.entities, [id]: { ...entity, brep: { ...entity.brep, law: { ...entity.brep.law, radius: 3 } } } },
    };
    const result = execute(folding, 'deform_jacobian_map', { id });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf<JacobianMap>(result);
    expect(data.min as number).toBeLessThanOrEqual(0);
    expect(data.folded).toBe(data.determinant.filter((det) => !(det > data.floor)).length);
    expect(data.folded).toBeGreaterThan(0);
    expect(result.summary).not.toContain(' 0 folded');
  });

  it('refuses without changing the document: unknown id, an entity that was not deformed, an unbuildable refinement', async () => {
    await installKernel('none');
    const { doc, id } = addBox();
    const missing = execute(doc, 'deform_jacobian_map', { id: 'nope' });
    expectNoOp(missing, doc);
    expect(missing.summary).toContain('DEF_ENTITY_NOT_FOUND');
    const plain = execute(doc, 'deform_jacobian_map', { id });
    expectNoOp(plain, doc);
    expect(plain.summary).toContain('DEF_NOT_DEFORMED');
    const bent = await deformed('bend_body', { radius: 400, angleDeg: 14 });
    const entity = meshEntity(bent.doc, bent.id);
    if (entity.brep?.op !== 'deform') throw new Error('deform node expected');
    const fine: CadDocument = {
      ...bent.doc,
      entities: {
        ...bent.doc.entities,
        [bent.id]: { ...entity, brep: { ...entity.brep, output: { ...entity.brep.output, tolerance: 1e-9 } } },
      },
    };
    const refused = execute(fine, 'deform_jacobian_map', { id: bent.id });
    expectNoOp(refused, fine);
    expect(refused.summary).toContain('DEF_BUDGET_EXCEEDED');
  });

  it('is pure', async () => {
    const { doc, id } = await deformed('twist_body', { angleDeg: 40 });
    expectPure(doc, () => execute(doc, 'deform_jacobian_map', { id }));
  });
});
