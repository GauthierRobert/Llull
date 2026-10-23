/** SWG M4-M8: refusal and edge branches of rails, lofts, coupling, developable pairing, mitre and the curve helpers. */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type LoftEntity, type SweepEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { arcLengthSamples } from '@lib/nurbs/arcSample';
import { cornerFractions, parameterAtLengthFraction, splitCurve } from '@lib/nurbs/curveSplit';
import { developableSurface } from '@lib/nurbs/developable';
import { evaluateCurve } from '@lib/nurbs/evaluate';
import { reseamCurve } from '@lib/nurbs/reseam';
import { arcLengthPair, ruledPatch } from '@lib/nurbs/ruled';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { applyMiter } from '@core/geometry/sweepEval/miter';
import { sweepFrames } from '@core/geometry/sweep';
import { expectNoOp } from '../../helpers/expectNoOp';
import { loftFacesVolume } from '../../helpers/loftVolume';
import { relError } from '../../helpers/swgPack';

const empty = createEmptyDocument();

function curve(doc: CadDocument, params: Record<string, unknown>, command = 'create_nurbs_curve'): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params);
  expect(result.affected, result.summary).toHaveLength(1);
  return { doc: result.document, id: result.affected[0] as string };
}

const W = Math.SQRT1_2;
const circlePoles = (r: number, z: number, turn = 0): number[][] => {
  const ring = [
    [r, 0],
    [r, r],
    [0, r],
    [-r, r],
    [-r, 0],
    [-r, -r],
    [0, -r],
    [r, -r],
    [r, 0],
  ];
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  return ring.map(([x, y]) => [(x as number) * c - (y as number) * s, (x as number) * s + (y as number) * c, z]);
};
const circle = (doc: CadDocument, r: number, z: number, turn = 0): { doc: CadDocument; id: string } =>
  curve(doc, {
    degree: 2,
    poles: circlePoles(r, z, turn),
    weights: [1, W, 1, W, 1, W, 1, W, 1],
    knots: [0, 0.25, 0.5, 0.75, 1],
    multiplicities: [3, 2, 2, 2, 3],
  });

function loft(
  doc: CadDocument,
  params: Record<string, unknown>,
): { entity: LoftEntity; data: Record<string, number | null>; doc: CadDocument } {
  const result = execute(doc, 'loft_sections', params);
  expect(result.affected, result.summary).toHaveLength(1);
  return {
    entity: result.document.entities[result.affected[0] as string] as LoftEntity,
    data: result.data as Record<string, number | null>,
    doc: result.document,
  };
}

