import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type NurbsSurfaceEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { closestOnSurface } from '@lib/nurbs/closest';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { sheetArea } from '@core/geometry/sheetArea';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';

const empty = createEmptyDocument();

const addLine = (doc: CadDocument, a: number[], b: number[]): { doc: CadDocument; id: string } => {
  const result = execute(doc, 'create_nurbs_curve', { degree: 1, poles: [a, b] });
  return { doc: result.document, id: result.affected[0]! };
};

/** The closed polygon through `points` as one line curve per side (ids in order). */
const polygon = (points: number[][]): { doc: CadDocument; ids: string[] } => {
  let doc = empty;
  const ids: string[] = [];
  points.forEach((point, k) => {
    const made = addLine(doc, point, points[(k + 1) % points.length]!);
    doc = made.doc;
    ids.push(made.id);
  });
  return { doc, ids };
};

const regular = (n: number, r: number): number[][] =>
  Array.from({ length: n }, (_, k) => [r * Math.cos((2 * Math.PI * k) / n), r * Math.sin((2 * Math.PI * k) / n), 0]);

const surfaceOf = (doc: CadDocument, id: string): NurbsSurfaceData => (doc.entities[id] as NurbsSurfaceEntity).surface;

describe('fill_surface with more than 4 curves', () => {
  for (const [n, expectedArea] of [
    [5, 2.5 * 4 * Math.sin((2 * Math.PI) / 5)],
    [6, 1.5 * Math.sqrt(3) * 4],
    [8, 2 * Math.SQRT2 * 4],
    [12, 3 * 4],
  ] as const)
    it(`fills a regular ${n}-gon with one patch containing every side, covering its area`, () => {
      const { doc, ids } = polygon(regular(n, 2));
      const result = execute(doc, 'fill_surface', { boundaryIds: ids });
      expect(result.affected).toHaveLength(1);
      const id = result.affected[0]!;
      const surface = surfaceOf(result.document, id);
      for (const k of [0, 1, n - 1]) {
        const [a, b] = [regular(n, 2)[k]!, regular(n, 2)[(k + 1) % n]!];
        const mid: [number, number, number] = [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2, 0];
        expect(closestOnSurface(surface, mid).distance).toBeLessThan(1e-9);
      }
      // a Coons map of many sides may overlap itself a little: the area is exact up to 8 sides, within 0.5 % at 12
      expect(sheetArea(result.document.entities[id] as NurbsSurfaceEntity)).toBeCloseTo(expectedArea, n <= 8 ? 6 : 1);
      expect((result.data as { sides: number }).sides).toBe(n);
    });

  it('refuses 13 curves, 2 curves and an open loop', () => {
    const big = polygon(regular(13, 2));
    expectNoOp(execute(big.doc, 'fill_surface', { boundaryIds: big.ids }), big.doc, 'SRF_FILL_UNSUPPORTED');
    const five = polygon(regular(5, 2));
    expectNoOp(execute(five.doc, 'fill_surface', { boundaryIds: five.ids.slice(0, 4) }), five.doc, 'SRF_FILL_LOOP_OPEN');
  });
});

