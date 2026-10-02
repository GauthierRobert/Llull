import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { SteelMemberElement } from '@core/model/building';
import { execute } from '@core/commands/registry';
import { findProfile } from '@core/commands/building/steel/profiles';
import { nextSecondaryProfile } from '@core/commands/building/industrial/purlinDesign';
import type { PurlinRow } from '@core/commands/building/industrial/purlinCheck';

const hall = (params: Record<string, unknown> = {}): CadDocument =>
  execute(createEmptyDocument(), 'add_portal_frame_building', {
    span: 24000,
    length: 30000,
    ...params,
  }).document;

const membersOf = (doc: CadDocument, role: SteelMemberElement['role']): SteelMemberElement[] =>
  Object.values(doc.building?.elements ?? {}).filter(
    (element): element is SteelMemberElement =>
      element.category === 'member' && element.role === role,
  );

const rowsOf = (doc: CadDocument, params: Record<string, unknown> = {}): PurlinRow[] =>
  (execute(doc, 'check_purlins', params).data as { rows: PurlinRow[] }).rows;

const maxOf = (rows: PurlinRow[]): number => Math.max(...rows.map((row) => row.utilisation));

const depth = (member: SteelMemberElement): number => findProfile(member.profile)?.h ?? 0;

const largestProfile = (): string => {
  let name = 'C200x75x2.5';
  for (let step = 0; step < 100; step++) {
    const next = nextSecondaryProfile(name);
    if (next === null) return name;
    name = next;
  }
  throw new Error('profile chain does not terminate');
};

describe('nextSecondaryProfile', () => {
  const largest = largestProfile();
  it('steps through the C range by mass, then to IPE; unknown names give null', () => {
    expect(nextSecondaryProfile('C200x75x2.0')).toBe('C200x75x2.5');
    expect(nextSecondaryProfile('C300x90x3.0')).toMatch(/^IPE/);
    const ipe = nextSecondaryProfile('C300x90x3.0') ?? '';
    expect(findProfile(ipe)?.family).toBe('IPE');
    expect(nextSecondaryProfile('IPE200')).toBe('IPE220');
    expect(nextSecondaryProfile('NOPE')).toBeNull();
    expect(nextSecondaryProfile(largest)).toBeNull();
  });
});

