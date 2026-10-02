import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { slabMesh } from '@core/commands/building/evaluate';
import { buildPlanDrawing } from '@core/commands/building/plan';
import type { TakeoffLine } from '@core/commands/building/quantities';
import type { IfcExport } from '@core/commands/building/ifc';
import { segmentsIntersect, pointInPolygon } from '@lib/polygon';

function run(doc: CadDocument, name: string, params: unknown): CadDocument {
  return execute(doc, name, params).document;
}

const rect = (x0: number, y0: number, x1: number, y1: number): number[][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Two levels, a ground slab, a stair and the first-floor slab. */
function twoStoreys(): CadDocument {
  let doc = run(createEmptyDocument(), 'add_level', { name: 'L0' });
  doc = run(doc, 'add_level', { name: 'L1', makeActive: false });
  doc = run(doc, 'add_slab', { boundary: rect(0, 0, 10000, 8000), levelId: 'level-1' });
  doc = run(doc, 'add_stair', { start: [1000, 1000], levelId: 'level-1' });
  return run(doc, 'add_slab', { boundary: rect(0, 0, 10000, 8000), levelId: 'level-2' });
}

describe('slabMesh', () => {
  it('is watertight with outward-facing triangles and the net volume', () => {
    const mesh = slabMesh(
      rect(0, 0, 10, 8) as Array<[number, number]>,
      [rect(2, 2, 4, 5) as Array<[number, number]>, rect(6, 1, 9, 3) as Array<[number, number]>],
      0,
      0.5,
    )!;
    const edges = new Map<string, number>();
    let volume = 0;
    const p = (index: number): [number, number, number] => [
      mesh.positions[index * 3]!,
      mesh.positions[index * 3 + 1]!,
      mesh.positions[index * 3 + 2]!,
    ];
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ] as const) {
        edges.set(`${u}>${v}`, (edges.get(`${u}>${v}`) ?? 0) + 1);
      }
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      volume +=
        (pa[0] * (pb[1] * pc[2] - pb[2] * pc[1]) -
          pa[1] * (pb[0] * pc[2] - pb[2] * pc[0]) +
          pa[2] * (pb[0] * pc[1] - pb[1] * pc[0])) /
        6;
    }
    for (const [key, count] of edges) {
      const [u, v] = key.split('>');
      expect(count).toBe(1);
      expect(edges.get(`${v}>${u}`), `edge ${key} has no twin`).toBe(1);
    }
    expect(volume).toBeCloseTo((80 - 6 - 6) * 0.5);
  });
});

