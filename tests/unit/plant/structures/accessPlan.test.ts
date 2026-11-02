/**
 * Plant 06 STA M8: export_access_plan (plan symbols as SVG / DXF), the hatch of a grating panel, and the geometry / search helpers of the access graph.
 * Hand numbers: ladder symbol = clear width 406.4 x 300 mm; a 6000 x 3000 deck with bars along x and 100 mm hatch spacing is hatched with 30 lines
 * (floor(3000 / 100) = 30, capped at 60); a 17-riser stair shows "UP 17 R".
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { disjointRoutes, routeTree } from '@aec/plant/structures/access/graph/search';
import { boxOf, distanceToRegion, makeRegion, minimumWidth, ringsWithin } from '@aec/plant/structures/access/graph/regions';
import type { AccessGraph, SurfaceNode } from '@aec/plant/structures/access/graph/types';
import { hatchLines } from '@aec/plant/structures/symbols/hatch';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { TYPE } from './accessFixtures';

interface PlanData {
  files: Array<{ name: string; format: string; content: string; sha256: string }>;
  counts: { platforms: number; gratingPanels: number; ladders: number; stairs: number; railings: number };
  primitives: number;
  widthMm: number;
  heightMm: number;
}

/** Grade, +3000 deck 6000 x 3000 with a railing, a caged-free ladder, a steel stair and (second level) nothing else. */
function scene(): CadDocument {
  let doc = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', { name: 'Grade', elevation: 0, height: 4000 });
  doc = apply(doc, 'add_level', { name: '+6000', elevation: 6000, height: 3000 });
  doc = apply(doc, 'add_access_platform', {
    bounds: [
      [0, 0],
      [6000, 3000],
    ],
    topOffset: 3000,
    gratingType: TYPE,
    bearingBarDirection: [1, 0],
    levelId: 'level-1',
    railing: { openings: [{ from: 2000, to: 2800, gate: true }] },
  });
  doc = apply(doc, 'add_ladder', {
    base: [1000, -250, 0],
    facing: [0, 1],
    attachTo: 'assembly-1',
    levelId: 'level-1',
    fallProtection: 'cage',
  });
  return apply(doc, 'add_steel_stair', {
    start: [-4480, 1500, 0],
    angle: 0,
    toSurfaceId: 'assembly-1',
    riserMax: 180,
    going: 280,
    levelId: 'level-1',
  });
}

const plan = (doc: CadDocument, extra: Record<string, unknown> = {}): PlanData => data<PlanData>(doc, 'export_access_plan', extra);
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

describe('export_access_plan: SVG', () => {
  const doc = scene();
  const answer = plan(doc);
  const svg = answer.files[0]?.content ?? '';

  it('one SVG file with a layer class per symbol family and the counts of what was drawn', () => {
    expect(answer.files.map((file) => [file.name, file.format])).toEqual([['access_plan.svg', 'svg']]);
    expect(answer.counts).toEqual({ platforms: 1, gratingPanels: 6, ladders: 1, stairs: 1, railings: 1 });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    for (const layer of ['S-PLAT', 'S-GRAT', 'S-LADR', 'S-STAR', 'S-RAIL', 'S-GATE', 'S-TEXT']) expect(svg).toContain(`class="${layer}"`);
    expect(count(svg, /<(line|polygon|polyline|circle|text)\b/g)).toBe(answer.primitives);
  });

  it('labels: the platform with its elevation, the ladder with its height, the stair "UP n R"', () => {
    expect(svg).toContain('>AS1 EL +3000<');
    expect(svg).toContain('>LD1 H=3000<');
    expect(svg).toContain('>SS1 UP 17 R<');
  });

  it('draws the grating hatch along the bars (30 lines per 3000 mm panel width) and a cage circle for the caged ladder', () => {
    // 6 panels of 1000 x 3000: 6 x 30 hatch lines on S-GRAT, plus the ladder dividers and stair lines on their own layers.
    expect(count(svg, /<line [^>]*class="S-GRAT"/g)).toBe(6 * 30);
    expect(count(svg, /<circle [^>]*class="S-LADR"/g)).toBe(1);
  });

  it('the railing is a line along the guarded stretches with a square tick at each post; the gate opening is on S-GATE', () => {
    expect(count(svg, /<line [^>]*class="S-GATE"/g)).toBe(1);
    expect(count(svg, /<polygon [^>]*class="S-RAIL"/g)).toBeGreaterThanOrEqual(10);
    expect(count(svg, /<line [^>]*class="S-RAIL"/g)).toBeGreaterThanOrEqual(4);
  });

  it('is deterministic, read-only and pure; the sha256 is the hash of the content', () => {
    expect(JSON.stringify(plan(doc))).toBe(JSON.stringify(answer));
    expectPure(doc, () => execute(doc, 'export_access_plan', {}));
    expect(answer.files[0]?.sha256).toBe(createHash('sha256').update(svg).digest('hex'));
    expect(answer.widthMm).toBeGreaterThan(10000);
    expect(answer.heightMm).toBeGreaterThan(4000);
  });
});

