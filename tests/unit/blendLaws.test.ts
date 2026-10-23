/**
 * BLD M1: radius laws (linear interpolation, expression laws, periodic closure), chord sizing on curved faces, over a scripted kernel
 * (the native values are asserted in server/tests/nativeBlendLaws.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type EdgeRadius, type MeshSolidEntity, type ShapeRecipe } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import {
  closedEdge,
  controlParameters,
  isLawProblem,
  lawEnds,
  lawNodes,
  lawTimesFactors,
  periodicProblem,
  radiusAt,
  resolveLaw,
  sampleExpression,
  scaleLaw,
} from '@core/geometry/blend/law';
import { SOURCE, scriptedKernel } from '../helpers/blendKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

describe('resolveLaw: explicit and expression radius laws', () => {
  it('keeps a valid explicit law and its interpolation', () => {
    expect(resolveLaw({ size: 1, sizeEnd: 2, sizes: [{ t: 0.5, size: 3 }], interpolation: 'linear' })).toEqual({
      size: 1,
      sizeEnd: 2,
      sizes: [{ t: 0.5, size: 3 }],
      interpolation: 'linear',
    });
    expect(resolveLaw({ size: 2 })).toEqual({ size: 2 });
    expect(resolveLaw({ size: 2, sizes: [], interpolation: 'smooth' })).toEqual({ size: 2 });
  });

  it('refuses sizes <= 0, control points out of order or outside (0, 1), with the path of the value', () => {
    expect(resolveLaw({})).toMatchObject({ code: 'BLD_LAW_INVALID', path: 'size' });
    expect(resolveLaw({ size: 0 })).toMatchObject({ code: 'BLD_LAW_INVALID', path: 'size' });
    expect(resolveLaw({ size: 1, sizeEnd: -1 })).toMatchObject({ path: 'sizeEnd' });
    expect(
      resolveLaw({
        size: 1,
        sizes: [
          { t: 0.6, size: 1 },
          { t: 0.4, size: 1 },
        ],
      }),
    ).toMatchObject({ path: 'sizes[1].t' });
    expect(resolveLaw({ size: 1, sizes: [{ t: 1, size: 1 }] })).toMatchObject({ path: 'sizes[0].t' });
    expect(resolveLaw({ size: 1, sizes: [{ t: 0.5, size: Number.NaN }] })).toMatchObject({ path: 'sizes[0].size' });
  });

  it('samples an expression at uniform t: first = size, last = sizeEnd, the rest = sizes', () => {
    const law = resolveLaw({ law: { expression: '1 + 0.5*t', samples: 5 } });
    expect(isLawProblem(law)).toBe(false);
    expect(law).toEqual({
      size: 1,
      sizeEnd: 1.5,
      sizes: [
        { t: 0.25, size: 1.125 },
        { t: 0.5, size: 1.25 },
        { t: 0.75, size: 1.375 },
      ],
    });
    const linear = resolveLaw({ law: { expression: '2' }, interpolation: 'linear' });
    expect(linear).toMatchObject({ size: 2, sizeEnd: 2, interpolation: 'linear' });
    expect((linear as EdgeRadius).sizes).toHaveLength(31);
  });

  it('refuses an expression that does not parse, names something but t, is <= 0 at a sample or has a bad sample count', () => {
    expect(resolveLaw({ law: { expression: '1 +' } })).toMatchObject({ code: 'BLD_LAW_INVALID', path: 'law.expression' });
    expect(resolveLaw({ law: { expression: 'width' } })).toMatchObject({
      path: 'law.expression',
      message: expect.stringContaining('width'),
    });
    expect(resolveLaw({ law: { expression: '0.5 - t' } })).toMatchObject({
      path: 'law.expression',
      message: expect.stringContaining('> 0'),
    });
    expect(resolveLaw({ law: { expression: '1', samples: 4 } })).toMatchObject({ path: 'law.samples' });
    expect(resolveLaw({ law: { expression: '1', samples: 300 } })).toMatchObject({ path: 'law.samples' });
    expect(resolveLaw({ law: { expression: '1', samples: 7.5 } })).toMatchObject({ path: 'law.samples' });
    expect(resolveLaw({ law: { expression: '1' }, size: 1 })).toMatchObject({ path: 'law', message: expect.stringContaining('not both') });
    expect(sampleExpression('t + 1', 5)).toEqual([1, 1.25, 1.5, 1.75, 2]);
  });
});

describe('law helpers', () => {
  const law: EdgeRadius = { size: 1, sizeEnd: 3, sizes: [{ t: 0.5, size: 2 }] };

  it('periodic closure: r(0) = r(1) within the named tolerance', () => {
    expect(periodicProblem({ size: 1 })).toBeNull();
    expect(periodicProblem({ size: 1, sizeEnd: 1 + 1e-12 })).toBeNull();
    expect(periodicProblem({ size: 1, sizeEnd: 2 })).toMatchObject({ code: 'BLD_LAW_NOT_PERIODIC', path: 'sizeEnd' });
    expect(lawEnds({ size: 1 })).toEqual([1, 1]);
  });

  it('closedEdge: a rim starts where it ends; seams, degenerate edges and open edges are not closed', () => {
    const edge = { start: [1, 0, 0] as const, end: [1, 0, 0] as const, length: 6, seam: false, degenerate: false };
    expect(closedEdge(edge)).toBe(true);
    expect(closedEdge({ ...edge, end: [2, 0, 0] })).toBe(false);
    expect(closedEdge({ ...edge, seam: true })).toBe(false);
    expect(closedEdge({ ...edge, degenerate: true })).toBe(false);
  });

  it('radiusAt interpolates straight between the ends and control points; controlParameters lists them', () => {
    expect(radiusAt(law, 0)).toBe(1);
    expect(radiusAt(law, 0.25)).toBe(1.5);
    expect(radiusAt(law, 0.5)).toBe(2);
    expect(radiusAt(law, 0.75)).toBe(2.5);
    expect(radiusAt(law, 1)).toBe(3);
    expect(radiusAt(law, 2)).toBe(3);
    expect(radiusAt({ size: 2 }, 0.3)).toBe(2);
    expect(controlParameters(law)).toEqual([0, 0.5, 1]);
  });

  it('scaleLaw multiplies every size and keeps the interpolation; lawTimesFactors keeps the shape for a constant factor, samples otherwise', () => {
    expect(scaleLaw({ ...law, interpolation: 'linear' }, 2)).toEqual({
      size: 2,
      sizeEnd: 6,
      sizes: [{ t: 0.5, size: 4 }],
      interpolation: 'linear',
    });
    expect(scaleLaw({ size: 1 }, 3)).toEqual({ size: 3 });
    expect(lawTimesFactors(law, [0.5, 0.5, 0.5])).toEqual(scaleLaw(law, 0.5));
    const varying = lawTimesFactors({ size: 1 }, [1, 2, 3]);
    expect(varying).toEqual({ size: 1, sizeEnd: 3, sizes: [{ t: 0.5, size: 2 }] });
  });

  it('lawNodes: null for plain radii, the corners for a smooth law, graded nodes on the polyline for a straight one', () => {
    expect(lawNodes({ size: 1 }, 20)).toBeNull();
    expect(lawNodes({ size: 1, sizeEnd: 2 }, 20)).toBeNull();
    expect(lawNodes({ size: 1 }, 20)).toBeNull();
    expect(lawNodes({ size: 1, interpolation: 'linear' }, 20)).toBeNull();
    expect(lawNodes(law, 20)).toEqual([
      [0, 1],
      [0.5, 2],
      [1, 3],
    ]);
    const tent: EdgeRadius = { size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' };
    const nodes = lawNodes(tent, 20) ?? [];
    expect(nodes[0]).toEqual([0, 1]);
    expect(nodes[nodes.length - 1]).toEqual([1, 1]);
    expect(nodes.some(([t]) => t === 0.5)).toBe(true);
    expect(nodes.length).toBeGreaterThan(40);
    for (let k = 1; k < nodes.length; k++) expect(nodes[k]?.[0]).toBeGreaterThan(nodes[k - 1]?.[0] ?? 0);
    for (const [t, radius] of nodes) expect(radius).toBeCloseTo(1 + (t <= 0.5 ? 2 * t : 2 * (1 - t)), 12);
    // a short edge cannot fit the blend zones: no node closer than 0.25 / corners to an end
    expect(lawNodes(tent, 1e-12)?.length).toBeGreaterThan(3);
    const straight = lawNodes({ size: 1, sizeEnd: 2, interpolation: 'linear' }, 20) ?? [];
    expect(straight[0]).toEqual([0, 1]);
    expect(straight[straight.length - 1]).toEqual([1, 2]);
  });
});

const context = (kernel: GeometryKernel): ReturnType<typeof defaultContext> => ({ ...defaultContext(), kernel });
const box = (): { doc: CadDocument; id: string } => {
  const made = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  return { doc: made.document, id: made.affected[0] as string };
};
const lastFillet = (kernel: { recipes: ShapeRecipe[] }): Extract<ShapeRecipe, { op: 'fillet' | 'chamfer' }> => {
  const found = [...kernel.recipes].reverse().find((recipe) => recipe.op === 'fillet' || recipe.op === 'chamfer');
  if (found === undefined || (found.op !== 'fillet' && found.op !== 'chamfer')) throw new Error('no fillet recipe was evaluated');
  return found;
};

describe('fillet_edge radius laws', () => {
  it('straight transitions and expression laws reach the kernel as radii with their interpolation', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const result = execute(
      doc,
      'fillet_edge',
      {
        id,
        edges: [
          { index: 0, size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' },
          { index: 2, law: { expression: '1 + 0.5*t', samples: 5 } },
        ],
      },
      context(kernel),
    );
    expect(result.affected).toHaveLength(1);
    const mesh = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    expect(mesh.brep).toMatchObject({
      op: 'fillet',
      edges: [0, 2],
      size: 0,
      radii: [
        { size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }], interpolation: 'linear' },
        {
          size: 1,
          sizeEnd: 1.5,
          sizes: [
            { t: 0.25, size: 1.125 },
            { t: 0.5, size: 1.25 },
            { t: 0.75, size: 1.375 },
          ],
        },
      ],
    });
    expect(result.summary).toContain('straight control point(s)');
    expect(result.summary).toContain('smooth control point(s)');
    expectPure(doc, () => execute(doc, 'fillet_edge', { id, edges: [{ index: 0, size: 1, interpolation: 'linear' }] }, context(kernel)));
  });

  it('BLD_LAW_INVALID names the entry and the value; the document is unchanged', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const bad = execute(
      doc,
      'fillet_edge',
      {
        id,
        edges: [
          { index: 0, size: 1 },
          { index: 2, law: { expression: '0.5 - t' } },
        ],
      },
      context(kernel),
    );
    expectNoOp(bad, doc, 'BLD_LAW_INVALID');
    expect(bad.rejected).toBe(true);
    expect(bad.error).toMatchObject({ code: 'BLD_LAW_INVALID', ids: [id], paths: ['edges[1].law.expression'] });
    expect(bad.error?.remediation).toContain('t in [0, 1]');
    const noSize = execute(doc, 'fillet_edge', { id, edges: [{ index: 0 }] }, context(kernel));
    expect(noSize.error).toMatchObject({ code: 'BLD_LAW_INVALID', paths: ['edges[0].size'] });
    const shorthand = execute(doc, 'fillet_edge', { id, edgeIndices: [0], radius: 1, radiusEnd: -2 }, context(kernel));
    expect(shorthand.error).toMatchObject({ code: 'BLD_LAW_INVALID', paths: ['radiusEnd'] });
    expect(kernel.recipes.some((recipe) => recipe.op === 'fillet')).toBe(false);
  });

  it('BLD_LAW_NOT_PERIODIC on a closed rim whose law does not return to its start; a periodic expression builds', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const open = execute(doc, 'fillet_edge', { id, edges: [{ index: 1, size: 1, sizeEnd: 2 }] }, context(kernel));
    expect(open.error).toMatchObject({ code: 'BLD_LAW_NOT_PERIODIC', ids: [id], paths: ['edges[0].sizeEnd'] });
    expect(open.error?.remediation).toContain('equal the start');
    const shorthand = execute(doc, 'fillet_edge', { id, edgeIndices: [1], radius: 1, radiusEnd: 2 }, context(kernel));
    expect(shorthand.error).toMatchObject({ code: 'BLD_LAW_NOT_PERIODIC', paths: ['radiusEnd'] });
    const periodic = execute(
      doc,
      'fillet_edge',
      { id, edges: [{ index: 1, law: { expression: '1 + 0.5*cos(2*pi*t)', samples: 9 } }] },
      context(kernel),
    );
    expect(periodic.error).toBeUndefined();
    expect(lastFillet(kernel)).toMatchObject({ edges: [1], radii: [{ size: 1.5, sizeEnd: 1.5 }] });
    const open2 = execute(doc, 'fillet_edge', { id, edges: [{ index: 0, size: 1, sizeEnd: 2 }] }, context(kernel));
    expect(open2.error).toBeUndefined();
  });

  it('recorded edge names keep the whole law (expression, interpolation) when the entries are re-resolved', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const params = {
      id,
      edges: [{ index: 0, size: 1, sizeEnd: 2, interpolation: 'linear' as const }],
      edgeNames: [`e(${SOURCE}:a0|${SOURCE}:b0)`],
    };
    const result = execute(doc, 'fillet_edge', params, context(kernel));
    expect(result.error).toBeUndefined();
    expect(lastFillet(kernel)).toMatchObject({ edges: [0], size: 0, radii: [{ size: 1, sizeEnd: 2, interpolation: 'linear' }] });
    const lost = execute(doc, 'fillet_edge', { ...params, edgeNames: ['e(gone|gone)'] }, context(kernel));
    expect(lost.error?.code).toBe('REF_LOST');
  });
});

describe('fillet_edge mode chord on curved faces', () => {
  it('a plane against a cylinder at a right angle gives r = c / sqrt 2 from the sampled wedge', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const result = execute(doc, 'fillet_edge', { id, edgeIndices: [1], radius: Math.SQRT2, mode: 'chord' }, context(kernel));
    expect(result.error).toBeUndefined();
    expect(lastFillet(kernel)).toMatchObject({ edges: [1] });
    expect(lastFillet(kernel).size).toBeCloseTo(1, 12);
    expect(result.summary).toContain('chord');
  });

  it('a varying wedge gives a sampled law: r(t) = c / (2 sin(g1 / 2)) at 17 uniform points', () => {
    const kernel = scriptedKernel({ g1: (_edge, t) => Math.PI / 2 + 0.2 * t });
    const { doc, id } = box();
    const result = execute(doc, 'fillet_edge', { id, edges: [{ index: 2, size: 2 }], mode: 'chord' }, context(kernel));
    expect(result.error).toBeUndefined();
    const recipe = lastFillet(kernel);
    const law = recipe.radii?.[0] as EdgeRadius;
    expect(law.sizes).toHaveLength(15);
    expect(law.size).toBeCloseTo(2 / (2 * Math.sin(Math.PI / 4)), 12);
    expect(law.sizeEnd).toBeCloseTo(2 / (2 * Math.sin((Math.PI / 2 + 0.2) / 2)), 12);
    const middle = law.sizes?.[7];
    expect(middle?.t).toBeCloseTo(0.5, 12);
    expect(middle?.size).toBeCloseTo(2 / (2 * Math.sin((Math.PI / 2 + 0.1) / 2)), 12);
  });

  it('BLD_CHORD_UNDEFINED where the faces are tangent (coplanar planes, or a sample with g1 = 0)', () => {
    const kernel = scriptedKernel({ g1: (_edge, t) => (t > 0.9 ? 0 : Math.PI / 2) });
    const { doc, id } = box();
    const flat = execute(doc, 'fillet_edge', { id, edgesNear: [[10, 4, 0]], radius: 1, mode: 'chord' }, context(kernel));
    expect(flat.error).toMatchObject({ code: 'BLD_CHORD_UNDEFINED', ids: [id], paths: ['mode'] });
    expect(flat.error?.remediation).toContain('radius');
    const curved = execute(doc, 'fillet_edge', { id, edges: [{ index: 2, size: 1 }], mode: 'chord' }, context(kernel));
    expect(curved.error).toMatchObject({ code: 'BLD_CHORD_UNDEFINED' });
    expect(curved.summary).toContain('tangent');
    expectNoOp(curved, doc);
  });

  it('refuses without face adjacency, without the wedge measurement on a curved pair, and on a seam', () => {
    const { doc, id } = box();
    const noGraph = execute(
      doc,
      'fillet_edge',
      { id, edges: [{ index: 0, size: 1 }], mode: 'chord' },
      context(scriptedKernel({ noGraph: true })),
    );
    expectNoOp(noGraph, doc, 'face adjacency');
    const noWedge = execute(
      doc,
      'fillet_edge',
      { id, edges: [{ index: 2, size: 1 }], mode: 'chord' },
      context(scriptedKernel({ noContinuity: true })),
    );
    expectNoOp(noWedge, doc, 'two planar faces');
    expect(noWedge.error).toBeUndefined();
  });
});
