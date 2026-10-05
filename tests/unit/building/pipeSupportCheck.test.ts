import { describe, expect, it } from 'vitest';
import type { CadDocument, Vec3 } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { checkPipeSupports, type PipeSupportRow } from '@aec/industrial/pipeSupportCheck';
import { hangerRodDiameter, pipeSpanLimit } from '@aec/industrial/pipeSpans';
import {
  arcLengths,
  nearestOnRoute,
  pointAtArc,
  spanCoordinate,
} from '@aec/industrial/routeSupport';
import { beam, step, twoLevels } from './steelFixtures';

interface CheckData {
  ok: boolean;
  pipes: PipeSupportRow[];
  failures: string[];
  totals: { pipes: number; ok: number; failing: number; supports: number; unattached: number };
  csv: string;
  assumptions: string[];
}

const run = (doc: CadDocument, params: Record<string, unknown> = {}): CheckData =>
  execute(doc, 'check_pipe_supports', params).data as CheckData;

const rowOf = (data: CheckData, mark: string): PipeSupportRow => {
  const row = data.pipes.find((candidate) => candidate.mark === mark);
  if (!row) throw new Error(`no row ${mark}`);
  return row;
};

/** DN100 pipe 12 m along X at y = 2000 (underside at the top of steel 2970) and beams along Y at `xs`. */
function railDoc(xs: number[], dn: number | undefined = 100): CadDocument {
  let doc = twoLevels();
  for (const x of xs) doc = beam(doc, [x, 0], [x, 4000]);
  return step(doc, 'add_pipe_run', {
    levelId: 'level-1',
    ...(dn === undefined ? { diameter: 114.3 } : { dn }),
    line: 'L-1',
    points: [
      [0, 2000, 3027.15],
      [12000, 2000, 3027.15],
    ],
  });
}

const shoes = (doc: CadDocument, xs: number[], extra: Record<string, unknown> = {}): CadDocument =>
  step(doc, 'add_pipe_support', {
    pipeId: 'pipe-1',
    at: xs.map((x) => [x, 2000, 3027.15]),
    ...extra,
  });