describe('export_access_plan: DXF, formats, level filter', () => {
  const doc = scene();

  it('DXF R12 text with the same layers, units mm', () => {
    const answer = plan(doc, { formats: ['dxf', 'svg', 'dxf'] });
    expect(answer.files.map((file) => file.name)).toEqual(['access_plan.dxf', 'access_plan.svg']);
    const dxf = answer.files[0]?.content ?? '';
    expect(dxf).toContain('AC1009');
    for (const layer of ['S-PLAT', 'S-GRAT', 'S-LADR', 'S-STAR', 'S-RAIL', 'S-GATE', 'S-TEXT']) expect(dxf).toContain(layer);
    expect(count(dxf, /\nTEXT\n/g)).toBe(3);
    expect(count(dxf, /\nCIRCLE\n/g)).toBe(1);
  });

  it('levelId keeps the elements of that level; another level with nothing on it is STA_NOTHING_TO_DRAW; an unknown level is STA_UNKNOWN_ELEMENT', () => {
    expect(plan(doc, { levelId: 'level-1' }).counts.ladders).toBe(1);
    expectRefusal(doc, 'export_access_plan', { levelId: 'level-2' }, 'STA_NOTHING_TO_DRAW');
    expectRefusal(doc, 'export_access_plan', { levelId: 'nope' }, 'STA_UNKNOWN_ELEMENT', 'levelId');
  });

  it('an empty model is STA_NOTHING_TO_DRAW and unchanged', () => {
    expectRefusal(createEmptyDocument(), 'export_access_plan', {}, 'STA_NOTHING_TO_DRAW');
  });

  it('a loose grating panel is drawn on S-GRAT with its mark; a vessel platform (circular) gets one outline per panel', () => {
    let loose = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', {
      name: 'Grade',
      elevation: 0,
      height: 4000,
    });
    loose = apply(loose, 'add_grid_system', { xSpacings: [2000], ySpacings: [1500] });
    loose = apply(loose, 'add_grid_columns', { profile: 'HEB200' });
    loose = apply(loose, 'add_grid_beams', { profile: 'IPE200', topOffset: -32 });
    loose = apply(loose, 'add_grating', {
      supportedBy: 'beams',
      bounds: [
        [0, 0],
        [2000, 1500],
      ],
      gratingType: TYPE,
      bearingBarDirection: [1, 0],
      thickness: 31.75,
    });
    const svg = plan(loose).files[0]?.content ?? '';
    expect(svg).toContain('>GR1<');
    expect(count(svg, /<polygon [^>]*class="S-GRAT"/g)).toBe(1);
    let vessel = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', {
      name: 'Grade',
      elevation: 0,
      height: 6000,
    });
    vessel = apply(vessel, 'add_equipment', {
      name: 'Column',
      mark: 'C-101',
      location: [0, 0],
      size: [3000, 3000, 18000],
      shape: 'vertical_vessel',
    });
    vessel = apply(vessel, 'add_circular_access_platform', {
      equipmentId: 'equipment-1',
      elevation: 6000,
      startAngleDeg: 0,
      sweepDeg: 180,
      gap: 150,
      width: 1000,
    });
    expect(count(plan(vessel).files[0]?.content ?? '', /<polygon [^>]*class="S-PLAT"/g)).toBe(23);
  });

  it('in a metre document the drawing is still in millimetres', () => {
    let metres = apply(apply(createEmptyDocument(), 'set_units', { units: 'm' }), 'add_level', { name: 'Grade', elevation: 0, height: 4 });
    metres = apply(metres, 'add_level', { name: '+6', elevation: 6, height: 3 });
    metres = apply(metres, 'add_access_platform', {
      bounds: [
        [0, 0],
        [6, 3],
      ],
      topOffset: 3,
      gratingType: TYPE,
      bearingBarDirection: [1, 0],
      levelId: 'level-1',
    });
    const answer = plan(metres);
    expect(answer.widthMm).toBe(7000);
    expect(answer.files[0]?.content).toContain('>AS1 EL +3000<');
  });
});