describe('lofts through sketches and inline sections', () => {
  it('rectangle and circle sketches become exact sections and keep their volume (rectangle -> circle, auto seams)', () => {
    const rect = execute(empty, 'draw_rectangle', { width: 20, height: 20, position: [-10, -10, 0] });
    const disc = execute(rect.document, 'draw_arc', { center: [0, 0], radius: 10, position: [0, 0, 50] });
    const { entity } = loft(disc.document, { sectionIds: [rect.affected[0], disc.affected[0]], ruled: true, alignment: 'auto' });
    expect(entity.faces?.length).toBeGreaterThan(0);
    expect(loftFacesVolume(entity)).toBeGreaterThan(50 * Math.PI * 100);
    expect(loftFacesVolume(entity)).toBeLessThan(50 * 400);
  });
  it('a polyline sketch and a spline sketch join through chain curves', () => {
    const poly = execute(empty, 'draw_polyline', {
      points: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ],
      closed: true,
    });
    const spline = execute(poly.document, 'draw_spline', {
      points: [
        [-8, -8],
        [8, -8],
        [8, 8],
        [-8, 8],
      ],
      closed: true,
      position: [0, 0, 40],
    });
    const made = execute(spline.document, 'loft_sections', { sectionIds: [poly.affected[0], spline.affected[0]], alignment: 'auto' });
    expect(made.affected, made.summary).toHaveLength(1);
  });
  it('inline ellipse, polygon and sketch sections; bad inline specs are refused', () => {
    const ellipse = loft(empty, {
      sections: [
        { center: [0, 0, 0], radiusX: 10, radiusY: 5 },
        { center: [0, 0, 30], radiusX: 5, radiusY: 10 },
      ],
      alignment: 'auto',
    });
    expect(loftFacesVolume(ellipse.entity)).toBeGreaterThan(0);
    const polygon = loft(empty, {
      sections: [
        {
          center: [0, 0, 0],
          section: [
            [-5, -5],
            [5, -5],
            [5, 5],
            [-5, 5],
          ],
        },
        {
          center: [0, 0, 20],
          section: [
            [-3, -3],
            [3, -3],
            [3, 3],
            [-3, 3],
          ],
        },
      ],
      alignment: 'auto',
    });
    expect(relError(loftFacesVolume(polygon.entity), (20 * (100 + 6 * 10 + 36)) / 3)).toBeLessThan(0.02);
    const sketch = execute(empty, 'draw_rectangle', { width: 8, height: 8, position: [-4, -4, 0] });
    const viaSketch = loft(sketch.document, {
      sections: [
        { center: [0, 0, 0], sectionId: sketch.affected[0] },
        { center: [0, 0, 10], radius: 4 },
      ],
      alignment: 'auto',
    });
    expect(viaSketch.entity.faces).toBeDefined();
    for (const bad of [
      { center: [0, 0, 0] },
      { center: [0, 0, 0], radius: -1 },
      {
        center: [0, 0, 0],
        section: [
          [0, 0],
          [1, 1],
        ],
      },
      { center: [0, 0, 0], sectionId: 'nope' },
    ]) {
      const result = execute(empty, 'loft_sections', { sections: [bad, { center: [0, 0, 9], radius: 3 }], alignment: 'auto' });
      expect(result.affected, JSON.stringify(bad)).toHaveLength(0);
    }
  });
  it('an unknown or open sketch section and an unknown count are refused', () => {
    const line = execute(empty, 'draw_polyline', {
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    });
    const result = execute(line.document, 'loft_sections', { sectionIds: [line.affected[0], 'nope'], alignment: 'auto' });
    expect(result.affected).toHaveLength(0);
    expect(execute(empty, 'loft_sections', { sectionIds: ['a'], alignment: 'auto' }).affected).toHaveLength(0);
    expect(execute(empty, 'loft_sections', { alignment: 'auto' }).affected).toHaveLength(0);
  });
});

