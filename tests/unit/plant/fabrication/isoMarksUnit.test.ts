/**
 * Plant 05 ISO M5, review round: support marks and skew boxes at unit level on hand-built graphs and layouts - the drawn position (lerp along the drawn segment), the symbol
 * of each support type, degenerate steps, the nearest-segment rule, and the squaring-in polyline (closes at the end node, first leg along the projected axis, minimum leg).
 */

import { describe, expect, it } from 'vitest';
import type { Vec2, Vec3 } from '@core/model/vectors';
import { nodeKey } from '@aec/plant/fabrication/joints';
import type { IsoGraph, IsoRun, WalkStep } from '@aec/plant/fabrication/iso/isoGraph';
import type { IsoLayout } from '@aec/plant/fabrication/iso/isoLayout';
import { projectIso } from '@aec/plant/fabrication/iso/isoProjection';
import { skewFigures } from '@aec/plant/fabrication/iso/isoSkew';
import { supportMarks } from '@aec/plant/fabrication/iso/isoSupports';
import type { LineSupport } from '@aec/plant/fabrication/supports';
import { data } from '../../../helpers/commandAssertions';
import { s501 } from './isoM5Fixtures';

const step = (start: Vec3, end: Vec3): WalkStep => ({ start, end }) as unknown as WalkStep;
const graphOf = (...steps: WalkStep[]): IsoGraph => ({ steps }) as unknown as IsoGraph;
const layoutOf = (starts: Vec2[], ends: Vec2[]): IsoLayout => ({ starts, ends, nodes: new Map() }) as unknown as IsoLayout;
const support = (type: string, xyz: Vec3, id = 'sup'): LineSupport => ({ id, mark: id, type, xyz });

describe('supportMarks', () => {
  const graph = graphOf(step([0, 0, 0], [1000, 0, 0]));
  const layout = layoutOf([[10, 10]], [[110, 30]]);

  it('is drawn at the same fraction along the drawn segment as in 3D (t = 0.25 -> a quarter of the way)', () => {
    const [placed] = supportMarks([support('shoe', [250, 0, 0])], graph, layout);
    expect(placed?.at[0]).toBeCloseTo(35, 12);
    expect(placed?.at[1]).toBeCloseTo(15, 12);
  });

  it('the symbol of each type: shoe stem + base, guide with stops, anchor filled triangle, hanger stem up + bar, anything else a circle', () => {
    const symbols = Object.fromEntries(
      ['shoe', 'guide', 'anchor', 'hanger', 'unspecified', 'other-kind'].map((type) => [
        type,
        supportMarks([support(type, [250, 0, 0])], graph, layout)[0]?.primitives ?? [],
      ]),
    );
    const kinds = (type: string): string[] => (symbols[type] ?? []).map((primitive) => primitive.t);
    expect(kinds('shoe')).toEqual(['line', 'line']);
    expect(kinds('guide')).toEqual(['line', 'line', 'line', 'line']);
    expect(kinds('anchor')).toEqual(['poly']);
    expect(symbols['anchor']?.[0]).toMatchObject({ closed: true, fill: true });
    expect(kinds('hanger')).toEqual(['line', 'line']);
    const [x, y] = [35, 15];
    expect(symbols['hanger']?.[0]).toMatchObject({ a: [x, y], b: [x, y + 3.5] });
    expect(symbols['shoe']?.[0]).toMatchObject({ a: [x, y], b: [x, y - 3] });
    expect(kinds('unspecified')).toEqual(['circle']);
    expect(symbols['unspecified']?.[0]).toMatchObject({ r: 1.6 });
    expect(kinds('other-kind')).toEqual(['circle']);
  });

  it('a zero-length step is skipped, so the support lies on the next segment that carries it', () => {
    const withZero = graphOf(step([0, 0, 0], [0, 0, 0]), step([0, 0, 0], [1000, 0, 0]));
    const [placed] = supportMarks(
      [support('shoe', [500, 0, 0])],
      withZero,
      layoutOf(
        [
          [0, 0],
          [10, 10],
        ],
        [
          [0, 0],
          [110, 10],
        ],
      ),
    );
    expect(placed?.at).toEqual([60, 10]);
    expect(supportMarks([support('shoe', [0, 0, 0])], graphOf(step([0, 0, 0], [0, 0, 0])), layoutOf([[0, 0]], [[0, 0]]))).toEqual([]);
  });

  it('at a joint of two segments the first wins on a tie, the nearer wins otherwise, and a point over 1.5 mm off every segment is not drawn', () => {
    const corner = graphOf(step([0, 0, 0], [1000, 0, 0]), step([1000, 0, 0], [1000, 1000, 0]));
    const drawn = layoutOf(
      [
        [0, 0],
        [100, 0],
      ],
      [
        [100, 0],
        [100, 100],
      ],
    );
    expect(supportMarks([support('shoe', [1000, 0, 0])], corner, drawn)[0]?.at).toEqual([100, 0]);
    expect(supportMarks([support('shoe', [1000, 500, 0.5])], corner, drawn)[0]?.at).toEqual([100, 50]);
    expect(supportMarks([support('shoe', [1000, 500, 2])], corner, drawn)).toEqual([]);
    expect(supportMarks([support('shoe', [999.9, 0, 0])], corner, drawn)[0]?.at[0]).toBeCloseTo(99.99, 9);
  });
});

