import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  boltResistance,
  nextProfile,
  yieldStrength,
  type CheckRow,
} from '@core/commands/building/industrial/frameCheck';
import { connectionWelds } from '@core/commands/building/industrial/connections';
import type { MomentConnectionElement } from '@core/model/building';
import type { TakeoffLine } from '@core/commands/building/quantities';
import { __resetIdCounter } from '@lib/id';

const HALL = { span: 24000, length: 30000 };

function hall(params: Record<string, unknown> = {}): CadDocument {
  return execute(createEmptyDocument(), 'add_portal_frame_building', { ...HALL, ...params })
    .document;
}

beforeEach(() => __resetIdCounter());

describe('design helpers', () => {
  it('reads yield strengths, bolt resistances and the next section size', () => {
    expect(yieldStrength('S275')).toBe(275);
    expect(yieldStrength('steel')).toBe(355);
    const m20 = boltResistance(20);
    expect(m20.tension / 1000).toBeCloseTo(141.1, 1);
    expect(m20.shear / 1000).toBeCloseTo(94.1, 1);
    expect(boltResistance(23).tension).toBe(boltResistance(22).tension);
    expect(nextProfile('IPE450')).toBe('IPE500');
    expect(nextProfile('IPE600')).toMatch(/^HE[AB]/);
    expect(nextProfile('NOPE')).toBeNull();
  });
});

describe('check_portal_frames', () => {
  it('analyses every frame and checks members and connections (read-only)', () => {
    const doc = hall();
    const snapshot = JSON.stringify(doc);
    const result = execute(doc, 'check_portal_frames', {});
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(
      /^Checked 6 frame\(s\), 42 element\(s\) at ULS 1\.35 G \+ 1\.5 S/,
    );
    const rows = (result.data as { rows: CheckRow[] }).rows;
    // Internal frame (6 m bay): eaves moment ≈ 491 kNm, IPE450 rafter at ≈ 0.88.
    const rafter = rows.find((row) => row.mark === 'RF3')!;
    expect(rafter.moment).toBeGreaterThan(450);
    expect(rafter.moment).toBeLessThan(530);
    expect(rafter.utilisation).toBeGreaterThan(0.8);
    expect(rafter.utilisation).toBeLessThan(0.95);
    // End frames carry half the load.
    const endRafter = rows.find((row) => row.mark === 'RF1')!;
    expect(endRafter.moment).toBeLessThan(rafter.moment * 0.6);
    // Default bolt groups are under-sized at the apex of internal frames.
    expect(rows.some((row) => row.kind === 'connection' && row.utilisation > 1)).toBe(true);
    expect((result.data as { csv: string }).csv.split('\n')[0]).toBe(
      'Frame,Mark,Type,N (kN),M (kNm),V (kN),Utilisation,Status,Check',
    );
  });

  it('scales with the loads and rejects bad input', () => {
    const doc = hall();
    const light = execute(doc, 'check_portal_frames', { deadLoad: 0.2, snowLoad: 0 });
    const heavy = execute(doc, 'check_portal_frames', { deadLoad: 0.5, snowLoad: 2 });
    const max = (result: ReturnType<typeof execute>): number =>
      (result.data as { maxUtilisation: number }).maxUtilisation;
    expect(max(heavy)).toBeGreaterThan(max(light));
    expect(execute(doc, 'check_portal_frames', { snowLoad: -1 }).data).toBeUndefined();
    expect(execute(doc, 'check_portal_frames', { levelId: 'nope' }).summary).toMatch(/no level/);
    expect(execute(createEmptyDocument(), 'check_portal_frames', {}).summary).toMatch(/failed/);
  });
});

describe('design_portal_frames', () => {
  it('sizes the bolt groups so every element of the default hall passes', () => {
    const before = hall();
    const result = execute(before, 'design_portal_frames', {});
    expect(result.summary).toMatch(/eaves connections: \d+ × M\d+; apex connections: \d+ × M\d+/);
    expect(result.summary).toMatch(/Max utilisation now 0\.\d\d\./);
    const check = execute(result.document, 'check_portal_frames', {});
    expect(check.summary).toMatch(/all OK/);
    expect(result.affected.length).toBeGreaterThan(0);
  });

  it('up-sizes undersized sections uniformly and refits the base plates', () => {
    const doc = hall({ rafterProfile: 'IPE300', columnProfile: 'HEA240' });
    const result = execute(doc, 'design_portal_frames', {});
    expect(result.summary).toMatch(/rafters IPE300 → IPE330/);
    expect(result.summary).toMatch(/columns HEA240 → HEA260/);
    const rafters = Object.values(result.document.building!.elements).filter(
      (element) => element.category === 'member' && element.role === 'rafter',
    );
    expect(
      new Set(rafters.map((rafter) => rafter.category === 'member' && rafter.profile)).size,
    ).toBe(1);
    const check = (
      execute(result.document, 'check_portal_frames', {}).data as { maxUtilisation: number }
    ).maxUtilisation;
    expect(check).toBeLessThanOrEqual(0.95);
  });

  it('reports elements it cannot make pass and rejects bad input', () => {
    const doc = hall({ spans: [30000, 30000], eaveHeight: 10000 });
    const result = execute(doc, 'design_portal_frames', { snowLoad: 1.2 });
    expect(result.summary).toMatch(/largest available size reached/);
    expect(execute(doc, 'design_portal_frames', { targetUtilisation: 2 }).affected).toEqual([]);
    expect(execute(doc, 'design_portal_frames', { levelId: 'nope' }).affected).toEqual([]);
    expect(execute(createEmptyDocument(), 'design_portal_frames', {}).affected).toEqual([]);
  });
});

describe('weld detailing', () => {
  it('sizes full-strength fillet welds and reports them in the schedule and takeoff', () => {
    const doc = hall();
    const connection = Object.values(doc.building!.elements).find(
      (element): element is MomentConnectionElement =>
        element.category === 'connection' && element.kind === 'eaves',
    )!;
    // IPE450: tf 14.6 → a9, tw 9.4 → a6.
    const welds = connectionWelds(doc, doc.building!, connection)!;
    expect(welds).toMatchObject({ flangeThroat: 9, webThroat: 6 });
    expect(welds.length).toBeGreaterThan(2000);
    expect(welds.metal).toBeGreaterThan(0.5);
    const schedule = execute(doc, 'building_schedule', { kind: 'connection' }).data as {
      rows: unknown[][];
    };
    expect(schedule.rows[0]?.[9]).toMatch(/^a9 flanges \/ a6 web · \d+\.\d m$/);
    const lines = (execute(doc, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
    expect(lines.find((line) => line.key === 'connection.weld.m')?.quantity).toBeGreaterThan(10);
    expect(lines.find((line) => line.key === 'connection.weld metal.kg')?.quantity).toBeGreaterThan(
      5,
    );
  });
});
