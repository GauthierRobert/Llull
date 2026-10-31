/** Plant 05 ISO M3: projection (VC-ISO-10), graph, dimensions (VC-ISO-11), slope (VC-ISO-12) and layout of hand-built networks and of the fixture. */

import { describe, expect, it } from 'vitest';
import { directionFrame } from '@core/geometry/viewDirections';
import type { Vec3 } from '@core/model/vectors';
import type { NetworkComponent, PipingNetwork } from '@aec/plant/fabrication/model';
import { networkOf } from '@aec/plant/fabrication/pcf/pcfMap';
import { readPcf } from '@aec/plant/fabrication/pcf/pcfRead';
import { lineAnnotations, mmText, roundMm, runDimensions } from '@aec/plant/fabrication/iso/isoDimensions';
import { buildIsoGraph, classifyDirection, type IsoGraph } from '@aec/plant/fabrication/iso/isoGraph';
import { MIN_DRAWN_MM, layoutIso } from '@aec/plant/fabrication/iso/isoLayout';
import { TRUE_ISO_SCALE, axisAngles, depthOf, projectIso } from '@aec/plant/fabrication/iso/isoProjection';
import { fixturePcf } from './fabricationFixtures';

const pipe = (id: string, a: Vec3, b: Vec3): NetworkComponent => ({
  id,
  type: 'PIPE',
  ends: [
    { xyz: a, boreMm: 100, endType: 'BW' },
    { xyz: b, boreMm: 100, endType: 'BW' },
  ],
  itemCode: 'PIPE',
});
const network = (components: NetworkComponent[]): PipingNetwork => ({
  lineId: 'T',
  attributes: {},
  components,
  source: 'pcf',
  warnings: [],
});
const chain = (points: Vec3[]): PipingNetwork => network(points.slice(1).map((point, at) => pipe(`p${at + 1}`, points[at] as Vec3, point)));
const degrees = (vector: readonly [number, number]): number => (Math.atan2(vector[1], vector[0]) * 180) / Math.PI;
const AREA = { width: 330, height: 200 };

const fixtureGraph = (): IsoGraph => {
  const read = readPcf(fixturePcf());
  if (!read.ok) throw new Error('fixture does not read');
  return buildIsoGraph(networkOf(read.file));
};

describe('VC-ISO-10: true isometric projection', () => {
  it('east -30, north +30, up 90 degrees, 120 degrees between the axes, north arrow along the projected north', () => {
    const angles = axisAngles('up_right');
    expect(angles.east).toBeCloseTo(-30, 9);
    expect(angles.north).toBeCloseTo(30, 9);
    expect(angles.up).toBeCloseTo(90, 9);
    expect(angles.northArrow).toBeCloseTo(30, 9);
    expect(angles.north - angles.east).toBeCloseTo(60, 9);
    expect(TRUE_ISO_SCALE).toBeCloseTo(0.816496580928, 12);
  });

  it('is the iso frame of viewDirections.ts (the same angles from its right / up vectors)', () => {
    const frame = directionFrame('iso');
    expect(degrees(frame.project([1, 0, 0]))).toBeCloseTo(-30, 9);
    expect(degrees(frame.project([0, 1, 0]))).toBeCloseTo(30, 9);
    expect(degrees(frame.project([0, 0, 1]))).toBeCloseTo(90, 9);
    const [x, y] = frame.project([1, 0, 0]);
    expect(Math.hypot(x, y)).toBeCloseTo(TRUE_ISO_SCALE, 12);
    expect(degrees(projectIso([1, 0, 0], 'up_right'))).toBeCloseTo(-30, 9);
  });

  it('up_left turns the plant by +90 degrees about Z: north at 150, east at +30', () => {
    const angles = axisAngles('up_left');
    expect(angles.north).toBeCloseTo(150, 9);
    expect(angles.east).toBeCloseTo(30, 9);
    expect(angles.up).toBeCloseTo(90, 9);
    expect(angles.northArrow).toBeCloseTo(150, 9);
  });

  it('depth grows toward the viewer (+X, -Y, +Z)', () => {
    expect(depthOf([1, 0, 0], 'up_right')).toBeGreaterThan(depthOf([-1, 0, 0], 'up_right'));
    expect(depthOf([0, -1, 0], 'up_right')).toBeGreaterThan(depthOf([0, 1, 0], 'up_right'));
    expect(depthOf([0, 0, 1], 'up_right')).toBeGreaterThan(0);
  });
});

