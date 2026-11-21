/** ASC M5 (TR-ASC-16): a ruled loft through polygon sections keeps the vertices, pairs them by index after seam alignment and refuses unequal counts (LOFT_VERTEX_COUNT). */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type LoftEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { loftTriangles } from '@core/geometry/loft';
import { expectPure } from '../../helpers/expectNoOp';

const rect = (hx: number, hy: number, first = 0): number[][] => {
  const corners = [
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ];
  return corners.map((_, i) => corners[(i + first) % 4] as number[]);
};

const loftOf = (sections: unknown[], extra: Record<string, unknown> = {}, doc: CadDocument = createEmptyDocument()) =>
  execute(doc, 'loft_sections', { sections, ruled: true, ...extra });

const entityOf = (result: ReturnType<typeof loftOf>): LoftEntity => result.document.entities[result.affected[0] as string] as LoftEntity;

describe('loft_sections: exact ruled polygon loft', () => {
  it('keeps the section vertices (no 24-point resampling) and marks the loft as a polygon loft', () => {
    const result = loftOf([
      { section: rect(5, 3), center: [0, 0, 0] },
      { section: rect(2, 1), center: [0, 0, 10] },
    ]);
    expect(result.affected, result.summary).toHaveLength(1);
    expect(result.summary).toContain('exact ruled polygon loft');
    const loft = entityOf(result);
    expect(loft.polygon).toBe(true);
    expect(loft.rings).toHaveLength(2);
    expect(loft.rings.every((ring) => ring.length === 4)).toBe(true);
    expect(result.document.order).toEqual(result.affected);
    const [first, second] = loft.rings.map((ring) => ring.map((p) => [p[0], p[1], p[2]]));
    expect(first?.map((p) => Math.abs(p[0] ?? 0)).sort()).toEqual([5, 5, 5, 5]);
    expect(second?.map((p) => Math.abs(p[0] ?? 0)).sort()).toEqual([2, 2, 2, 2]);
    expect(loftTriangles(loft)).toHaveLength(4 * 2 + 2 * 2);
  });

  it('pairs vertices by index after seam alignment: a second section starting at another corner is shifted back', () => {
    const loft = entityOf(
      loftOf([
        { section: rect(5, 5), center: [0, 0, 0] },
        { section: rect(5, 5, 2), center: [0, 0, 10] },
      ]),
    );
    const [low, high] = loft.rings as ReadonlyArray<ReadonlyArray<[number, number, number]>>;
    low?.forEach((p, k) => {
      const q = high?.[k] as [number, number, number];
      expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(1e-9);
    });
  });

  it('a rectangle sketch section is a polygon section', () => {
    let doc = createEmptyDocument();
    const make = (z: number, width: number): string => {
      const drawn = execute(doc, 'draw_rectangle', { width, height: 4 });
      doc = execute(drawn.document, 'move_entities', { ids: drawn.affected, delta: [0, 0, z] }).document;
      return drawn.affected[0] as string;
    };
    const [a, b] = [make(0, 8), make(10, 4)];
    const result = execute(doc, 'loft_sections', { sectionIds: [a, b], ruled: true });
    expect(result.affected, result.summary).toHaveLength(1);
    expect(entityOf(result).polygon).toBe(true);
  });

  it('refuses sections with different vertex counts with LOFT_VERTEX_COUNT and leaves the document unchanged', () => {
    const doc = createEmptyDocument();
    const result = loftOf(
      [
        { section: rect(5, 3), center: [0, 0, 0] },
        {
          section: [
            [-2, -2],
            [2, -2],
            [0, 2],
          ],
          center: [0, 0, 10],
        },
      ],
      {},
      doc,
    );
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('LOFT_VERTEX_COUNT');
    expect(result.summary).toContain('section 1 has 3 vertices, section 0 has 4');
    expect(result.error).toMatchObject({ code: 'LOFT_VERTEX_COUNT', paths: ['params.sections.1'] });
  });

  it('a smooth loft (ruled: false) still resamples polygons, and a round section keeps the general ruled path', () => {
    const smooth = loftOf(
      [
        { section: rect(5, 3), center: [0, 0, 0] },
        { section: rect(2, 1), center: [0, 0, 10] },
      ],
      { ruled: false },
    );
    expect(entityOf(smooth).polygon).toBeUndefined();
    expect(entityOf(smooth).rings[0]).toHaveLength(24);
    const mixed = loftOf([
      { section: rect(5, 3), center: [0, 0, 0] },
      { radius: 2, center: [0, 0, 10] },
    ]);
    expect(entityOf(mixed).polygon).toBeUndefined();
    expect(entityOf(mixed).rings[1]).toHaveLength(24);
  });

  it('keeps the general failures: coincident centres and a single section', () => {
    const same = loftOf([
      { section: rect(5, 3), center: [0, 0, 0] },
      { section: rect(2, 1), center: [0, 0, 0] },
    ]);
    expect(same.affected).toEqual([]);
    expect(same.summary).toContain('share the same centre');
    const one = loftOf([{ section: rect(5, 3), center: [0, 0, 0] }]);
    expect(one.affected).toEqual([]);
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () =>
      loftOf(
        [
          { section: rect(5, 3), center: [0, 0, 0] },
          { section: rect(2, 1), center: [0, 0, 10] },
        ],
        {},
        doc,
      ),
    );
  });

  it('code export keeps the straight edges (a chain of 4 lines per section)', () => {
    const doc = loftOf([
      { section: rect(5, 3), center: [0, 0, 0] },
      { section: rect(2, 1), center: [0, 0, 10] },
    ]).document;
    const { text } = execute(doc, 'export_code', { language: 'cadquery' }).data as { text: string };
    expect(text).toMatch(/\("chain", \[\[\([^\]]*\), \([^\]]*\)\](, \[\[?\([^\]]*\), \([^\]]*\)\]){3}\]\)/);
    expect(text).not.toContain('"bspline"');
  });

  it('a persisted polygon flag other than true is rejected on load', () => {
    const made = loftOf([
      { section: rect(5, 3), center: [0, 0, 0] },
      { section: rect(2, 1), center: [0, 0, 10] },
    ]);
    const loft = entityOf(made);
    const flagged = (polygon: boolean): string =>
      serializeDocument({ ...made.document, entities: { ...made.document.entities, [loft.id]: { ...loft, polygon } as LoftEntity } });
    expect(execute(createEmptyDocument(), 'load_document', { json: flagged(true) }).document.entities[loft.id]).toMatchObject({
      polygon: true,
    });
    const loaded = execute(createEmptyDocument(), 'load_document', { json: flagged(false) });
    expect(loaded.document.entities[loft.id]).toBeUndefined();
    expect(loaded.summary).toContain('polygon must be true');
  });
});
