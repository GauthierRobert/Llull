import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { BuildingElement } from '@core/model/building';
import { findProfile, profileOutline, STEEL_PROFILES } from '@aec/steel/profiles';
import { boxOverlap, type Clash, type OrientedBox } from '@aec/industrial/clash';
import { buildPlanDrawing } from '@aec/plan';
import type { TakeoffLine } from '@aec/quantities';
import type { IfcExport } from '@aec/ifc';
import { serializeDocument } from '@core/commands/persistence';
import { buildingErrors } from '@aec/validate';
import { polygonArea } from '@lib/polygon';

function run(doc: CadDocument, name: string, params: unknown): CadDocument {
  const result = execute(doc, name, params);
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return result.document;
}

function element(doc: CadDocument, id: string): BuildingElement {
  const found = doc.building?.elements[id];
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

function elementsOf(doc: CadDocument, category: BuildingElement['category']): BuildingElement[] {
  return Object.values(doc.building?.elements ?? {}).filter((e) => e.category === category);
}

const SMALL_HALL = {
  span: 18000,
  length: 30000,
  baySpacing: 6000,
  eaveHeight: 6000,
  roofPitch: 6,
};

describe('steel profile catalogue', () => {
  it('finds profiles case- and space-insensitively', () => {
    expect(findProfile('ipe 300')?.name).toBe('IPE300');
    expect(findProfile('HEA400')?.massPerMetre).toBeCloseTo(125, 0);
    expect(findProfile('XYZ1')).toBeUndefined();
  });

  it('produces closed outlines whose area matches the catalogue', () => {
    for (const name of ['SHS100x5', 'CHS76.1x3.6', 'L100x10', 'C200x75x2.5', 'UPN200']) {
      const profile = findProfile(name);
      expect(profile, name).toBeDefined();
      const { outer, holes } = profileOutline(profile!);
      const area =
        Math.abs(polygonArea(outer)) - holes.reduce((s, h) => s + Math.abs(polygonArea(h)), 0);
      expect(area / profile!.area, name).toBeGreaterThan(0.9);
      expect(area / profile!.area, name).toBeLessThan(1.1);
    }
  });

  it('list_steel_profiles filters by family and is read-only', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'list_steel_profiles', { family: 'hea' });
    const profiles = (result.data as { profiles: Array<{ family: string }> }).profiles;
    expect(profiles.length).toBeGreaterThan(5);
    expect(profiles.every((p) => p.family === 'HEA')).toBe(true);
    expect(result.document).toBe(doc);
    expect(
      (execute(doc, 'list_steel_profiles', {}).data as { profiles: unknown[] }).profiles,
    ).toHaveLength(STEEL_PROFILES.length);
  });
});

describe('add_steel_member / update_steel_member', () => {
  it('creates a member with an exact section mesh on its role layer', () => {
    const before = createEmptyDocument();
    const snapshot = JSON.stringify(before);
    const result = execute(before, 'add_steel_member', {
      profile: 'IPE300',
      start: [0, 0, 3000],
      end: [6000, 0, 3000],
    });
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(result.summary).toMatch(/beam SB1 \(member-1\) IPE300.*6000\.0 mm.*253\.\d kg/);
    expect(result.affected[0]).toBe('member-1');
    const body = result.document.entities['member-1:body'];
    expect(body?.kind).toBe('mesh');
    expect(body?.tags).toContain('element:member-1');
  });

  it('rejects unknown profiles, zero length, bad roles and bad points', () => {
    const doc = createEmptyDocument();
    for (const params of [
      { profile: 'NOPE', start: [0, 0, 0], end: [1, 0, 0] },
      { profile: 'IPE300', start: [0, 0, 0], end: [0, 0, 0] },
      { profile: 'IPE300', start: [0, 0, 0], end: [1, 0, 0], role: 'girder' },
      { profile: 'IPE300', start: [0], end: [1, 0, 0] },
      { profile: 'IPE300', start: [0, 0, 0], end: [1, 0, 0], levelId: 'nope' },
    ]) {
      const result = execute(doc, 'add_steel_member', params);
      expect(result.affected, JSON.stringify(params)).toEqual([]);
      expect(result.summary).toMatch(/add_steel_member (failed|rejected)/);
    }
  });

  it('upsizes a member and validates edits', () => {
    let doc = run(createEmptyDocument(), 'add_steel_member', {
      profile: 'HEA300',
      role: 'column',
      start: [0, 0],
      end: [0, 0, 6000],
    });
    expect(element(doc, 'member-1').mark).toBe('SC1');
    const result = execute(doc, 'update_steel_member', {
      memberId: 'member-1',
      profile: 'hea 400',
      note: 'upsized',
    });
    expect(result.summary).toMatch(/HEA400/);
    doc = result.document;
    expect(element(doc, 'member-1')).toMatchObject({ profile: 'HEA400', note: 'upsized' });
    for (const params of [
      { memberId: 'member-9' },
      { memberId: 'member-1', profile: 'NOPE' },
      { memberId: 'member-1', role: 'girder' },
      { memberId: 'member-1', start: [0, 0, 6000] },
      { memberId: 'member-1', end: 'x' },
    ]) {
      expect(execute(doc, 'update_steel_member', params).affected).toEqual([]);
    }
  });

  it('blocks generic edits of member geometry (integrity guard)', () => {
    const doc = run(createEmptyDocument(), 'add_steel_member', {
      profile: 'IPE200',
      start: [0, 0, 0],
      end: [1000, 0, 0],
    });
    const result = execute(doc, 'delete_entity', { id: 'member-1:body' });
    expect(result.affected).toEqual([]);
    expect(result.document.entities['member-1:body']).toBeDefined();
  });
});