describe('graph: runs and direction classes', () => {
  it('classifies axes, a slight fall, and skew', () => {
    expect(classifyDirection([1, 0, 0])).toBe('+E');
    expect(classifyDirection([0, -1, 0])).toBe('-N');
    expect(classifyDirection([0, 0, -1])).toBe('-U');
    expect(classifyDirection([1, 0.00001, 0])).toBe('+E');
    const fall = Math.hypot(1, 0.01);
    expect(classifyDirection([1 / fall, 0, -0.01 / fall])).toBe('slope');
    const steep = Math.hypot(1, 0.5);
    expect(classifyDirection([1 / steep, 0, -0.5 / steep])).toBe('skew');
    const diagonal = Math.SQRT1_2;
    expect(classifyDirection([diagonal, diagonal, 0])).toBe('skew');
  });

  it('the fixture is five runs in one connected group, walked run before branch', () => {
    const graph = fixtureGraph();
    expect(graph.groups).toBe(1);
    expect(graph.unreachable).toEqual([]);
    expect(graph.runs.map((run) => run.axis)).toEqual(['+E', '+N', '-U', '+E', '+U']);
    expect(graph.runs[0]?.points[0]).toEqual([0, 0, 3000]);
    expect(graph.steps[0]?.parent).toBe(-1);
  });

  it('a component with no centre point (elbow) goes through the L corner; unconnected pieces are another group', () => {
    const elbow: NetworkComponent = {
      id: 'e',
      type: 'ELBOW',
      ends: [
        { xyz: [100, 0, 0], boreMm: 100, endType: 'BW' },
        { xyz: [150, 50, 0], boreMm: 100, endType: 'BW' },
      ],
    };
    const graph = buildIsoGraph(network([pipe('a', [0, 0, 0], [100, 0, 0]), elbow, pipe('far', [900, 900, 0], [1000, 900, 0])]));
    expect(graph.steps.filter((step) => step.segment.componentId === 'e').map((step) => [step.end[0], step.end[1]])).toEqual([
      [150, 0],
      [150, 50],
    ]);
    expect(graph.groups).toBe(2);
    expect(graph.unreachable).toEqual(['far']);
  });
});