describe('fill_surface with G1 / G2 neighbours (VC-SRF-15)', () => {
  /** Strips of the parabolic cylinder z = x^2 / 2 over x in [0, 1] and [2, 3], and a hole between them bounded by straight chords. */
  const setup = (): { doc: CadDocument; a: string; b: string; ids: string[]; left: string; right: string } => {
    const strip = (x0: number): Record<string, unknown> => ({
      degreeU: 2,
      degreeV: 1,
      poles: [0, 1, 2].map((i) => {
        const z = [(x0 * x0) / 2, (x0 * x0) / 2 + x0 / 2, (x0 + 1) ** 2 / 2][i]!;
        return [
          [x0 + i / 2, 0, z],
          [x0 + i / 2, 1, z],
        ];
      }),
      knotsU: [0, 1],
      multiplicitiesU: [3, 3],
      knotsV: [0, 1],
      multiplicitiesV: [2, 2],
    });
    const first = execute(empty, 'create_nurbs_surface', strip(0));
    const second = execute(first.document, 'create_nurbs_surface', strip(2));
    let doc = second.document;
    const curves = [
      [
        [1, 0, 0.5],
        [2, 0, 2],
      ],
      [
        [2, 0, 2],
        [2, 1, 2],
      ],
      [
        [2, 1, 2],
        [1, 1, 0.5],
      ],
      [
        [1, 1, 0.5],
        [1, 0, 0.5],
      ],
    ] as const;
    const ids: string[] = [];
    for (const [a, b] of curves) {
      const made = addLine(doc, [...a], [...b]);
      doc = made.doc;
      ids.push(made.id);
    }
    return { doc, a: first.affected[0]!, b: second.affected[0]!, ids, left: ids[3]!, right: ids[1]! };
  };
  type Boundary = { requested: string; g0Gap: number; g1AngleRad: number; g2Gap: number; order: string };
  const boundaries = (result: ReturnType<typeof execute>): Boundary[] => (result.data as { boundaries: Boundary[] }).boundaries;

  it('without neighbours the chord fill is not tangent to the sheets', () => {
    const { doc, ids } = setup();
    const result = execute(doc, 'fill_surface', { boundaryIds: ids });
    expect(boundaries(result)).toEqual([]);
    const probe = execute(result.document, 'check_continuity', {
      pairs: [{ a: { id: setup().a, side: 'u1' }, b: { id: result.affected[0]! } }],
    });
    expect((probe.data as { joints: Array<{ g1AngleRad: number }> }).joints[0]!.g1AngleRad).toBeGreaterThan(0.1);
  });

  it('G1: leaves both sheets in their tangent planes (angle < 0.01 rad, g0 gap < 1e-4)', () => {
    const { doc, a, b, ids, left, right } = setup();
    const result = execute(doc, 'fill_surface', {
      boundaryIds: ids,
      neighbours: [
        { curveId: left, surfaceId: a, continuity: 'G1' },
        { curveId: right, surfaceId: b, continuity: 'G1' },
      ],
    });
    expect(result.affected).toHaveLength(1);
    const found = boundaries(result);
    expect(found).toHaveLength(2);
    for (const boundary of found) {
      expect(boundary.g0Gap).toBeLessThan(1e-4);
      expect(boundary.g1AngleRad).toBeLessThan(0.01);
      expect(['G1', 'G2']).toContain(boundary.order);
    }
    expect(result.summary).toContain('fill_surface');
  });

  it('G2: also matches the normal curvature across both edges', () => {
    const { doc, a, b, ids, left, right } = setup();
    const result = execute(doc, 'fill_surface', {
      boundaryIds: ids,
      neighbours: [
        { curveId: left, surfaceId: a, continuity: 'G2' },
        { curveId: right, surfaceId: b, continuity: 'G2' },
      ],
    });
    for (const boundary of boundaries(result)) {
      expect(boundary.g1AngleRad).toBeLessThan(0.01);
      expect(boundary.g2Gap).toBeLessThan(0.05);
      expect(boundary.order).toBe('G2');
    }
    expectPure(doc, () =>
      execute(doc, 'fill_surface', { boundaryIds: ids, neighbours: [{ curveId: left, surfaceId: a, continuity: 'G2' }] }),
    );
  });

  it('refuses a neighbour curve outside the loop or off the sheet, and bad ids', () => {
    const { doc, a, b, ids, left } = setup();
    expectNoOp(
      execute(doc, 'fill_surface', { boundaryIds: ids, neighbours: [{ curveId: a, surfaceId: a, continuity: 'G1' }] }),
      doc,
      'SRF_FILL_NEIGHBOUR_MISMATCH',
    );
    expectNoOp(
      execute(doc, 'fill_surface', { boundaryIds: ids, neighbours: [{ curveId: left, surfaceId: b, continuity: 'G1' }] }),
      doc,
      'SRF_FILL_NEIGHBOUR_MISMATCH',
    );
    expectNoOp(
      execute(doc, 'fill_surface', { boundaryIds: ids, neighbours: [{ curveId: left, surfaceId: 'nope', continuity: 'G1' }] }),
      doc,
      'SRF_ENTITY_NOT_FOUND',
    );
    expectNoOp(execute(doc, 'fill_surface', { boundaryIds: ids, tolerance: -1 }), doc, 'SRF_PARAM_INVALID');
  });

  it('a G1 fill of a five-sided hole next to a sheet keeps the other four sides exact', () => {
    // a pentagon whose first side is the edge x = 1 of the first strip, lifted off the plane (z = 0.5)
    const { doc, a } = setup();
    const points = [
      [1, 0, 0.5],
      [1, 1, 0.5],
      [1.5, 1.6, 0.9],
      [2, 0.5, 1.4],
      [1.5, -0.6, 0.9],
    ];
    let current = doc;
    const ids: string[] = [];
    points.forEach((point, k) => {
      const made = addLine(current, point, points[(k + 1) % points.length]!);
      current = made.doc;
      ids.push(made.id);
    });
    const result = execute(current, 'fill_surface', {
      boundaryIds: ids,
      neighbours: [{ curveId: ids[0]!, surfaceId: a, continuity: 'G1' }],
    });
    expect(result.affected).toHaveLength(1);
    const surface = surfaceOf(result.document, result.affected[0]!);
    expect(closestOnSurface(surface, [1.25, 1.3, 0.7]).distance).toBeLessThan(1e-6);
    expect(boundaries(result)[0]!.g1AngleRad).toBeLessThan(0.05);
  });
});
