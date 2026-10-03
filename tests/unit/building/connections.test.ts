import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { buildingErrors } from '@aec/validate';
import type { BuildingElement, MomentConnectionElement } from '@core/model/building';
import type { TakeoffLine } from '@aec/takeoffBasics';
import type { IfcExport } from '@aec/ifcBuild';

const HALL = { span: 18000, length: 12000, eaveHeight: 6000, roofPitch: 6 };

function connections(doc: CadDocument): MomentConnectionElement[] {
  return Object.values(doc.building?.elements ?? {}).filter(
    (element): element is MomentConnectionElement => element.category === 'connection',
  );
}

/** One frame built by hand: two columns, two rafters meeting at the ridge. */
function frame(): CadDocument {
  let doc = createEmptyDocument();
  const add = (params: Record<string, unknown>): void => {
    doc = execute(doc, 'add_steel_member', params).document;
  };
  add({ profile: 'HEA300', role: 'column', start: [0, 0, 0], end: [0, 0, 6000] });
  add({ profile: 'HEA300', role: 'column', start: [12000, 0, 0], end: [12000, 0, 6000] });
  add({ profile: 'IPE400', role: 'rafter', start: [0, 0, 6000], end: [6000, 0, 6600] });
  add({ profile: 'IPE400', role: 'rafter', start: [12000, 0, 6000], end: [6000, 0, 6600] });
  return doc;
}

function meshXs(doc: CadDocument, id: string): number[] {
  const entity = doc.entities[id];
  if (entity?.kind !== 'mesh') throw new Error(id);
  return entity.mesh.positions.filter((_, index) => index % 3 === 0);
}