describe('add_footing / add_panel', () => {
  it('places a footing at a location or under every column', () => {
    let doc = run(createEmptyDocument(), 'add_footing', { location: [1000, 2000] });
    expect(doc.entities['footing-1:body']).toMatchObject({
      kind: 'box',
      size: [1500, 1500, 600],
      position: [1000, 2000, -600],
    });
    doc = run(doc, 'add_steel_member', {
      profile: 'HEA300',
      role: 'column',
      start: [5000, 0, 0],
      end: [5000, 0, 6000],
    });
    doc = run(doc, 'add_column', { location: [10000, 0] });
    const result = execute(doc, 'add_footing', { underColumns: true, width: 2000 });
    expect(result.summary).toMatch(/Added 2 pad footing/);
    expect(element(result.document, 'footing-2')).toMatchObject({ location: [5000, 0] });
  });

  it('rejects bad footings', () => {
    const doc = createEmptyDocument();
    expect(execute(doc, 'add_footing', {}).summary).toMatch(/location must be/);
    expect(execute(doc, 'add_footing', { underColumns: true }).summary).toMatch(/no columns/);
    expect(execute(doc, 'add_footing', { location: [0, 0], width: 0 }).affected).toEqual([]);
    expect(execute(doc, 'add_footing', { location: [0, 0], topOffset: NaN }).affected).toEqual([]);
  });

  it('builds a panel along its normal and rejects degenerate planes', () => {
    const doc = run(createEmptyDocument(), 'add_panel', {
      corners: [
        [0, 0, 0],
        [4000, 0, 0],
        [4000, 0, 3000],
        [0, 0, 3000],
      ],
      thickness: 100,
    });
    expect(element(doc, 'panel-1')).toMatchObject({ role: 'wall', mark: 'CL1', thickness: 100 });
    expect(doc.entities['panel-1:body']?.kind).toBe('mesh');
    const empty = createEmptyDocument();
    expect(execute(empty, 'add_panel', { corners: [[0, 0, 0]] }).affected).toEqual([]);
    expect(
      execute(empty, 'add_panel', {
        corners: [
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
        ],
      }).summary,
    ).toMatch(/do not span a plane/);
    expect(
      execute(empty, 'add_panel', {
        corners: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        thickness: -1,
      }).affected,
    ).toEqual([]);
  });
});

describe('add_equipment / add_pipe_run', () => {
  it('places equipment with a default clearance', () => {
    const result = execute(createEmptyDocument(), 'add_equipment', {
      name: 'CNC lathe',
      location: [5000, 5000],
      size: [4000, 2000, 2200],
      weight: 6500,
    });
    expect(result.summary).toMatch(/EQ1 "CNC lathe".*clearance 800, 6500 kg/);
    expect(element(result.document, 'equipment-1')).toMatchObject({ clearance: 800, angle: 0 });
    expect(result.document.entities['equipment-1:body']).toMatchObject({
      kind: 'box',
      position: [5000, 5000, 1100],
    });
  });

  it('rejects bad equipment', () => {
    const doc = createEmptyDocument();
    for (const params of [
      { name: ' ', location: [0, 0], size: [1, 1, 1] },
      { name: 'A', location: [0], size: [1, 1, 1] },
      { name: 'A', location: [0, 0], size: [1, 0, 1] },
      { name: 'A', location: [0, 0], size: [1, 1] },
      { name: 'A', location: [0, 0], size: [1, 1, 1], clearance: -1 },
      { name: 'A', location: [0, 0], size: [1, 1, 1], weight: -5 },
      { name: 'A', location: [0, 0], size: [1, 1, 1], levelId: 'nope' },
    ]) {
      expect(execute(doc, 'add_equipment', params).affected, JSON.stringify(params)).toEqual([]);
    }
  });

  it('routes a pipe with segments and bends', () => {
    const result = execute(createEmptyDocument(), 'add_pipe_run', {
      points: [
        [0, 0, 3000],
        [6000, 0, 3000],
        [6000, 4000, 3000],
      ],
      service: 'compressed air',
      diameter: 60.3,
    });
    expect(result.summary).toMatch(/compressed air pipe PL1 \(pipe-1\) Ø60\.3, 10\.00 m, 1 bend/);
    const ids = element(result.document, 'pipe-1').entityIds;
    expect(ids).toEqual(['pipe-1:segment-0', 'pipe-1:segment-1', 'pipe-1:joint-1']);
  });

  it('rejects bad pipes', () => {
    const doc = createEmptyDocument();
    expect(execute(doc, 'add_pipe_run', { points: [[0, 0, 0]] }).affected).toEqual([]);
    expect(
      execute(doc, 'add_pipe_run', {
        points: [
          [0, 0, 0],
          [0, 0, 0],
        ],
      }).summary,
    ).toMatch(/must differ/);
    expect(
      execute(doc, 'add_pipe_run', {
        points: [
          [0, 0, 0],
          [1, 0, 0],
        ],
        diameter: 0,
      }).affected,
    ).toEqual([]);
    expect(execute(doc, 'add_pipe_run', { points: 'x' }).affected).toEqual([]);
  });
});

