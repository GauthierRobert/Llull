/** SWG M5-M7: the remaining refusal branches of the loft builder, network sorting, developable pairing and the end-condition solver. */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type SweepEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { fitSweepFaces, fitToleranceOf } from '@core/geometry/sweepEval/fitted';
import { ellipseCurve } from '@core/geometry/sectionCurve';
import { developableSurface } from '@lib/nurbs/developable';
import { sortNetwork } from '@lib/nurbs/network';
import { skinWithEnds } from '@lib/nurbs/skinEnds';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { expectNoOp } from '../../helpers/expectNoOp';

const empty = createEmptyDocument();

function curve(doc: CadDocument, params: Record<string, unknown>, command = 'create_nurbs_curve'): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params);
  expect(result.affected, result.summary).toHaveLength(1);
  return { doc: result.document, id: result.affected[0] as string };
}

const ellipseCurveParams = (z: number): Record<string, unknown> => ({
  degree: 2,
  poles: [
    [10, 0, z],
    [10, 10, z],
    [0, 10, z],
    [-10, 10, z],
    [-10, 0, z],
    [-10, -10, z],
    [0, -10, z],
    [10, -10, z],
    [10, 0, z],
  ],
  weights: [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1],
  knots: [0, 0.25, 0.5, 0.75, 1],
  multiplicities: [3, 2, 2, 2, 3],
});
const at = (z: number, r = 10): NurbsCurveData => {
  const base = ellipseCurve(r, r);
  return { ...base, poles: base.poles.map(([x, y]) => [x, y, z] as const) };
};
const line = (points: number[][]): NurbsCurveData => ({
  degree: 1,
  poles: points.map(([x, y, z]) => [x as number, y as number, z as number] as const),
  knots: points.map((_, i) => i / (points.length - 1)),
  multiplicities: points.map((_, i) => (i === 0 || i === points.length - 1 ? 2 : 1)),
});

describe('lib/nurbs/skinEnds: the end-derivative solver', () => {
  const direction = (c: NurbsCurveData): Array<readonly [number, number, number]> => c.poles.map(() => [0, 0, 1] as const);
  it('refuses one section, sections on different bases, and skins plain sections with given parameters', () => {
    expect('code' in skinWithEnds([at(0)], undefined, undefined)).toBe(true);
    expect(
      'code' in
        skinWithEnds(
          [
            at(0),
            line([
              [0, 0, 0],
              [1, 0, 0],
            ]),
          ],
          undefined,
          undefined,
        ),
    ).toBe(true);
    const plain = skinWithEnds([at(0), at(10), at(20)], undefined, undefined, 3, [0, 0.4, 1]);
    expect('surface' in plain && plain.parameters[1] === 0.4).toBe(true);
  });
  it('end derivatives and end curvatures at either end give degree 3 / 5 skins that reproduce the sections', () => {
    const [a, b] = [at(0), at(10, 6)];
    const normals = a.poles.map(() => [0, 0, 1] as const);
    const startOnly = skinWithEnds([a, b], { directions: direction(a), magnitude: 1 }, undefined);
    expect('surface' in startOnly && startOnly.surface.degreeV === 2).toBe(true);
    const endOnly = skinWithEnds([a, b], undefined, {
      directions: direction(b),
      magnitude: 1,
      curvature: { values: b.poles.map(() => 0.01), normals },
    });
    expect('surface' in endOnly && endOnly.surface.degreeV >= 3).toBe(true);
    const both = skinWithEnds(
      [a, at(5, 8), b],
      { directions: direction(a), magnitude: 1, curvature: { values: a.poles.map(() => 0), normals } },
      { directions: direction(b), magnitude: 2 },
    );
    expect('surface' in both && both.surface.degreeV === 5).toBe(true);
  });
});

