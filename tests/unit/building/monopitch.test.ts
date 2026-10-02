import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type {
  BuildingElement,
  MomentConnectionElement,
  PanelElement,
  SteelMemberElement,
} from '@core/model/building';
import { execute } from '@core/commands/registry';
import { baseReactions, framesOf } from '@core/commands/building/industrial/frameModel';
import type { PurlinRow, ZoneSummary } from '@core/commands/building/industrial/purlinCheck';
import type { ElevationSheet } from '@core/commands/building/elevation';
import type { IfcExport } from '@core/commands/building/ifc';
import { __resetIdCounter } from '@lib/id';

const HALL = { span: 24000, length: 30000 };
const PITCH = (6 * Math.PI) / 180;
const RISE = HALL.span * Math.tan(PITCH);
const LOADS = { deadLoad: 0.5, snowLoad: 0.8, windPressure: 1 };

function hall(params: Record<string, unknown> = {}): CadDocument {
  return execute(createEmptyDocument(), 'add_portal_frame_building', {
    ...HALL,
    roofType: 'monopitch',
    ...params,
  }).document;
}

const elementsOf = (doc: CadDocument): BuildingElement[] => Object.values(doc.building!.elements);

const membersOf = (doc: CadDocument, role: SteelMemberElement['role']): SteelMemberElement[] =>
  elementsOf(doc).filter(
    (element): element is SteelMemberElement =>
      element.category === 'member' && element.role === role,
  );

const topOf = (member: SteelMemberElement): number => Math.max(member.start[2], member.end[2]);

beforeEach(() => __resetIdCounter());