describe('check_pipe_supports registration', () => {
  it('is a read-only industrial tool', () => {
    expect(getCommand('check_pipe_supports')?.name).toBe(checkPipeSupports.name);
    expect(checkPipeSupports.annotations).toEqual({ readOnly: true, idempotent: true });
  });

  it('is pure: same document back, nothing affected, input untouched', () => {
    const doc = shoes(railDoc([2000, 6000, 10000]), [2000, 6000, 10000]);
    const snapshot = JSON.stringify(doc);
    const result = execute(doc, 'check_pipe_supports', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(result.summary).toContain('1 pipe(s), 1 ok');
  });
});

describe('span table', () => {
  it.each([
    [25, 33.7, 2.1],
    [50, 60.3, 3.0],
    [80, 88.9, 3.7],
    [100, 114.3, 4.3],
    [150, 168.3, 5.2],
    [200, 219.1, 5.8],
    [250, 273, 6.7],
    [300, 323.9, 7.0],
    [600, 610, 9.8],
  ])('DN%i (Ø%d) allows %d m', (dn, od, span) => {
    expect(pipeSpanLimit(dn, od)).toEqual({ dn, spanM: span, approximated: false });
    expect(pipeSpanLimit(undefined, od + 1)).toEqual({ dn, spanM: span, approximated: false });
  });

  it('never rounds an untabulated size up', () => {
    expect(pipeSpanLimit(undefined, 95)).toEqual({ dn: 80, spanM: 3.7, approximated: true });
    expect(pipeSpanLimit(90, 101.6)).toEqual({ dn: 80, spanM: 3.7, approximated: true });
    expect(pipeSpanLimit(undefined, 10)).toEqual({ dn: 15, spanM: 2.1, approximated: true });
    expect(pipeSpanLimit(undefined, 900)).toEqual({ dn: 600, spanM: 9.8, approximated: true });
  });

  it('picks typical hanger rods by DN', () => {
    expect([25, 50, 80, 100, 150, 200, 250, 300, 400].map(hangerRodDiameter)).toEqual([
      10, 10, 12, 12, 16, 20, 24, 24, 30,
    ]);
  });
});

describe('span verdicts', () => {
  it('passes 4 m spans and 2 m end overhangs on a DN100 line (4.3 m, overhang ≤ 2.15 m)', () => {
    const data = run(shoes(railDoc([2000, 6000, 10000]), [2000, 6000, 10000]));
    const row = rowOf(data, 'PL1');
    expect(row).toMatchObject({
      line: 'L-1',
      dn: 100,
      lengthM: 12,
      maxSpanM: 4.3,
      allowedSpanM: 4.3,
      largestSpanM: 4,
      overhangM: { start: 2, end: 2 },
      supports: 3,
      unattached: 0,
      basis: 'supports',
      ok: true,
      issues: [],
    });
    expect(data.ok).toBe(true);
    expect(data.totals).toMatchObject({ pipes: 1, ok: 1, failing: 0, supports: 3, unattached: 0 });
  });

  it('fails a 5 m span and the 5 m overhang left at the end', () => {
    const data = run(shoes(railDoc([2000, 7000]), [2000, 7000]));
    const row = rowOf(data, 'PL1');
    expect(row.ok).toBe(false);
    expect(row.largestSpanM).toBe(5);
    expect(row.issues).toEqual([
      'span 5.00 m exceeds 4.30 m allowed for DN100 (table 4.3 m)',
      'end overhang 5.00 m exceeds 2.15 m (0.5 × allowed span)',
    ]);
    expect(data.ok).toBe(false);
    expect(data.failures).toEqual(['pipe-1']);
    expect(
      execute(shoes(railDoc([2000, 7000]), [2000, 7000]), 'check_pipe_supports', {}).summary,
    ).toContain('1 failing: PL1 L-1 (span 5.00 m');
  });

  it('scales the table with spanFactor and the overhang with overhangRatio', () => {
    const doc = shoes(railDoc([2000, 6000, 10000]), [2000, 6000, 10000]);
    const tight = rowOf(run(doc, { spanFactor: 0.8 }), 'PL1');
    expect(tight.allowedSpanM).toBe(3.44);
    expect(tight.ok).toBe(false);
    expect(tight.issues[0]).toBe('span 4.00 m exceeds 3.44 m allowed for DN100 (table 4.3 m)');
    const overhang = rowOf(run(doc, { overhangRatio: 0.4 }), 'PL1');
    expect(overhang.issues).toEqual([
      'start overhang 2.00 m exceeds 1.72 m (0.4 × allowed span)',
      'end overhang 2.00 m exceeds 1.72 m (0.4 × allowed span)',
    ]);
    expect(rowOf(run(doc, { overhangRatio: 0.5 }), 'PL1').ok).toBe(true);
  });

  it('treats an end inside equipment as carried by the nozzle', () => {
    let doc = shoes(railDoc([4000, 8000]), [4000, 8000]);
    doc = step(doc, 'add_equipment', {
      name: 'Tank',
      location: [-500, 2000],
      size: [2000, 2000, 3100],
      levelId: 'level-1',
    });
    const row = rowOf(run(doc), 'PL1');
    expect(row.endCarriers).toEqual(['equipment', null]);
    expect(row.overhangM).toEqual({ start: null, end: 4 });
    expect(row.largestSpanM).toBe(4);
    expect(row.issues).toEqual(['end overhang 4.00 m exceeds 2.15 m (0.5 × allowed span)']);
  });

  it('passes a pipe carried at both ends when its whole length is within the span', () => {
    let doc = step(twoLevels(), 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 0, 1000],
        [4000, 0, 1000],
      ],
    });
    for (const x of [0, 4000]) {
      doc = step(doc, 'add_equipment', {
        name: `Vessel ${x}`,
        location: [x, 0],
        size: [1000, 1000, 2000],
        levelId: 'level-1',
      });
    }
    const row = rowOf(run(doc), 'PL1');
    expect(row).toMatchObject({ largestSpanM: 4, supports: 0, basis: 'nozzles', ok: true });
    expect(row.endCarriers).toEqual(['equipment', 'equipment']);
    const long = step(twoLevels(), 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 0, 1000],
        [6000, 0, 1000],
      ],
    });
    let carried = long;
    for (const x of [0, 6000]) {
      carried = step(carried, 'add_equipment', {
        name: `Vessel ${x}`,
        location: [x, 0],
        size: [1000, 1000, 2000],
        levelId: 'level-1',
      });
    }
    expect(rowOf(run(carried), 'PL1').issues[0]).toContain('span 6.00 m exceeds 4.30 m');
  });

  it('treats an end on another pipe (a branch on a header) as carried', () => {
    let doc = step(twoLevels(), 'add_pipe_run', {
      levelId: 'level-1',
      dn: 200,
      points: [
        [0, 0, 1000],
        [0, 5000, 1000],
      ],
    });
    doc = step(doc, 'add_pipe_run', {
      levelId: 'level-1',
      dn: 50,
      points: [
        [0, 2000, 1000],
        [2500, 2000, 1000],
      ],
    });
    const branch = rowOf(run(doc), 'PL2');
    expect(branch.endCarriers).toEqual(['pipe', null]);
    expect(branch.issues).toEqual(['end overhang 2.50 m exceeds 1.50 m (0.5 × allowed span)']);
  });

  it('fails a pipe resting on nothing, an unattached support, and uses resting beams without supports', () => {
    const none = run(
      step(twoLevels(), 'add_pipe_run', {
        levelId: 'level-1',
        dn: 100,
        points: [
          [0, 0, 1000],
          [6000, 0, 1000],
        ],
      }),
    );
    expect(rowOf(none, 'PL1')).toMatchObject({ basis: 'none', supports: 0, ok: false });
    expect(rowOf(none, 'PL1').issues).toEqual(['no support: 6.00 m of pipe rest on nothing']);
    const resting = rowOf(run(railDoc([6000])), 'PL1');
    expect(resting).toMatchObject({ basis: 'resting', supports: 1, ok: false });
    expect(resting.notes).toEqual(['no supports: the beams the pipe rests on are used']);
    const loose = shoes(railDoc([2000]), [2000, 9000]);
    const unattached = rowOf(run(loose), 'PL1');
    expect(unattached).toMatchObject({ supports: 1, unattached: 1, ok: false });
    expect(unattached.issues).toContain('support PS2 (shoe) is attached to no steel member');
    expect(run(loose).totals.unattached).toBe(1);
    expect(execute(loose, 'check_pipe_supports', {}).summary).toContain('1 unattached support(s)');
  });

  it('takes an untabulated size from the next smaller table row and says so', () => {
    const row = rowOf(
      run(shoes(railDoc([2000, 6000, 10000], undefined), [2000, 6000, 10000])),
      'PL1',
    );
    expect(row.dn).toBe(100);
    expect(row.notes).toEqual([]);
    const odd = step(twoLevels(), 'add_pipe_run', {
      levelId: 'level-1',
      diameter: 95,
      points: [
        [0, 0, 1000],
        [1000, 0, 1000],
      ],
    });
    expect(rowOf(run(odd), 'PL1')).toMatchObject({ dn: 80, maxSpanM: 3.7 });
    expect(rowOf(run(odd), 'PL1').notes[0]).toBe(
      'DN not tabulated: span of DN80 used (next smaller size)',
    );
  });
});

