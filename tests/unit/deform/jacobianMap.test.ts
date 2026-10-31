/** 01 DEF M4: `deform_jacobian_map`, the det J of a deformation per triangle of the deformed body (the colour map of the viewport). */

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
  readonly law: string;
  readonly displayTolerance: number;
}

async function deformed(
  name: string,
  params: Record<string, unknown>,
  kernel: 'none' | 'manifold' = 'none',
): Promise<{ doc: CadDocument; id: string }> {
  await installKernel(kernel);
  const { doc, id } = addBox([10, 10, 100]);
  const made = execute(doc, name, { id, frame: WORLD_Z, output: { tolerance: 0.01 }, ...params });
  expect(made.error, made.summary).toBeUndefined();
  return { doc: made.document, id: made.affected[0] as string };
}

const mapOf = (doc: CadDocument, id: string): JacobianMap => {
  const result = execute(doc, 'deform_jacobian_map', { id });
  expect(result.error, result.summary).toBeUndefined();
  return dataOf<JacobianMap>(result);
};

/** The document with the deform node of `id` replaced (a fixture: the commands refuse the parameters that fold). */
function withNode(doc: CadDocument, id: string, change: (node: Record<string, unknown>) => Record<string, unknown>): CadDocument {
  const entity = meshEntity(doc, id);
  if (entity.brep?.op !== 'deform') throw new Error('deform node expected');
  const brep = change({ ...entity.brep }) as unknown as typeof entity.brep;
  return { ...doc, entities: { ...doc.entities, [id]: { ...entity, brep } } };
}