describe('loft refusals and the end-condition solver', () => {
  const two = (): { doc: CadDocument; ids: [string, string] } => {
    const a = circle(empty, 10, 0);
    const b = circle(a.doc, 6, 40);
    return { doc: b.doc, ids: [a.id, b.id] };
  };
  it('unequal weights (a circle and a square) refuse end conditions; a point end and a curvature end work', () => {
    const square = curve(empty, {
      degree: 1,
      poles: [
        [10, -10, 0],
        [10, 10, 0],
        [-10, 10, 0],
        [-10, -10, 0],
        [10, -10, 0],
      ],
    });
    const ring = circle(square.doc, 10, 40);
    const refused = execute(ring.doc, 'loft_sections', { sectionIds: [square.id, ring.id], startCondition: { type: 'normal' } });
    expect(refused.error?.code).toBe('SWG_LOFT_END_CONDITION_INVALID');
    const { doc, ids } = two();
    const tip = loft(doc, { sectionIds: ids, startCondition: { type: 'point', at: [0, 0, -20] } });
    expect(loftFacesVolume(tip.entity)).toBeGreaterThan(0);
    const wall = execute(doc, 'create_nurbs_surface', {
      degreeU: 2,
      degreeV: 1,
      poles: circlePoles(6, 0).map((p) => [
        [p[0], p[1], 40],
        [p[0], p[1], 60],
      ]),
      weights: [1, W, 1, W, 1, W, 1, W, 1].map((w) => [w, w]),
      knotsU: [0, 0.25, 0.5, 0.75, 1],
      multiplicitiesU: [3, 2, 2, 2, 3],
    });
    const faceId = wall.affected[0] as string;
    const both = loft(wall.document, {
      sectionIds: ids,
      endCondition: { type: 'curvature_to_face', faceId, magnitude: 1.5 },
      startCondition: { type: 'normal', magnitude: 0.5 },
    });
    expect(both.data['sectionDeviation']).toBeLessThan(1e-6);
  });
  it('builder refusals: guides with ends, closed with coupling, open sections, centreline combinations, bad counts', () => {
    const { doc, ids } = two();
    const guide = curve(doc, {
      degree: 1,
      poles: [
        [10, 0, 0],
        [6, 0, 40],
      ],
    });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ sectionIds: ids, guideIds: [guide.id], startCondition: { type: 'normal' } }, 'SWG_PARAM_INVALID'],
      [{ sectionIds: ids, closed: true, coupling: 'arc_length' }, 'SWG_LOFT_CLOSED_TOO_FEW'],
      [{ sectionIds: ids, centerlineId: guide.id, coupling: 'arc_length' }, 'SWG_PARAM_INVALID'],
      [{ sectionIds: ids, centerlineId: guide.id, sectionCount: 100 }, 'SWG_PARAM_INVALID'],
      [{ sectionIds: ids, coupling: 'vertices' }, 'SWG_LOFT_COUPLING_MISMATCH'],
      [{ sectionIds: ids, coupling: 'arc_length', fitTolerance: 1e-15 }, 'SWG_FIT_TOLERANCE'],
    ];
    for (const [params, code] of cases) {
      const result = execute(guide.doc, 'loft_sections', params);
      expect(result.affected, JSON.stringify(params)).toHaveLength(0);
      expect(result.error?.code, JSON.stringify(params)).toBe(code);
    }
    const open = curve(doc, {
      degree: 1,
      poles: [
        [0, 0, 0],
        [5, 0, 0],
        [5, 5, 0],
      ],
    });
    const result = execute(open.doc, 'loft_sections', {
      sectionIds: [open.id, ids[1]],
      alignment: 'auto',
      startCondition: { type: 'normal' },
    });
    expect(result.error?.code).toBe('SWG_SECTION_INVALID');
  });
  it('a centreline that misses the sections, or runs the wrong way, is handled', () => {
    const { doc, ids } = two();
    const along = curve(doc, {
      degree: 1,
      poles: [
        [0, 0, 0],
        [0, 0, 40],
      ],
    });
    const forward = loft(along.doc, { sectionIds: ids, centerlineId: along.id, sectionCount: 3 });
    const backward = curve(doc, {
      degree: 1,
      poles: [
        [0, 0, 40],
        [0, 0, 0],
      ],
    });
    const reversed = loft(backward.doc, { sectionIds: ids, centerlineId: backward.id, sectionCount: 3 });
    expect(relError(loftFacesVolume(reversed.entity), loftFacesVolume(forward.entity))).toBeLessThan(1e-9);
    const off = curve(doc, {
      degree: 1,
      poles: [
        [30, 0, 0],
        [30, 0, 40],
      ],
    });
    expect(execute(off.doc, 'loft_sections', { sectionIds: ids, centerlineId: off.id }).error?.code).toBe('SWG_LOFT_CENTERLINE_MISSES');
  });
  it('opposite section planes (rotated half a turn) are wound and aligned', () => {
    const a = circle(empty, 10, 0);
    const b = circle(a.doc, 10, 30, Math.PI);
    const { entity } = loft(b.doc, { sectionIds: [a.id, b.id], ruled: true, alignment: 'auto' });
    expect(relError(loftFacesVolume(entity), Math.PI * 100 * 30)).toBeLessThan(1e-6);
  });
});