describe('risers', () => {
  it('does not count vertical pipe in the span and checks the riser at a carried end', () => {
    let doc = step(twoLevels(), 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 0, 500],
        [0, 0, 4500],
        [3000, 0, 4500],
      ],
    });
    doc = step(doc, 'add_equipment', {
      name: 'Tank',
      location: [0, 0],
      size: [1000, 1000, 600],
      levelId: 'level-1',
    });
    const row = rowOf(run(doc), 'PL1');
    expect(row.lengthM).toBe(7);
    expect(row.overhangM).toEqual({ start: null, end: 3 });
    expect(row.notes).toEqual(['risers (4.00 m) are not counted in the spans']);
    expect(row.issues).toEqual([
      'end overhang 3.00 m exceeds 2.15 m (0.5 × allowed span)',
      'riser z 0.50 → 4.50 m (4.00 m): end elbow is 4.00 m from the nearest lateral guide (max 2.15 m = 0.5 × allowed spacing)',
    ]);
    expect(row.risers).toHaveLength(1);
    expect(row.risers[0]).toMatchObject({
      lengthM: 4,
      guides: 0,
      weightBy: 'carried end',
      ok: false,
    });
  });

  it('measures spans on the horizontal run only', () => {
    let doc = step(twoLevels(), 'add_pipe_run', {
      levelId: 'level-1',
      dn: 100,
      points: [
        [0, 0, 1000],
        [3000, 0, 1000],
        [3000, 0, 5000],
        [6000, 0, 5000],
      ],
    });
    for (const [x, z] of [
      [0, 1000],
      [6000, 5000],
    ] as const) {
      doc = step(doc, 'add_equipment', {
        name: `Vessel ${x}`,
        location: [x, 0],
        size: [1000, 1000, z + 100],
        levelId: 'level-1',
      });
    }
    const row = rowOf(run(doc), 'PL1');
    expect(row.largestSpanM).toBe(6);
    expect(row.issues[0]).toBe('span 6.00 m exceeds 4.30 m allowed for DN100 (table 4.3 m)');
    expect(row.issues).toHaveLength(3);
    expect(row.notes).toEqual(['risers (4.00 m) are not counted in the spans']);
  });
});