describe('deform_jacobian_map', () => {
  it('a twist keeps volume: det J is 1 on every triangle, one determinant per triangle, the vertices are those of the deformed body', async () => {
    const { doc, id } = await deformed('twist_body', { angleDeg: 40 });
    const data = mapOf(doc, id);
    expect(data.determinant.length).toBe(data.indices.length / 3);
    expect(data.determinant.length).toBeGreaterThan(8);
    for (const det of data.determinant) expect(det).toBeCloseTo(1, 9);
    expect(data.folded).toBe(0);
    expect(data.floor).toBe(1e-6);
    expect(data.law).toBe('twist');
    expect(data.displayTolerance).toBe(0.01);
    const stored = meshEntity(doc, id).mesh;
    expect(data.indices).toEqual(Array.from(stored.indices));
    expect(data.positions).toEqual(Array.from(stored.positions, Math.fround));
    expect(execute(doc, 'deform_jacobian_map', { id }).summary).toContain('0 folded');
  });

  it('a stretch of 2 over the whole body is 2 on EVERY triangle, the base and the far end included (no triangle straddles a region end)', async () => {
    const { doc, id } = await deformed('stretch_body', { factor: 2 });
    const data = mapOf(doc, id);
    expect(data.min).toBeCloseTo(2, 9);
    expect(data.max).toBeCloseTo(2, 9);
  });

  it('a taper to 0.5 compresses toward the apex: det J falls from 1 at the base to 0.25 at the end, never below the floor', async () => {
    const { doc, id } = await deformed('taper_body', { scaleEnd: 0.5, region: { start: 0, end: 100 } });
    const data = mapOf(doc, id);
    expect(data.max).toBeCloseTo(1, 6);
    expect(data.min).toBeCloseTo(0.25, 6);
    expect(data.folded).toBe(0);
  });

  it('a bend over the default region: det J = 1 - y / R across the 10 mm section, (R - 5) / R .. (R + 5) / R', async () => {
    const { doc, id } = await deformed('bend_body', { radius: 400, angleDeg: 14 });
    const data = mapOf(doc, id);
    expect(data.min).toBeCloseTo(395 / 400, 3);
    expect(data.max).toBeCloseTo(405 / 400, 3);
  });

  it('flags the folded triangles of a recipe whose bend radius is smaller than the body: det J <= 0 there', async () => {
    const bent = await deformed('bend_body', { radius: 400, angleDeg: 14 });
    const folding = withNode(bent.doc, bent.id, (node) => ({ ...node, law: { ...(node['law'] as object), radius: 3 } }));
    const data = mapOf(folding, bent.id);
    expect(data.min as number).toBeLessThanOrEqual(0);
    expect(data.folded).toBe(data.determinant.filter((det) => !(det > data.floor)).length);
    expect(data.folded).toBeGreaterThan(0);
    expect(execute(folding, 'deform_jacobian_map', { id: bent.id }).summary).not.toContain(' 0 folded');
  });

  it('a flow onto a straight target keeps every triangle at det J 1; a lattice answers with its own law and a determinant per triangle', async () => {
    await installKernel('none');
    const rod = addBox([10, 10, 100]);
    const target = execute(rod.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [200, 0, 0],
        [200, 0, 100],
      ],
    });
    const flowed = execute(target.document, 'flow_along_curve', {
      id: rod.id,
      targetId: target.affected[0],
      frame: WORLD_Z,
      output: { tolerance: 0.01 },
    });
    expect(flowed.error, flowed.summary).toBeUndefined();
    const flow = mapOf(flowed.document, flowed.affected[0] as string);
    expect(flow.determinant.length).toBeGreaterThan(8);
    for (const det of flow.determinant) expect(det).toBeCloseTo(1, 5);

    const lattice = execute(rod.doc, 'deform_lattice', {
      id: rod.id,
      degrees: [2, 2, 2],
      box: { min: [-6, -6, -1], max: [6, 6, 101] },
      frame: WORLD_Z,
      moves: [{ index: [1, 1, 1], delta: [0, 0, 8] }],
      output: { tolerance: 0.01 },
    });
    expect(lattice.error, lattice.summary).toBeUndefined();
    const free = mapOf(lattice.document, lattice.affected[0] as string);
    expect(free.law).toBe('lattice');
    expect(free.determinant.length).toBe(free.indices.length / 3);
    expect(free.min as number).toBeGreaterThan(0);
    expect(free.max as number).not.toBeCloseTo(free.min as number, 3);
  });

  it('with the Manifold kernel installed (the source is the kernel tessellation): one determinant per triangle, indices inside the vertices', async () => {
    const { doc, id } = await deformed('twist_body', { angleDeg: 40 }, 'manifold');
    const data = mapOf(doc, id);
    expect(data.positions.length % 3).toBe(0);
    expect(data.indices.length).toBe(3 * data.determinant.length);
    expect(Math.max(...data.indices)).toBeLessThan(data.positions.length / 3);
    for (const det of data.determinant) expect(det).toBeCloseTo(1, 3);
  });

  it('coarsens the picture, never the deformation, when the refinement would be too large: a fine tolerance answers at a coarser displayTolerance', async () => {
    const bent = await deformed('bend_body', { radius: 400, angleDeg: 14 });
    const fine = withNode(bent.doc, bent.id, (node) => ({ ...node, output: { ...(node['output'] as object), tolerance: 1e-9 } }));
    const result = execute(fine, 'deform_jacobian_map', { id: bent.id });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf<JacobianMap>(result);
    expect(data.displayTolerance).toBeGreaterThan(1e-9);
    expect(data.determinant.length).toBeLessThanOrEqual(200_000);
    expect(result.summary).toContain('coarsened');
  });

  it('refuses without changing the document: unknown id, an entity that was not deformed, a refinement that stays over the budget at any coarsening', async () => {
    await installKernel('none');
    const { doc, id } = addBox();
    const missing = execute(doc, 'deform_jacobian_map', { id: 'nope' });
    expectNoOp(missing, doc);
    expect(missing.summary).toContain('DEF_ENTITY_NOT_FOUND');
    const plain = execute(doc, 'deform_jacobian_map', { id });
    expectNoOp(plain, doc);
    expect(plain.summary).toContain('DEF_NOT_DEFORMED');
    const bent = await deformed('bend_body', { radius: 400, angleDeg: 14 });
    const hopeless = withNode(bent.doc, bent.id, (node) => ({ ...node, output: { ...(node['output'] as object), tolerance: 1e-30 } }));
    const refused = execute(hopeless, 'deform_jacobian_map', { id: bent.id });
    expectNoOp(refused, hopeless);
    expect(refused.summary).toContain('DEF_BUDGET_EXCEEDED');
  });

  it('is pure', async () => {
    const { doc, id } = await deformed('twist_body', { angleDeg: 40 });
    expectPure(doc, () => execute(doc, 'deform_jacobian_map', { id }));
  });
});

