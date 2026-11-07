/** import_dxf of the entities export_dxf writes (and what other CAD writes): HATCH paths, SPLINE forms, ELLIPSE, TEXT alignment, layer state. */
import { describe, expect, it } from 'vitest';
import { type CadDocument, type Entity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { parseDxf } from '@lib/dxfRead';

type Pair = [number, string | number];

const text = (...pairs: Pair[]): string => pairs.map(([code, value]) => `${code}\n${value}`).join('\n') + '\n';
const file = (...entities: Pair[]): string => text([0, 'SECTION'], [2, 'ENTITIES'], ...entities, [0, 'ENDSEC'], [0, 'EOF']);
const importText = (source: string): { document: CadDocument; summary: string; entities: Entity[] } => {
  const result = execute(createEmptyDocument(), 'import_dxf', { text: source });
  return {
    document: result.document,
    summary: result.summary,
    entities: result.affected.map((id) => result.document.entities[id] as Entity),
  };
};

/** HATCH head: elevation point, extrusion, name, solid flag, associativity, path count. */
const hatchHead = (paths: number, solid = 0): Pair[] => [
  [0, 'HATCH'],
  [8, 'H'],
  [10, 0],
  [20, 0],
  [30, 0],
  [210, 0],
  [220, 0],
  [230, 1],
  [2, 'X'],
  [70, solid],
  [71, 0],
  [91, paths],
];
// prettier-ignore
const square = (x: number, size: number): Pair[] => [
  [92, 3], [72, 0], [73, 1], [93, 4],
  [10, x], [20, 0], [10, x + size], [20, 0], [10, x + size], [20, size], [10, x], [20, size], [97, 0],
];
const solidTail: Pair[] = [
  [75, 0],
  [76, 1],
  [98, 0],
];

interface HatchedRegion {
  readonly kind: string;
  readonly loops: number[][][];
  readonly hatch: { pattern: string; angle: number; spacing: number };
}

describe('import_dxf: HATCH', () => {
  it('a predefined ANSI31-style pattern gives its line angle and spacing from the first pattern line', () => {
    // prettier-ignore
    const pattern: Pair[] = [[75, 0], [76, 1], [52, 0], [41, 1], [77, 0], [78, 1], [53, 45], [43, 0], [44, 0], [45, -2.245], [46, 2.245], [79, 0], [98, 0]];
    const region = importText(file(...hatchHead(1), ...square(0, 10), ...pattern)).entities[0] as unknown as HatchedRegion;
    expect(region.kind).toBe('region');
    expect(region.hatch.pattern).toBe('lines');
    expect(region.hatch.angle).toBeCloseTo(Math.PI / 4, 9);
    expect(region.hatch.spacing).toBeCloseTo(3.175, 3);
  });

  it('two perpendicular predefined lines are a cross; a user-defined double hatch is a cross too', () => {
    // prettier-ignore
    const twoLines: Pair[] = [[75, 0], [76, 1], [52, 0], [41, 1], [78, 2], [53, 0], [45, 0], [46, 2], [79, 0], [53, 90], [45, -2], [46, 0], [79, 0], [98, 0]];
    const cross = importText(file(...hatchHead(1), ...square(0, 10), ...twoLines)).entities[0] as unknown as HatchedRegion;
    expect(cross.hatch.pattern).toBe('cross');
    const user: Pair[] = [
      [75, 0],
      [76, 0],
      [52, 90],
      [41, 2],
      [77, 1],
      [78, 0],
      [98, 0],
    ];
    const region = importText(file(...hatchHead(1), ...square(0, 10), ...user)).entities[0] as unknown as HatchedRegion;
    expect(region.hatch).toMatchObject({ pattern: 'cross', spacing: 2 });
    expect(region.hatch.angle).toBeCloseTo(Math.PI / 2, 9);
  });

  it('a solid hatch is a solid region whose spacing (not in the DXF) defaults to 1/40 of the diagonal', () => {
    const region = importText(file(...hatchHead(1, 1), ...square(0, 40), ...solidTail)).entities[0] as unknown as HatchedRegion;
    expect(region.hatch.pattern).toBe('solid');
    expect(region.hatch.spacing).toBeCloseTo((40 * Math.SQRT2) / 40, 9);
    expect(region.hatch.angle).toBeCloseTo(Math.PI / 4, 9);
  });

  it('reads edge paths (line + counter-clockwise and clockwise arcs) and bulged polyline paths', () => {
    // prettier-ignore
    const edges = (ccw: number): Pair[] => [
      [92, 1], [93, 2],
      [72, 1], [10, 0], [20, 0], [11, 10], [21, 0],
      [72, 2], [10, 5], [20, 0], [40, 5], [50, 0], [51, 180], [73, ccw],
      [97, 0],
    ];
    const clockwise = importText(file(...hatchHead(1, 1), ...edges(0), ...solidTail)).entities[0] as unknown as HatchedRegion;
    // the clockwise arc from 0 to 180 degrees about (5,0) runs through (5,-5)
    expect(clockwise.loops[0]?.some((p) => (p[1] as number) < -4.9)).toBe(true);
    const ccw = importText(file(...hatchHead(1, 1), ...edges(1), ...solidTail)).entities[0] as unknown as HatchedRegion;
    expect(ccw.loops[0]?.some((p) => (p[1] as number) > 4.9)).toBe(true);
    // prettier-ignore
    const bulged: Pair[] = [[92, 3], [72, 1], [73, 1], [93, 2], [10, 0], [20, 0], [42, 1], [10, 10], [20, 0], [42, 1], [97, 0]];
    const disc = importText(file(...hatchHead(1, 1), ...bulged, ...solidTail)).entities[0] as unknown as HatchedRegion;
    expect(disc.loops[0]?.length).toBeGreaterThan(20);
    expect(Math.max(...(disc.loops[0] as number[][]).map((p) => p[1] as number))).toBeCloseTo(5, 1);
  });

  it('loops that cross are kept as closed polylines; an unreadable boundary is skipped and named', () => {
    const crossing = importText(file(...hatchHead(2, 1), ...square(0, 10), ...square(5, 10), ...solidTail));
    expect(crossing.entities.map((e) => e.kind)).toEqual(['polyline', 'polyline']);
    expect(crossing.summary).toContain('2 polyline (hatch loop)');
    const splineEdge: Pair[] = [
      [92, 1],
      [93, 1],
      [72, 4],
      [94, 3],
      [73, 0],
      [74, 0],
    ];
    const line: Pair[] = [
      [0, 'LINE'],
      [8, 'L'],
      [10, 0],
      [20, 0],
      [11, 1],
      [21, 1],
    ];
    const skipped = importText(file(...hatchHead(1, 1), ...splineEdge, ...solidTail, ...line));
    expect(skipped.entities.map((e) => e.kind)).toEqual(['line']);
    expect(skipped.summary).toContain('skipped 1 HATCH (unreadable boundary)');
    expect(importText(file(...hatchHead(0))).summary).toContain('nothing importable');
  });
});

describe('import_dxf: SPLINE, ELLIPSE, TEXT, rectangle marks, layer state', () => {
  const llull = (tag: string, ...rest: Pair[]): Pair[] => [[1001, 'LLULL'], [1000, tag], ...rest];
  const lw = (points: number[][], ...marks: Pair[]): Pair[] => [
    [0, 'LWPOLYLINE'],
    [8, 'P'],
    [90, points.length],
    [70, 1],
    ...points.flatMap(([x, y]): Pair[] => [
      [10, x as number],
      [20, y as number],
    ]),
    ...marks,
  ];

  it('a SPLINE with fit points becomes a spline through them (closed from flag 1); a malformed one is skipped and named', () => {
    // prettier-ignore
    const fit = importText(file([0, 'SPLINE'], [8, 'S'], [70, 9], [71, 3], [11, 0], [21, 0], [31, 0], [11, 4], [21, 0], [31, 0], [11, 4], [21, 4], [31, 0]));
    expect(fit.entities[0]).toMatchObject({
      kind: 'spline',
      closed: true,
      points: [
        [0, 0],
        [4, 0],
        [4, 4],
      ],
    });
    // prettier-ignore
    const bad = importText(file([0, 'SPLINE'], [8, 'S'], [71, 3], [72, 2], [40, 0], [40, 1], [10, 0], [20, 0], [30, 0], [0, 'LINE'], [8, 'L'], [10, 0], [20, 0], [11, 1], [21, 1]));
    expect(bad.summary).toContain('skipped 1 SPLINE (malformed)');
  });

  it('a clamped quadratic rational NURBS is sampled along its curve (the weighted Bezier through (0,0) (5,5) (10,0) peaks below its control point)', () => {
    // prettier-ignore
    const nurbs: Pair[] = [[70, 8], [71, 2], [72, 6], [73, 3], [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1], [10, 0], [20, 0], [30, 0], [10, 5], [20, 5], [30, 0], [10, 10], [20, 0], [30, 0], [41, 1], [41, 1], [41, 1]];
    const spline = importText(file([0, 'SPLINE'], [8, 'S'], ...nurbs)).entities[0];
    expect(spline).toMatchObject({ kind: 'spline', closed: false });
    const peak = Math.max(...(spline as unknown as { points: number[][] }).points.map((p) => p[1] as number));
    expect(peak).toBeCloseTo(2.5, 6);
    // prettier-ignore
    const heavy = nurbs.map((pair, index): Pair => (pair[0] === 41 && index === nurbs.length - 2 ? [41, 4] : pair));
    const weighted = importText(file([0, 'SPLINE'], [8, 'S'], ...heavy)).entities[0] as unknown as { points: number[][] };
    expect(Math.max(...weighted.points.map((p) => p[1] as number))).toBeGreaterThan(3);
  });

  it('ELLIPSE: a complete one is an ellipse entity along its major axis, an arc is a polyline, a non-uniform INSERT samples it', () => {
    // prettier-ignore
    const full = importText(file([0, 'ELLIPSE'], [8, 'E'], [10, 1], [20, 2], [30, 0], [11, 0], [21, 4], [31, 0], [40, 0.5], [41, 0], [42, Math.PI * 2])).entities[0];
    expect(full).toMatchObject({ kind: 'ellipse', radiusX: 4, radiusY: 2, position: [1, 2, 0] });
    expect(full?.rotation[2]).toBeCloseTo(Math.PI / 2, 9);
    // prettier-ignore
    const arc = importText(file([0, 'ELLIPSE'], [8, 'E'], [10, 0], [20, 0], [30, 0], [11, 4], [21, 0], [31, 0], [40, 0.5], [41, 0], [42, 1])).entities[0];
    expect(arc?.kind).toBe('polyline');
    // prettier-ignore
    const block: Pair[] = [
      [0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [2, 'B'], [10, 0], [20, 0], [30, 0],
      [0, 'ELLIPSE'], [8, '0'], [10, 0], [20, 0], [30, 0], [11, 2], [21, 0], [31, 0], [40, 0.5], [41, 0], [42, Math.PI * 2],
      [0, 'SPLINE'], [8, '0'], [11, 0], [21, 0], [31, 0], [11, 1], [21, 1], [31, 0],
      [0, 'ENDBLK'], [0, 'ENDSEC'],
    ];
    const insert = (sx: number, sy: number): string =>
      text(
        ...block,
        [0, 'SECTION'],
        [2, 'ENTITIES'],
        [0, 'INSERT'],
        [2, 'B'],
        [8, 'L'],
        [10, 5],
        [20, 0],
        [30, 0],
        [41, sx],
        [42, sy],
        [0, 'ENDSEC'],
        [0, 'EOF'],
      );
    expect(importText(insert(3, 3)).entities.map((e) => e.kind)).toEqual(['ellipse', 'spline']);
    expect(importText(insert(3, 1)).entities.map((e) => e.kind)).toEqual(['polyline', 'spline']);
  });

  it('TEXT keeps its alignment (the alignment point is the anchor) and decodes unicode escapes', () => {
    // prettier-ignore
    const result = importText(file([0, 'TEXT'], [8, 'T'], [10, 0], [20, 0], [30, 0], [11, 5], [21, 6], [31, 0], [40, 2], [1, 'A\\U+00D8B'], [72, 2]));
    expect(result.entities[0]).toMatchObject({ kind: 'text', content: 'AØB', anchor: 'right', position: [5, 6, 0] });
  });

  it('a polyline marked rectangle that is not a rectangle stays a polyline; overlapping marked region loops too', () => {
    const skew = importText(
      file(
        ...lw(
          [
            [0, 0],
            [4, 0],
            [5, 3],
            [0, 3],
          ],
          ...llull('rectangle'),
        ),
      ),
    );
    expect(skew.entities[0]?.kind).toBe('polyline');
    const clockwise = importText(
      file(
        ...lw(
          [
            [0, 0],
            [0, 3],
            [4, 3],
            [4, 0],
          ],
          ...llull('rectangle'),
        ),
      ),
    );
    expect(clockwise.entities[0]?.kind).toBe('polyline');
    const ok = importText(
      file(
        ...lw(
          [
            [1, 1],
            [5, 1],
            [5, 4],
            [1, 4],
          ],
          ...llull('rectangle'),
        ),
      ),
    );
    expect(ok.entities[0]).toMatchObject({ kind: 'rectangle', width: 4, height: 3, position: [1, 1, 0] });
    const overlapping = importText(
      file(
        ...lw(
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
          ],
          ...llull('region', [1070, 7]),
        ),
        ...lw(
          [
            [5, 5],
            [15, 5],
            [15, 15],
            [5, 15],
          ],
          ...llull('region', [1070, 7]),
        ),
      ),
    );
    expect(overlapping.entities.map((e) => e.kind)).toEqual(['polyline', 'polyline']);
    expect(overlapping.summary).toContain('polyline (region loop)');
  });

  it('layer state: a frozen or negative-colour layer imports hidden, flag 4 locked, 420 true colour', () => {
    // prettier-ignore
    const tables: Pair[] = [
      [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'],
      [0, 'LAYER'], [2, 'FROZEN'], [70, 1], [62, 3],
      [0, 'LAYER'], [2, 'OFF'], [70, 0], [62, -5],
      [0, 'LAYER'], [2, 'LOCKED'], [70, 4], [62, 7], [420, 0x336699],
      [0, 'ENDTAB'], [0, 'ENDSEC'],
    ];
    const points: Pair[] = ['FROZEN', 'OFF', 'LOCKED'].flatMap((layer): Pair[] => [
      [0, 'POINT'],
      [8, layer],
      [10, 1],
      [20, 1],
      [30, 0],
    ]);
    const source = text(...tables, [0, 'SECTION'], [2, 'ENTITIES'], ...points, [0, 'ENDSEC'], [0, 'EOF']);
    const { document, entities } = importText(source);
    const layer = (name: string): unknown => Object.values(document.layers).find((l) => l.name === name);
    expect(layer('FROZEN')).toMatchObject({ visible: false, locked: false });
    expect(layer('OFF')).toMatchObject({ visible: false });
    expect(layer('LOCKED')).toMatchObject({ visible: true, locked: true, color: '#336699' });
    expect(entities.map((e) => e.color)).toEqual(['#00ff00', '#0000ff', '#336699']);
    expect(parseDxf(source)?.layerStyles.get('LOCKED')?.trueColor).toBe('#336699');
  });
});