describe('support marks on the sheet', () => {
  it('the label sits 5 mm below the symbol anchor, which is the drawn point of the support (stem start of the shoe)', () => {
    const sheet = data<{
      files: Array<{ name: string; content: string }>;
      annotations: Array<{ kind: string; text: string; sheet: number[] }>;
    }>(s501(), 'export_isometric', { lineId: 'S-501', style: 'check', paper: 'A3' });
    const svg = sheet.files[0]?.content ?? '';
    const stems = [...svg.matchAll(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)" class="iso-symb"\/>/g)].filter(
      (m) => m[1] === m[3] && Math.abs(Number(m[4]) - Number(m[2]) - 3) < 1e-6,
    );
    const marks = sheet.annotations.filter((annotation) => annotation.kind === 'support');
    expect(marks).toHaveLength(2);
    expect(stems.length).toBeGreaterThanOrEqual(2);
    for (const mark of marks) {
      const anchor = stems.find(
        (m) =>
          Math.abs(Number(m[1]) - (mark.sheet[0] as number)) < 0.006 &&
          Math.abs(297 - Number(m[2]) - 5 - (mark.sheet[1] as number)) < 0.006,
      );
      expect(anchor, mark.text).toBeDefined();
    }
  });
});

describe('skewFigures', () => {
  const run = (a: Vec3, b: Vec3, axis: IsoRun['axis'] = 'skew'): IsoGraph =>
    ({ runs: [{ id: 1, axis, dir: [0, 0, 0], steps: [], points: [a, b] }] }) as unknown as IsoGraph;
  const nodes = (a: Vec3, b: Vec3, from: Vec2, to: Vec2): IsoLayout =>
    ({
      nodes: new Map<string, Vec2>([
        [nodeKey(a), from],
        [nodeKey(b), to],
      ]),
    }) as unknown as IsoLayout;
  const unit = (v: Vec2): Vec2 => [v[0] / Math.hypot(...v), v[1] / Math.hypot(...v)];

  it('the polyline closes at the end node of the run (1e-9) and its first leg runs along the projected axis', () => {
    const [a, b]: [Vec3, Vec3] = [
      [0, 0, 0],
      [1000, 1000, 0],
    ];
    const from: Vec2 = [20, 30];
    const factor = 0.05;
    const projected = projectIso([1000, 1000, 0], 'up_right');
    const to: Vec2 = [from[0] + projected[0] * factor, from[1] + projected[1] * factor];
    const figure = skewFigures(run(a, b), nodes(a, b, from, to), 'up_right');
    const poly = figure.primitives[0];
    expect(poly?.t).toBe('poly');
    const points = (poly as unknown as { points: Vec2[] }).points;
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual(from);
    expect(Math.hypot(points[2]![0] - to[0], points[2]![1] - to[1])).toBeLessThan(1e-9);
    const first = unit([points[1]![0] - from[0], points[1]![1] - from[1]]);
    const axis = unit(projectIso([1, 0, 0], 'up_right'));
    expect(Math.hypot(first[0] - axis[0], first[1] - axis[1])).toBeLessThan(1e-12);
  });

  it('an oblique run has three legs, closes at the end node, and honours north up_left and negative directions', () => {
    const [a, b]: [Vec3, Vec3] = [
      [0, 0, 0],
      [-1000, 500, -250],
    ];
    const from: Vec2 = [0, 0];
    const projected = projectIso([-1000, 500, -250], 'up_left');
    const to: Vec2 = [projected[0] * 0.1, projected[1] * 0.1];
    const points = (skewFigures(run(a, b), nodes(a, b, from, to), 'up_left').primitives[0] as unknown as { points: Vec2[] }).points;
    expect(points).toHaveLength(4);
    expect(Math.hypot(points[3]![0] - to[0], points[3]![1] - to[1])).toBeLessThan(1e-9);
    const first = unit([points[1]![0], points[1]![1]]);
    const axis = unit(projectIso([-1, 0, 0], 'up_left'));
    expect(Math.hypot(first[0] - axis[0], first[1] - axis[1])).toBeLessThan(1e-12);
  });

  it('draws nothing for a run with fewer than two legs, a missing node, a non-skew axis or no points; the minimum leg is 0.05 mm', () => {
    const [a, b]: [Vec3, Vec3] = [
      [0, 0, 0],
      [1000, 0.01, 0],
    ];
    const layout = nodes(a, b, [0, 0], [50, 0]);
    expect(skewFigures(run(a, b), layout, 'up_right').primitives).toEqual([]);
    const [c, d]: [Vec3, Vec3] = [
      [0, 0, 0],
      [1000, 0.04, 0],
    ];
    expect(skewFigures(run(c, d), nodes(c, d, [0, 0], [50, 0]), 'up_right').primitives).toEqual([]);
    const [e, f]: [Vec3, Vec3] = [
      [0, 0, 0],
      [1000, 0.06, 0],
    ];
    expect(skewFigures(run(e, f), nodes(e, f, [0, 0], [50, 0]), 'up_right').primitives).toHaveLength(1);
    const [g, h]: [Vec3, Vec3] = [
      [0, 0, 0],
      [1000, 1000, 0],
    ];
    expect(skewFigures(run(g, h), { nodes: new Map() } as unknown as IsoLayout, 'up_right')).toEqual({ primitives: [], marks: [] });
    const oneNode = { nodes: new Map<string, Vec2>([[nodeKey(g), [0, 0]]]) } as unknown as IsoLayout;
    expect(skewFigures(run(g, h), oneNode, 'up_right').marks).toEqual([]);
    expect(skewFigures(run(g, h, '+E'), nodes(g, h, [0, 0], [10, 10]), 'up_right').marks).toEqual([]);
    expect(
      skewFigures(
        { runs: [{ id: 1, axis: 'skew', dir: [0, 0, 0], steps: [], points: [] }] } as unknown as IsoGraph,
        layoutOf([], []),
        'up_right',
      ).marks,
    ).toEqual([]);
  });
});