describe('add_moment_connections', () => {
  it('details eaves (haunched) and apex joints of a frame', () => {
    const doc = frame();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'add_moment_connections', {});
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.summary).toMatch(
      /Added 3 moment connection\(s\): 2 eaves \(haunched\), 1 apex; 22 bolt\(s\) M20, \d+\.\d kg/,
    );
    const added = connections(result.document);
    expect(added.map((c) => [c.kind, c.rafterId, c.end, c.otherId])).toEqual([
      ['eaves', 'member-3', 'start', 'member-1'],
      ['apex', 'member-3', 'end', 'member-4'],
      ['eaves', 'member-4', 'start', 'member-2'],
    ]);
    expect(added[0]).toMatchObject({ plateThickness: 25, boltRows: 4, haunchLength: 1200 });
    expect(added[1]).toMatchObject({ haunchLength: 0, boltRows: 3 });
    const ids = added[0]!.entityIds;
    expect(ids).toContain('connection-1:plate');
    expect(ids).toContain('connection-1:haunch');
    expect(ids.filter((id) => id.includes(':bolt-'))).toHaveLength(8);
    expect(added[1]!.entityIds).toContain('connection-2:plate-2');
    // The eaves end plate is vertical, on the column flange face (HEA300: h/2 = 145).
    const xs = meshXs(result.document, 'connection-1:plate');
    expect(Math.min(...xs)).toBeCloseTo(145, 6);
    expect(Math.max(...xs)).toBeCloseTo(170, 6);
    expect(execute(result.document, 'add_moment_connections', {}).summary).toMatch(
      /no unconnected/,
    );
  });

  it('takes sizes and explicit rafters, and validates them', () => {
    const result = execute(frame(), 'add_moment_connections', {
      rafterIds: ['member-4'],
      plateThickness: 30,
      boltDiameter: 24,
      haunchLength: 1500,
    });
    // The higher-id rafter of the apex pair also gets its apex detailed.
    expect(connections(result.document).map((c) => c.kind)).toEqual(['eaves', 'apex']);
    expect(connections(result.document)[0]).toMatchObject({
      plateThickness: 30,
      boltDiameter: 24,
      haunchLength: 1500,
    });
    for (const params of [{ plateThickness: 0 }, { boltDiameter: -1 }, { levelId: 'nope' }]) {
      expect(execute(frame(), 'add_moment_connections', params).affected).toEqual([]);
    }
    expect(execute(createEmptyDocument(), 'add_moment_connections', {}).summary).toMatch(
      /no unconnected/,
    );
  });

  it('follows its rafter and is deleted with the rafter or the column', () => {
    let doc = execute(frame(), 'add_moment_connections', {}).document;
    const before = Math.min(...meshXs(doc, 'connection-1:plate'));
    doc = execute(doc, 'update_steel_member', {
      memberId: 'member-1',
      profile: 'HEB400',
    }).document;
    expect(Math.min(...meshXs(doc, 'connection-1:plate'))).toBeGreaterThan(before);
    expect(
      execute(doc, 'move_building_element', { elementIds: ['connection-1'], delta: [1, 0] })
        .summary,
    ).toMatch(/refused/);
    const withoutColumn = execute(doc, 'delete_building_element', { elementIds: ['member-1'] });
    expect(withoutColumn.document.building?.elements['connection-1']).toBeUndefined();
    expect(withoutColumn.document.building?.elements['connection-2']).toBeDefined();
    const withoutRafter = execute(doc, 'delete_building_element', { elementIds: ['member-4'] });
    expect(connections(withoutRafter.document).map((c) => c.id)).toEqual(['connection-1']);
    expect(buildingErrors(withoutRafter.document.building)).toEqual([]);
  });

  it('is generated by the hall generator (one eaves per rafter, one apex per span)', () => {
    const doc = execute(createEmptyDocument(), 'add_portal_frame_building', HALL).document;
    const all = connections(doc);
    expect(all.filter((c) => c.kind === 'eaves')).toHaveLength(3 * 2);
    expect(all.filter((c) => c.kind === 'apex')).toHaveLength(3);
    const twoSpans = execute(createEmptyDocument(), 'add_portal_frame_building', {
      ...HALL,
      spans: [12000, 12000],
    }).document;
    expect(connections(twoSpans).filter((c) => c.kind === 'eaves')).toHaveLength(3 * 4);
    const bare = execute(createEmptyDocument(), 'add_portal_frame_building', {
      ...HALL,
      connections: false,
    }).document;
    expect(connections(bare)).toHaveLength(0);
  });

  it('feeds takeoff, schedule and IFC, and is validated on load', () => {
    const doc = execute(frame(), 'add_moment_connections', {}).document;
    const lines = (execute(doc, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
    expect(lines.find((line) => line.key === 'connection.bolt M20.ea')?.quantity).toBe(22);
    expect(lines.find((line) => line.key === 'connection.eaves.ea')?.quantity).toBe(2);
    expect(lines.find((line) => line.key === 'connection.S355.kg')?.quantity).toBeGreaterThan(50);
    const schedule = execute(doc, 'building_schedule', { kind: 'connection' }).data as {
      rows: unknown[][];
    };
    expect(schedule.rows[0]?.slice(0, 7)).toEqual([
      'MC1',
      'eaves',
      'RF1',
      'SC1',
      25,
      '8×M20',
      1200,
    ]);
    const ifc = (execute(doc, 'export_ifc', {}).data as IfcExport).ifc;
    expect(ifc).toContain("'END_PLATE'");
    expect(ifc).toContain("'HAUNCH'");
    expect(ifc).toContain('.BOLT.)');
    expect(buildingErrors(doc.building)).toEqual([]);
    const broken = JSON.parse(JSON.stringify(doc.building)) as {
      elements: Record<string, Record<string, unknown>>;
    };
    const connection = broken.elements['connection-1'] as Record<string, unknown>;
    connection['otherId'] = 'nope';
    connection['kind'] = 'knee';
    connection['end'] = 'middle';
    expect(buildingErrors(broken)).toEqual([
      expect.stringMatching(/otherId 'nope' is not a steel member/),
      expect.stringMatching(/kind must be eaves or apex/),
      expect.stringMatching(/end must be start or end/),
    ]);
    const element: BuildingElement | undefined = doc.building?.elements['connection-1'];
    expect(element?.mark).toBe('MC1');
  });
});