describe('vertex and arc-length coupling edge cases', () => {
  const square = (doc: CadDocument, half: number, z: number): { doc: CadDocument; id: string } =>
    curve(doc, {
      degree: 1,
      poles: [
        [half, -half, z],
        [half, half, z],
        [-half, half, z],
        [-half, -half, z],
        [half, -half, z],
      ],
    });
  it('open sections are cut at the vertex fractions; closed ones start at the first vertex', () => {
    const a = curve(empty, {
      degree: 1,
      poles: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
      ],
    });
    const b = curve(a.doc, {
      degree: 1,
      poles: [
        [0, 0, 5],
        [10, 0, 5],
        [10, 10, 5],
      ],
    });
    const open = execute(b.doc, 'loft_surface', {
      sectionIds: [a.id, b.id],
      degreeV: 1,
      coupling: 'vertices',
      vertexPairs: [[0.5], [0.5]],
    });
    expect(open.affected).toHaveLength(2);
    const s0 = square(empty, 10, 0);
    const s1 = square(s0.doc, 5, 20);
    const closed = loft(s1.doc, {
      sectionIds: [s0.id, s1.id],
      ruled: true,
      coupling: 'vertices',
      vertexPairs: [
        [0.25, 0.5, 0.75],
        [0.25, 0.5, 0.75],
      ],
      alignment: 'none',
    });
    expect(closed.data['faces']).toBe(3);
    const bad = [
      [
        [0.25, 0.25],
        [0.25, 0.5],
      ],
      [[0, 0.5], [0]],
    ];
    for (const vertexPairs of bad)
      expect(
        execute(s1.doc, 'loft_sections', { sectionIds: [s0.id, s1.id], ruled: true, coupling: 'vertices', vertexPairs }).error?.code,
      ).toBe('SWG_LOFT_COUPLING_MISMATCH');
  });
  it('arc-length coupling of two circles needs no corner cuts and refits both', () => {
    const a = circle(empty, 10, 0);
    const b = circle(a.doc, 5, 30, 0.5);
    const { data } = loft(b.doc, { sectionIds: [a.id, b.id], ruled: true, coupling: 'arc_length', alignment: 'auto' });
    expect(data['faces']).toBe(1);
    expect(data['fitDeviation']).toBeGreaterThan(0);
  });
});

describe('lib: curve splitting, re-seaming, ruled pairing, developable rulings', () => {
  const unit = (doc: CadDocument): NurbsCurveData =>
    (doc.entities[Object.keys(doc.entities)[0] as string] as unknown as { curve: NurbsCurveData }).curve;
  const ringCurve = (r: number, z: number, turn = 0): NurbsCurveData => unit(circle(empty, r, z, turn).doc);
  it('splitCurve keeps the shape; parameterAtLengthFraction and cornerFractions agree with arc length', () => {
    const c = ringCurve(10, 0);
    const pieces = splitCurve(c, [0.3, 0.8, 5]);
    expect(Array.isArray(pieces) && pieces.length === 3).toBe(true);
    expect(parameterAtLengthFraction(c, 0)).toBe(0);
    expect(parameterAtLengthFraction(c, 1)).toBe(1);
    expect(parameterAtLengthFraction(c, 0.25)).toBeCloseTo(0.25, 6);
    expect(cornerFractions(c)).toEqual([]);
    const l = unit(
      curve(empty, {
        degree: 1,
        poles: [
          [0, 0, 0],
          [10, 0, 0],
          [10, 10, 0],
        ],
      }).doc,
    );
    expect(cornerFractions(l)).toHaveLength(1);
    expect(typeof splitCurve(l, [2])).not.toBe('string');
  });
  it('reseamCurve rotates a closed curve exactly and refuses an open one', () => {
    const c = ringCurve(10, 0);
    const moved = reseamCurve(c, 0.3);
    expect(typeof moved).not.toBe('string');
    const m = moved as NurbsCurveData;
    const [x, y] = evaluateCurve(m, m.knots[0] as number);
    expect(Math.hypot(x, y)).toBeCloseTo(10, 9);
    expect(reseamCurve(c, 0)).toBe(c);
    expect(
      typeof reseamCurve(
        unit(
          curve(empty, {
            degree: 1,
            poles: [
              [0, 0, 0],
              [1, 0, 0],
            ],
          }).doc,
        ),
        0.5,
      ),
    ).toBe('string');
  });
  it('ruledPatch lifts mixed rational / polynomial curves; arcLengthPair refuses a point curve', () => {
    const line = unit(
      curve(empty, {
        degree: 1,
        poles: [
          [0, 0, 0],
          [1, 0, 0],
        ],
      }).doc,
    );
    const rational = unit(
      curve(empty, {
        degree: 2,
        poles: [
          [0, 1, 0],
          [1, 1, 1],
          [2, 1, 0],
        ],
        weights: [1, 2, 1],
      }).doc,
    );
    expect(typeof ruledPatch(line, rational)).not.toBe('string');
    const dot = {
      ...line,
      poles: [
        [1, 1, 1],
        [1, 1, 1],
      ] as const,
    };
    expect('code' in arcLengthPair(line, dot, 1e-6)).toBe(true);
    expect(arcLengthSamples(line, 4).length).toBeCloseTo(1, 9);
  });
  it('developable pairing by Newton: two circles whose parameters do not match still give a cone-like sheet', () => {
    const big = ringCurve(10, 0);
    const small = ringCurve(5, 50, 0.7);
    const made = developableSurface(big, small);
    expect('surface' in made && !made.exact).toBe(true);
    const backwards = developableSurface(
      big,
      unit(
        curve(empty, {
          degree: 2,
          poles: circlePoles(5, 50).reverse(),
          weights: [1, W, 1, W, 1, W, 1, W, 1],
          knots: [0, 0.25, 0.5, 0.75, 1],
          multiplicities: [3, 2, 2, 2, 3],
        }).doc,
      ),
    );
    expect('surface' in backwards || backwards.code === 'SWG_NOT_DEVELOPABLE').toBe(true);
    const planar = developableSurface(
      unit(
        curve(empty, {
          degree: 1,
          poles: [
            [0, 0, 0],
            [10, 0, 0],
          ],
        }).doc,
      ),
      unit(
        curve(empty, {
          degree: 1,
          poles: [
            [0, 0, 5],
            [10, 0, 5],
          ],
        }).doc,
      ),
    );
    expect('surface' in planar).toBe(true);
  });
});