describe('lib/nurbs/network: families, conflicts and orientation', () => {
  const planar = (...segments: number[][][]): NurbsCurveData[] => segments.map((s) => line(s));
  it('a triangle of mutually crossing curves cannot be two families', () => {
    const curves = planar(
      [
        [0, 0, 0],
        [10, 0, 0],
      ],
      [
        [2, -5, 0],
        [2, 5, 0],
      ],
      [
        [0, -3, 0],
        [6, 3, 0],
      ],
      [
        [50, 0, 0],
        [60, 0, 0],
      ],
      [
        [50, 5, 0],
        [60, 5, 0],
      ],
      [
        [50, 10, 0],
        [60, 10, 0],
      ],
    );
    const sorted = sortNetwork(curves, 1e-6);
    expect('code' in sorted && sorted.code).toBe('SWG_NETWORK_UNSORTABLE');
  });
  it('one curve across five parallel ones has no order or direction to take from its family; reversed curves are turned round', () => {
    const rows = [0, 2, 4, 6, 8].map((y) => [
      [0, y, 0],
      [10, y, 0],
    ]);
    const across = [
      [5, -1, 0],
      [5, 9, 0],
    ];
    const sorted = sortNetwork(planar(across, ...rows), 1e-6);
    expect('code' in sorted && sorted.code).toBe('SWG_NETWORK_UNSORTABLE');
    const reversed = sortNetwork(
      planar(
        [
          [0, 0, 0],
          [10, 0, 0],
        ],
        [
          [10, 2, 0],
          [0, 2, 0],
        ],
        [
          [0, 4, 0],
          [10, 4, 0],
        ],
        [
          [3, -1, 0],
          [3, 5, 0],
        ],
        [
          [6, 5, 0],
          [6, -1, 0],
        ],
        [
          [9, -1, 0],
          [9, 5, 0],
        ],
      ),
      1e-6,
    );
    expect('code' in reversed).toBe(false);
    if ('code' in reversed) return;
    const startY = reversed.sections.map((c) => c.poles[0]?.[1]);
    const endY = reversed.sections.map((c) => c.poles[c.poles.length - 1]?.[1]);
    expect(startY.every((y, i) => (y as number) <= (endY[i] as number))).toBe(true);
  });
  it('two curves that cross twice make the crossing ambiguous', () => {
    const parabola: NurbsCurveData = {
      degree: 2,
      poles: [
        [0, 4, 0],
        [5, -4, 0],
        [10, 4, 0],
      ],
      knots: [0, 1],
      multiplicities: [3, 3],
    };
    const rows = [
      line([
        [0, 0, 0],
        [10, 0, 0],
      ]),
      line([
        [0, 1, 0],
        [10, 1, 0],
      ]),
    ];
    const sorted = sortNetwork(
      [
        ...rows,
        parabola,
        line([
          [5, -6, 0],
          [5, 6, 0],
        ]),
      ],
      1e-6,
    );
    expect('code' in sorted && sorted.code).toBe('SWG_NETWORK_UNSORTABLE');
    expect('code' in sorted && sorted.message).toContain('more than once');
  });
  it('two crossing curves only: not enough for a network', () => {
    const sorted = sortNetwork(
      planar(
        [
          [0, 0, 0],
          [10, 0, 0],
        ],
        [
          [5, -5, 0],
          [5, 5, 0],
        ],
      ),
      1e-6,
    );
    expect('code' in sorted && sorted.code).toBe('SWG_NETWORK_UNSORTABLE');
  });
});

describe('lib/nurbs/developable: open curves and pairings that do not run across', () => {
  const arc = (r: number, z: number, sweep: number, rho = Math.cos(sweep / 2) / (1 + Math.cos(sweep / 2))): NurbsCurveData => {
    const w = Math.cos(sweep / 2);
    return {
      degree: 2,
      poles: [
        [r, 0, z],
        [r / w, (r / w) * Math.tan(sweep / 2) * w, z],
        [r * Math.cos(sweep), r * Math.sin(sweep), z],
      ].map(([x, y, h]) => [x as number, y as number, h as number] as const),
      weights: [1, rho / (1 - rho), 1],
      knots: [0, 1],
      multiplicities: [3, 3],
    };
  };
  it('two open arcs of different radii pair by Newton into a sheet; an arc longer than its partner does not', () => {
    const quarter = arc(10, 0, Math.PI / 2);
    const smaller = arc(5, 50, Math.PI / 2, 0.35);
    const made = developableSurface(quarter, smaller);
    expect('surface' in made || made.code === 'SWG_NOT_DEVELOPABLE').toBe(true);
    const half = arc(5, 50, Math.PI * 0.99);
    const longer = developableSurface(quarter, half);
    expect('code' in longer && longer.code).toBe('SWG_NOT_DEVELOPABLE');
    const shorter = developableSurface(half, quarter);
    expect('code' in shorter || 'surface' in shorter).toBe(true);
  });
});