describe('phase 3 review regressions', () => {
  it('places the apex partner plate at the joint for spliced rafters', () => {
    let doc = createEmptyDocument();
    for (const [start, end] of [
      [
        [0, 0, 6000],
        [5000, 0, 6500],
      ],
      [
        [5000, 0, 6500],
        [10000, 0, 7000],
      ],
    ]) {
      doc = execute(doc, 'add_steel_member', {
        profile: 'IPE400',
        role: 'rafter',
        start,
        end,
      }).document;
    }
    doc = execute(doc, 'add_moment_connections', {}).document;
    const xs = meshXs(doc, 'connection-1:plate-2');
    expect(Math.min(...xs)).toBeGreaterThan(4900);
    expect(Math.max(...xs)).toBeLessThan(5100);
  });

  it('drops connections whose joint disappears on update_steel_member', () => {
    const doc = execute(frame(), 'add_moment_connections', {}).document;
    const role = execute(doc, 'update_steel_member', { memberId: 'member-1', role: 'beam' });
    expect(role.summary).toMatch(/Moment connection\(s\) connection-1 removed/);
    expect(connections(role.document).map((c) => c.id)).toEqual(['connection-2', 'connection-3']);
    const moved = execute(doc, 'update_steel_member', {
      memberId: 'member-3',
      start: [0, 0, 5000],
    });
    expect(moved.summary).toMatch(/connection-1 removed/);
    expect(
      execute(doc, 'update_steel_member', { memberId: 'member-1', note: 'x' }).summary,
    ).not.toMatch(/removed/);
  });

  it('refuses to move a column away from its connected rafter', () => {
    const doc = execute(frame(), 'add_moment_connections', {}).document;
    expect(
      execute(doc, 'move_building_element', { elementIds: ['member-1'], delta: [3000, 0] }).summary,
    ).toMatch(/connection-1 tie the moved member\(s\) to rafters/);
    const together = execute(doc, 'move_building_element', {
      elementIds: ['member-1', 'member-2', 'member-3', 'member-4'],
      delta: [3000, 0],
    });
    expect(together.affected.length).toBeGreaterThan(0);
    expect(
      execute(doc, 'move_building_element', { elementIds: ['connection-1'], delta: [1, 0] })
        .summary,
    ).toMatch(/follow their host \(a wall, a steel column or a rafter\)/);
  });

  it('copies connections with their members to another level', () => {
    let doc = execute(frame(), 'add_moment_connections', {}).document;
    doc = execute(doc, 'add_level', { name: 'Upper' }).document;
    const result = execute(doc, 'copy_level_elements', {
      sourceLevelId: 'level-1',
      targetLevelIds: ['level-2'],
    });
    const copied = connections(result.document).filter((c) => c.levelId === 'level-2');
    expect(copied.map((c) => [c.kind, c.rafterId, c.otherId])).toEqual([
      ['eaves', 'member-7', 'member-5'],
      ['apex', 'member-7', 'member-8'],
      ['eaves', 'member-8', 'member-6'],
    ]);
    expect(buildingErrors(result.document.building)).toEqual([]);
  });

  it('details the apex when only the higher-id rafter is requested', () => {
    const result = execute(frame(), 'add_moment_connections', { rafterIds: ['member-4'] });
    expect(connections(result.document).map((c) => c.kind)).toEqual(['eaves', 'apex']);
    expect(execute(result.document, 'add_moment_connections', {}).summary).toMatch(
      /Added 1 moment connection\(s\): 1 eaves/,
    );
  });

  it('weighs the modelled plates (taller on a steep rafter)', () => {
    const steep = (pitchRise: number): number => {
      let doc = createEmptyDocument();
      doc = execute(doc, 'add_steel_member', {
        profile: 'HEA300',
        role: 'column',
        start: [0, 0, 0],
        end: [0, 0, 6000],
      }).document;
      doc = execute(doc, 'add_steel_member', {
        profile: 'IPE400',
        role: 'rafter',
        start: [0, 0, 6000],
        end: [6000, 0, 6000 + pitchRise],
      }).document;
      doc = execute(doc, 'add_moment_connections', { haunchLength: 1000 }).document;
      const lines = (execute(doc, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
      return lines.find((line) => line.key === 'connection.S355.kg')?.quantity ?? 0;
    };
    expect(steep(3000)).toBeGreaterThan(steep(300));
  });
});
