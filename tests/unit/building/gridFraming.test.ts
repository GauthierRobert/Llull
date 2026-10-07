import { describe, expect, it } from 'vitest';
import type { GridElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import type { SteelMemberElement } from '@core/model/building';
import { execute } from '@core/commands/registry';
import { crossGridLines, crossingsOnLine, parseCrossingName } from '@aec/industrial/gridFraming';
import { step, twoLevels } from './steelFixtures';

/** Lines A, B along X (y = 0, 6000); 1, 2, 3 along Y (x = 0, 5000, 10000). 6 intersections ... 2 x 3. */
function gridded(): CadDocument {
  let doc = twoLevels();
  doc = step(doc, 'add_grid_line', { start: [-1000, 0], end: [11000, 0], label: 'A' });
  doc = step(doc, 'add_grid_line', { start: [-1000, 6000], end: [11000, 6000], label: 'B' });
  for (const [label, x] of [
    ['1', 0],
    ['2', 5000],
    ['3', 10000],
  ] as const) {
    doc = step(doc, 'add_grid_line', { start: [x, -1000], end: [x, 7000], label });
  }
  return doc;
}

const members = (doc: CadDocument): SteelMemberElement[] =>
  Object.values(doc.building?.elements ?? {}).filter(
    (element): element is SteelMemberElement => element.category === 'member',
  );

const data = (result: { data?: unknown }): { elementIds: string[]; skipped: number } =>
  result.data as { elementIds: string[]; skipped: number };

function rejects(doc: CadDocument, tool: string, params: Record<string, unknown>): string {
  const before = structuredClone(doc);
  const result = execute(doc, tool, params);
  expect(result.document).toBe(doc);
  expect(doc).toEqual(before);
  expect(result.affected).toEqual([]);
  return result.summary;
}

describe('add_grid_columns', () => {
  it('places a column at every intersection, base level height by default', () => {
    const doc = gridded();
    const before = structuredClone(doc);
    const result = execute(doc, 'add_grid_columns', { profile: 'HEB300', levelId: 'level-1' });
    expect(doc).toEqual(before);
    expect(data(result)).toMatchObject({ skipped: 0 });
    expect(data(result).elementIds).toHaveLength(6);
    expect(result.summary).toMatch(/Added 6 columns HEB300 .*on level "Ground", 3000 mm high/);
    const columns = members(result.document);
    expect(columns.every((c) => c.role === 'column' && c.levelId === 'level-1')).toBe(true);
    expect(columns.map((c) => c.start)).toContainEqual([5000, 6000, 0]);
    expect(columns.map((c) => c.end)).toContainEqual([5000, 6000, 3000]);
    expect(result.affected).toEqual(expect.arrayContaining(data(result).elementIds));
    expect(result.document.building?.elementOrder).toEqual(
      expect.arrayContaining(data(result).elementIds),
    );
  });

  it('runs continuously to topLevelId and applies roll, fixity, material', () => {
    const result = execute(gridded(), 'add_grid_columns', {
      profile: 'HEB300',
      levelId: 'level-1',
      topLevelId: 'level-2',
      roll: Math.PI / 2,
      baseFixity: 'fixed',
      material: 'S235',
    });
    const first = members(result.document)[0] as SteelMemberElement;
    expect(first.end[2]).toBe(3000);
    expect(first).toMatchObject({ roll: Math.PI / 2, baseFixity: 'fixed', material: 'S235' });
  });

  it('honours axes and exclude (either order)', () => {
    const result = execute(gridded(), 'add_grid_columns', {
      profile: 'HEB300',
      levelId: 'level-1',
      axes: ['A', 'B', '1', '2'],
      exclude: ['1/B'],
    });
    expect(data(result).elementIds).toHaveLength(3);
    const xy = members(result.document).map((c) => [c.start[0], c.start[1]]);
    expect(xy).not.toContainEqual([0, 6000]);
    expect(xy).not.toContainEqual([10000, 0]);
    const inverse = execute(gridded(), 'add_grid_columns', {
      profile: 'HEB300',
      levelId: 'level-1',
      exclude: ['A/1', '2/B'],
    });
    expect(data(inverse).elementIds).toHaveLength(4);
  });

  it('skips intersections that already hold a column and no-ops when all do', () => {
    const first = execute(gridded(), 'add_grid_columns', {
      profile: 'HEB300',
      levelId: 'level-1',
      axes: ['A', '1', '2'],
    });
    expect(data(first).elementIds).toHaveLength(2);
    const second = execute(first.document, 'add_grid_columns', {
      profile: 'HEB300',
      levelId: 'level-1',
    });
    expect(data(second)).toMatchObject({ skipped: 2 });
    expect(data(second).elementIds).toHaveLength(4);
    expect(second.summary).toMatch(/skipped 2 existing/);
    expect(
      rejects(second.document, 'add_grid_columns', { profile: 'HEB300', levelId: 'level-1' }),
    ).toMatch(/already hold a column/);
  });

  it('works on non-orthogonal grid lines', () => {
    let doc = twoLevels();
    doc = step(doc, 'add_grid_line', { start: [0, 0], end: [10000, 10000], label: 'D' });
    doc = step(doc, 'add_grid_line', { start: [0, 10000], end: [10000, 0], label: 'E' });
    const result = execute(doc, 'add_grid_columns', { profile: 'HEB300', levelId: 'level-1' });
    const column = members(result.document)[0] as SteelMemberElement;
    expect(column.start[0]).toBeCloseTo(5000);
    expect(column.start[1]).toBeCloseTo(5000);
  });

  it('rejects bad input without changing the document', () => {
    const doc = gridded();
    const call = (extra: Record<string, unknown>): string =>
      rejects(doc, 'add_grid_columns', { profile: 'HEB300', levelId: 'level-1', ...extra });
    expect(call({ profile: 'NOPE' })).toMatch(/unknown steel profile/);
    expect(call({ levelId: 'level-9' })).toMatch(/unknown level/);
    expect(call({ axes: ['A', 'Z'] })).toMatch(/unknown grid axis label.*Z/);
    expect(call({ exclude: ['A-1'] })).toMatch(/must look like/);
    expect(call({ exclude: ['A/Q'] })).toMatch(/unknown grid label.*Q/);
    expect(call({ topLevelId: 'level-9' })).toMatch(/unknown top level/);
    expect(call({ topLevelId: 'level-1' })).toMatch(/not above the base level/);
    expect(call({ axes: ['A', 'B'] })).toMatch(/no grid intersections/);
    expect(rejects(twoLevels(), 'add_grid_columns', { profile: 'HEB300' })).toMatch(
      /at least 2 grid lines/,
    );
    expect(rejects(createEmptyDocForGrid(), 'add_grid_columns', { profile: 'HEB300' })).toMatch(
      /at least 2 grid lines/,
    );
  });
});

function createEmptyDocForGrid(): CadDocument {
  return step(twoLevels(), 'add_grid_line', { start: [0, 0], end: [0, 10], label: 'A' });
}

describe('add_grid_beams', () => {
  it('frames one beam per bay with axis z = topOffset - depth / 2', () => {
    const doc = gridded();
    const before = structuredClone(doc);
    const result = execute(doc, 'add_grid_beams', {
      profile: 'IPE400',
      levelId: 'level-2',
      topOffset: -30,
      startJoint: 'rigid',
    });
    expect(doc).toEqual(before);
    // 2 lines with 3 crossings -> 2 bays each; 3 lines with 2 crossings -> 1 bay each.
    expect(data(result).elementIds).toHaveLength(7);
    const beams = members(result.document);
    expect(beams.every((b) => b.role === 'beam' && b.start[2] === -230)).toBe(true);
    expect(beams.every((b) => b.startJoint === 'rigid' && b.endJoint === undefined)).toBe(true);
    expect(beams.map((b) => [b.start, b.end])).toContainEqual([
      [0, 0, -230],
      [5000, 0, -230],
    ]);
    expect(result.summary).toMatch(/Added 7 beams IPE400 .*total length 38000 mm.*skipped 0/);
  });

  it('filters axes and skips bays that already hold a beam (either direction)', () => {
    const first = execute(gridded(), 'add_grid_beams', { profile: 'IPE300', axes: ['A'] });
    expect(data(first).elementIds).toHaveLength(2);
    const second = execute(first.document, 'add_grid_beams', {
      profile: 'IPE300',
      axes: ['A', 'B'],
    });
    expect(data(second)).toMatchObject({ skipped: 2 });
    expect(data(second).elementIds).toHaveLength(2);
    const reversed = step(gridded(), 'add_steel_member', {
      role: 'beam',
      profile: 'IPE300',
      start: [5000, 0, -150],
      end: [0, 0, -150],
    });
    const third = execute(reversed, 'add_grid_beams', { profile: 'IPE300', axes: ['A'] });
    expect(data(third)).toMatchObject({ skipped: 1 });
    // Another section with the same top of steel is the same beam; a lower tier is not.
    const resized = execute(first.document, 'add_grid_beams', { profile: 'IPE500', axes: ['A'] });
    expect(resized.summary).toMatch(/all 2 bay\(s\) already hold a beam/);
    const lowerTier = execute(first.document, 'add_grid_beams', {
      profile: 'IPE300',
      axes: ['A'],
      topOffset: -1000,
    });
    expect(data(lowerTier)).toMatchObject({ skipped: 0 });
  });

  it('rejects bad input without changing the document', () => {
    const doc = gridded();
    expect(rejects(doc, 'add_grid_beams', { profile: 'NOPE' })).toMatch(/unknown steel profile/);
    expect(rejects(doc, 'add_grid_beams', { profile: 'IPE300', levelId: 'x' })).toMatch(
      /unknown level/,
    );
    expect(rejects(doc, 'add_grid_beams', { profile: 'IPE300', axes: ['Z'] })).toMatch(
      /unknown grid axis label/,
    );
    expect(rejects(twoLevels(), 'add_grid_beams', { profile: 'IPE300' })).toMatch(
      /at least 2 grid lines/,
    );
    let parallel = twoLevels();
    parallel = step(parallel, 'add_grid_line', { start: [0, 0], end: [10, 0], label: 'A' });
    parallel = step(parallel, 'add_grid_line', { start: [0, 5], end: [10, 5], label: 'B' });
    expect(rejects(parallel, 'add_grid_beams', { profile: 'IPE300' })).toMatch(/no bays/);
    const framed = execute(doc, 'add_grid_beams', { profile: 'IPE300', levelId: 'level-1' });
    expect(
      rejects(framed.document, 'add_grid_beams', { profile: 'IPE300', levelId: 'level-1' }),
    ).toMatch(/already hold a beam/);
  });
});

describe('add_grid_bracing', () => {
  it('adds an X pair rising one storey between the bay nodes', () => {
    const doc = gridded();
    const before = structuredClone(doc);
    const result = execute(doc, 'add_grid_bracing', {
      profile: 'CHS76.1x3.6',
      axis: 'A',
      from: '1',
      to: '2',
      levelId: 'level-1',
    });
    expect(doc).toEqual(before);
    expect(data(result).elementIds).toHaveLength(2);
    const braces = members(result.document);
    expect(braces.every((b) => b.role === 'brace')).toBe(true);
    expect(braces.map((b) => [b.start, b.end])).toEqual([
      [
        [0, 0, 0],
        [5000, 0, 3000],
      ],
      [
        [5000, 0, 0],
        [0, 0, 3000],
      ],
    ]);
    expect(result.summary).toMatch(/Added 2 X brace\(s\) BR1, BR2 .* in grid A between 1 and 2/);
  });

  it('adds one diagonal from bottom at from to top at to with offsets', () => {
    const result = execute(gridded(), 'add_grid_bracing', {
      profile: 'CHS76.1x3.6',
      axis: '2',
      from: 'B',
      to: 'A',
      levelId: 'level-1',
      pattern: 'diagonal',
      bottomOffset: 100,
      topOffset: -250,
    });
    const [brace] = members(result.document);
    expect(members(result.document)).toHaveLength(1);
    expect(brace?.start).toEqual([5000, 6000, 100]);
    expect(brace?.end).toEqual([5000, 0, 2750]);
    expect(result.summary).toMatch(/diagonal/);
  });

  it('rejects bad input without changing the document', () => {
    const doc = gridded();
    const call = (extra: Record<string, unknown>): string =>
      rejects(doc, 'add_grid_bracing', {
        profile: 'CHS76.1x3.6',
        axis: 'A',
        from: '1',
        to: '2',
        levelId: 'level-1',
        ...extra,
      });
    expect(call({ profile: 'NOPE' })).toMatch(/unknown steel profile/);
    expect(call({ levelId: 'x' })).toMatch(/unknown level/);
    expect(call({ to: 'Q' })).toMatch(/unknown grid label.*Q/);
    expect(call({ to: '1' })).toMatch(/must be different/);
    expect(call({ to: 'B' })).toMatch(/must both cross axis/);
    expect(call({ to: 'A' })).toMatch(/must both cross axis/);
    expect(call({ topOffset: -3000 })).toMatch(/zero or negative/);
    expect(
      rejects(twoLevels(), 'add_grid_bracing', {
        profile: 'CHS76.1x3.6',
        axis: 'A',
        from: '1',
        to: '2',
      }),
    ).toMatch(/at least 2 grid lines/);
  });
});

describe('grid framing geometry', () => {
  const line = (mark: string, start: [number, number], end: [number, number]): GridElement => ({
    id: mark,
    category: 'grid',
    mark,
    entityIds: [],
    start,
    end,
  });

  it('requires crossings inside both segments within tolerance', () => {
    const a = line('A', [0, 0], [10, 0]);
    expect(crossGridLines(a, line('1', [10.0005, -5], [10.0005, 5]), 0.001)?.along).toBeCloseTo(10);
    expect(crossGridLines(a, line('2', [11, -5], [11, 5]), 0.001)).toBeNull();
    expect(crossGridLines(a, line('3', [5, 1], [5, 5]), 0.001)).toBeNull();
    expect(crossGridLines(a, line('4', [0, 1], [10, 1]), 0.001)).toBeNull();
    expect(crossGridLines(a, line('5', [3, 3], [3, 3]), 0.001)).toBeNull();
  });

  it('merges coincident crossings and parses names', () => {
    const a = line('A', [0, 0], [10, 0]);
    const crossings = crossingsOnLine(
      a,
      [a, line('1', [5, -1], [5, 1]), line('2', [5, -2], [5, 2]), line('3', [8, -1], [8, 1])],
      0.001,
    );
    expect(crossings.map((c) => c.along)).toEqual([5, 8]);
    expect(parseCrossingName(' A / 1 ')).toEqual(['A', '1']);
    expect(parseCrossingName('A/')).toBeNull();
    expect(parseCrossingName('A/1/2')).toBeNull();
  });
});
