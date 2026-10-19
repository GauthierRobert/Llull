import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type LoftEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { sectionChain, sectionRing } from '@core/geometry/sectionChain';
import { evaluateCurve } from '@lib/nurbs/evaluate';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';

const empty = createEmptyDocument();

/** A closed interpolated curve around the z axis (radius r, 9 points), placed at height z. */
const circleCurve = (
  doc: CadDocument,
  radius: number,
  z: number,
  extra: Record<string, unknown> = {},
): { doc: CadDocument; id: string } => {
  const points = Array.from({ length: 9 }, (_, i) => {
    const angle = (2 * Math.PI * i) / 8;
    return [radius * Math.cos(angle), radius * Math.sin(angle), 0];
  });
  const result = execute(doc, 'interpolate_curve', { points, position: [0, 0, z], ...extra });
  return { doc: result.document, id: result.affected[0]! };
};

const twoSections = (r0 = 2, r1 = 1): { doc: CadDocument; ids: [string, string] } => {
  const a = circleCurve(empty, r0, 0);
  const b = circleCurve(a.doc, r1, 5);
  return { doc: b.doc, ids: [a.id, b.id] };
};

describe('loft_sections through nurbs_curve sections (loft v3)', () => {
  it('keeps the exact sections and a dense ring fallback, positioned at the first section centre', () => {
    const { doc, ids } = twoSections();
    const result = execute(doc, 'loft_sections', { sectionIds: ids, ruled: true });
    expect(result.affected).toHaveLength(1);
    const loft = result.document.entities[result.affected[0]!] as LoftEntity;
    expect(loft.kind).toBe('loft');
    expect(loft.sections).toHaveLength(2);
    expect(loft.rings).toHaveLength(2);
    expect(loft.rings[0]).toHaveLength(48);
    expect(loft.ruled).toBe(true);
    expect(result.summary).toContain('exact ruled loft');
    expect(result.summary).toContain('NURBS sections (not resampled; 6 spans each)');
    expect(loft.position[2]).toBeCloseTo(0, 9);
    // first section in the entity frame is still the radius-2 circle around the origin
    expect(Math.hypot(...evaluateCurve(loft.sections![0]!, 0.123).slice(0, 2))).toBeCloseTo(2, 0);
    expect(sectionChain(loft.sections![1]!)).toHaveLength(6);
    expect(sectionRing(loft.sections![1]!)).toHaveLength(48);
  });

  it('winds every section about the direction of travel, whichever way the curves run', () => {
    const forward = twoSections();
    const down = execute(forward.doc, 'loft_sections', { sectionIds: forward.ids });
    const upLoft = down.document.entities[down.affected[0]!] as LoftEntity;
    const reversedOrder = execute(forward.doc, 'loft_sections', { sectionIds: [forward.ids[1], forward.ids[0]] });
    const downLoft = reversedOrder.document.entities[reversedOrder.affected[0]!] as LoftEntity;
    const area = (ring: ReadonlyArray<readonly number[]>): number =>
      ring.reduce((sum, p, i) => sum + (p[0]! * ring[(i + 1) % ring.length]![1]! - ring[(i + 1) % ring.length]![0]! * p[1]!), 0) / 2;
    // counter-clockwise seen along +z for the loft going up, along -z (clockwise in plan) for the loft going down
    expect(area(upLoft.rings[0]!)).toBeGreaterThan(0);
    expect(area(downLoft.rings[0]!)).toBeLessThan(0);
  });

  it('mesh fallback volume of the exact loft matches the cone frustum', () => {
    const { doc, ids } = twoSections(2, 1);
    const loft = execute(doc, 'loft_sections', { sectionIds: ids, ruled: true });
    const mass = execute(loft.document, 'mass_properties', { entityId: loft.affected[0]! }).data as { volume: number };
    const frustum = (Math.PI * 5 * (4 + 2 + 1)) / 3;
    expect(Math.abs(mass.volume / frustum - 1)).toBeLessThan(0.05);
  });

  it('is pure', () => {
    const { doc, ids } = twoSections();
    expectPure(doc, () => execute(doc, 'loft_sections', { sectionIds: ids }));
  });

  it('honours an explicit id, a colour and refuses a duplicate id', () => {
    const { doc, ids } = twoSections();
    const made = execute(doc, 'loft_sections', { sectionIds: ids, id: 'hull', color: '#123456' });
    expect(made.affected).toEqual(['hull']);
    expect((made.document.entities['hull'] as LoftEntity).color).toBe('#123456');
    expectNoOp(execute(made.document, 'loft_sections', { sectionIds: ids, id: 'hull' }), made.document, 'already exists');
  });

  it('refuses sections that cannot be skinned together', () => {
    const { doc, ids } = twoSections();
    const rational = execute(doc, 'create_conic', { start: [1, 0, 0], apex: [1, 1, 0], end: [0, 1, 0], rho: 0.4, position: [0, 0, 8] });
    expectNoOp(
      execute(rational.document, 'loft_sections', { sectionIds: [ids[0], rational.affected[0]!] }),
      rational.document,
      'rational or above degree 3',
    );
    const fewer = execute(doc, 'interpolate_curve', {
      points: Array.from({ length: 5 }, (_, i) => [Math.cos((Math.PI * i) / 2), Math.sin((Math.PI * i) / 2), 0]),
      position: [0, 0, 9],
    });
    expectNoOp(
      execute(fewer.document, 'loft_sections', { sectionIds: [ids[0], fewer.affected[0]!] }),
      fewer.document,
      'different number of Bézier spans',
    );
    const open = execute(doc, 'interpolate_curve', {
      points: Array.from({ length: 9 }, (_, i) => [Math.cos((Math.PI * i) / 8), Math.sin((Math.PI * i) / 8), 0]),
      position: [0, 0, 9],
    });
    expectNoOp(execute(open.document, 'loft_sections', { sectionIds: [ids[0], open.affected[0]!] }), open.document, 'closing edge');
    const same = circleCurve(doc, 2, 0);
    expectNoOp(execute(same.doc, 'loft_sections', { sectionIds: [ids[0], same.id] }), same.doc, 'same centre');
    expectNoOp(execute(doc, 'loft_sections', { sectionIds: [ids[0]] }), doc, 'needs 2..200 sections');
  });

  it('places rotated curve entities in the world before lofting', () => {
    const a = circleCurve(empty, 2, 0);
    const b = circleCurve(a.doc, 2, 0, { position: [0, 0, 6] });
    const rotated = {
      ...b.doc,
      entities: { ...b.doc.entities, [b.id]: { ...b.doc.entities[b.id]!, rotation: [0, 0, Math.PI / 2] as const } },
    } as CadDocument;
    const result = execute(rotated, 'loft_sections', { sectionIds: [a.id, b.id] });
    const loft = result.document.entities[result.affected[0]!] as LoftEntity;
    expect(loft.rings[1]!.every((p) => Math.abs(Math.hypot(p[0], p[1]) - 2) < 0.15)).toBe(true);
    expect(loft.rings[1]!.every((p) => Math.abs(p[2] - 6) < 1e-9)).toBe(true);
  });

  it('inline sections and sketches still take the resampling path', () => {
    const inline = execute(empty, 'loft_sections', {
      sections: [
        { center: [0, 0, 0], radius: 2 },
        { center: [0, 0, 5], radius: 1 },
      ],
    });
    const loft = inline.document.entities[inline.affected[0]!] as LoftEntity;
    expect(loft.sections).toBeUndefined();
    expect(loft.rings[0]).toHaveLength(24);
  });
});
