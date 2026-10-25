/** SWG M4: rails (1 / 2), the surface orientation mode and sweep_surface (validation VC-SWG-16..18, 27, 34, 35; target_rails_and_surface_mode). */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type NurbsSurfaceEntity, type SweepEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { fitSweepFaces, fitToleranceOf } from '@core/geometry/sweepEval/fitted';
import { railTransforms, railOffsets } from '@core/geometry/sweepEval/rails';
import { evaluateSweep } from '@core/geometry/sweepEval/evaluate';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { volumeOf } from '../../helpers/fixtureDocument';
import { relError, runSwgPlan, swgCase, swgPlan, swgValue } from '../../helpers/swgPack';

const empty = createEmptyDocument();
const MESH = 0.005;

function line(doc: CadDocument, points: number[][]): { doc: CadDocument; id: string } {
  const result = execute(doc, 'interpolate_curve', { points, degree: 1 });
  expect(result.affected, result.summary).toHaveLength(1);
  return { doc: result.document, id: result.affected[0] as string };
}

function rails(doc: CadDocument, a: number[][], b: number[][]): { doc: CadDocument; ids: [string, string] } {
  const first = line(doc, a);
  const second = line(first.doc, b);
  return { doc: second.doc, ids: [first.id, second.id] };
}

const taper = (doc: CadDocument = empty): { doc: CadDocument; ids: [string, string] } =>
  rails(
    doc,
    [
      [0, 10, 0],
      [100, 5, 0],
    ],
    [
      [0, -10, 0],
      [100, -5, 0],
    ],
  );

function sweep(doc: CadDocument, params: Record<string, unknown>): SweepEntity {
  const result = execute(doc, 'sweep_profile', params);
  expect(result.affected, result.summary).toHaveLength(1);
  return result.document.entities[result.affected[0] as string] as SweepEntity;
}

const TWO_ANCHORS = [
  [10, 0],
  [-10, 0],
];

describe('target_rails_and_surface_mode — the pack plan', () => {
  const actions = swgPlan('target_rails_and_surface_mode');
  const { steps, volumeOf: planVolume } = runSwgPlan(actions);
  it('every step succeeds (the sheet check is covered with the loft checks)', () => {
    expect(steps.filter((s) => !s.ok && s.command !== 'check_sweep_loft').map((s) => `${s.command}: ${s.summary}`)).toEqual([]);
  });
  it('VC-SWG-16: two straight rails 20 -> 10 scale the section uniformly (the frustum: the circle area integrated along the frames)', () => {
    expect(relError(planVolume('twoRail'), swgValue('VC-SWG-16', 'two_rails_uniform_scale'))).toBeLessThan(1e-4);
  });
  it('VC-SWG-17: maintainHeight keeps the height and stretches the width (elliptic sections)', () => {
    expect(relError(planVolume('twoRailHeight'), swgValue('VC-SWG-17', 'two_rails_maintain_height'))).toBeLessThan(MESH);
  });
  it('VC-SWG-35: one rail 10 -> 5 scales like the frustum', () => {
    expect(relError(planVolume('oneRail'), swgValue('VC-SWG-35', 'linear_1_to_0.5_straight'))).toBeLessThan(MESH);
  });
  it('VC-SWG-18: the segment between two opposite helical rails is a helicoid of area 1 555.878', () => {
    const data = steps.find((s) => s.command === 'sweep_surface')?.data as { area: number; fitDeviation: number } | undefined;
    expect(data).toBeDefined();
    expect(relError((data as { area: number }).area, 1555.8782)).toBeLessThan(1e-5);
    expect((data as { fitDeviation: number }).fitDeviation).toBeLessThan(1e-5);
  });
});