/** `second` applied to the result of `first` on the 10 x 10 x 100 box (a chain of two deformations). */
async function chained(
  first: [string, Record<string, unknown>],
  second: [string, Record<string, unknown>],
): Promise<{ doc: CadDocument; id: string }> {
  const one = await deformed(first[0], first[1]);
  const made = execute(one.doc, second[0], { id: one.id, frame: WORLD_Z, output: { tolerance: 0.01 }, ...second[1] });
  expect(made.error, made.summary).toBeUndefined();
  return { doc: made.document, id: made.affected[0] as string };
}

interface ChainMap extends JacobianMap {
  readonly laws: string[];
  readonly deforms: number;
  readonly scope: string;
}

const chainMap = (doc: CadDocument, id: string, scope?: 'composed' | 'outermost'): ChainMap => {
  const result = execute(doc, 'deform_jacobian_map', { id, ...(scope === undefined ? {} : { scope }) });
  expect(result.error, result.summary).toBeUndefined();
  return dataOf<ChainMap>(result);
};

describe('deform_jacobian_map along a chain of deformations (composed det J = the volume ratio against the original body)', () => {
  it('a twist (det 1) then a taper to 0.5: the composed map is the taper alone, 0.25 .. 1, and the summary says composed (2 deforms)', async () => {
    const { doc, id } = await chained(['twist_body', { angleDeg: 40 }], ['taper_body', { scaleEnd: 0.5, region: { start: 0, end: 100 } }]);
    const composed = chainMap(doc, id);
    const outermost = chainMap(doc, id, 'outermost');
    expect(composed).toMatchObject({ laws: ['twist', 'taper'], deforms: 2, scope: 'composed' });
    expect(outermost).toMatchObject({ laws: ['taper'], deforms: 1, scope: 'outermost' });
    expect(composed.min).toBeCloseTo(0.25, 6);
    expect(composed.max).toBeCloseTo(1, 6);
    expect(composed.determinant).toEqual(outermost.determinant);
    expect(execute(doc, 'deform_jacobian_map', { id }).summary).toContain('composed (2 deforms)');
  });

  it('a stretch of 2 over the whole body, then a taper to 0.5 over its 200: composed = 2 s^2 (0.5 .. 2) on every triangle, the outermost alone s^2 (0.25 .. 1)', async () => {
    const { doc, id } = await chained(['stretch_body', { factor: 2 }], ['taper_body', { scaleEnd: 0.5, region: { start: 0, end: 200 } }]);
    const composed = chainMap(doc, id);
    const outermost = chainMap(doc, id, 'outermost');
    expect(composed.min).toBeCloseTo(0.5, 6);
    expect(composed.max).toBeCloseTo(2, 6);
    expect(outermost.min).toBeCloseTo(0.25, 6);
    expect(outermost.max).toBeCloseTo(1, 6);
    expect(composed.determinant).toHaveLength(outermost.determinant.length);
    composed.determinant.forEach((det, t) => expect(det).toBeCloseTo(2 * (outermost.determinant[t] as number), 3));
  });

  it('a stretch then a bend (the bend splits triangles: the rest positions of the new vertices are carried): composed = 2 (1 - y / R) = 2 (R - 5) / R .. 2 (R + 5) / R', async () => {
    const { doc, id } = await chained(['stretch_body', { factor: 2 }], ['bend_body', { radius: 400, angleDeg: 20 }]);
    const composed = chainMap(doc, id);
    expect(composed.deforms).toBe(2);
    expect(composed.min).toBeCloseTo((2 * 395) / 400, 3);
    expect(composed.max).toBeCloseTo((2 * 405) / 400, 3);
    expect(composed.determinant.length).toBeGreaterThan(24);
  });

  it('three deformations multiply: stretch 2 x stretch 1.5 x taper 0.5 over 300 -> 3 s^2', async () => {
    await installKernel('none');
    const one = await chained(['stretch_body', { factor: 2 }], ['stretch_body', { factor: 1.5 }]);
    const made = execute(one.doc, 'taper_body', {
      id: one.id,
      frame: WORLD_Z,
      scaleEnd: 0.5,
      region: { start: 0, end: 300 },
      output: { tolerance: 0.01 },
    });
    expect(made.error, made.summary).toBeUndefined();
    const composed = chainMap(made.document, made.affected[0] as string);
    expect(composed.laws).toEqual(['stretch', 'stretch', 'taper']);
    expect(composed.min).toBeCloseTo(0.75, 6);
    expect(composed.max).toBeCloseTo(3, 6);
  });

  it('an inner deformation the mesh warp refuses refuses the composed map by its code and leaves the document alone; the outermost scope names the missing source', async () => {
    const { doc, id } = await chained(['bend_body', { radius: 400, angleDeg: 14 }], ['stretch_body', { factor: 2 }]);
    const entity = meshEntity(doc, id);
    if (entity.brep?.op !== 'deform' || entity.brep.source.op !== 'deform') throw new Error('a chain of two deform nodes expected');
    const hopeless: CadDocument = {
      ...doc,
      entities: {
        ...doc.entities,
        [id]: {
          ...entity,
          brep: { ...entity.brep, source: { ...entity.brep.source, output: { ...entity.brep.source.output, tolerance: 1e-30 } } },
        },
      },
    };
    const refused = execute(hopeless, 'deform_jacobian_map', { id });
    expectNoOp(refused, hopeless);
    expect(refused.summary).toContain('DEF_BUDGET_EXCEEDED');
  });
});