describe('route helpers', () => {
  const route: Vec3[] = [
    [0, 0, 0],
    [3000, 0, 0],
    [3000, 0, 4000],
  ];

  it('snaps to the nearest segment and reports arc length and direction', () => {
    expect(nearestOnRoute(route, [1000, 500, 0])).toMatchObject({
      point: [1000, 0, 0],
      distance: 500,
      arc: 1000,
      segment: 0,
      direction: [1, 0, 0],
    });
    expect(nearestOnRoute(route, [3200, 0, 3000])).toMatchObject({ arc: 6000, segment: 1 });
    expect(nearestOnRoute([[0, 0, 0]], [1, 1, 1])).toBeNull();
    expect(
      nearestOnRoute(
        [
          [0, 0, 0],
          [0, 0, 0],
          [1000, 0, 0],
        ],
        [500, 0, 0],
      )?.arc,
    ).toBe(500);
  });

  it('finds the point at an arc length, clamped to the ends', () => {
    expect(pointAtArc(route, 1500)).toMatchObject({ point: [1500, 0, 0], segment: 0 });
    expect(pointAtArc(route, 5000)).toMatchObject({ point: [3000, 0, 2000], segment: 1 });
    expect(pointAtArc(route, 99999)?.point).toEqual([3000, 0, 4000]);
    expect(pointAtArc([[0, 0, 0]], 1)).toBeNull();
    expect(arcLengths(route)).toEqual([0, 3000, 7000]);
  });

  it('excludes risers from the span coordinate', () => {
    expect(spanCoordinate(route, 1000)).toBe(1000);
    expect(spanCoordinate(route, 5000)).toBe(3000);
    expect(spanCoordinate(route, 7000)).toBe(3000);
  });
});

describe('rows for every pipe, filters and failures', () => {
  const plant = (): CadDocument => {
    let doc = shoes(railDoc([2000, 6000, 10000]), [2000, 6000, 10000]);
    doc = step(doc, 'add_pipe_run', {
      levelId: 'level-2',
      dn: 50,
      line: 'L-2',
      points: [
        [0, 0, -1000],
        [8000, 0, -1000],
      ],
    });
    return doc;
  };

  it('lists every pipe with its line, DN and verdict', () => {
    const data = run(plant());
    expect(data.pipes.map((row) => [row.mark, row.line, row.dn, row.ok])).toEqual([
      ['PL1', 'L-1', 100, true],
      ['PL2', 'L-2', 50, false],
    ]);
    expect(data.totals).toMatchObject({ pipes: 2, ok: 1, failing: 1 });
    expect(data.csv.split('\n')[0]).toBe(
      'Mark,Line,DN,Length (m),Allowed span (m),Largest span (m),Supports,Status,Issues',
    );
    expect(data.csv).toContain('PL1,L-1,DN100,12,4.3,4,3,OK,');
    expect(data.csv).toContain('PL2,L-2,DN50,8,3,0,0,FAIL,');
    expect(data.assumptions.join(' ')).toContain('MSS SP-69');
  });

  it('filters by line and by level', () => {
    expect(run(plant(), { line: 'L-2' }).pipes.map((row) => row.mark)).toEqual(['PL2']);
    expect(run(plant(), { line: ' L-1 ' }).pipes.map((row) => row.mark)).toEqual(['PL1']);
    expect(run(plant(), { levelId: 'level-2' }).pipes.map((row) => row.mark)).toEqual(['PL2']);
  });

  it.each([
    ['unknown level', { levelId: 'level-9' }, "no level 'level-9'"],
    ['no matching line', { line: 'L-9' }, 'no pipe matches the level / line filter'],
    ['spanFactor <= 0', { spanFactor: 0 }, 'spanFactor must be a number > 0'],
    ['negative overhangRatio', { overhangRatio: -1 }, 'overhangRatio must be a number >= 0'],
  ])('is a no-op for %s', (_label, params, text) => {
    const doc = plant();
    const result = execute(doc, 'check_pipe_supports', params);
    expect(result.document).toBe(doc);
    expect(result.data).toBeUndefined();
    expect(result.summary).toContain(text);
  });

  it('is a no-op on a model without pipes', () => {
    const doc = twoLevels();
    const result = execute(doc, 'check_pipe_supports', {});
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('the model has no pipes');
  });
});
