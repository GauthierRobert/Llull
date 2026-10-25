/** SWG internals: persistence of the new fields, fitted faces, section edges, 3D paths, symmetry, analytic volumes, frames. */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type SweepEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { curveChain } from '@core/geometry/nurbsChain';
import { fitSweepFaces, fitToleranceOf } from '@core/geometry/sweepEval/fitted';
import { framesAtSamples, orientedFrames, pathSamplesAt, sweepFrames } from '@core/geometry/sweepEval/frames';
import { constantEdges, ringEdges } from '@core/geometry/sweepEval/sectionEdges';
import { sectionSymmetryOrder } from '@core/geometry/sweepEval/symmetry';
import { sweepAnalyticVolume } from '@core/geometry/sweepEval/volume';
import { sweepSamples } from '@core/geometry/sweepEval/inspect';
import { sweepTriangles } from '@core/geometry/sweep';
import { helixProblem } from '@core/commands/persistence/sweepGuard';
import { docWith } from '../../helpers/fixtureDocument';
import { runSwgPlan, swgPlan } from '../../helpers/swgPack';
import { xyz } from '../../helpers/xy';

const empty = createEmptyDocument();
const SQUARE: Array<[number, number]> = [
  [-5, -5],
  [5, -5],
  [5, 5],
  [-5, 5],
];
const BAR = xyz(0, 0, 0, 0, 0, 100);

function sweepEntity(params: Record<string, unknown>, doc: CadDocument = empty): SweepEntity {
  const result = execute(doc, 'sweep_profile', params);
  expect(result.affected, result.summary).toHaveLength(1);
  return result.document.entities[result.affected[0] as string] as SweepEntity;
}

describe('persistence of the SWG fields', () => {
  const built = runSwgPlan(swgPlan('target_helix_spring_thread')).document;
  const mixed = runSwgPlan(swgPlan('target_twist_scale_orientation')).document;

  it('laws, orientation, stationBlend and helices survive a save and a load unchanged', () => {
    for (const doc of [built, mixed]) {
      const json = serializeDocument(doc);
      expect(serializeDocument(deserializeDocument(json))).toBe(json);
    }
    const reloaded = deserializeDocument(serializeDocument(mixed));
    const twisted = Object.values(reloaded.entities).find((e): e is SweepEntity => e.kind === 'sweep' && e.twist !== undefined);
    expect(twisted?.twist).toBeDefined();
  });

  const corrupt = (doc: CadDocument, kind: string, edit: (entity: Record<string, unknown>) => void): string => {
    const parsed = JSON.parse(serializeDocument(doc)) as { document: { entities: Record<string, Record<string, unknown>> } };
    const target = Object.values(parsed.document.entities).find(
      (e) => e['kind'] === kind && (kind !== 'sweep' || e['twist'] !== undefined || e['helix'] !== undefined),
    );
    edit(target as Record<string, unknown>);
    return JSON.stringify(parsed);
  };

  it('refuses a saved sweep whose law, blend, orientation or helix is broken', () => {
    const bad = (edit: (entity: Record<string, unknown>) => void, doc = mixed): void => {
      expect(() => deserializeDocument(corrupt(doc, 'sweep', edit))).toThrow(/invalid values/);
    };
    bad((e) => (e['twist'] = { type: 'linear', start: 0 }));
    bad((e) => (e['twist'] = 'spin'));
    bad(
      (e) =>
        (e['twist'] = {
          type: 'table',
          points: [
            [0, 0],
            [0.7, 1],
            [0.5, 2],
            [1, 3],
          ],
        }),
    );
    bad((e) => (e['scale'] = { type: 'linear', start: 1, end: -1 }));
    bad((e) => {
      e['scale'] = { type: 'constant', value: 1 };
      e['area'] = { type: 'constant', value: 1 };
    });
    bad((e) => (e['stretch'] = 3));
    bad((e) => (e['stationBlend'] = 'cubic'));
    bad((e) => (e['orientation'] = { mode: 'spin' }));
    bad((e) => (e['orientation'] = { mode: 'binormal' }));
    bad((e) => (e['orientation'] = { mode: 'fixed', direction: [0, 0, 0] }));
    bad((e) => (e['orientation'] = { mode: 'axis_plane', direction: [0, 0, 1] }), built);
    bad((e) => (e['orientation'] = { mode: 'axis_plane', direction: [0, 0, 1], axisPoint: [0, 0, 0], sectionFrame: 'x' }), built);
    bad((e) => (e['orientation'] = 4), built);
    bad((e) => (e['helix'] = { type: 'knot' }), built);
    expect(() =>
      deserializeDocument(corrupt(built, 'nurbs_curve', (e) => ((e['analytic'] as Record<string, unknown>)['radius'] = -1))),
    ).toThrow(/invalid values/);
  });

  it('helixProblem names what is wrong', () => {
    const ok = {
      type: 'helix',
      origin: [0, 0, 0],
      axis: [0, 0, 1],
      radius: 1,
      endRadius: 1,
      turns: 2,
      pitch: 1,
      handedness: 'left',
      startAngle: 0,
    };
    expect(helixProblem(ok)).toBeNull();
    expect(helixProblem(undefined)).toBeNull();
    expect(helixProblem({ ...ok, pitch: { type: 'linear', start: 1, end: 2 } })).toBeNull();
    for (const edit of [
      { origin: 3 },
      { axis: [0, 0, 2] },
      { turns: 0 },
      { handedness: 'up' },
      { startAngle: Number.NaN },
      { pitch: -1 },
      { pitch: { type: 'linear', start: 1, end: -1 } },
    ])
      expect(helixProblem({ ...ok, ...edit }), JSON.stringify(edit)).not.toBeNull();
    expect(helixProblem(5)).not.toBeNull();
  });
});

