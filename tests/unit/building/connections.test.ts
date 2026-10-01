import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { buildingErrors } from '@core/commands/building/validate';
import type { BuildingElement, MomentConnectionElement } from '@core/model/building';
import type { TakeoffLine } from '@core/commands/building/quantities';
import type { IfcExport } from '@core/commands/building/ifc';
import { __resetIdCounter } from '@lib/id';

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

beforeEach(() => __resetIdCounter());

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
    expect(connections(result.document).map((c) => c.kind)).toEqual(['eaves']);
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