describe('rails — exact fitted faces and orientation (VC-SWG-16, 35)', () => {
  it('the rail sweep realises as fitted faces within the fit tolerance, the anchors on the rails', () => {
    const { doc, ids } = taper();
    const entity = sweep(doc, { guideIds: ids, radius: 10, anchors: TWO_ANCHORS });
    const fit = fitSweepFaces(entity, fitToleranceOf(entity));
    expect('faces' in fit && fit.faces.length === 4).toBe(true);
    const evaluation = evaluateSweep(entity);
    expect('frames' in evaluation).toBe(true);
    if (!('frames' in evaluation)) return;
    const offsets = railOffsets(entity.rails ?? [], evaluation.frames, evaluation.fractions);
    expect(Array.isArray(offsets)).toBe(true);
    const middle = Math.floor(evaluation.frames.length / 2);
    const rail0 = (offsets as unknown as number[][][])[0] as number[][];
    expect(Math.abs(Math.abs(rail0[middle]?.[0] as number) - 7.5)).toBeLessThan(0.2);
    expect(Array.isArray(railTransforms(entity, evaluation.frames, evaluation.fractions))).toBe(true);
  });

  it('VC-SWG-35 orient: a helical rail round a straight spine twists a square without changing its volume (A L = 10 000)', () => {
    const spine = line(empty, [
      [0, 0, 0],
      [0, 0, 100],
    ]);
    const helix = execute(spine.doc, 'add_helix', { position: [0, 0, 0], axis: [0, 0, 1], radius: 5, pitch: 100, turns: 1 });
    const entity = sweep(helix.document, {
      pathId: spine.id,
      guideIds: [helix.affected[0]],
      guideMode: 'orient',
      section: [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ],
      anchors: [[5, 0]],
    });
    expect(relError(volumeOf(entity), (swgCase('VC-SWG-35').orientCase as { value: number }).value)).toBeLessThan(MESH);
    expect(entity.guideMode).toBe('orient');
  });

  it('derived anchors: rails through the section outline need no anchors', () => {
    const { doc, ids } = taper();
    const entity = sweep(doc, { guideIds: ids, radius: 10 });
    expect(entity.anchors).toHaveLength(2);
    expect(Math.abs(Math.abs((entity.anchors?.[0] as readonly number[])[0] as number) - 10)).toBeLessThan(1e-9);
  });

  it('stretch mode with one rail scales only along the anchor direction', () => {
    const spine = line(empty, [
      [0, 0, 0],
      [0, 0, 100],
    ]);
    const rail = line(spine.doc, [
      [10, 0, 0],
      [5, 0, 100],
    ]);
    const entity = sweep(rail.doc, { pathId: spine.id, guideIds: [rail.id], guideMode: 'stretch', radius: 10, anchors: [[10, 0]] });
    // the x half-axis shrinks 10 -> 5 along the bar and the y half-axis stays 10: V = pi * 10 * mean(a) * L
    expect(relError(volumeOf(entity), Math.PI * 10 * 7.5 * 100)).toBeLessThan(MESH);
  });
});