describe('section edges and fitted faces', () => {
  it('a circle is four rational quarter arcs; a polygon is its sides; an ellipse sketch keeps its Béziers; a hollow circle is not supported', () => {
    const circle = constantEdges({ shape: 'circle', radius: 3 });
    expect(circle).toHaveLength(4);
    expect(circle?.[0]?.weights?.[1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(constantEdges({ shape: 'circle', radius: 3, innerRadius: 1 })).toBeNull();
    expect(constantEdges({ shape: 'profile', profile: SQUARE })).toHaveLength(4);
    const bezier = constantEdges({
      shape: 'profile',
      profile: SQUARE,
      curves: [
        {
          type: 'bezier',
          points: [
            [0, 0],
            [3, 0],
            [3, 3],
            [0, 3],
          ],
        },
        {
          type: 'line',
          points: [
            [0, 3],
            [0, 0],
          ],
        },
      ],
    });
    expect(bezier?.map((e) => e.degree)).toEqual([3, 1]);
    const arcs = constantEdges({
      shape: 'profile',
      profile: SQUARE,
      curves: [
        {
          type: 'arc',
          points: [
            [1, 0],
            [0, 1],
            [-1, 0],
          ],
        },
        {
          type: 'line',
          points: [
            [-1, 0],
            [1, 0],
          ],
        },
      ],
    });
    expect(arcs?.map((e) => e.degree)).toEqual([2, 2, 1]);
    expect(
      constantEdges({
        shape: 'profile',
        profile: SQUARE,
        curves: [
          {
            type: 'arc',
            points: [
              [0, 0],
              [1, 1],
              [2, 2],
            ],
          },
        ],
      }),
    ).toBeNull();
    const ring = Array.from({ length: 24 }, (_, k): [number, number] => [Math.cos((k * Math.PI) / 12), Math.sin((k * Math.PI) / 12)]);
    expect(ringEdges(ring)).toHaveLength(24);
  });

  it('fits a twisted square within the tolerance and a scaled round section too', () => {
    const twisted = sweepEntity({ path: BAR, section: SQUARE, twistTurns: 1 });
    const fit = fitSweepFaces(twisted, fitToleranceOf(twisted));
    expect('faces' in fit && fit.faces.length % 4).toBe(0);
    expect('cells' in fit && fit.cells).toBeGreaterThanOrEqual(64);
    expect('deviation' in fit && fit.deviation).toBeLessThan(1e-5);
    const cone = sweepEntity({ path: BAR, radius: 10, scale: { type: 'linear', start: 1, end: 0.5 } });
    const coneFit = fitSweepFaces(cone, fitToleranceOf(cone));
    expect('faces' in coneFit && coneFit.faces.length % 4).toBe(0);
  });

  it('fits a station sweep with a linear blend (one face per ring Bézier)', () => {
    const tapered = sweepEntity({
      path: BAR,
      stations: [
        { at: 0, radius: 10 },
        { at: 1, radius: 5 },
      ],
      stationBlend: 'linear',
    });
    const fit = fitSweepFaces(tapered, fitToleranceOf(tapered));
    expect('faces' in fit && fit.faces.length).toBe(24);
  });

  it('fits a twisted square ring round a closed path (faces meet where they started); fits a hollow section with a bore, refuses a bore with stations, an unreachable tolerance, a degenerate frame', () => {
    const ring = sweepEntity({
      path: xyz(0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 100, 0),
      closed: true,
      section: SQUARE,
      bendRadius: 20,
      twistTurns: 1,
    });
    const loop = fitSweepFaces(ring, 1e-6);
    expect('faces' in loop && loop.faces.length >= 4 && loop.deviation <= 1e-6).toBe(true);
    const hollow = sweepEntity({ path: BAR, radius: 5, innerRadius: 2, scale: { type: 'linear', start: 1, end: 2 } });
    expect(fitSweepFaces(hollow, 1e-6)).toMatchObject({ bore: expect.anything() });
    const stationed = {
      ...hollow,
      stations: [
        {
          at: 0,
          ring: [
            [1, 0],
            [0, 1],
            [-1, 0],
            [0, -1],
          ],
        },
        {
          at: 1,
          ring: [
            [2, 0],
            [0, 2],
            [-2, 0],
            [0, -2],
          ],
        },
      ],
    } as unknown as SweepEntity;
    expect(fitSweepFaces(stationed, 1e-6)).toMatchObject({ code: 'SWG_FIT_UNSUPPORTED' });
    const wavy = sweepEntity({ path: BAR, section: SQUARE, twist: { type: 'expression', expression: '40*sin(30*t)' } });
    expect(fitSweepFaces(wavy, 1e-12)).toMatchObject({ code: 'SWG_FIT_TOLERANCE' });
    const straight = { ...sweepEntity({ path: BAR, radius: 5 }), orientation: { mode: 'frenet' as const } };
    expect(fitSweepFaces(straight, 1e-6)).toMatchObject({ code: 'SWG_FRAME_DEGENERATE' });
  });
});

describe('frames', () => {
  it('pathSamplesAt gives exact arc and Bézier points by arc-length fraction', () => {
    const arc = [
      {
        type: 'arc' as const,
        points: [
          [50, 0, 0],
          [50 * Math.SQRT1_2, 50 * Math.SQRT1_2, 0],
          [0, 50, 0],
        ] as [[number, number, number], [number, number, number], [number, number, number]],
      },
    ];
    const [mid] = pathSamplesAt(arc, [0.5]);
    expect(mid?.point[0]).toBeCloseTo(50 * Math.SQRT1_2, 9);
    const bezier = [
      {
        type: 'bezier' as const,
        points: [
          [0, 0, 0],
          [10, 0, 0],
          [20, 0, 0],
          [30, 0, 0],
        ] as [[number, number, number], [number, number, number], [number, number, number], [number, number, number]],
      },
    ];
    const [quarter] = pathSamplesAt(bezier, [0.25]);
    expect(quarter?.point[0]).toBeCloseTo(7.5, 6);
  });

  it('frames at samples follow each mode; a closed path drops its duplicate end', () => {
    const samples = pathSamplesAt(
      [
        {
          type: 'arc' as const,
          points: [
            [50, 0, 0],
            [0, 50, 0],
            [-50, 0, 0],
          ],
        },
      ],
      Array.from({ length: 11 }, (_, k) => k / 10),
    );
    const frenet = framesAtSamples(samples, { mode: 'frenet' });
    expect(Array.isArray(frenet) && frenet[5]?.normal[0]).toBeDefined();
    expect(framesAtSamples(samples, undefined)).toHaveLength(11);
    expect(framesAtSamples(samples, { mode: 'minimal' })).toHaveLength(11);
    const loop = [
      {
        type: 'arc' as const,
        points: [
          [50, 0, 0],
          [0, 50, 0],
          [-50, 0, 0],
        ] as [[number, number, number], [number, number, number], [number, number, number]],
      },
      {
        type: 'arc' as const,
        points: [
          [-50, 0, 0],
          [0, -50, 0],
          [50, 0, 0],
        ] as [[number, number, number], [number, number, number], [number, number, number]],
      },
    ];
    const closedFrenet = orientedFrames(loop, { mode: 'frenet' });
    expect(Array.isArray(closedFrenet) && closedFrenet.length).toBeGreaterThan(8);
    const closedMinimal = sweepFrames(loop);
    expect(closedMinimal.length).toBe(Array.isArray(closedFrenet) ? closedFrenet.length : -1);
  });

  it('axis_plane frames: radial x, axial y, section origin on the axis for the axial frame', () => {
    const helix = execute(empty, 'add_helix', { radius: 20, pitch: 10, turns: 1 });
    const swept = sweepEntity(
      {
        pathId: helix.affected[0],
        section: [
          [18, -1],
          [22, -1],
          [22, 1],
          [18, 1],
        ],
        sectionFrame: 'axial',
        orientation: { mode: 'axis_plane' },
      },
      helix.document,
    );
    expect(swept.orientation).toMatchObject({ mode: 'axis_plane', sectionFrame: 'axial' });
    const samples = sweepSamples(swept, [0, 0.5]);
    expect(Array.isArray(samples) && samples[0]?.normal[0]).toBeCloseTo(1, 6);
    const triangles = sweepTriangles(swept).flat();
    const radii = triangles.map((p) => Math.hypot(p[0] + swept.position[0], p[1] + swept.position[1]));
    expect(Math.min(...radii)).toBeGreaterThan(17.9);
    expect(Math.max(...radii)).toBeLessThan(22.1);
    const outward = execute(helix.document, 'sweep_profile', {
      pathId: helix.affected[0],
      section: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
      orientation: { mode: 'axis_plane' },
    });
    expect(outward.affected).toHaveLength(1);
  });
});

describe('nurbs paths and analytic volumes', () => {
  it('curveChain turns lines and quadratics into line / cubic segments; rational and quartic curves are refused', () => {
    expect(
      curveChain({
        degree: 1,
        poles: [
          [0, 0, 0],
          [1, 0, 0],
          [1, 0, 0],
          [1, 1, 0],
        ],
        knots: [0, 1 / 3, 2 / 3, 1],
        multiplicities: [2, 1, 1, 2],
      }),
    ).toHaveLength(2);
    const quadratic = curveChain({
      degree: 2,
      poles: [
        [0, 0, 0],
        [1, 1, 0],
        [2, 0, 0],
      ],
      knots: [0, 1],
      multiplicities: [3, 3],
    });
    expect(Array.isArray(quadratic) && quadratic.every((s) => s.type === 'bezier')).toBe(true);
    const multi = curveChain({
      degree: 3,
      poles: [
        [0, 0, 0],
        [1, 1, 0],
        [2, 1, 0],
        [3, 0, 0],
        [4, -1, 0],
        [5, 0, 0],
      ],
      knots: [0, 0.5, 1],
      multiplicities: [4, 1, 4],
    });
    expect(multi).toHaveLength(2);
    expect(
      typeof curveChain({
        degree: 2,
        poles: [
          [0, 0, 0],
          [1, 1, 0],
          [2, 0, 0],
        ],
        weights: [1, 2, 1],
        knots: [0, 1],
        multiplicities: [3, 3],
      }),
    ).toBe('string');
    expect(
      typeof curveChain({ degree: 4, poles: xyz(0, 0, 0, 1, 1, 0, 2, 0, 0, 3, 1, 0, 4, 0, 0), knots: [0, 1], multiplicities: [5, 5] }),
    ).toBe('string');
  });

  it('the closed form covers round sections only, and refuses laws a fixed plane cannot integrate', () => {
    const round = sweepEntity({ path: BAR, radius: 2 });
    expect(sweepAnalyticVolume(round)).toBeCloseTo(Math.PI * 4 * 100, 9);
    expect(sweepAnalyticVolume(sweepEntity({ path: BAR, radius: 2, area: { type: 'linear', start: 4, end: 8 } }))).toBeCloseTo(600, 6);
    expect(sweepAnalyticVolume(sweepEntity({ path: BAR, section: SQUARE }))).toBeNull();
    expect(sweepAnalyticVolume(sweepEntity({ path: BAR, radius: 2, stretch: { x: { type: 'constant', value: 2 } } }))).toBeNull();
    expect(
      sweepAnalyticVolume(
        sweepEntity({ path: BAR, radius: 2, orientation: { mode: 'fixed', direction: [1, 0, 1] }, scale: { type: 'constant', value: 1 } }),
      ),
    ).toBeNull();
    const bent = {
      ...round,
      path: [
        {
          type: 'arc' as const,
          points: [
            [0, 0, 0],
            [10, 10, 0],
            [20, 0, 0],
          ] as [[number, number, number], [number, number, number], [number, number, number]],
        },
      ],
      orientation: { mode: 'fixed' as const, direction: [1, 0, 0] as [number, number, number] },
    };
    expect(sweepAnalyticVolume(bent)).toBeNull();
  });

  it('sweepSamples reads stations and an unsupported frame', () => {
    const tapered = sweepEntity({
      path: BAR,
      stations: [
        { at: 0, radius: 4 },
        { at: 1, radius: 2 },
      ],
      stationBlend: 'linear',
    });
    const samples = sweepSamples(tapered, [0, 1]);
    expect(Array.isArray(samples) && samples.length).toBe(2);
    expect(sweepSamples({ ...tapered, orientation: { mode: 'frenet' } }, [0])).toMatchObject({ code: 'SWG_FRAME_DEGENERATE' });
  });
});

describe('section symmetry order', () => {
  it('counts the rotations that map a section onto itself', () => {
    expect(sectionSymmetryOrder({ shape: 'circle', radius: 1 })).toBe(Number.POSITIVE_INFINITY);
    expect(sectionSymmetryOrder({ shape: 'profile', profile: SQUARE })).toBe(4);
    expect(
      sectionSymmetryOrder({
        shape: 'profile',
        profile: [
          [-2, -1],
          [2, -1],
          [2, 1],
          [-2, 1],
        ],
      }),
    ).toBe(2);
    expect(
      sectionSymmetryOrder({
        shape: 'profile',
        profile: [
          [0, 1],
          [-Math.sqrt(3) / 2, -0.5],
          [Math.sqrt(3) / 2, -0.5],
        ],
      }),
    ).toBe(3);
    expect(
      sectionSymmetryOrder({
        shape: 'profile',
        profile: [
          [0, 0],
          [2, 0],
          [1, 3],
        ],
      }),
    ).toBe(1);
  });
});

describe('docWith raw sweeps', () => {
  it('a hand-built sweep with a wrong path never crashes the tessellation', () => {
    const doc = docWith({ id: 's', kind: 'sweep', path: [], section: { shape: 'circle', radius: 1 } });
    expect(sweepTriangles(doc.entities['s'] as SweepEntity)).toEqual([]);
    expect(sweepSamples(doc.entities['s'] as SweepEntity, [0.5])).toBeDefined();
  });
});