describe('add_portal_frame_building', () => {
  it('generates a complete hall in one step', () => {
    const before = createEmptyDocument();
    const snapshot = JSON.stringify(before);
    const result = execute(before, 'add_portal_frame_building', SMALL_HALL);
    expect(JSON.stringify(before)).toBe(snapshot);
    const doc = result.document;
    const members = elementsOf(doc, 'member');
    const byRole = (role: string): number =>
      members.filter((m) => m.category === 'member' && m.role === role).length;
    // 6 frames (5 bays) × 2 columns + 2 gable posts per end.
    expect(byRole('column')).toBe(12 + 4);
    expect(byRole('rafter')).toBe(12);
    expect(byRole('brace')).toBeGreaterThan(0);
    expect(byRole('purlin')).toBeGreaterThan(0);
    expect(byRole('rail')).toBeGreaterThan(0);
    expect(elementsOf(doc, 'footing')).toHaveLength(16);
    expect(elementsOf(doc, 'panel')).toHaveLength(6);
    expect(elementsOf(doc, 'slab')).toHaveLength(1);
    const grids = elementsOf(doc, 'grid').map((g) => g.mark);
    expect(grids).toEqual(['A', 'B', '1', '2', '3', '4', '5', '6']);
    expect(result.summary).toMatch(/134 steel members \(\d+\.\d t\), 8 grid lines/);
    expect(result.affected[0]).toBe(doc.building?.elementOrder[0]);
    expect(buildingErrors(doc.building)).toEqual([]);
  });

  it('adds a crane runway on brackets and can skip optional parts', () => {
    const doc = execute(createEmptyDocument(), 'add_portal_frame_building', {
      ...SMALL_HALL,
      footings: false,
      cladding: false,
      floorSlab: false,
      crane: { capacity: 16, railHeight: 4500 },
    }).document;
    const crane = elementsOf(doc, 'member').filter(
      (m) => m.category === 'member' && m.role === 'crane',
    );
    expect(crane).toHaveLength(10);
    const brackets = elementsOf(doc, 'member').filter(
      (m) => m.category === 'member' && m.note === 'crane bracket',
    );
    expect(brackets).toHaveLength(12);
    expect(elementsOf(doc, 'footing')).toHaveLength(0);
    expect(elementsOf(doc, 'panel')).toHaveLength(0);
    expect(elementsOf(doc, 'slab')).toHaveLength(0);
  });

  it('continues grid labels on a second hall', () => {
    let doc = run(createEmptyDocument(), 'add_portal_frame_building', SMALL_HALL);
    doc = run(doc, 'add_portal_frame_building', { ...SMALL_HALL, origin: [30000, 0] });
    const labels = elementsOf(doc, 'grid').map((g) => g.mark);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('rejects invalid halls', () => {
    const doc = createEmptyDocument();
    for (const params of [
      { span: 0 },
      { origin: [0] },
      { roofPitch: 50 },
      { columnProfile: 'NOPE' },
      { crane: { railHeight: 9000 } },
      { crane: { railHeight: 4000, profile: 'NOPE' } },
      { levelId: 'nope' },
    ]) {
      const result = execute(doc, 'add_portal_frame_building', params);
      expect(result.affected, JSON.stringify(params)).toEqual([]);
      expect(result.summary).toMatch(/add_portal_frame_building failed/);
    }
  });
});

describe('add_crane_runway', () => {
  it('splits the runway at supports and brackets it to nearby columns', () => {
    let doc = createEmptyDocument();
    for (const y of [0, 6000, 12000]) {
      doc = run(doc, 'add_steel_member', {
        profile: 'HEA400',
        role: 'column',
        start: [0, y, 0],
        end: [0, y, 7000],
      });
    }
    const result = execute(doc, 'add_crane_runway', {
      start: [700, 0],
      end: [700, 12000],
      railHeight: 5000,
      capacity: 5,
    });
    expect(result.summary).toMatch(/\(5 t\): 2 beam segment\(s\) HEB300, 3 bracket/);
    const beam = element(result.document, 'member-4');
    expect(beam).toMatchObject({ role: 'crane', start: [700, 0, 4850] });
  });

  it('rejects bad runways', () => {
    const doc = createEmptyDocument();
    for (const params of [
      { start: [0], end: [1, 0], railHeight: 1 },
      { start: [0, 0], end: [0, 0], railHeight: 1 },
      { start: [0, 0], end: [1000, 0], railHeight: 0 },
      { start: [0, 0], end: [1000, 0], railHeight: 1, profile: 'NOPE' },
      { start: [0, 0], end: [1000, 0], railHeight: 1, levelId: 'nope' },
    ]) {
      expect(execute(doc, 'add_crane_runway', params).affected).toEqual([]);
    }
  });
});

describe('check_clashes', () => {
  it('measures the overlap of oriented boxes', () => {
    const box = (x: number, angle = 0): OrientedBox => {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      return {
        center: [x, 0, 0] as [number, number, number],
        axes: [
          [c, s, 0],
          [-s, c, 0],
          [0, 0, 1],
        ] as [[number, number, number], [number, number, number], [number, number, number]],
        half: [1, 1, 1] as [number, number, number],
      };
    };
    expect(boxOverlap(box(0), box(1.5))).toBeCloseTo(0.5);
    expect(boxOverlap(box(0), box(3))).toBeLessThanOrEqual(0);
    expect(boxOverlap(box(0), box(2.3, Math.PI / 4))).toBeGreaterThan(0);
  });

  it('finds no false positives in a clean hall', () => {
    const doc = execute(createEmptyDocument(), 'add_portal_frame_building', {
      ...SMALL_HALL,
      crane: { railHeight: 4500 },
    }).document;
    const result = execute(doc, 'check_clashes', {});
    expect(result.summary).toBe('No clashes found.');
    expect(result.document).toBe(doc);
  });

  it('reports hard clashes and clearance violations', () => {
    let doc = run(createEmptyDocument(), 'add_portal_frame_building', SMALL_HALL);
    // Press placed on column line A and a pipe running through the columns of line B.
    doc = run(doc, 'add_equipment', {
      name: 'Press',
      location: [0, 3000],
      size: [2000, 2000, 3000],
    });
    doc = run(doc, 'add_equipment', {
      name: 'Saw',
      location: [9000, 9000],
      size: [2000, 2000, 2000],
      clearance: 1000,
    });
    doc = run(doc, 'add_equipment', {
      name: 'Drill',
      location: [9000, 11500],
      size: [2000, 2000, 2000],
      clearance: 0,
    });
    doc = run(doc, 'add_pipe_run', {
      points: [
        [18000, -1000, 3000],
        [18000, 31000, 3000],
      ],
    });
    const result = execute(doc, 'check_clashes', {});
    const clashes = (result.data as { clashes: Clash[] }).clashes;
    const involving = (id: string): Clash[] => clashes.filter((c) => c.a === id || c.b === id);
    const [press, saw, drill] = elementsOf(doc, 'equipment').map((e) => e.id);
    const pipe = elementsOf(doc, 'pipe')[0]!.id;
    expect(involving(press!).some((c) => c.kind === 'hard')).toBe(true);
    expect(involving(pipe).filter((c) => c.kind === 'hard').length).toBeGreaterThanOrEqual(6);
    expect(
      clashes.some(
        (c) => c.kind === 'clearance' && [c.a, c.b].includes(saw!) && [c.a, c.b].includes(drill!),
      ),
    ).toBe(true);
    expect(result.summary).toMatch(/hard clash\(es\), \d+ clearance violation/);
    // Clashes are sorted hard first.
    expect(clashes[0]?.kind).toBe('hard');
  });

  it('treats pipes ending inside equipment as connections', () => {
    let doc = run(createEmptyDocument(), 'add_equipment', {
      name: 'Compressor',
      location: [0, 0],
      size: [2000, 1000, 1500],
      clearance: 0,
    });
    doc = run(doc, 'add_pipe_run', {
      points: [
        [500, 0, 1000],
        [5000, 0, 1000],
      ],
    });
    expect(execute(doc, 'check_clashes', {}).summary).toBe('No clashes found.');
  });

  it('rejects an unknown level or a negative tolerance', () => {
    const doc = createEmptyDocument();
    expect(execute(doc, 'check_clashes', { levelId: 'nope' }).summary).toMatch(/no level/);
    expect(execute(doc, 'check_clashes', { tolerance: -1 }).data).toBeUndefined();
  });
});

describe('industrial takeoff, schedules, plan and IFC', () => {
  function hallWithProcess(): CadDocument {
    let doc = run(createEmptyDocument(), 'add_portal_frame_building', SMALL_HALL);
    doc = run(doc, 'add_equipment', {
      name: 'Lathe',
      location: [9000, 15000],
      size: [3000, 1500, 2000],
    });
    doc = run(doc, 'add_pipe_run', {
      points: [
        [2000, 1000, 4000],
        [2000, 20000, 4000],
      ],
      service: 'water',
    });
    return doc;
  }

  it('reports steel tonnage, paint, footings, cladding, equipment and pipes', () => {
    const lines = (
      execute(hallWithProcess(), 'quantity_takeoff', {}).data as {
        lines: TakeoffLine[];
      }
    ).lines;
    const kg = lines.filter((l) => l.unit === 'kg');
    expect(kg.length).toBeGreaterThan(3);
    const columns = lines.find((l) => l.key === 'member.HEA400.kg');
    expect(columns?.quantity).toBeCloseTo(12 * 6 * 125, -2);
    expect(lines.find((l) => l.key === 'member.paint.m2')?.quantity).toBeGreaterThan(0);
    expect(lines.find((l) => l.key === 'footing.concrete.ea')?.quantity).toBe(16);
    expect(lines.find((l) => l.group === 'panel-roof')?.quantity).toBeGreaterThan(18 * 30);
    expect(lines.find((l) => l.key === 'equipment.Lathe.ea')?.quantity).toBe(1);
    expect(lines.find((l) => l.category === 'pipe')?.quantity).toBeCloseTo(19, 5);
  });

  it.each([
    ['member', 'Profile'],
    ['footing', 'Volume (m³)'],
    ['panel', 'Role'],
    ['equipment', 'Clearance'],
    ['pipe', 'Service'],
  ])('builds the %s schedule', (kind, column) => {
    const data = execute(hallWithProcess(), 'building_schedule', { kind }).data as {
      rows: unknown[][];
      columns: string[];
    };
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.columns.some((c) => c.startsWith(column))).toBe(true);
  });

  it('draws columns as cut sections, equipment with clearance and hides roof framing', () => {
    const doc = hallWithProcess();
    const plan = buildPlanDrawing(doc, undefined)!;
    const memberPolygons = plan.primitives.filter(
      (p) => p.type === 'polygon' && p.layer.startsWith('S-'),
    );
    expect(memberPolygons.length).toBeGreaterThanOrEqual(16);
    const texts = plan.primitives.filter((p) => p.type === 'text').map((p) => p.content);
    expect(texts.some((t) => t.includes('Lathe'))).toBe(true);
    expect(texts.some((t) => t.includes('water'))).toBe(true);
    expect(plan.primitives.some((p) => p.style === 'hidden' && p.layer === 'S-FNDN')).toBe(true);
  });

  it('exports members, footings, cladding, equipment and pipes to IFC', () => {
    const ifc = (execute(hallWithProcess(), 'export_ifc', {}).data as IfcExport).ifc;
    for (const entity of [
      'IFCCOLUMN(',
      'IFCBEAM(',
      'IFCMEMBER(',
      'IFCFOOTING(',
      'IFCCOVERING(',
      'IFCBUILDINGELEMENTPROXY(',
      'IFCPIPESEGMENT(',
      'IFCISHAPEPROFILEDEF(',
    ]) {
      expect(ifc, entity).toContain(entity);
    }
  });

  it('survives save / load with the new categories', () => {
    const doc = hallWithProcess();
    const loaded = execute(createEmptyDocument(), 'load_document', {
      json: serializeDocument(doc),
    });
    expect(loaded.summary).not.toMatch(/failed/);
    expect(Object.keys(loaded.document.building!.elements)).toEqual(
      Object.keys(doc.building!.elements),
    );
  });
});

describe('review regressions', () => {
  it('a second hall adds footings only under its own columns; underColumns skips existing ones', () => {
    let doc = run(createEmptyDocument(), 'add_portal_frame_building', SMALL_HALL);
    const first = elementsOf(doc, 'footing').length;
    doc = run(doc, 'add_portal_frame_building', { ...SMALL_HALL, origin: [40000, 0] });
    expect(elementsOf(doc, 'footing')).toHaveLength(2 * first);
    expect(execute(doc, 'add_footing', { underColumns: true }).summary).toMatch(
      /every column already has a footing/,
    );
  });

  it('closes the front gable cladding flush with the side walls', () => {
    const doc = execute(createEmptyDocument(), 'add_portal_frame_building', SMALL_HALL).document;
    const gables = elementsOf(doc, 'panel').filter(
      (panel) =>
        panel.category === 'panel' &&
        panel.role === 'wall' &&
        new Set(panel.corners.map((corner) => corner[1])).size === 1,
    );
    const ys = gables.map((panel) => (panel.category === 'panel' ? panel.corners[0]![1] : 0));
    expect(ys.sort((a, b) => a - b)).toEqual([-200, 30200]);
  });

  it('orients gable wind posts on their strong axis', () => {
    const doc = execute(createEmptyDocument(), 'add_portal_frame_building', SMALL_HALL).document;
    const posts = elementsOf(doc, 'member').filter(
      (m) => m.category === 'member' && m.profile === 'HEA200',
    );
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((m) => m.category === 'member' && m.roll === Math.PI / 2)).toBe(true);
  });

  it('refuses generators that would create an excessive number of members', () => {
    const doc = createEmptyDocument();
    expect(execute(doc, 'add_portal_frame_building', { purlinSpacing: 1 }).summary).toMatch(
      /over the 5000 limit/,
    );
    expect(
      execute(doc, 'add_crane_runway', {
        start: [0, 0],
        end: [100000, 0],
        railHeight: 5000,
        supportSpacing: 1,
      }).summary,
    ).toMatch(/supportSpacing too small/);
    expect(
      execute(doc, 'add_crane_runway', { start: [0, 0], end: [6000, 0], railHeight: 400 }).summary,
    ).toMatch(/railHeight must exceed/);
  });

  it('draws a diagonal wall panel along its true plan line', () => {
    const doc = run(createEmptyDocument(), 'add_panel', {
      corners: [
        [0, 10000, 0],
        [10000, 0, 0],
        [10000, 0, 3000],
        [0, 10000, 3000],
      ],
    });
    const line = buildPlanDrawing(doc, undefined)!.primitives.find(
      (p) => p.type === 'line' && p.layer === 'A-CLAD',
    );
    expect(line?.type === 'line' && [line.a, line.b]).toEqual([
      [0, 10000],
      [10000, 0],
    ]);
  });

  it('treats a pipe tee as a connection but still reports pipes on other levels', () => {
    let doc = run(createEmptyDocument(), 'add_pipe_run', {
      points: [
        [0, 0, 3000],
        [10000, 0, 3000],
      ],
    });
    doc = run(doc, 'add_pipe_run', {
      points: [
        [5000, 0, 3000],
        [5000, 5000, 3000],
      ],
    });
    expect(execute(doc, 'check_clashes', {}).summary).toBe('No clashes found.');
    // Same local coordinates one level up: no longer touching.
    doc = run(doc, 'add_level', { name: 'Upper', height: 3000 });
    doc = run(doc, 'add_pipe_run', {
      points: [
        [5000, -2000, -50],
        [5000, 2000, -50],
      ],
      diameter: 200,
    });
    expect(execute(doc, 'check_clashes', {}).summary).toMatch(/1 hard clash.*PL1 × PL3/);
  });

  it('reports a pipe ending inside a steel column and each clearance pair once', () => {
    let doc = run(createEmptyDocument(), 'add_steel_member', {
      profile: 'HEA300',
      role: 'column',
      start: [0, 0, 0],
      end: [0, 0, 6000],
    });
    doc = run(doc, 'add_pipe_run', {
      points: [
        [0, 0, 3000],
        [5000, 0, 3000],
      ],
    });
    doc = run(doc, 'add_equipment', { name: 'A', location: [20000, 0], size: [1000, 1000, 1000] });
    doc = run(doc, 'add_equipment', { name: 'B', location: [21500, 0], size: [1000, 1000, 1000] });
    const result = execute(doc, 'check_clashes', {});
    const clashes = (result.data as { clashes: Clash[] }).clashes;
    expect(clashes.filter((c) => c.kind === 'hard')).toHaveLength(1);
    expect(clashes.filter((c) => c.kind === 'clearance')).toHaveLength(1);
    expect(result.summary).toMatch(/\(\d+ mm\)/);
  });

  it('reports clash depths in mm in a metre document', () => {
    let doc = execute(createEmptyDocument(), 'set_units', { units: 'm' }).document;
    doc = run(doc, 'add_steel_member', {
      profile: 'HEA300',
      role: 'column',
      start: [0, 0, 0],
      end: [0, 0, 6],
    });
    doc = run(doc, 'add_equipment', { name: 'Press', location: [0.6, 0], size: [1, 1, 1] });
    expect(execute(doc, 'check_clashes', {}).summary).toMatch(/EQ1 × SC1 \(45 mm\)/);
  });

  it('keeps role-based marks when copying members or changing their role', () => {
    let doc = run(createEmptyDocument(), 'add_steel_member', {
      profile: 'HEA300',
      role: 'column',
      start: [0, 0, 0],
      end: [0, 0, 3000],
    });
    doc = run(doc, 'update_steel_member', { memberId: 'member-1', role: 'brace' });
    expect(element(doc, 'member-1').mark).toBe('BR1');
    doc = run(doc, 'add_level', { name: 'Upper' });
    doc = run(doc, 'copy_level_elements', {
      sourceLevelId: 'level-1',
      targetLevelIds: ['level-2'],
    });
    expect(element(doc, 'member-2').mark).toBe('BR2');
  });

  it('fails gracefully on non-string profiles and families', () => {
    const doc = createEmptyDocument();
    expect(
      execute(doc, 'add_steel_member', { profile: 300, start: [0, 0, 0], end: [1, 0, 0] }).summary,
    ).toMatch(/rejected: invalid params/);
    expect(execute(doc, 'list_steel_profiles', { family: 3 }).summary).toMatch(/must be a string/);
  });

  it('rejects saved buildings with invalid industrial fields', () => {
    const doc = run(createEmptyDocument(), 'add_steel_member', {
      profile: 'HEA300',
      start: [0, 0, 0],
      end: [1000, 0, 0],
    });
    const broken = JSON.parse(JSON.stringify(doc.building)) as {
      elements: Record<string, Record<string, unknown>>;
    };
    broken.elements['member-1']!['role'] = 'girder';
    broken.elements['member-1']!['material'] = 5;
    expect(buildingErrors(broken)).toEqual([
      expect.stringMatching(/role must be one of/),
      expect.stringMatching(/material must be a string/),
    ]);
  });
});