describe('add_portal_frame_building roofType', () => {
  it('keeps duopitch as the default (explicit duopitch gives the identical document)', () => {
    const defaulted = execute(createEmptyDocument(), 'add_portal_frame_building', HALL);
    const explicit = execute(createEmptyDocument(), 'add_portal_frame_building', {
      ...HALL,
      roofType: 'duopitch',
    });
    expect(explicit.document.building!.elements).toEqual(defaulted.document.building!.elements);
    expect(explicit.document.building!.elementOrder).toEqual(
      defaulted.document.building!.elementOrder,
    );
    expect(explicit.summary).toBe(defaulted.summary);
    expect(defaulted.summary).toContain('ridge 8.26 m');
    expect(membersOf(defaulted.document, 'rafter')).toHaveLength(12);
  });

  it('rejects an unknown roofType (no-op)', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'add_portal_frame_building', { ...HALL, roofType: 'sawtooth' });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain("roofType must be 'duopitch' or 'monopitch'");
  });

  it('generates one rafter per frame rising from the low eaves (left) to the high eaves', () => {
    const result = execute(createEmptyDocument(), 'add_portal_frame_building', {
      ...HALL,
      roofType: 'monopitch',
    });
    expect(result.summary).toContain('eaves 7.00 m, high eaves 9.52 m');
    expect(result.summary).toContain('monopitch roof');
    const rafters = membersOf(result.document, 'rafter');
    expect(rafters).toHaveLength(6);
    for (const rafter of rafters) {
      expect(rafter.start[0]).toBe(0);
      expect(rafter.end[0]).toBe(24000);
      expect(rafter.start[2]).toBeCloseTo(7000, 6);
      expect(rafter.end[2]).toBeCloseTo(7000 + RISE, 6);
      const slope = Math.atan2(rafter.end[2] - rafter.start[2], rafter.end[0] - rafter.start[0]);
      expect(slope).toBeCloseTo(PITCH, 9);
    }
  });

  it('gives the columns different heights: eaves at the left, eaves + rise at the right', () => {
    const doc = hall();
    const frameColumns = membersOf(doc, 'column').filter((column) => column.roll === 0);
    expect(frameColumns).toHaveLength(12);
    for (const column of frameColumns) {
      expect(topOf(column)).toBeCloseTo(column.start[0] === 0 ? 7000 : 7000 + RISE, 6);
    }
    // Gable wind posts stop under the rafter at their own x.
    const posts = membersOf(doc, 'column').filter((column) => column.roll !== 0);
    expect(posts.length).toBeGreaterThan(0);
    const heights = posts.map(topOf);
    expect(Math.min(...heights)).toBeGreaterThan(7000);
    expect(Math.max(...heights)).toBeLessThan(7000 + RISE);
    for (const post of posts) {
      const expected = 7000 + post.start[0] * Math.tan(PITCH) - 450 / 2 / Math.cos(PITCH);
      expect(topOf(post)).toBeCloseTo(expected, 6);
    }
  });

  it('has two eaves connections per frame and no apex', () => {
    const doc = hall();
    const connections = elementsOf(doc).filter(
      (element): element is MomentConnectionElement => element.category === 'connection',
    );
    expect(connections).toHaveLength(12);
    expect(connections.every((connection) => connection.kind === 'eaves')).toBe(true);
    expect(connections.filter((connection) => connection.end === 'start')).toHaveLength(6);
    expect(connections.filter((connection) => connection.end === 'end')).toHaveLength(6);
  });

  it('places purlins on the single slope and rails up to each side’s own eaves', () => {
    const doc = hall();
    const purlins = membersOf(doc, 'purlin');
    // One slope per bay: 5 bays × (ceil(24.13 m / 1.8 m) + 1) purlin lines.
    expect(purlins).toHaveLength(5 * 15);
    for (const purlin of purlins) expect(purlin.roll).toBeCloseTo(PITCH, 9);
    const firstBay = purlins.filter((purlin) => purlin.start[1] === 0);
    const sorted = [...firstBay].sort((a, b) => a.start[0] - b.start[0]);
    for (let index = 1; index < sorted.length; index++) {
      expect(sorted[index]!.start[2]).toBeGreaterThan(sorted[index - 1]!.start[2]);
      const slope = Math.atan2(
        sorted[index]!.start[2] - sorted[index - 1]!.start[2],
        sorted[index]!.start[0] - sorted[index - 1]!.start[0],
      );
      expect(slope).toBeCloseTo(PITCH, 9);
    }
    const rails = membersOf(doc, 'rail');
    const topLeft = Math.max(
      ...rails.filter((rail) => rail.start[0] < 0).map((rail) => rail.start[2]),
    );
    const topRight = Math.max(
      ...rails.filter((rail) => rail.start[0] > 24000).map((rail) => rail.start[2]),
    );
    expect(topLeft).toBeLessThan(7000);
    expect(topRight).toBeGreaterThan(7000);
    expect(topRight).toBeLessThan(7000 + RISE);
    expect(rails.filter((rail) => rail.start[0] > 24000).length).toBeGreaterThan(
      rails.filter((rail) => rail.start[0] < 0).length,
    );
  });

  it('braces the single roof slope in an X and the walls to their own heights', () => {
    const doc = hall();
    const braces = membersOf(doc, 'brace');
    // 2 end bays × (2 roof + 2 + 2 wall) diagonals.
    expect(braces).toHaveLength(12);
    const walls = braces.filter((brace) => brace.start[0] === brace.end[0]);
    expect(Math.max(...walls.filter((brace) => brace.start[0] === 0).map(topOf))).toBeCloseTo(
      7000,
      6,
    );
    expect(Math.max(...walls.filter((brace) => brace.start[0] === 24000).map(topOf))).toBeCloseTo(
      7000 + RISE,
      6,
    );
    const roof = braces.filter((brace) => brace.start[0] !== brace.end[0]);
    expect(roof).toHaveLength(4);
    for (const brace of roof) {
      expect(Math.min(brace.start[0], brace.end[0])).toBe(0);
      expect(Math.max(brace.start[0], brace.end[0])).toBe(24000);
    }
  });

  it('generates base plates, footings, crane runway and cladding that fit the roof', () => {
    const doc = hall({ crane: { capacity: 10, railHeight: 5000 }, columnBase: 'fixed' });
    const elements = elementsOf(doc);
    expect(elements.filter((element) => element.category === 'plate')).toHaveLength(18);
    expect(elements.filter((element) => element.category === 'footing')).toHaveLength(18);
    expect(membersOf(doc, 'crane').length).toBeGreaterThan(0);
    const roofPanels = elements.filter(
      (element): element is PanelElement => element.category === 'panel' && element.role === 'roof',
    );
    expect(roofPanels).toHaveLength(1);
    const corners = roofPanels[0]!.corners;
    const slope = Math.atan2(
      Math.max(...corners.map((c) => c[2])) - Math.min(...corners.map((c) => c[2])),
      Math.max(...corners.map((c) => c[0])) - Math.min(...corners.map((c) => c[0])),
    );
    expect(slope).toBeCloseTo(PITCH, 9);
    expect(elements.filter((element) => element.category === 'panel')).toHaveLength(5);
  });

  it('supports several spans: the slope continues across the internal column line', () => {
    const doc = hall({ spans: [12000, 12000] });
    const columns = membersOf(doc, 'column').filter((column) => column.roll === 0);
    const heightAt = (x: number): number => topOf(columns.find((column) => column.start[0] === x)!);
    expect(heightAt(0)).toBeCloseTo(7000, 6);
    expect(heightAt(12000)).toBeCloseTo(7000 + 12000 * Math.tan(PITCH), 6);
    expect(heightAt(24000)).toBeCloseTo(7000 + RISE, 6);
    expect(membersOf(doc, 'rafter')).toHaveLength(12);
  });
});