describe('mitre joints of the frame builder', () => {
  it('a joint beyond 150 degrees or with a curved leg is left as built', () => {
    const sharp = [
      {
        type: 'line' as const,
        points: [
          [0, 0, 0],
          [100, 0, 0],
        ] as [[number, number, number], [number, number, number]],
      },
      {
        type: 'line' as const,
        points: [
          [100, 0, 0],
          [0, 5, 0],
        ] as [[number, number, number], [number, number, number]],
      },
    ];
    const frames = sweepFrames(sharp);
    const out = applyMiter(sharp, frames, null);
    expect(out.frames).toHaveLength(frames.length);
    expect(out.transforms.every((t) => t.affine === undefined)).toBe(true);
    const arc = [
      {
        type: 'line' as const,
        points: [
          [0, 0, 0],
          [100, 0, 0],
        ] as [[number, number, number], [number, number, number]],
      },
      {
        type: 'arc' as const,
        points: [
          [100, 0, 0],
          [110, 10, 0],
          [100, 20, 0],
        ] as [[number, number, number], [number, number, number], [number, number, number]],
      },
    ];
    expect(applyMiter(arc, sweepFrames(arc), null).transforms.every((t) => t.affine === undefined)).toBe(true);
  });
});

describe('rails: modes, outlines and degenerate cases', () => {
  const rails = (doc: CadDocument): { doc: CadDocument; ids: [string, string] } => {
    const a = curve(
      doc,
      {
        degree: 1,
        poles: [
          [0, 10, 0],
          [100, 6, 0],
        ],
      },
      'create_nurbs_curve',
    );
    const b = curve(
      a.doc,
      {
        degree: 1,
        poles: [
          [0, -10, 0],
          [100, -6, 0],
        ],
      },
      'create_nurbs_curve',
    );
    return { doc: b.doc, ids: [a.id, b.id] };
  };
  const SQUARE = [
    [-10, -10],
    [10, -10],
    [10, 10],
    [-10, 10],
  ];
  it('two rails with orient and stretch modes, derived anchors on a polygon outline', () => {
    const { doc, ids } = rails(empty);
    for (const guideMode of ['orient', 'stretch'] as const) {
      const made = execute(doc, 'sweep_profile', {
        guideIds: ids,
        guideMode,
        section: SQUARE,
        anchors: [
          [-10, 10],
          [-10, -10],
        ],
      });
      expect(made.affected, `${guideMode}: ${made.summary}`).toHaveLength(1);
    }
    const derived = execute(doc, 'sweep_profile', {
      guideIds: ids,
      section: [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ],
    });
    expect(derived.affected, derived.summary).toHaveLength(1);
    expect((derived.document.entities[derived.affected[0] as string] as SweepEntity).anchors).toHaveLength(2);
  });
  it('a single rail through the path point, or equal anchors, is refused', () => {
    const { doc, ids } = rails(empty);
    const spine = curve(doc, {
      degree: 1,
      poles: [
        [0, 0, 0],
        [100, 0, 0],
      ],
    });
    const through = curve(spine.doc, {
      degree: 1,
      poles: [
        [0, 0, 0],
        [100, 0, 0],
      ],
    });
    const result = execute(through.doc, 'sweep_profile', { pathId: spine.id, guideIds: [through.id], radius: 5, anchors: [[5, 0]] });
    expect(result.affected).toHaveLength(0);
    const zeroAnchor = execute(through.doc, 'sweep_profile', { pathId: spine.id, guideIds: [ids[0]], radius: 5, anchors: [[0, 0]] });
    expect(zeroAnchor.error?.code).toBe('SWG_GUIDE_ANCHOR_UNDEFINED');
    const same = execute(through.doc, 'sweep_profile', {
      guideIds: ids,
      radius: 10,
      anchors: [
        [10, 0],
        [10, 0],
      ],
    });
    expect(same.error?.code).toBe('SWG_GUIDE_ANCHOR_UNDEFINED');
    const meeting = curve(doc, {
      degree: 1,
      poles: [
        [0, 10, 0],
        [100, 0, 0],
      ],
    });
    const meeting2 = curve(meeting.doc, {
      degree: 1,
      poles: [
        [0, -10, 0],
        [100, 0, 0],
      ],
    });
    expect(
      execute(meeting2.doc, 'sweep_profile', {
        guideIds: [meeting.id, meeting2.id],
        radius: 10,
        anchors: [
          [10, 0],
          [-10, 0],
        ],
      }).affected,
    ).toHaveLength(0);
  });
  it('curved rails: the midline of two arcs is fitted, a zero-length rail is refused, a bad railTolerance too', () => {
    // concentric arcs of radius 110 and 90 about (0, -100), 30 degrees each: the section plane at the start of the radius-100 midline holds both starts
    const arc = (doc: CadDocument, r: number): ReturnType<typeof execute> => {
      const at = (theta: number, radius: number): number[] => [radius * Math.sin(theta), radius * Math.cos(theta) - 100, 0];
      const sweep = Math.PI / 6;
      const w = Math.cos(sweep / 2);
      return execute(doc, 'create_conic', { start: at(0, r), apex: at(sweep / 2, r / w), end: at(sweep, r), rho: w / (1 + w) });
    };
    const left = arc(empty, 110);
    const right = arc(left.document, 90);
    const ids = [left.affected[0], right.affected[0]];
    const made = execute(right.document, 'sweep_profile', {
      guideIds: ids,
      radius: 10,
      anchors: [
        [10, 0],
        [-10, 0],
      ],
    });
    expect(made.affected, made.summary).toHaveLength(1);
    const dot = curve(right.document, {
      degree: 1,
      poles: [
        [1, 1, 1],
        [1, 1, 1],
      ],
    });
    const zero = execute(dot.doc, 'sweep_profile', { guideIds: [dot.id, dot.id], radius: 1 });
    expect(zero.affected).toHaveLength(0);
    expect(execute(right.document, 'sweep_profile', { guideIds: ids, radius: 10, railTolerance: -1 }).error?.code).toBe(
      'SWG_PARAM_INVALID',
    );
  });
  it('a rail that doubles back is followed by continuation and rescanning', () => {
    const spine = curve(empty, {
      degree: 1,
      poles: [
        [0, 0, 0],
        [0, 0, 100],
      ],
    });
    const wavy = curve(spine.doc, {
      degree: 3,
      poles: [
        [10, 0, 0],
        [10, 0, 40],
        [10, 0, 20],
        [10, 0, 100],
        [10, 0, 60],
        [10, 0, 100],
      ],
    });
    const result = execute(wavy.doc, 'sweep_profile', { pathId: spine.id, guideIds: [wavy.id], radius: 10, anchors: [[10, 0]] });
    expect(result.summary.length).toBeGreaterThan(0);
  });
  it('scale_entity scales rails, anchors and a surface reference with the sweep', () => {
    const { doc, ids } = rails(empty);
    const made = execute(doc, 'sweep_profile', {
      guideIds: ids,
      radius: 10,
      anchors: [
        [10, 0],
        [-10, 0],
      ],
    });
    const id = made.affected[0] as string;
    const scaled = execute(made.document, 'scale_entity', { id, factor: 2 });
    const sweep = scaled.document.entities[id] as SweepEntity;
    expect(sweep.anchors?.[0]).toEqual([20, 0]);
    expect(sweep.rails?.[0]?.curve.poles[1]?.[0]).toBeCloseTo(200, 9);
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
    const onPlane = execute(plane.document, 'sweep_profile', {
      path: [
        [0, 0, 0],
        [30, 0, 0],
      ],
      section: [
        [-1, 0],
        [1, 0],
        [1, 5],
        [-1, 5],
      ],
      orientation: { mode: 'surface', surfaceId: plane.affected[0] },
    });
    const big = execute(onPlane.document, 'scale_entity', { id: onPlane.affected[0], factor: 3 });
    const orientation = (big.document.entities[onPlane.affected[0] as string] as SweepEntity).orientation;
    expect(orientation?.mode === 'surface' && orientation.tolerance).toBeGreaterThan(0);
  });
  it('the surface frame is degenerate where the path runs along the surface normal', () => {
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
    const result = execute(plane.document, 'sweep_profile', {
      path: [
        [0, 0, 0],
        [0, 0, 30],
      ],
      radius: 3,
      orientation: { mode: 'surface', surfaceId: plane.affected[0], tolerance: 100 },
    });
    expectNoOp(result, plane.document, 'SWG_FRAME_DEGENERATE');
  });
});

