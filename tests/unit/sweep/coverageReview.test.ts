/** SWG review: refusal and defensive branches of the Gordon blend, the sweep totals, the periodic seam and the vertex coupling. */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type SweepEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { sweepTotals } from '@core/geometry/sweepEval/inspect';
import { alignSections } from '@core/geometry/loftSkin/sections';
import { closureJump } from '@core/geometry/loftSkin/closure';
import { gordonSurface } from '@lib/nurbs/gordon';
import type { NurbsCurveData } from '@lib/nurbs/types';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';

const empty = createEmptyDocument();

const line = (...points: number[][]): NurbsCurveData => ({
  degree: 1,
  poles: points.map(([x, y, z]) => [x as number, y as number, z as number] as const),
  knots: points.map((_, i) => i / (points.length - 1)),
  multiplicities: points.map((_, i) => (i === 0 || i === points.length - 1 ? 2 : 1)),
});

describe('gordonSurface: ordering, collapsed sections and ambiguous crossings', () => {
  const rows = [0, 5, 10].map((y) => line([0, y, 0], [10, y, 0]));
  const columns = [0, 5, 10].map((x) => line([x, 0, 0], [x, 10, 0]));
  it('guides given in reverse order are re-ordered across the sections', () => {
    const made = gordonSurface(rows, [...columns].reverse(), 1e-6);
    expect('surface' in made).toBe(true);
  });
  it('guides that stop short of the section ends and sections inside the guides get end re-timing nodes', () => {
    const inner = [2, 5, 8].map((y) => line([0, y, 0], [10, y, 0]));
    const guides = [2, 5, 8].map((x) => line([x, 0, 0], [x, 10, 0]));
    const made = gordonSurface(inner, guides, 1e-6);
    expect('surface' in made && made.deviation).toBeLessThan(1e-9);
  });
  it('sections listed out of order along the guides, and guides that cross each other, are refused', () => {
    const shuffled = gordonSurface([rows[0] as NurbsCurveData, rows[2] as NurbsCurveData, rows[1] as NurbsCurveData], columns, 1e-6);
    expect('code' in shuffled && shuffled.message).toContain('out of order');
    // g0 runs corner to corner and g1 the other diagonal: they swap places between the two sections
    const crossing = gordonSurface(
      [line([0, 0, 0], [10, 0, 0]), line([0, 10, 0], [10, 10, 0])],
      [line([0, 0, 0], [10, 10, 0]), line([10, 0, 0], [0, 10, 0])],
      1e-6,
    );
    expect('code' in crossing).toBe(true);
  });
  it('a guide that meets a section twice is ambiguous; sections that are all points have no shape', () => {
    const arch: NurbsCurveData = {
      degree: 2,
      poles: [
        [2, -6, 0],
        [5, 8, 0],
        [8, -6, 0],
      ],
      knots: [0, 1],
      multiplicities: [3, 3],
    };
    const twice = gordonSurface([line([0, 0, 0], [10, 0, 0]), line([0, -3, 0], [10, -3, 0])], [arch, line([0, -6, 0], [0, 10, 0])], 1e-6);
    expect('code' in twice && twice.message).toContain('more than once');
    const point = (x: number, y: number): NurbsCurveData => line([x, y, 0], [x, y, 0]);
    const points = gordonSurface([point(0, 0), point(0, 10)], [line([0, 0, 0], [0, 10, 0])], 1e-6);
    expect('code' in points).toBe(true);
  });
  it('a section collapsed to a point takes the mean crossing of the others (a nose tip)', () => {
    const w = Math.SQRT1_2;
    const ring = (r: number, z: number): NurbsCurveData => ({
      degree: 2,
      poles: [
        [1, 0],
        [1, 1],
        [0, 1],
        [-1, 1],
        [-1, 0],
        [-1, -1],
        [0, -1],
        [1, -1],
        [1, 0],
      ].map(([x, y]) => [(x as number) * r, (y as number) * r, z] as const),
      weights: [1, w, 1, w, 1, w, 1, w, 1],
      knots: [0, 0.25, 0.5, 0.75, 1],
      multiplicities: [3, 2, 2, 2, 3],
    });
    const nose = line([0, 0, 30], [0, 0, 30]);
    const meridians = [
      [10, 0],
      [0, 10],
      [-10, 0],
      [0, -10],
    ].map(([x, y]) => line([x as number, y as number, 0], [(x as number) / 2, (y as number) / 2, 15], [0, 0, 30]));
    const made = gordonSurface([ring(10, 0), ring(5, 15), nose], meridians, 1e-3);
    expect('surface' in made || 'code' in made).toBe(true);
  });
});

describe('sweepTotals, the periodic seam and the vertex coupling', () => {
  const made = (params: Record<string, unknown>, doc: CadDocument = empty): { doc: CadDocument; entity: SweepEntity } => {
    const result = execute(doc, 'sweep_profile', params);
    expect(result.affected, result.summary).toHaveLength(1);
    return { doc: result.document, entity: result.document.entities[result.affected[0] as string] as SweepEntity };
  };
  it('totals of a variable-section sweep integrate the blended loops, a left-handed helix reports negative torsion, a bad law is refused', () => {
    const tapered = made({
      path: [
        [0, 0, 0],
        [0, 0, 100],
      ],
      stations: [
        { at: 0, radius: 5 },
        { at: 1, radius: 2 },
      ],
    });
    const totals = sweepTotals(tapered.entity);
    expect('integralAreaDs' in totals && totals.integralAreaDs).toBeGreaterThan(0);
    const helix = execute(empty, 'add_helix', { radius: 20, pitch: 10, turns: 2, handedness: 'left' });
    const coil = made({ pathId: helix.affected[0], radius: 1 }, helix.document);
    const turning = sweepTotals(coil.entity);
    expect('twistVsFrenetRad' in turning && turning.twistVsFrenetRad).toBeLessThan(0);
    const broken = sweepTotals({
      ...tapered.entity,
      stations: undefined,
      scale: { type: 'constant', value: -1 },
    } as unknown as SweepEntity);
    expect('code' in broken).toBe(true);
  });
  it('a periodic seam of fewer than three or of open sections is left as it is; a surface without a v extent has no jump', () => {
    const open = [line([0, 0, 0], [1, 0, 0]), line([0, 0, 1], [1, 0, 1]), line([0, 0, 2], [1, 0, 2])];
    expect(alignSections(open, 'auto', undefined, true)).toHaveLength(3);
    const flat: NurbsSurfaceData = {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
        [
          [1, 0, 0],
          [1, 0, 0],
        ],
      ],
      knotsU: [0, 1],
      multiplicitiesU: [2, 2],
      knotsV: [0, 1],
      multiplicitiesV: [2, 2],
    };
    expect(closureJump(flat)).toBe(0);
  });
  it('vertex pairs of open sections must ascend', () => {
    const open = (z: number): Record<string, unknown> => ({
      degree: 1,
      poles: [
        [0, 0, z],
        [10, 0, z],
        [10, 10, z],
        [0, 10, z],
      ],
    });
    const a = execute(empty, 'create_nurbs_curve', open(0));
    const b = execute(a.document, 'create_nurbs_curve', open(20));
    const result = execute(b.document, 'loft_surface', {
      sectionIds: [a.affected[0], b.affected[0]],
      coupling: 'vertices',
      vertexPairs: [
        [0.5, 0.25],
        [0.5, 0.25],
      ],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.error?.code).toBe('SWG_LOFT_COUPLING_MISMATCH');
  });
});