/** The chain of `id` (two deform nodes) with the tolerance of the INNER node replaced (a fixture: the commands take the tolerance from `output`). */
function withInnerTolerance(doc: CadDocument, id: string, tolerance: number): CadDocument {
  const entity = meshEntity(doc, id);
  if (entity.brep?.op !== 'deform' || entity.brep.source.op !== 'deform') throw new Error('a chain of two deform nodes expected');
  const source = { ...entity.brep.source, output: { ...entity.brep.source.output, tolerance } };
  return { ...doc, entities: { ...doc.entities, [id]: { ...entity, brep: { ...entity.brep, source } } } };
}

describe('deform_jacobian_map composed: budget, collapse, mirror, accuracy', () => {
  it('a heavy inner node is coarsened with the picture: the answer arrives at a coarser displayTolerance within the triangle cap, the composed range still holds', async () => {
    const { doc, id } = await chained(['bend_body', { radius: 400, angleDeg: 14 }], ['stretch_body', { factor: 2 }]);
    const heavy = withInnerTolerance(doc, id, 1e-6);
    const result = execute(heavy, 'deform_jacobian_map', { id });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf<ChainMap>(result);
    expect(data.displayTolerance).toBeGreaterThan(0.01);
    expect(data.determinant.length).toBeLessThanOrEqual(200_000);
    expect(result.summary).toContain('coarsened');
    expect(data.min).toBeCloseTo((2 * 395) / 400, 1);
    expect(data.max).toBeCloseTo((2 * 405) / 400, 1);
  });

  it('a taper that collapses the end onto a point (distinct rest points on one position) refuses the composed map by name; the outermost scope still answers', async () => {
    const { doc, id } = await deformed('taper_body', { scaleEnd: 0.5, region: { start: 0, end: 100 } });
    const collapsed = withNode(doc, id, (node) => ({ ...node, law: { ...(node['law'] as object), scaleEnd: 1e-12 } }));
    const stretched = execute(collapsed, 'stretch_body', { id, frame: WORLD_Z, factor: 2, output: { tolerance: 0.01 } });
    expect(stretched.error, stretched.summary).toBeUndefined();
    const refused = execute(stretched.document, 'deform_jacobian_map', { id: stretched.affected[0] });
    expectNoOp(refused, stretched.document);
    expect(refused.summary).toContain('DEF_APPROX_TOLERANCE');
    expect(refused.summary).toContain('collapses distinct points');
    const outermost = execute(stretched.document, 'deform_jacobian_map', { id: stretched.affected[0], scope: 'outermost' });
    expect(outermost.error, outermost.summary).toBeUndefined();
  });

  it('a mirror then a taper to 0.5: composed = minus the taper on every triangle, every triangle reads as folded', async () => {
    const { doc, id } = await chained(
      ['scale_nonuniform', { factors: [-1, 1, 1] }],
      ['taper_body', { scaleEnd: 0.5, region: { start: 0, end: 100 } }],
    );
    const composed = chainMap(doc, id);
    const outermost = chainMap(doc, id, 'outermost');
    expect(composed.laws).toEqual(['affine', 'taper']);
    expect(composed.determinant).toHaveLength(outermost.determinant.length);
    composed.determinant.forEach((det, t) => expect(det).toBeCloseTo(-(outermost.determinant[t] as number), 6));
    expect(composed.folded).toBe(composed.determinant.length);
    expect(composed.max).toBeCloseTo(-0.25, 6);
  });

  it('a stretch of 2 over z 0..50 then a mirror: the cap in the region start plane reads the inside of the region (-2), the cap at the far end -1; the inward nudge follows the mirror flip', async () => {
    const { doc, id } = await chained(
      ['stretch_body', { factor: 2, region: { start: 0, end: 50 } }],
      ['scale_nonuniform', { factors: [-1, 1, 1] }],
    );
    const data = chainMap(doc, id);
    const heights = (t: number): number[] => [0, 1, 2].map((k) => data.positions[3 * (data.indices[3 * t + k] as number) + 2] as number);
    const base = Math.min(...data.positions.filter((_, i) => i % 3 === 2));
    const baseCap = data.determinant.filter((_, t) => heights(t).every((z) => Math.abs(z - base) < 1e-4));
    expect(baseCap.length).toBeGreaterThanOrEqual(2);
    for (const det of baseCap) expect(det).toBeCloseTo(-2, 9);
    expect(data.min).toBeCloseTo(-2, 9);
    expect(data.max).toBeCloseTo(-1, 9);
  });

  it('the rest point of a curved inner map is good to the outer chord tolerance: a bend then a taper, the extremes move less and less as the tolerance falls (about proportionally) and stay under the 4-digit display precision', async () => {
    const { doc, id } = await chained(
      ['bend_body', { radius: 400, angleDeg: 20 }],
      ['taper_body', { scaleEnd: 0.6, region: { start: 0, end: 100 } }],
    );
    const withTolerance = (tolerance: number): ChainMap => {
      const entity = meshEntity(doc, id);
      if (entity.brep?.op !== 'deform' || entity.brep.source.op !== 'deform') throw new Error('a chain of two deform nodes expected');
      const brep = {
        ...entity.brep,
        output: { ...entity.brep.output, tolerance },
        source: { ...entity.brep.source, output: { ...entity.brep.source.output, tolerance } },
      };
      return chainMap({ ...doc, entities: { ...doc.entities, [id]: { ...entity, brep } } }, id);
    };
    const [coarse, middle, fine] = [withTolerance(0.04), withTolerance(0.01), withTolerance(0.0025)];
    const errors = [middle, fine].map((finer, k) => Math.abs((finer.min as number) - ([coarse, middle][k] as ChainMap).min!));
    expect(errors[0]).toBeLessThan(5e-3);
    expect(errors[1] as number).toBeLessThan(0.7 * (errors[0] as number));
    expect(errors[1] as number).toBeLessThan(1e-3);
  });
});