describe('rails — coded refusals (VC-SWG-27)', () => {
  const { doc, ids } = taper();
  it('three rails or none: SWG_GUIDE_COUNT', () => {
    for (const guideIds of [[...ids, ids[0]], []]) {
      const result = execute(doc, 'sweep_profile', { guideIds, radius: 10 });
      expectNoOp(result, doc, 'SWG_GUIDE_COUNT');
      expect(result.error?.code).toBe('SWG_GUIDE_COUNT');
    }
  });
  it('anchor-less rails away from the outline: SWG_GUIDE_ANCHOR_UNDEFINED', () => {
    const result = execute(doc, 'sweep_profile', { guideIds: ids, radius: 6 });
    expectNoOp(result, doc, 'SWG_GUIDE_ANCHOR_UNDEFINED');
    expect(result.error?.code).toBe('SWG_GUIDE_ANCHOR_UNDEFINED');
  });
  it('malformed anchors: SWG_GUIDE_ANCHOR_UNDEFINED', () => {
    expect(execute(doc, 'sweep_profile', { guideIds: ids, radius: 10, anchors: [[10, 0]] }).error?.code).toBe('SWG_GUIDE_ANCHOR_UNDEFINED');
  });
  it('a path longer than the rails: SWG_GUIDE_PLANE_NO_INTERSECTION', () => {
    const short = rails(
      empty,
      [
        [0, 10, 0],
        [50, 10, 0],
      ],
      [
        [0, -10, 0],
        [50, -10, 0],
      ],
    );
    const spine = line(short.doc, [
      [0, 0, 0],
      [100, 0, 0],
    ]);
    const result = execute(spine.doc, 'sweep_profile', { pathId: spine.id, guideIds: short.ids, radius: 10, anchors: TWO_ANCHORS });
    expectNoOp(result, spine.doc, 'SWG_GUIDE_PLANE_NO_INTERSECTION');
  });
  it('rails with laws are exclusive; one rail needs a path', () => {
    expect(execute(doc, 'sweep_profile', { guideIds: ids, radius: 10, scale: { type: 'constant', value: 1 } }).error?.code).toBe(
      'SWG_LAW_EXCLUSIVE',
    );
    const one = execute(doc, 'sweep_profile', { guideIds: [ids[0]], radius: 10 });
    expectNoOp(one, doc);
    expect(one.error?.code).toBe('SWG_PATH_INVALID');
  });
  it('an unknown rail id is a coded no-op', () => {
    expect(execute(doc, 'sweep_profile', { guideIds: [ids[0], 'nope'], radius: 10 }).error?.code).toBe('SRF_ENTITY_NOT_FOUND');
  });
  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'sweep_profile', { guideIds: ids, radius: 10, anchors: TWO_ANCHORS }));
  });
});

describe('orientation surface and sweep_surface (VC-SWG-34)', () => {
  const plane = (): { doc: CadDocument; id: string } => {
    const result = execute(empty, 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [-100, -100, 0],
          [-100, 100, 0],
        ],
        [
          [100, -100, 0],
          [100, 100, 0],
        ],
      ],
    });
    return { doc: result.document, id: result.affected[0] as string };
  };
  const cylinder = (): { doc: CadDocument; id: string } => {
    const r = 50;
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
    const w = Math.SQRT1_2;
    const result = execute(empty, 'create_nurbs_surface', {
      degreeU: 2,
      degreeV: 1,
      poles: ring.map(([x, y]) => [
        [x, y, -10],
        [x, y, 10],
      ]),
      weights: ring.map((_, i) => (i % 2 === 0 ? [1, 1] : [w, w])),
      knotsU: [0, 0.25, 0.5, 0.75, 1],
      multiplicitiesU: [3, 2, 2, 2, 3],
    });
    return { doc: result.document, id: result.affected[0] as string };
  };
  const circle = (doc: CadDocument): { doc: CadDocument; id: string } => {
    const result = execute(doc, 'draw_arc', { center: [0, 0], radius: 50 });
    return { doc: result.document, id: result.affected[0] as string };
  };
  const SEGMENT = {
    line: [
      [0, 0],
      [0, 10],
    ],
  };

  it('a 10 mm segment along the plane normal round a circle R 50 is a band of area 3 141.5927', () => {
    const { doc, id } = plane();
    const path = circle(doc);
    const result = execute(path.doc, 'sweep_surface', {
      pathId: path.id,
      section: SEGMENT,
      orientation: { mode: 'surface', surfaceId: id },
    });
    expect(result.affected, result.summary).toHaveLength(1);
    expect(relError((result.data as { area: number }).area, (swgCase('VC-SWG-34').value as { plane: number }).plane)).toBeLessThan(1e-5);
  });

  it('along the cylinder normal it is the annulus of area 3 455.7519', () => {
    const { doc, id } = cylinder();
    const path = circle(doc);
    const result = execute(path.doc, 'sweep_surface', {
      pathId: path.id,
      section: SEGMENT,
      orientation: { mode: 'surface', surfaceId: id },
    });
    expect(result.affected, result.summary).toHaveLength(1);
    expect(relError((result.data as { area: number }).area, (swgCase('VC-SWG-34').value as { cylinder: number }).cylinder)).toBeLessThan(
      1e-5,
    );
    expect((result.document.entities[result.affected[0] as string] as NurbsSurfaceEntity).kind).toBe('nurbs_surface');
  });

  it('a path off the reference surface is SWG_SURFACE_TOO_FAR; an unknown surface is refused', () => {
    const { doc, id } = plane();
    const raised = execute(doc, 'sweep_surface', {
      path: [
        [0, 0, 5],
        [50, 0, 5],
      ],
      section: SEGMENT,
      orientation: { mode: 'surface', surfaceId: id, tolerance: 0.01 },
    });
    expectNoOp(raised, doc, 'SWG_SURFACE_TOO_FAR');
    expect(raised.error?.code).toBe('SWG_SURFACE_TOO_FAR');
    const missing = execute(doc, 'sweep_surface', {
      path: [
        [0, 0, 0],
        [50, 0, 0],
      ],
      section: SEGMENT,
      orientation: { mode: 'surface', surfaceId: 'nope' },
    });
    expectNoOp(missing, doc);
  });

  it('sweep_profile accepts the surface mode too (a solid standing on the sheet)', () => {
    const { doc, id } = plane();
    const entity = sweep(doc, {
      path: [
        [0, 0, 0],
        [60, 0, 0],
      ],
      section: [
        [-2, 0],
        [2, 0],
        [2, 10],
        [-2, 10],
      ],
      orientation: { mode: 'surface', surfaceId: id },
    });
    expect(entity.orientation?.mode).toBe('surface');
    expect(relError(volumeOf(entity), 4 * 10 * 60)).toBeLessThan(MESH);
  });
});