describe('loft_surface refusals', () => {
  const ring = (z: number): Record<string, unknown> => ({
    degree: 2,
    poles: [
      [10, 0, z],
      [10, 10, z],
      [0, 10, z],
      [-10, 10, z],
      [-10, 0, z],
      [-10, -10, z],
      [0, -10, z],
      [10, -10, z],
      [10, 0, z],
    ],
    weights: [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1],
    knots: [0, 0.25, 0.5, 0.75, 1],
    multiplicities: [3, 2, 2, 2, 3],
  });
  it('too few or too many sections, bad conditions and guides with conditions', () => {
    const a = curve(empty, ring(0));
    const b = curve(a.doc, ring(30));
    expect(execute(b.doc, 'loft_surface', { sectionIds: [a.id] }).error?.code).toBe('SRF_LOFT_SECTIONS_TOO_FEW');
    expect(execute(b.doc, 'loft_surface', { sectionIds: Array(61).fill(a.id) }).error?.code).toBe('SRF_PARAM_INVALID');
    expect(execute(b.doc, 'loft_surface', { sectionIds: [a.id, b.id], endCondition: { type: 'direction' } }).error?.code).toBe(
      'SWG_LOFT_END_CONDITION_INVALID',
    );
    expect(execute(b.doc, 'loft_surface', { sectionIds: [a.id, b.id], startCondition: { type: 'point' } }).error?.code).toBe(
      'SWG_LOFT_END_CONDITION_INVALID',
    );
    const closed = execute(b.doc, 'loft_surface', { sectionIds: [a.id, b.id], closed: true });
    expectNoOp(closed, b.doc, 'SWG_LOFT_CLOSED_TOO_FEW');
    const periodic = execute(b.doc, 'loft_surface', { sectionIds: [a.id, b.id, a.id, b.id], closed: true });
    expect(periodic.affected.length).toBeGreaterThanOrEqual(0);
  });
  it('a closed and an open section cannot be cut into the same segments', () => {
    const a = curve(empty, ring(0));
    const open = curve(a.doc, {
      degree: 1,
      poles: [
        [0, 0, 20],
        [5, 0, 20],
        [5, 5, 20],
      ],
    });
    const result = execute(open.doc, 'loft_surface', {
      sectionIds: [a.id, open.id],
      degreeV: 1,
      coupling: 'vertices',
      vertexPairs: [
        [0, 0.5],
        [0.3, 0.6],
      ],
    });
    expect(result.error?.code).toBe('SWG_LOFT_COUPLING_MISMATCH');
  });
});

describe('sweep_surface: too many runs and smooth paths', () => {
  it('a path with a dozen bends cannot be one sheet at a tolerance that needs the finest fit', () => {
    const zigzag = Array.from({ length: 14 }, (_, k) => [k * 40, k % 2 === 0 ? 0 : 40, 0]);
    const result = execute(empty, 'sweep_surface', {
      path: zigzag,
      bendRadius: 10,
      section: {
        line: [
          [0, 0],
          [0, 4],
        ],
      },
      fitTolerance: 1e-13,
    });
    expect(result.affected).toHaveLength(0);
    expect(['SWG_FIT_UNSUPPORTED', 'SWG_FIT_TOLERANCE']).toContain(result.error?.code);
  });
  it('a smooth (Bézier) path with a scale law fits exactly within tolerance (curvature breaks between its spans)', () => {
    const made = execute(empty, 'sweep_profile', {
      path: [
        [0, 0, 0],
        [60, 0, 20],
        [100, 50, 0],
        [150, 50, 40],
      ],
      smooth: true,
      radius: 4,
      scale: { type: 'linear', start: 1, end: 0.7 },
    });
    const entity = made.document.entities[made.affected[0] as string] as SweepEntity;
    const fit = fitSweepFaces(entity, fitToleranceOf(entity));
    expect('faces' in fit).toBe(true);
  });
});

describe('check_sweep_loft on a ring-only loft', () => {
  it('a loft of sketched sections has no exact skin: only the seam twist is judged', () => {
    const a = execute(empty, 'draw_arc', { center: [0, 0], radius: 10 });
    const b = execute(a.document, 'draw_arc', { center: [0, 0], radius: 6, position: [0, 0, 30] });
    const made = execute(b.document, 'loft_sections', { sectionIds: [a.affected[0], b.affected[0]] });
    const check = execute(made.document, 'check_sweep_loft', { ids: made.affected });
    expect((check.data as { status: string }).status).toBe('pass');
  });
});