describe('add_slab_opening / delete_slab_opening', () => {
  it('cuts a stair well in the slab above and re-evaluates it as a mesh', () => {
    const doc = twoStoreys();
    const snapshot = structuredClone(doc);
    const result = execute(doc, 'add_slab_opening', { stairId: 'stair-1' });
    expect(doc).toEqual(snapshot);
    expect(result.summary).toMatch(/opening #1 .* in slab SL2 \(slab-2\)/);
    const body = result.document.entities['slab-2:body'];
    expect(body?.kind).toBe('mesh');
    expect(result.document.entities['slab-1:body']?.kind).toBe('extrusion');
    const slab = result.document.building!.elements['slab-2'];
    // 18 risers × 280 run + 2 × 100 margin, 1000 width + 2 × 100.
    expect(slab?.category === 'slab' && slab.openings?.[0]).toEqual([
      [900, 400],
      [6140, 400],
      [6140, 1600],
      [900, 1600],
    ]);
    const lines = (
      execute(result.document, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }
    ).lines;
    const area = lines.find((line) => line.key === 'slab-floor.concrete.m2')!.quantity;
    expect(area).toBeCloseTo(160 - 5.24 * 1.2);
    const plan = buildPlanDrawing(result.document, 'level-2')!;
    expect(plan.primitives.filter((p) => p.type === 'line' && p.layer === 'S-SLAB')).toHaveLength(
      2,
    );
    const ifc = (execute(result.document, 'export_ifc', {}).data as IfcExport).ifc;
    expect(ifc).toContain("'SL2 opening 1'");
  });

  it('cuts by boundary, refuses overlaps / outside / bad input, and fills openings back', () => {
    let doc = twoStoreys();
    doc = run(doc, 'add_slab_opening', {
      slabId: 'slab-1',
      boundary: rect(7000, 5000, 8000, 6000),
    });
    const refuse = (params: unknown): string => execute(doc, 'add_slab_opening', params).summary;
    expect(refuse({ slabId: 'slab-1', boundary: rect(7500, 5500, 8500, 6500) })).toMatch(
      /overlaps opening #0/,
    );
    expect(refuse({ slabId: 'slab-1', boundary: rect(9500, 7500, 10500, 8500) })).toMatch(
      /not strictly inside/,
    );
    expect(
      refuse({
        slabId: 'slab-1',
        boundary: [
          [1, 1],
          [2, 2],
          [3, 3],
        ],
      }),
    ).toMatch(/non-collinear/);
    expect(refuse({ slabId: 'nope', boundary: rect(1, 1, 2, 2) })).toMatch(/no slab 'nope'/);
    expect(refuse({ boundary: rect(1, 1, 2, 2) })).toMatch(/pass slabId/);
    expect(refuse({ stairId: 'x' })).toMatch(/no stair/);
    expect(refuse({ stairId: 'stair-1', margin: -1 })).toMatch(/margin/);
    expect(refuse({})).toMatch(/boundary of ≥ 3/);
    expect(refuse({ stairId: 'stair-1', slabId: 'slab-1' })).toMatch(/opening #2/);

    expect(execute(doc, 'delete_slab_opening', { slabId: 'slab-1', index: 3 }).summary).toMatch(
      /has 1 opening/,
    );
    expect(execute(doc, 'delete_slab_opening', { slabId: 'x', index: 0 }).summary).toMatch(
      /no slab/,
    );
    const filled = execute(doc, 'delete_slab_opening', { slabId: 'slab-1', index: 0 });
    expect(filled.document.entities['slab-1:body']?.kind).toBe('extrusion');
  });

  it('finds no slab above a stair on the top level', () => {
    let doc = run(createEmptyDocument(), 'add_level', {});
    doc = run(doc, 'add_stair', { start: [0, 0] });
    expect(execute(doc, 'add_slab_opening', { stairId: 'stair-1' }).summary).toMatch(
      /no floor slab/,
    );
  });

  it('templates cut their stair wells', () => {
    const house = execute(createEmptyDocument(), 'add_building_template', {
      template: 'house',
    }).document;
    const slabs = Object.values(house.building!.elements).filter(
      (element) => element.category === 'slab',
    );
    expect(
      slabs.some((slab) => slab.category === 'slab' && (slab.openings?.length ?? 0) === 1),
    ).toBe(true);
  });
});

describe('polygon predicates', () => {
  it('segmentsIntersect and pointInPolygon', () => {
    expect(segmentsIntersect([0, 0], [2, 2], [0, 2], [2, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [1, 0], [1, 0], [2, 0])).toBe(false);
    expect(pointInPolygon([1, 1], rect(0, 0, 2, 2) as Array<[number, number]>)).toBe(true);
    expect(pointInPolygon([3, 1], rect(0, 0, 2, 2) as Array<[number, number]>)).toBe(false);
  });
});

describe('slab opening clearances', () => {
  it('refuses openings touching the slab edge or another opening', () => {
    let doc = run(createEmptyDocument(), 'add_slab', { boundary: rect(0, 0, 10000, 8000) });
    expect(
      execute(doc, 'add_slab_opening', { slabId: 'slab-1', boundary: rect(0, 5000, 1000, 6000) })
        .summary,
    ).toMatch(/not strictly inside|keep a gap/);
    doc = run(doc, 'add_slab_opening', {
      slabId: 'slab-1',
      boundary: rect(2000, 2000, 3000, 3000),
    });
    expect(
      execute(doc, 'add_slab_opening', { slabId: 'slab-1', boundary: rect(3000, 2000, 4000, 3000) })
        .summary,
    ).toMatch(/keep a gap|overlaps/);
  });

  it('drops repeated boundary vertices', () => {
    const doc = run(createEmptyDocument(), 'add_slab', {
      boundary: [
        [0, 0],
        [1000, 0],
        [1000, 0],
        [1000, 1000],
        [0, 1000],
      ],
    });
    const slab = doc.building!.elements['slab-1']!;
    expect(slab.category === 'slab' && slab.boundary).toHaveLength(4);
  });
});