describe('hatchLines', () => {
  const square: Array<[number, number]> = [
    [0, 0],
    [1000, 0],
    [1000, 500],
    [0, 500],
  ];

  it('parallel lines across a rectangle, spread evenly, none on the outline, clipped to it', () => {
    const lines = hatchLines(square, [1, 0], 100, 60);
    expect(lines).toHaveLength(5);
    lines.forEach(([a, b], index) => {
      expect(a[1]).toBeCloseTo((index + 1) * (500 / 6), 9);
      expect(b[1]).toBeCloseTo(a[1], 9);
      expect([a[0], b[0]]).toEqual([0, 1000]);
    });
  });

  it('is capped at maxLines and empty for degenerate input', () => {
    expect(hatchLines(square, [1, 0], 1, 7)).toHaveLength(7);
    expect(hatchLines(square, [1, 0], 600, 60)).toEqual([]);
    expect(hatchLines(square, [0, 0], 100, 60)).toEqual([]);
    expect(hatchLines(square, [1, 0], 0, 60)).toEqual([]);
    expect(hatchLines(square, [1, 0], 100, 0)).toEqual([]);
    expect(hatchLines(square.slice(0, 2), [1, 0], 100, 60)).toEqual([]);
  });

  it('a slanted direction clips to the polygon (lines along a diagonal)', () => {
    const lines = hatchLines(square, [1, 1], 100, 60);
    expect(lines.length).toBeGreaterThan(3);
    for (const [a, b] of lines) {
      for (const [x, y] of [a, b]) {
        expect(x).toBeGreaterThanOrEqual(-1e-9);
        expect(x).toBeLessThanOrEqual(1000 + 1e-9);
        expect(y).toBeGreaterThanOrEqual(-1e-9);
        expect(y).toBeLessThanOrEqual(500 + 1e-9);
      }
      expect(Math.abs(b[1] - a[1] - (b[0] - a[0]))).toBeLessThan(1e-6);
    }
  });
});

describe('access graph geometry', () => {
  const ring = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];

  it('minimumWidth: rectangle 6000 x 500 -> 500; right triangle legs 3000 and 4000 -> the altitude 2400', () => {
    expect(minimumWidth(ring(0, 0, 6000, 500))).toBe(500);
    expect(
      minimumWidth([
        [0, 0],
        [4000, 0],
        [0, 3000],
      ]),
    ).toBeCloseTo(2400, 9);
    expect(
      minimumWidth([
        [0, 0],
        [0, 0],
        [0, 0],
      ]),
    ).toBe(Infinity);
  });

  it('distanceToRegion: 0 on the material, to the hole edge inside a hole, to the outline outside', () => {
    const region = makeRegion(ring(0, 0, 4000, 4000), [ring(1000, 1000, 3000, 3000)]);
    expect(distanceToRegion([500, 500], region)).toBe(0);
    expect(distanceToRegion([2000, 1500], region)).toBe(500);
    expect(distanceToRegion([5000, 2000], region)).toBe(1000);
  });

  it('ringsWithin: touching, overlapping and nested rings are within tolerance; a gap beyond it is not', () => {
    const a = ring(0, 0, 1000, 1000);
    expect(ringsWithin(a, ring(1000, 0, 2000, 1000), 0)).toBe(true);
    expect(ringsWithin(a, ring(1005, 0, 2000, 1000), 10)).toBe(true);
    expect(ringsWithin(a, ring(1020, 0, 2000, 1000), 10)).toBe(false);
    expect(ringsWithin(a, ring(500, 500, 1500, 1500), 0)).toBe(true);
    expect(ringsWithin(a, ring(200, 200, 300, 300), 0)).toBe(true);
    expect(ringsWithin(a, ring(5000, 5000, 6000, 6000), 10)).toBe(false);
    expect(boxOf(a)).toEqual([0, 0, 1000, 1000]);
  });
});

/** A hand-made graph: grade -a- P1 -b- P2 and grade -c- P2 (P2 has two edge-disjoint routes), P3 hangs off P2 by one edge, P4 is alone. */
function graphOf(): AccessGraph {
  const node = (id: string): SurfaceNode => ({
    id,
    kind: id === 'grade' ? 'grade' : 'slab',
    members: [id],
    levelId: null,
    mark: id,
    topMm: 0,
    thicknessMm: 0,
    regions: [],
    box: [0, 0, 0, 0],
    areaM2: 0,
  });
  const edge = (id: string, from: string, to: string): AccessGraph['edges'][number] => ({
    id,
    kind: 'ladder',
    mark: id,
    from,
    to,
    clearWidthMm: null,
    riseMm: 0,
  });
  return {
    nodes: ['grade', 'P1', 'P2', 'P3', 'P4'].map(node),
    edges: [edge('a', 'grade', 'P1'), edge('b', 'P1', 'P2'), edge('c', 'grade', 'P2'), edge('d', 'P2', 'P3')],
    dangling: [],
    gradeMm: 0,
  };
}

describe('access graph search', () => {
  const graph = graphOf();

  it('breadth-first routes from grade: fewest legs, edge order breaks ties; unreachable nodes are absent', () => {
    const tree = routeTree(graph);
    expect([...tree.via.keys()]).toEqual(['grade', 'P1', 'P2', 'P3']);
    expect(tree.via.get('P2')?.edge.id).toBe('c');
  });

  it('edge-disjoint routes: P1 has 2 (a, or c-b), P2 has 2, P3 has 1 (it hangs by one edge), P4 has 0; capped at the limit', () => {
    expect(disjointRoutes(graph, 'P1', 5)).toBe(2);
    expect(disjointRoutes(graph, 'P2', 5)).toBe(2);
    expect(disjointRoutes(graph, 'P3', 5)).toBe(1);
    expect(disjointRoutes(graph, 'P4', 5)).toBe(0);
    expect(disjointRoutes(graph, 'P2', 1)).toBe(1);
    expect(disjointRoutes(graph, 'grade', 3)).toBe(3);
  });
});
