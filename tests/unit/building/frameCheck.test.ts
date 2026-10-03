import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CheckRow } from '@aec/industrial/frameCheckSolve';
import { nextProfile } from '@aec/industrial/frameDesign';
import { boltResistance, yieldStrength } from '@aec/industrial/steelDesign';
import { connectionWelds } from '@aec/industrial/connections';
import type { MomentConnectionElement, SteelMemberElement } from '@core/model/building';
import type { TakeoffLine } from '@aec/takeoffBasics';

const HALL = { span: 24000, length: 30000 };

function hall(params: Record<string, unknown> = {}): CadDocument {
  return execute(createEmptyDocument(), 'add_portal_frame_building', { ...HALL, ...params })
    .document;
}

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
      /^Checked 6 frame\(s\), \d+ check\(s\) over 2 ULS combination\(s\) \+ SLS \(G = 0\.5 kN\/m² \+ self-weight, S = 0\.8 kN\/m², no wind/,
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
      'Frame,Mark,Type,N (kN),M (kNm),V (kN),Utilisation,Status,Combination,Check',
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

describe('structural review regressions', () => {
  it('gives mirror-image eaves the same (hogging) moment sign', () => {
    const rows = (execute(hall(), 'check_portal_frames', {}).data as { rows: CheckRow[] }).rows;
    const eaves = rows.filter(
      (row) =>
        row.kind === 'connection' && row.frame === 'frame 2' && row.check.startsWith('eaves'),
    );
    expect(eaves).toHaveLength(2);
    expect(eaves.every((row) => row.forces!.every((force) => force.moment < 0))).toBe(true);
    // Left eaves under the → imperfection mirrors the right eaves under ←.
    expect(eaves[0]!.forces![0]!.moment / eaves[1]!.forces![1]!.moment).toBeCloseTo(1, 2);
    const apex = rows.filter(
      (row) => row.kind === 'connection' && row.frame === 'frame 2' && row.check.startsWith('apex'),
    );
    expect(apex.every((row) => row.forces!.every((force) => force.moment > 0))).toBe(true);
  });

  it('re-seats purlins, rails and gable posts and keeps gable posts unchanged', () => {
    const doc = hall({
      rafterProfile: 'IPE300',
      columnProfile: 'HEA240',
      gablePostProfile: 'HEA240',
    });
    const result = execute(doc, 'design_portal_frames', {});
    expect(result.summary).toMatch(/gable posts are not analysed/);
    expect(result.summary).toMatch(/Frames only/);
    const members = (d: CadDocument): SteelMemberElement[] =>
      Object.values(d.building!.elements).flatMap((e) => (e.category === 'member' ? [e] : []));
    const before = new Map(members(doc).map((m) => [m.id, m]));
    const after = members(result.document);
    const gablePosts = after.filter(
      (m) => m.role === 'column' && m.start[0] !== 0 && m.start[0] !== 24000,
    );
    expect(gablePosts.length).toBeGreaterThan(0);
    expect(gablePosts.every((m) => m.profile === 'HEA240')).toBe(true);
    // Gable post tops drop by half the rafter depth increase (on the slope).
    const post = gablePosts[0]!;
    expect(Math.max(post.start[2], post.end[2])).toBeLessThan(
      Math.max(before.get(post.id)!.start[2], before.get(post.id)!.end[2]),
    );
    // Purlins move up with the deeper rafter; rails move out with the deeper column.
    const purlin = after.find((m) => m.role === 'purlin')!;
    expect(purlin.start[2]).toBeGreaterThan(before.get(purlin.id)!.start[2]);
    const rail = after.find((m) => m.role === 'rail' && m.start[0] < 0)!;
    expect(rail.start[0]).toBeLessThan(before.get(rail.id)!.start[0]);
  });

  it('skips single-frame halls and keeps tributary widths per hall', () => {
    const single = execute(createEmptyDocument(), 'add_steel_member', {
      profile: 'IPE400',
      role: 'rafter',
      start: [0, 0, 6000],
      end: [6000, 0, 6600],
    }).document;
    expect(execute(single, 'check_portal_frames', {}).summary).toMatch(
      /single frame: no tributary width/,
    );
    let two = hall();
    two = execute(two, 'add_portal_frame_building', {
      origin: [40000, 0],
      span: 24000,
      length: 30000,
      baySpacing: 5000,
    }).document;
    const rows = (execute(two, 'check_portal_frames', {}).data as { rows: CheckRow[] }).rows;
    const internal = (mark: string): number => rows.find((row) => row.mark === mark)!.moment;
    // First hall: 6 m bays; second hall: 5 m bays → smaller internal-frame moments.
    expect(internal('RF3')).toBeGreaterThan(internal('RF15') * 1.1);
  });

  it('returns the unchanged document when nothing needs designing', () => {
    const designed = execute(hall(), 'design_portal_frames', {}).document;
    const again = execute(designed, 'design_portal_frames', {});
    expect(again.document).toBe(designed);
    expect(again.affected).toEqual([]);
    expect(again.summary).toMatch(/no change needed/);
  });

  it('sizes weld throats by steel grade', async () => {
    const { fullStrengthFactor } = await import('@aec/industrial/connections');
    expect(fullStrengthFactor(235)).toBeCloseTo(0.46, 2);
    expect(fullStrengthFactor(355)).toBeCloseTo(0.58, 2);
    expect(fullStrengthFactor(460)).toBeCloseTo(0.75, 2);
  });

  it('labels every connection schedule column', () => {
    const data = execute(hall(), 'building_schedule', { kind: 'connection' }).data as {
      columns: string[];
      rows: unknown[][];
    };
    expect(data.columns).toHaveLength(data.rows[0]!.length);
    expect(data.columns.at(-1)).toBe('Welds');
  });
});