describe('VC-ISO-11: dimensions are the 3D centreline distances and close to the overall', () => {
  it('the fixture east run is 76 / 2424 / 2348 / 152 = 5000, the north run 4000, the other runs close too', () => {
    const dimensions = runDimensions(fixtureGraph());
    expect(dimensions[0]?.values).toEqual([76, 2424, 2348, 152]);
    expect(dimensions[0]?.overall).toBe(5000);
    expect(dimensions[1]?.overall).toBe(4000);
    for (const dimension of dimensions) {
      expect(dimension.mismatches).toBe(0);
      expect(dimension.values.reduce((sum, value) => sum + value, 0)).toBeCloseTo(dimension.overall, 6);
      for (const label of dimension.labels) expect(Math.abs(label.valueMm - label.exactMm)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });

  it('a length shows one decimal at most, no trailing zero and no negative zero', () => {
    expect(mmText(1000.04)).toBe('1000');
    expect(mmText(1234.56)).toBe('1234.6');
    expect(roundMm(-0.01)).toBe(0);
    expect(Object.is(roundMm(-0.01), 0)).toBe(true);
    const [dimension] = runDimensions(
      buildIsoGraph(
        chain([
          [0, 0, 0],
          [1000.04, 0, 0],
          [2500.5, 0, 0],
        ]),
      ),
    );
    expect(dimension?.values).toEqual([1000, 1500.5]);
    expect(dimension?.mismatches).toBe(0);
  });

  it('a string that does not close to its overall is counted as a mismatch (the guard)', () => {
    const graph: IsoGraph = {
      steps: [],
      runs: [
        {
          id: 1,
          axis: '+E',
          dir: [1, 0, 0],
          steps: [],
          points: [
            [0, 0, 0],
            [100, 100, 0],
            [200, 0, 0],
          ],
        },
      ],
      groups: 1,
      unreachable: [],
      degree: new Map(),
      points: new Map(),
    };
    expect(runDimensions(graph)[0]?.mismatches).toBe(1);
  });

  it('a run with a single point has no dimension', () => {
    const graph: IsoGraph = {
      steps: [],
      runs: [{ id: 1, axis: '+E', dir: [1, 0, 0], steps: [], points: [[0, 0, 0]] }],
      groups: 1,
      unreachable: [],
      degree: new Map(),
      points: new Map(),
    };
    expect(runDimensions(graph)).toEqual([]);
  });
});

describe('elevations and coordinates', () => {
  it('EL at the horizontal runs and the vertical line end, E / N at the line ends and the branch', () => {
    const texts = lineAnnotations(fixtureGraph()).map((annotation) => annotation.text);
    expect(texts).toContain('EL +3000');
    expect(texts).toContain('EL +1000');
    expect(texts).toContain('EL +1500');
    expect(texts).toContain('E 0 N 0');
    expect(texts).toContain('E 8000 N 4000');
    expect(texts.filter((text) => text === 'EL +3000')).toHaveLength(2);
  });

  it('a negative elevation shows its sign, zero shows none', () => {
    const texts = lineAnnotations(
      buildIsoGraph(
        chain([
          [0, 0, -250],
          [1000, 0, -250],
        ]),
      ),
    ).map((annotation) => annotation.text);
    expect(texts).toContain('EL -250');
    expect(
      lineAnnotations(
        buildIsoGraph(
          chain([
            [0, 0, 0],
            [1000, 0, 0],
          ]),
        ),
      ).map((annotation) => annotation.text),
    ).toContain('EL 0');
  });
});

describe('VC-ISO-12: slope', () => {
  const slope = (points: Vec3[]): Record<string, unknown> | undefined =>
    lineAnnotations(buildIsoGraph(chain(points))).find((annotation) => annotation.kind === 'slope');

  it('100 mm over 10 m is SLOPE 1:100, 1 %, 0.5729386977 degrees, falling toward +X', () => {
    const found = slope([
      [0, 0, 1000],
      [10000, 0, 900],
    ]);
    expect(found?.['text']).toBe('SLOPE 1:100');
    expect(found?.['ratio']).toBe('1:100');
    expect(found?.['percent'] as number).toBeCloseTo(1, 9);
    expect(found?.['deg'] as number).toBeCloseTo(0.5729386977, 9);
    expect(found?.['fallDirection']).toBe('+X');
    const labels = lineAnnotations(
      buildIsoGraph(
        chain([
          [0, 0, 1000],
          [10000, 0, 900],
        ]),
      ),
    ).filter((annotation) => annotation.kind === 'elevation');
    expect(labels.map((annotation) => annotation.text)).toEqual(['EL +1000', 'EL +900']);
  });

  it('a ratio that is not within 0.5 % of an integer is given as a percent', () => {
    const found = slope([
      [0, 0, 1000],
      [10000, 0, 864],
    ]);
    expect(found?.['ratio']).toBeNull();
    expect(found?.['text']).toBe('SLOPE 1.36 %');
  });

  it('the fall arrow follows the falling end: rising toward +X falls toward -X, and along Y', () => {
    expect(
      slope([
        [0, 0, 1000],
        [10000, 0, 1100],
      ])?.['fallDirection'],
    ).toBe('-X');
    expect(
      slope([
        [0, 0, 1000],
        [0, 10000, 900],
      ])?.['fallDirection'],
    ).toBe('+Y');
    expect(
      slope([
        [0, 10000, 1000],
        [0, 0, 900],
      ])?.['fallDirection'],
    ).toBe('-Y');
  });

  it('a level run, a vertical run and a steep or diagonal run carry no slope annotation', () => {
    expect(
      slope([
        [0, 0, 1000],
        [10000, 0, 1000],
      ]),
    ).toBeUndefined();
    expect(
      slope([
        [0, 0, 0],
        [0, 0, 5000],
      ]),
    ).toBeUndefined();
    expect(
      slope([
        [0, 0, 0],
        [1000, 0, 500],
      ]),
    ).toBeUndefined();
    expect(
      slope([
        [0, 0, 0],
        [1000, 1000, 10],
      ]),
    ).toBeUndefined();
  });
});

describe('not-to-scale layout', () => {
  const lengthsOf = (points: Vec3[]): number[] => {
    const graph = buildIsoGraph(chain(points));
    const layout = layoutIso(graph, 'up_right', AREA);
    return graph.steps.map((_step, index) => {
      const [a, b] = [layout.starts[index] as readonly number[], layout.ends[index] as readonly number[]];
      return Math.hypot((b[0] as number) - (a[0] as number), (b[1] as number) - (a[1] as number)) / layout.scale;
    });
  };

  it('drawn lengths never fall under the minimum and grow with the 3D length (longer pipes look longer)', () => {
    const lengths = [30, 300, 1500, 6000];
    const drawn = lengthsOf([
      [0, 0, 0],
      [lengths[0] as number, 0, 0],
      [lengths[0] as number, lengths[1] as number, 0],
      [lengths[0] as number, lengths[1] as number, lengths[2] as number],
      [(lengths[0] as number) + (lengths[3] as number), lengths[1] as number, lengths[2] as number],
    ]);
    expect(Math.min(...drawn)).toBeGreaterThanOrEqual(MIN_DRAWN_MM - 1e-9);
    drawn.forEach((length, at) => expect(length).toBeGreaterThanOrEqual((drawn[at - 1] ?? 0) - 1e-6));
  });

  it('fits the area, is deterministic, and starts at the origin of its bounds', () => {
    const graph = fixtureGraph();
    const first = layoutIso(graph, 'up_right', AREA);
    expect(first.bounds[2]).toBeLessThanOrEqual(AREA.width + 1e-6);
    expect(first.bounds[3]).toBeLessThanOrEqual(AREA.height + 1e-6);
    expect(first.overflow).toBe(false);
    expect(first.scale).toBe(1);
    expect(JSON.stringify(layoutIso(graph, 'up_right', AREA))).toBe(JSON.stringify(first));
    expect(first.nodes.size).toBeGreaterThan(10);
  });

  it('draws the plant turned for up_left: the east run goes up-right instead of down-right', () => {
    const graph = buildIsoGraph(
      chain([
        [0, 0, 0],
        [1000, 0, 0],
      ]),
    );
    const right = layoutIso(graph, 'up_right', AREA);
    const left = layoutIso(graph, 'up_left', AREA);
    const direction = (layout: typeof right): number =>
      ((layout.ends[0] as readonly number[])[1] as number) - ((layout.starts[0] as readonly number[])[1] as number);
    expect(direction(right)).toBeLessThan(0);
    expect(direction(left)).toBeGreaterThan(0);
  });

  it('a line too large for the area is shrunk and reported as overflow', () => {
    const points: Vec3[] = [[0, 0, 0]];
    for (let k = 0; k < 60; k++) {
      const last = points[points.length - 1] as Vec3;
      points.push(k % 2 === 0 ? [last[0] + 3000, last[1], last[2]] : [last[0], last[1] + 3000, last[2]]);
    }
    const layout = layoutIso(buildIsoGraph(chain(points)), 'up_right', { width: 100, height: 60 });
    expect(layout.overflow).toBe(true);
    expect(layout.scale).toBeLessThan(0.7);
    expect(layout.bounds[2]).toBeLessThanOrEqual(100 + 1e-6);
  });

  it('two pipes that land on the same sheet line are separated or, failing that, reported as crossings with the farther one named', () => {
    // +E then +U lands where +N lands: a tee branch run along +N from the start overlaps the +E / +U detour only at its ends; a closed
    // ring of E, N, -E, -N, U, ... exercises the crossing search deterministically.
    const ring: Vec3[] = [
      [0, 0, 0],
      [3000, 0, 0],
      [3000, 3000, 0],
      [0, 3000, 0],
      [0, 3000, 3000],
      [3000, 3000, 3000],
      [3000, 0, 3000],
      [0, 0, 3000],
      [0, 0, 400],
      [-3000, 0, 400],
    ];
    const layout = layoutIso(buildIsoGraph(chain(ring)), 'up_right', AREA);
    expect(layout.passes).toBeLessThanOrEqual(12);
    for (const crossing of layout.crossings) {
      expect(crossing.a).toBeLessThan(crossing.b);
      expect([crossing.a, crossing.b]).toContain(crossing.farther);
    }
    expect(JSON.stringify(layoutIso(buildIsoGraph(chain(ring)), 'up_right', AREA))).toBe(JSON.stringify(layout));
  });
});