describe('monopitch frames and wind', () => {
  it('analyses the frames (one rafter, two different column heights)', () => {
    const doc = hall();
    const building = doc.building!;
    const { frames, skipped } = framesOf(doc, building, building.levelOrder[0]!, LOADS);
    expect(skipped).toEqual([]);
    expect(frames).toHaveLength(6);
    const frame = frames[0]!;
    expect(frame.members.filter((member) => member.role === 'rafter')).toHaveLength(1);
    expect(frame.members.filter((member) => member.role === 'column')).toHaveLength(2);
    const heights = frame.columnTops.map((top) => top.height).sort((a, b) => a - b);
    expect(heights[0]).toBeCloseTo(7000, 6);
    expect(heights[1]).toBeCloseTo(7000 + RISE, 6);
    const check = execute(doc, 'check_portal_frames', { windPressure: 0.7 });
    expect(check.summary).toMatch(/^Checked 6 frame\(s\)/);
    const designed = execute(doc, 'design_portal_frames', { windPressure: 0.7 });
    expect((designed.data as { failures: number }).failures).toBe(0);
    const rechecked = execute(designed.document, 'check_portal_frames', { windPressure: 0.7 });
    expect((rechecked.data as { failures: string[] }).failures).toEqual([]);
  });

  it('lifts the roof more with wind on the high eaves (zone H −0.81 vs −0.57 at 6°); duopitch is symmetric', () => {
    const uplift = (doc: CadDocument, key: 'WL' | 'WR' | 'WLs' | 'WRs'): number => {
      const building = doc.building!;
      return baseReactions(doc, building, building.levelOrder[0]!, LOADS)
        .filter((reaction) => reaction.frame === 'frame 3')
        .reduce((sum, reaction) => sum - reaction.cases[key]!.vertical, 0);
    };
    const mono = hall();
    // Roof suction ratio (cpe + cpi) at 6°: H −0.81 (high eaves) over −0.57 (low eaves), Tab. 7.3a interpolated.
    expect(uplift(mono, 'WR') / uplift(mono, 'WL')).toBeCloseTo(1.01 / 0.77, 6);
    expect(uplift(mono, 'WRs') / uplift(mono, 'WLs')).toBeCloseTo(0.51 / 0.27, 6);
    expect(uplift(mono, 'WR')).toBeGreaterThan(uplift(mono, 'WL'));
    const duo = hall({ roofType: 'duopitch' });
    expect(uplift(duo, 'WR')).toBeCloseTo(uplift(duo, 'WL'), 3);
  });
});