describe('sweep_surface along a bend and with curved rails', () => {
  it('a straight section swept along line - arc - line has the area of the three runs (runs merged into one patch)', () => {
    const made = execute(empty, 'sweep_surface', {
      path: [
        [0, 0, 0],
        [100, 0, 0],
        [100, 100, 0],
      ],
      bendRadius: 20,
      section: {
        line: [
          [0, 0],
          [0, 10],
        ],
      },
    });
    expect(made.affected, made.summary).toHaveLength(1);
    const length = 160 + (Math.PI * 20) / 2;
    expect(relError((made.data as { area: number }).area, length * 10)).toBeLessThan(1e-4);
  });
  it('an unreachable fitTolerance is SWG_FIT_TOLERANCE', () => {
    const result = execute(empty, 'sweep_surface', {
      path: [
        [0, 0, 0],
        [100, 0, 0],
        [100, 100, 0],
      ],
      bendRadius: 20,
      section: {
        line: [
          [0, 0],
          [0, 10],
        ],
      },
      twist: { type: 'expression', expression: '30*sin(40*t)' },
      fitTolerance: 1e-13,
    });
    expect(result.error?.code).toBe('SWG_FIT_TOLERANCE');
  });
});

describe('check_sweep_loft findings for rails', () => {
  it('a rail sweep whose fit misses the tolerance fails with SWG_CHECK_RAIL_DEVIATION', () => {
    const a = curve(empty, {
      degree: 1,
      poles: [
        [0, 10, 0],
        [100, 5, 0],
      ],
    });
    const b = curve(a.doc, {
      degree: 1,
      poles: [
        [0, -10, 0],
        [100, -5, 0],
      ],
    });
    const made = execute(b.doc, 'sweep_profile', {
      guideIds: [a.id, b.id],
      radius: 10,
      anchors: [
        [10, 0],
        [-10, 0],
      ],
    });
    const strict = execute(made.document, 'check_sweep_loft', { ids: made.affected, fitTolerance: 1e-16 });
    const data = strict.data as { status: string; findings: Array<{ code: string }> };
    expect(data.findings.map((f) => f.code)).toContain('SWG_CHECK_RAIL_DEVIATION');
    expect(data.status).toBe('fail');
  });
});
