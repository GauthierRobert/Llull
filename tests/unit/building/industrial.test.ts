import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { BuildingElement } from '@core/model/building';
import {
  findProfile,
  profileOutline,
  STEEL_PROFILES,
} from '@core/commands/building/steel/profiles';
import { boxOverlap, type Clash, type OrientedBox } from '@core/commands/building/industrial/clash';
import { buildPlanDrawing } from '@core/commands/building/plan';
import type { TakeoffLine } from '@core/commands/building/quantities';
import type { IfcExport } from '@core/commands/building/ifc';
import { serializeDocument } from '@core/commands/persistence';
import { buildingErrors } from '@core/commands/building/validate';
import { polygonArea } from '@lib/polygon';
import { __resetIdCounter } from '@lib/id';

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

beforeEach(() => __resetIdCounter());

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
      expect(result.summary).toMatch(/add_steel_member failed/);
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