describe('sweep_surface — failures and purity', () => {
  const bar = [
    [0, 0, 0],
    [0, 0, 20],
  ];
  it('needs exactly one section form and a path', () => {
    for (const params of [
      { path: bar },
      { path: bar, section: { line: [[0, 0]] } },
      {
        path: bar,
        section: {
          points: [
            [0, 0],
            [0, 0],
          ],
        },
      },
      { path: bar, sectionId: 'nope' },
    ]) {
      expectNoOp(execute(empty, 'sweep_surface', params), empty, 'SWG_SECTION_INVALID');
    }
    expectNoOp(
      execute(empty, 'sweep_surface', {
        section: {
          line: [
            [0, 0],
            [0, 1],
          ],
        },
      }),
      empty,
      'SWG_PATH_INVALID',
    );
  });
  it('a polyline section and a curve section sweep, laws apply, and it is pure', () => {
    const curve = execute(empty, 'create_nurbs_curve', {
      degree: 2,
      poles: [
        [0, 0, 0],
        [1, 2, 0],
        [2, 0, 0],
      ],
    });
    const id = curve.affected[0] as string;
    const params = { path: bar, sectionId: id, scale: { type: 'linear', start: 1, end: 2 } };
    const result = execute(curve.document, 'sweep_surface', params);
    expect(result.affected, result.summary).toHaveLength(1);
    const poly = execute(empty, 'sweep_surface', {
      path: bar,
      section: {
        points: [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
      },
      twistTurns: 0.25,
    });
    expect(poly.affected, poly.summary).toHaveLength(1);
    expectPure(curve.document, () => execute(curve.document, 'sweep_surface', params));
  });
  it('a closed point path needs a frame mode that closes', () => {
    const result = execute(empty, 'sweep_surface', {
      path: [
        [0, 0, 0],
        [50, 0, 0],
        [50, 50, 0],
        [0, 50, 0],
      ],
      closed: true,
      bendRadius: 5,
      section: {
        line: [
          [0, 0],
          [0, 5],
        ],
      },
    });
    expectNoOp(result, empty, 'SWG_PATH_INVALID');
  });
});