describe('multi-span halls', () => {
  it('shares internal columns between spans and roofs each span separately', () => {
    const result = execute(createEmptyDocument(), 'add_portal_frame_building', {
      spans: [12000, 18000],
      length: 12000,
      eaveHeight: 6000,
      roofPitch: 5,
    });
    const doc = result.document;
    expect(result.summary).toMatch(/30\.0 × 12\.0 m \(2 spans\)/);
    expect(result.data).toMatchObject({ spans: 2, frames: 3 });
    const members = elementsOf(doc, 'member');
    const frameColumns = members.filter(
      (m) => m.category === 'member' && m.role === 'column' && m.profile === 'HEA400',
    );
    expect(frameColumns).toHaveLength(3 * 3);
    expect(members.filter((m) => m.category === 'member' && m.role === 'rafter')).toHaveLength(
      3 * 4,
    );
    const grids = elementsOf(doc, 'grid').map((g) => g.mark);
    expect(grids.slice(0, 3)).toEqual(['A', 'B', 'C']);
    // 2 roof panels per span + 2 side walls + 2 gables (one polygon following both roofs).
    const panels = elementsOf(doc, 'panel');
    expect(panels).toHaveLength(8);
    const gable = panels.find(
      (panel) => panel.category === 'panel' && panel.role === 'wall' && panel.corners.length > 4,
    );
    expect(gable?.category === 'panel' && gable.corners).toHaveLength(2 + 5);
    expect(doc.entities[`${gable!.id}:body`]?.kind).toBe('mesh');
    expect(execute(doc, 'check_clashes', {}).summary).toBe('No clashes found.');
    expect(buildingErrors(doc.building)).toEqual([]);
  });

  it('puts a crane runway in every span', () => {
    const doc = execute(createEmptyDocument(), 'add_portal_frame_building', {
      spans: [15000, 15000],
      length: 12000,
      crane: { railHeight: 5000 },
    }).document;
    const runway = elementsOf(doc, 'member').filter(
      (m) => m.category === 'member' && m.role === 'crane',
    );
    expect(new Set(runway.map((m) => (m.category === 'member' ? m.start[0] : 0))).size).toBe(4);
  });

  it.each([[[]], [[0, 10000]], [Array(11).fill(6000)], ['12000']])('rejects spans %j', (spans) => {
    expect(execute(createEmptyDocument(), 'add_portal_frame_building', { spans }).summary).toMatch(
      /spans must be 1–10 widths|rejected: invalid params/,
    );
  });
});