describe('check_purlins on a monopitch roof (EN 1991-1-4 Tab. 7.3a)', () => {
  const data = (doc: CadDocument): { rows: PurlinRow[]; zones: ZoneSummary[]; roofType: string } =>
    execute(doc, 'check_purlins', { windPressure: 0.7 }).data as {
      rows: PurlinRow[];
      zones: ZoneSummary[];
      roofType: string;
    };
  const roofZones = (zones: ZoneSummary[]): Array<[string, number]> =>
    zones.filter((zone) => zone.surface === 'roof').map((zone) => [zone.zone, zone.cpe]);

  it('uses the monopitch coefficients per wind direction and zone', () => {
    const result = data(hall());
    expect(result.roofType).toBe('monopitch');
    const zones = roofZones(result.zones);
    for (const expected of [
      ['F', -2.32],
      ['G', -1.3],
      ['H', -0.81],
      ['G', -1.16],
      ['F', -1.62],
      ['G', -1.8],
    ] as const) {
      expect(zones, `${expected}`).toContainEqual([expected[0], expected[1]]);
    }
    // Duopitch values are not used on a monopitch roof.
    expect(zones.some(([zone]) => zone === 'H/I' || zone === 'J')).toBe(false);
  });

  it('puts the strongest uplift on the purlins at the high eaves', () => {
    const result = data(hall());
    const doc = hall();
    const purlins = new Map(membersOf(doc, 'purlin').map((purlin) => [purlin.id, purlin]));
    const midBay = result.rows
      .filter((row) => row.kind === 'purlin')
      .map((row) => ({ row, purlin: purlins.get(row.elementId)! }))
      .filter(({ purlin }) => Math.abs((purlin.start[1] + purlin.end[1]) / 2 - 15000) < 3500);
    const highest = midBay.reduce((a, b) => (b.purlin.start[2] > a.purlin.start[2] ? b : a));
    const lowest = midBay.reduce((a, b) => (b.purlin.start[2] < a.purlin.start[2] ? b : a));
    expect(highest.row.zone).toBe('G');
    expect(lowest.row.zone).toBe('G');
    expect(highest.row.upliftUtilisation!).toBeGreaterThan(lowest.row.upliftUtilisation!);
    const cornerHigh = result.rows
      .filter((row) => row.check.includes('cpe -2.32'))
      .every((row) => row.zone === 'F');
    expect(cornerHigh).toBe(true);
  });

  it('keeps the duopitch zones on a duopitch roof', () => {
    const result = data(hall({ roofType: 'duopitch' }));
    expect(result.roofType).toBe('duopitch');
    const zones = roofZones(result.zones);
    expect(zones).toContainEqual(['I', -0.59]);
    expect(zones.some(([, cpe]) => cpe === -2.32)).toBe(false);
  });
});

describe('monopitch hall in the drawing, IFC and quantity exports', () => {
  it('draws elevations, exports IFC and quantities', () => {
    const doc = hall({ crane: { capacity: 10, railHeight: 5000 } });
    for (const direction of ['east', 'south'] as const) {
      const sheet = execute(doc, 'export_elevation_sheet', { direction }).data as ElevationSheet;
      expect(sheet.svg).toMatch(/^<svg xmlns/);
      expect(sheet.faces).toBeGreaterThan(0);
    }
    const ifc = (execute(doc, 'export_ifc', {}).data as IfcExport).ifc;
    for (const entity of ['IFCCOLUMN(', 'IFCBEAM(', 'IFCMEMBER(', 'IFCPLATE(', 'IFCFOOTING(']) {
      expect(ifc, entity).toContain(entity);
    }
    const lines = (
      execute(doc, 'quantity_takeoff', {}).data as {
        lines: Array<{ key: string; quantity: number }>;
      }
    ).lines;
    const quantity = (key: string): number => lines.find((line) => line.key === key)!.quantity;
    // One roof plane: (span + overhang) / cos(pitch) × (length + 2 × 200).
    const expectedRoof = ((24000 + 2 * 450) / Math.cos(PITCH) / 1000) * (HALL.length / 1000 + 0.4);
    expect(quantity('panel-roof.sandwich-panel.m2')).toBeGreaterThan(0.95 * expectedRoof);
    expect(quantity('panel-roof.sandwich-panel.m2')).toBeLessThan(1.05 * expectedRoof);
    expect(quantity('member.IPE450.m')).toBeCloseTo((6 * 24000) / Math.cos(PITCH) / 1000, 1);
    expect(lines.some((line) => line.key === 'connection.eaves.ea' && line.quantity === 12)).toBe(
      true,
    );
    expect(lines.some((line) => line.key.startsWith('connection.apex'))).toBe(false);
  });

  it('checks bracing, foundations and the crane runway of a monopitch hall', () => {
    const doc = hall({ crane: { capacity: 10, railHeight: 5000 } });
    expect(execute(doc, 'check_bracing', { windPressure: 0.7 }).summary).toContain('all OK');
    expect(execute(doc, 'check_foundations', { windPressure: 0.7 }).summary).toMatch(
      /^Checked 12 footing/,
    );
    expect(execute(doc, 'check_crane_runways', {}).summary).toMatch(/crane runway beam/);
  });
});