describe('design_purlins', () => {
  const loads = { windPressure: 0.7 };

  it('up-sizes the failing purlins of a monopitch hall until check_purlins passes', () => {
    const doc = hall({ roofType: 'monopitch' });
    expect(maxOf(rowsOf(doc, loads))).toBeGreaterThan(1.05);
    const before = new Map(membersOf(doc, 'purlin').map((member) => [member.id, depth(member)]));
    const result = execute(doc, 'design_purlins', loads);
    expect(result.affected.length).toBeGreaterThan(0);
    expect(result.summary).toMatch(/purlins C200x75x2\.5 → /);
    expect(maxOf(rowsOf(result.document, loads))).toBeLessThanOrEqual(0.95);
    const data = result.data as { changes: string[]; maxUtilisation: number; failures: number };
    expect(data.failures).toBe(0);
    expect(data.changes.length).toBeGreaterThan(0);
    expect(data.maxUtilisation).toBeLessThanOrEqual(0.95);
    const purlins = membersOf(result.document, 'purlin');
    expect(purlins.every((member) => depth(member) >= (before.get(member.id) ?? 0))).toBe(true);
    expect(purlins.some((member) => depth(member) > (before.get(member.id) ?? 0))).toBe(true);
    // rows stay uniform: one profile for the whole roof
    expect(new Set(purlins.map((member) => member.profile)).size).toBe(1);
  });

  it('needs no change for the default duopitch hall at qp 0.6', () => {
    const doc = hall();
    const result = execute(doc, 'design_purlins', { windPressure: 0.6 });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(/no change needed/);
  });

  it('re-seats a deeper purlin along the rafter normal and a deeper rail outwards, by half the depth change', () => {
    const doc = hall({ roofType: 'monopitch' });
    const result = execute(doc, 'design_purlins', { windPressure: 1.2 });
    const unit = doc.units === 'mm' ? 1 : 0.001;
    const [oldPurlins, newPurlins] = [
      membersOf(doc, 'purlin'),
      membersOf(result.document, 'purlin'),
    ];
    for (const purlin of newPurlins) {
      const old = oldPurlins.find((member) => member.id === purlin.id);
      if (!old) throw new Error('purlin');
      const delta = (depth(purlin) - depth(old)) * unit;
      const shift = [0, 1, 2].map((axis) => purlin.start[axis]! - old.start[axis]!);
      expect(Math.hypot(...shift)).toBeCloseTo(delta / 2, 6);
      // moves up and away from the roof plane, never along the purlin axis
      expect(shift[2]).toBeGreaterThan(0);
      expect(shift[1]).toBeCloseTo(0, 9);
      expect(purlin.end[1]! - purlin.start[1]!).toBeCloseTo(old.end[1]! - old.start[1]!, 9);
    }
    const [oldRails, newRails] = [membersOf(doc, 'rail'), membersOf(result.document, 'rail')];
    const centre = 12000 * unit;
    const moved = newRails.filter((rail) => {
      const old = oldRails.find((member) => member.id === rail.id);
      return old !== undefined && depth(rail) > depth(old);
    });
    for (const rail of moved) {
      const old = oldRails.find((member) => member.id === rail.id) as SteelMemberElement;
      const shift = rail.start[0]! - old.start[0]!;
      expect(Math.sign(shift)).toBe(Math.sign(old.start[0]! - centre));
      expect(Math.abs(shift)).toBeCloseTo(((depth(rail) - depth(old)) * unit) / 2, 6);
      expect(rail.start[2]).toBeCloseTo(old.start[2]!, 9);
    }
  });

  it('up-sizes failing rails and reports the largest size reached when the range is exhausted', () => {
    const doc = hall({ roofType: 'monopitch' });
    const rails = membersOf(doc, 'rail');
    expect(rails.length).toBeGreaterThan(0);
    const result = execute(doc, 'design_purlins', { windPressure: 40, snowLoad: 0 });
    expect(result.summary).toMatch(/largest available size reached/);
    expect(result.summary).toMatch(/still failing/);
    expect(result.affected.length).toBeGreaterThan(0);
    expect(membersOf(result.document, 'rail').some((rail) => /^IPE/.test(rail.profile))).toBe(true);
  });

  it('reports the limit without changing the document when no heavier section exists', () => {
    const base = hall({ roofType: 'monopitch' });
    const building = base.building!;
    const elements = Object.fromEntries(
      Object.entries(building.elements).map(([id, element]) => [
        id,
        element.category === 'member' && (element.role === 'purlin' || element.role === 'rail')
          ? { ...element, profile: largestProfile() }
          : element,
      ]),
    );
    const doc = { ...base, building: { ...building, elements } };
    const result = execute(doc, 'design_purlins', { windPressure: 4000 });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(/largest available size reached/);
  });

  it('is pure and idempotent', () => {
    const doc = hall({ roofType: 'monopitch' });
    const snapshot = JSON.stringify(doc);
    const result = execute(doc, 'design_purlins', loads);
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(result.document).not.toBe(doc);
    expect(execute(result.document, 'design_purlins', loads).affected).toEqual([]);
  });

  it('is a no-op on bad input', () => {
    const doc = hall({ roofType: 'monopitch' });
    for (const bad of [
      { targetUtilisation: 2 },
      { targetUtilisation: 0.1 },
      { targetUtilisation: Number.NaN },
      { windPressure: -1 },
      { levelId: 'nope' },
    ]) {
      const result = execute(doc, 'design_purlins', bad);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.summary).toMatch(/design_purlins (failed|rejected)/);
    }
    const empty = createEmptyDocument();
    expect(execute(empty, 'design_purlins', {}).document).toBe(empty);
  });
});