describe('add_cable_tray', () => {
  function trayDoc(): CadDocument {
    return execute(createEmptyDocument(), 'add_cable_tray', {
      points: [
        [0, 0, 4000],
        [6000, 0, 4000],
        [6000, 3000, 4000],
      ],
      width: 400,
      height: 100,
      system: 'data',
    }).document;
  }

  it('routes a U-section tray and reports its length', () => {
    const before = createEmptyDocument();
    const snapshot = JSON.stringify(before);
    const result = execute(before, 'add_cable_tray', {
      points: [
        [0, 0, 4000],
        [6000, 0, 4000],
        [6000, 3000, 4000],
      ],
      width: 400,
      height: 100,
      system: 'data',
    });
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(result.summary).toBe('Added data cable tray CT1 (tray-1) 400×100, 9.00 m.');
    expect(result.affected[0]).toBe('tray-1');
    expect(element(result.document, 'tray-1').entityIds).toEqual([
      'tray-1:segment-0',
      'tray-1:segment-1',
    ]);
    expect(result.document.entities['tray-1:segment-0']?.layerId).toBeDefined();
    const defaults = execute(createEmptyDocument(), 'add_cable_tray', {
      points: [
        [0, 0],
        [1000, 0],
      ],
    });
    expect(element(defaults.document, 'tray-1')).toMatchObject({
      width: 300,
      height: 60,
      system: 'power',
    });
  });

  it.each([
    [{ points: [[0, 0, 0]] }],
    [
      {
        points: [
          [0, 0, 0],
          [0, 0, 0],
        ],
      },
    ],
    [
      {
        points: [
          [0, 0, 0],
          [1, 0, 0],
        ],
        width: 0,
      },
    ],
    [
      {
        points: [
          [0, 0, 0],
          [1, 0, 0],
        ],
        levelId: 'nope',
      },
    ],
    [{ points: 'x' }],
  ])('rejects %j', (params) => {
    const result = execute(createEmptyDocument(), 'add_cable_tray', params);
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(/add_cable_tray (failed|rejected)/);
  });

  it('feeds takeoff, schedule, plan, IFC, clashes and survives save / load', () => {
    let doc = trayDoc();
    const lines = (execute(doc, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
    expect(lines.find((line) => line.key === 'tray.data 400×100.m')?.quantity).toBeCloseTo(9);
    const schedule = execute(doc, 'building_schedule', { kind: 'tray' }).data as {
      rows: unknown[][];
    };
    expect(schedule.rows).toEqual([['CT1', 'data', 400, 100, 9, 1, 'Level 0']]);
    const plan = buildPlanDrawing(doc, undefined)!;
    const edges = plan.primitives.filter((p) => p.type === 'polyline' && p.layer === 'E-TRAY');
    expect(edges).toHaveLength(2);
    expect(edges[0]?.type === 'polyline' && edges[0].points[1]).toEqual([5800, 200]);
    expect((execute(doc, 'export_ifc', {}).data as IfcExport).ifc).toContain('.CABLETRAYSEGMENT.');
    // A tee into the run is a connection; a beam through it is a clash.
    doc = run(doc, 'add_cable_tray', {
      points: [
        [3000, 0, 4000],
        [3000, -5000, 4000],
      ],
    });
    expect(execute(doc, 'check_clashes', {}).summary).toBe('No clashes found.');
    doc = run(doc, 'add_steel_member', {
      profile: 'IPE300',
      start: [1000, -2000, 4000],
      end: [1000, 2000, 4000],
    });
    expect(execute(doc, 'check_clashes', {}).summary).toMatch(/1 hard clash.*SB1 × CT1|CT1 × SB1/);
    const loaded = execute(createEmptyDocument(), 'load_document', {
      json: serializeDocument(doc),
    });
    expect(loaded.document.building?.elements['tray-1']).toEqual(doc.building?.elements['tray-1']);
    expect(buildingErrors(doc.building)).toEqual([]);
  });

  it('moves with move_building_element', () => {
    let doc = trayDoc();
    doc = run(doc, 'move_building_element', { elementIds: ['tray-1'], delta: [1000, 0] });
    expect(element(doc, 'tray-1').category === 'tray' && element(doc, 'tray-1')).toMatchObject({
      points: [
        [1000, 0, 4000],
        [7000, 0, 4000],
        [7000, 3000, 4000],
      ],
    });
  });
});

describe('add_base_plates', () => {
  function column(doc: CadDocument, x: number, profile = 'HEA300'): CadDocument {
    return run(doc, 'add_steel_member', {
      profile,
      role: 'column',
      start: [x, 0, 0],
      end: [x, 0, 6000],
    });
  }

  it('adds a plate with anchor bolts under every unplated column', () => {
    let doc = column(column(createEmptyDocument(), 0), 6000, 'HEB200');
    const before = JSON.stringify(doc);
    const result = execute(doc, 'add_base_plates', {});
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.summary).toMatch(
      /Added 2 base plate\(s\) with 8 anchor bolt\(s\) M24: \d+\.\d kg/,
    );
    doc = result.document;
    expect(element(doc, 'plate-1')).toMatchObject({
      memberId: 'member-1',
      length: 490,
      width: 500,
      thickness: 20,
      boltCount: 4,
      mark: 'BP1',
    });
    expect(element(doc, 'plate-1').entityIds).toEqual([
      'plate-1:body',
      'plate-1:bolt-0',
      'plate-1:bolt-1',
      'plate-1:bolt-2',
      'plate-1:bolt-3',
    ]);
    // Plate top under the column foot; HEA300 depth along +X.
    expect(doc.entities['plate-1:body']).toMatchObject({ kind: 'box', position: [0, 0, -10] });
    expect(execute(doc, 'add_base_plates', {}).summary).toMatch(/no steel column without/);
  });

  it('takes sizes and explicit columns, and validates them', () => {
    const doc = column(column(createEmptyDocument(), 0), 6000);
    const result = execute(doc, 'add_base_plates', {
      memberIds: ['member-2'],
      thickness: 30,
      boltCount: 6,
      boltDiameter: 30,
      margin: 150,
    });
    expect(element(result.document, 'plate-1')).toMatchObject({
      memberId: 'member-2',
      thickness: 30,
      boltCount: 6,
      boltDiameter: 30,
      length: 590,
    });
    for (const params of [
      { boltCount: 3 },
      { boltCount: 14 },
      { thickness: 0 },
      { levelId: 'nope' },
      { memberIds: ['member-9'] },
    ]) {
      expect(execute(doc, 'add_base_plates', params).affected, JSON.stringify(params)).toEqual([]);
    }
  });

  it('follows, copies and deletes with its column; cannot move alone', () => {
    let doc = run(column(createEmptyDocument(), 0), 'add_base_plates', {});
    doc = run(doc, 'move_building_element', { elementIds: ['member-1'], delta: [1000, 0] });
    expect(doc.entities['plate-1:body']?.position).toEqual([1000, 0, -10]);
    expect(
      execute(doc, 'move_building_element', { elementIds: ['plate-1'], delta: [1, 0] }).summary,
    ).toMatch(/refused: plate-1 follow their host/);
    doc = run(doc, 'add_level', { name: 'Upper' });
    doc = run(doc, 'copy_level_elements', {
      sourceLevelId: 'level-1',
      targetLevelIds: ['level-2'],
    });
    expect(element(doc, 'plate-2')).toMatchObject({ memberId: 'member-2', levelId: 'level-2' });
    doc = run(doc, 'delete_building_element', { elementIds: ['member-1'] });
    expect(doc.building?.elements['plate-1']).toBeUndefined();
    expect(doc.entities['plate-1:body']).toBeUndefined();
  });

  it('feeds takeoff, schedule, plan, IFC and the hall generator', () => {
    const hall = execute(createEmptyDocument(), 'add_portal_frame_building', SMALL_HALL).document;
    const plates = elementsOf(hall, 'plate');
    expect(plates).toHaveLength(16);
    const lines = (execute(hall, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
    expect(lines.find((line) => line.key === 'plate.anchor M24.ea')?.quantity).toBe(64);
    expect(lines.find((line) => line.key === 'plate.S355.kg')?.quantity).toBeGreaterThan(400);
    const schedule = execute(hall, 'building_schedule', { kind: 'plate' }).data as {
      rows: unknown[][];
    };
    expect(schedule.rows[0]?.slice(0, 5)).toEqual(['BP1', 'SC1', '590×500', 25, '4×M24']);
    const plan = buildPlanDrawing(hall, undefined)!;
    expect(plan.primitives.filter((p) => p.type === 'circle' && p.layer === 'S-CONN')).toHaveLength(
      64,
    );
    const ifc = (execute(hall, 'export_ifc', {}).data as IfcExport).ifc;
    expect(ifc).toContain("'BASE_PLATE'");
    expect(ifc).toContain('.ANCHORBOLT.');
    expect(execute(hall, 'check_clashes', {}).summary).toBe('No clashes found.');
    expect(buildingErrors(hall.building)).toEqual([]);
    const broken = JSON.parse(JSON.stringify(hall.building)) as {
      elements: Record<string, Record<string, unknown>>;
    };
    broken.elements['plate-1']!['memberId'] = 'slab-1';
    broken.elements['plate-1']!['boltCount'] = 3;
    expect(buildingErrors(broken)).toEqual([
      expect.stringMatching(/is not a steel column/),
      expect.stringMatching(/boltCount must be an even integer/),
    ]);
    const bare = execute(createEmptyDocument(), 'add_portal_frame_building', {
      ...SMALL_HALL,
      basePlates: false,
    }).document;
    expect(elementsOf(bare, 'plate')).toHaveLength(0);
  });
});

describe('phase 2 review regressions', () => {
  function plated(profile = 'HEA300'): CadDocument {
    const doc = run(createEmptyDocument(), 'add_steel_member', {
      profile,
      role: 'column',
      start: [0, 0, 0],
      end: [0, 0, 6000],
    });
    return run(doc, 'add_base_plates', {});
  }

  it('fails gracefully on non-array spans', () => {
    for (const spans of [18000, {}]) {
      expect(
        execute(createEmptyDocument(), 'add_portal_frame_building', { spans }).summary,
      ).toMatch(/rejected: invalid params/);
    }
  });

  it('never copies a base plate without its column', () => {
    const doc = run(plated(), 'add_level', { name: 'Upper' });
    const result = execute(doc, 'copy_level_elements', {
      sourceLevelId: 'level-1',
      targetLevelIds: ['level-2'],
      categories: ['plate'],
    });
    expect(result.affected).toEqual([]);
    expect(elementsOf(result.document, 'plate')).toHaveLength(1);
  });

  it('re-sizes plates with their column and removes them when it stops being one', () => {
    let doc = plated();
    const result = execute(doc, 'update_steel_member', { memberId: 'member-1', profile: 'HEB500' });
    expect(result.summary).toMatch(/Base plate\(s\) plate-1 re-sized/);
    doc = result.document;
    expect(element(doc, 'plate-1')).toMatchObject({ length: 700, width: 500 });
    const rafter = execute(doc, 'update_steel_member', { memberId: 'member-1', role: 'rafter' });
    expect(rafter.summary).toMatch(/plate-1 removed \(no longer a column\)/);
    expect(rafter.document.building?.elements['plate-1']).toBeUndefined();
    expect(rafter.document.entities['plate-1:body']).toBeUndefined();
    // Unrelated edits leave the plate alone.
    const noted = execute(doc, 'update_steel_member', { memberId: 'member-1', note: 'x' });
    expect(noted.summary).not.toMatch(/plate/i);
  });

  it('names bolts in mm in a metre document', () => {
    let doc = execute(createEmptyDocument(), 'set_units', { units: 'm' }).document;
    doc = run(doc, 'add_steel_member', {
      profile: 'HEA300',
      role: 'column',
      start: [0, 0, 0],
      end: [0, 0, 6],
    });
    const result = execute(doc, 'add_base_plates', {});
    expect(result.summary).toMatch(/anchor bolt\(s\) M24/);
    const lines = (
      execute(result.document, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }
    ).lines;
    expect(lines.some((line) => line.key === 'plate.anchor M24.ea')).toBe(true);
  });

  it('draws a tray starting with a vertical riser as a full-width band', () => {
    const doc = run(createEmptyDocument(), 'add_cable_tray', {
      points: [
        [0, 0, 3000],
        [0, 0, 5000],
        [10000, 0, 5000],
      ],
    });
    const edges = buildPlanDrawing(doc, undefined)!.primitives.filter(
      (p) => p.type === 'polyline' && p.layer === 'E-TRAY',
    );
    expect(edges.map((edge) => edge.type === 'polyline' && edge.points[0])).toEqual([
      [0, 150],
      [0, -150],
    ]);
    const riser = run(createEmptyDocument(), 'add_cable_tray', {
      points: [
        [0, 0, 3000],
        [0, 0, 5000],
      ],
    });
    const symbol = buildPlanDrawing(riser, undefined)!.primitives.find((p) => p.layer === 'E-TRAY');
    expect(symbol?.type).toBe('polygon');
  });

  it('fills cut plates as steel in sections and rejects plates on non-columns', () => {
    const doc = plated();
    const drawing = execute(doc, 'export_elevation_sheet', { direction: 'south', cutAt: 0 })
      .data as { svg: string };
    expect(drawing.svg).toContain('class="poche-steel"');
    const broken = JSON.parse(JSON.stringify(doc.building)) as {
      elements: Record<string, Record<string, unknown>>;
    };
    broken.elements['member-1']!['role'] = 'beam';
    expect(buildingErrors(broken)).toEqual([expect.stringMatching(/is not a steel column/)]);
  });
});