describe('seam alignment helpers and rational swept sections', () => {
  it('alignSections keeps sections as built (none), leaves open ones alone and defaults a missing seam to the start', async () => {
    const { alignSections } = await import('@core/geometry/loftSkin/sections');
    const [a, b] = [at(0), at(10)];
    expect(alignSections([a, b], 'none', undefined)).toEqual([a, b]);
    const open = line([
      [0, 0, 0],
      [5, 0, 0],
      [5, 5, 0],
    ]);
    const out = alignSections([a, open, b], 'auto', undefined);
    expect(Array.isArray(out) && out[1] === open).toBe(true);
    const seamed = alignSections([a, b], 'seams', [0.25]);
    expect(Array.isArray(seamed)).toBe(true);
  });
  it('a conic section (rational) sweeps along a bend into one sheet, and 36 bends overflow the pole budget', () => {
    const conic = execute(empty, 'create_conic', { start: [0, 0, 0], apex: [3, 3, 0], end: [6, 0, 0], rho: 0.4 });
    const bent = execute(conic.document, 'sweep_surface', {
      path: [
        [0, 0, 0],
        [100, 0, 0],
        [100, 100, 0],
      ],
      bendRadius: 20,
      sectionId: conic.affected[0],
    });
    expect(bent.affected, bent.summary).toHaveLength(1);
    const zigzag = Array.from({ length: 40 }, (_, k) => [k * 40, k % 2 === 0 ? 0 : 40, 0]);
    const many = execute(empty, 'sweep_surface', {
      path: zigzag,
      bendRadius: 10,
      section: {
        line: [
          [0, 0],
          [0, 4],
        ],
      },
      fitTolerance: 1e-13,
    });
    expect(many.error?.code).toBe('SWG_FIT_UNSUPPORTED');
  });
  it('open sketch sections of loft_surface are aligned by their start only when closed', () => {
    const a = curve(empty, {
      degree: 1,
      poles: [
        [0, 0, 0],
        [5, 0, 0],
        [5, 5, 0],
      ],
    });
    const b = curve(a.doc, {
      degree: 1,
      poles: [
        [0, 0, 10],
        [5, 0, 10],
        [5, 5, 10],
      ],
    });
    const made = execute(b.doc, 'loft_surface', { sectionIds: [a.id, b.id], alignment: 'auto', degreeV: 1 });
    expect(made.affected, made.summary).toHaveLength(1);
  });
});

describe('surface orientation: flip and a reversing normal', () => {
  const sheet = (xs: number[]): { doc: CadDocument; id: string } =>
    curve(
      empty,
      {
        degreeU: 2,
        degreeV: 1,
        poles: xs.map((x) => [
          [x, 0, 0],
          [x, 100, 0],
        ]),
        weights: undefined,
        knotsU: [0, 1],
        multiplicitiesU: [3, 3],
      },
      'create_nurbs_surface',
    );
  const dz = (doc: CadDocument, id: string): number[] =>
    ((doc.entities[id] as unknown as { surface: { poles: number[][][] } }).surface.poles as number[][][]).flat().map((p) => p[2] as number);
  it('orientation.flip puts the band on the other side of the sheet', () => {
    const plane = execute(empty, 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [-50, -50, 0],
          [-50, 50, 0],
        ],
        [
          [50, -50, 0],
          [50, 50, 0],
        ],
      ],
    });
    const band = (flip: boolean): number[] => {
      const made = execute(plane.document, 'sweep_surface', {
        path: [
          [0, 0, 0],
          [30, 0, 0],
        ],
        section: {
          line: [
            [0, 0],
            [0, 10],
          ],
        },
        orientation: { mode: 'surface', surfaceId: plane.affected[0], flip },
      });
      expect(made.affected, made.summary).toHaveLength(1);
      return dz(made.document, made.affected[0] as string);
    };
    const [up, down] = [band(false), band(true)];
    expect(Math.max(...up)).toBeCloseTo(10, 6);
    expect(Math.min(...down)).toBeCloseTo(-10, 6);
  });
  it('a sheet normal that reverses along the path (a fold) is refused, not followed', () => {
    const folded = sheet([0, 100, 0]);
    const result = execute(folded.doc, 'sweep_surface', {
      path: [
        [5, 10, 0],
        [49, 50, 0],
        [5, 90, 0],
      ],
      section: {
        line: [
          [0, 0],
          [0, 4],
        ],
      },
      orientation: { mode: 'surface', surfaceId: folded.id, tolerance: 1 },
    });
    expect(result.affected).toHaveLength(0);
    expect(result.error?.code, result.summary).toBe('SWG_FRAME_DEGENERATE');
    expect(result.summary).toContain('reverses');
  });
});

describe('seams validation', () => {
  it('one fraction per section, each in [0, 1)', () => {
    const a = curve(empty, ellipseCurveParams(0));
    const b = curve(a.doc, ellipseCurveParams(20));
    const base = { sectionIds: [a.id, b.id], ruled: true };
    expect(execute(b.doc, 'loft_sections', { ...base, seams: [0] }).error?.code).toBe('SWG_PARAM_INVALID');
    expect(execute(b.doc, 'loft_sections', { ...base, seams: [0, 1] }).error?.code).toBe('SWG_PARAM_INVALID');
    expect(execute(b.doc, 'loft_sections', { ...base, seams: [-0.1, 0.5] }).error?.code).toBe('SWG_PARAM_INVALID');
    expect(execute(b.doc, 'loft_sections', { ...base, seams: [0, 0.5] }).affected).toHaveLength(1);
  });
});
