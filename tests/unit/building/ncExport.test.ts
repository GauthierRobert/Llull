import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { exportNcFiles, type NcExport } from '@aec/industrial/ncExport';
import type { NcFile } from '@aec/industrial/ncFiles';
import type { MomentConnectionElement, SteelMemberElement } from '@core/model/building';
import { findProfile } from '@aec/steel/profiles';

const HALL = { span: 24000, length: 30000 };

function hall(): CadDocument {
  return execute(createEmptyDocument(), 'add_portal_frame_building', HALL).document;
}

function run(
  doc: CadDocument,
  params: Record<string, unknown> = {},
): ReturnType<typeof exportNcFiles.run> {
  return execute(doc, 'export_nc_files', params);
}

function files(doc: CadDocument, params: Record<string, unknown> = {}): NcFile[] {
  return (run(doc, params).data as NcExport).files;
}

/** Non-empty trimmed lines of an NC1 file. */
function lines(file: NcFile): string[] {
  return file.content.split('\n').filter((line) => line.trim() !== '');
}

function block(file: NcFile, name: string): string[][] {
  const all = lines(file);
  const start = all.findIndex((line) => line.trim() === name);
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const line of all.slice(start + 1)) {
    if (/^[A-Z]{2}$/.test(line.trim())) break;
    rows.push(line.trim().split(/\s+/));
  }
  return rows;
}

function stField(file: NcFile, index: number): string {
  const all = lines(file);
  return (all[index + 1] ?? '').trim();
}

describe('export_nc_files', () => {
  it('produces NC1 files for the default hall without touching the document', () => {
    const doc = hall();
    const before = JSON.stringify(doc);
    const result = run(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const data = result.data as NcExport;
    expect(data.count).toBe(data.files.length);
    expect(data.count).toBeGreaterThan(0);
    expect(result.summary).toMatch(/^DSTV NC1: \d+ file\(s\)/);
    for (const file of data.files) {
      expect(file.name).toMatch(/\.nc1$/);
      expect(lines(file)[0]).toBe('ST');
      expect(lines(file).at(-1)).toBe('EN');
    }
    expect(new Set(data.files.map((file) => file.name)).size).toBe(data.count);
    expect(exportNcFiles.annotations).toEqual({ readOnly: true, idempotent: true });
  });

  it('writes an ST block for an IPE450 rafter with a pitched cut', () => {
    const rafter = files(hall()).find(
      (file) => file.kind === 'member' && file.profile === 'IPE450',
    );
    expect(rafter).toBeDefined();
    const file = rafter as NcFile;
    expect(file.quantity).toBeGreaterThan(1);
    expect(stField(file, 0)).toBe('Untitled project');
    expect(stField(file, 1)).toBe('A-101');
    expect(stField(file, 3)).toBe(file.mark);
    expect(stField(file, 4)).toBe('S355');
    expect(stField(file, 5)).toBe(String(file.quantity));
    expect(stField(file, 6)).toBe('IPE450');
    expect(stField(file, 7)).toBe('I');
    const [length, height, width, tf, tw] = [8, 9, 10, 11, 12].map((i) => Number(stField(file, i)));
    expect(length).toBeLessThan(Math.hypot(12000, 1261.25));
    expect([height, width, tf, tw]).toEqual([450, 190, 14.6, 9.4]);
    const cuts = [16, 17, 18, 19].map((i) => Number(stField(file, i)));
    expect(cuts.slice(0, 2).every((cut) => cut > 5 && cut < 8)).toBe(true);
    expect(cuts.slice(2)).toEqual([0, 0]);
    const mass = Number(stField(file, 14));
    expect(mass).toBeGreaterThan(70);
  });

  it('gives straight members square cuts and flange holes at eaves columns', () => {
    const columns = files(hall()).filter(
      (file) => file.kind === 'member' && file.profile === 'HEA400',
    );
    expect(columns.length).toBeGreaterThan(0);
    const withHoles = columns.find((file) => block(file, 'BO').length > 0) as NcFile;
    expect(withHoles).toBeDefined();
    expect([16, 17, 18, 19].map((i) => Number(stField(withHoles, i)))).toEqual([0, 0, 0, 0]);
    const holes = block(withHoles, 'BO');
    expect(holes).toHaveLength(8);
    expect(
      holes.every(([face, , , diameter]) =>
        face === 'o' || face === 'u' ? diameter === '22.00' : true,
      ),
    ).toBe(true);
    const flange = Number(stField(withHoles, 10));
    for (const [, x, y] of holes) {
      expect(Number(y)).toBeGreaterThan(0);
      expect(Number(y)).toBeLessThan(flange);
      expect(Number(x)).toBeGreaterThan(5000);
    }
  });

  it('writes base plate files with an AK contour and the anchor holes', () => {
    const plate = files(hall()).find((file) => file.kind === 'plate' && file.mark.startsWith('BP'));
    const base = (plate ?? files(hall()).find((file) => file.kind === 'plate')) as NcFile;
    const baseFiles = files(hall()).filter(
      (file) => file.kind === 'plate' && block(file, 'BO').length === 4,
    );
    expect(baseFiles.length).toBeGreaterThan(0);
    const file = baseFiles[0] as NcFile;
    expect(base).toBeDefined();
    expect(stField(file, 7)).toBe('B');
    const contour = block(file, 'AK');
    expect(contour).toHaveLength(5);
    expect(contour[0]?.slice(1)).toEqual(contour[4]?.slice(1));
    const [length, width] = [8, 9].map((i) => Number(stField(file, i)));
    expect(length).toBeGreaterThan(0);
    const holes = block(file, 'BO');
    expect(holes).toHaveLength(4);
    for (const [face, x, y, diameter] of holes) {
      expect(face).toBe('o');
      expect(Number(x)).toBeGreaterThan(0);
      expect(Number(x)).toBeLessThan(length as number);
      expect(Number(y)).toBeGreaterThan(0);
      expect(Number(y)).toBeLessThan(width as number);
      expect(diameter).toBe('28.00');
    }
  });

  it('writes connection end plates with their bolt holes', () => {
    const endPlates = files(hall()).filter(
      (file) => file.kind === 'plate' && block(file, 'BO').length === 8,
    );
    expect(endPlates.length).toBeGreaterThan(0);
    expect(block(endPlates[0] as NcFile, 'AK')).toHaveLength(5);
  });

  it('groups identical members with a quantity and lists source ids', () => {
    const all = files(hall());
    const totalMembers = Object.values(hall().building?.elements ?? {}).filter(
      (element) => element.category === 'member',
    ).length;
    const memberFiles = all.filter((file) => file.kind === 'member');
    expect(memberFiles.reduce((sum, file) => sum + file.quantity, 0)).toBe(totalMembers);
    expect(memberFiles.length).toBeLessThan(totalMembers);
    for (const file of memberFiles) expect(file.sourceIds).toHaveLength(file.quantity);
  });

  it('splits members of different length into separate uniquely named files', () => {
    let doc = createEmptyDocument();
    const add = (end: number, y = 0): void => {
      doc = execute(doc, 'add_steel_member', {
        profile: 'IPE300',
        role: 'beam',
        start: [0, y, 3000],
        end: [end, y, 3000],
      }).document;
    };
    add(4000);
    add(4000, 1000);
    add(5000, 2000);
    const result = files(doc);
    expect(result.map((file) => file.quantity).sort()).toEqual([1, 2]);
    expect(new Set(result.map((file) => file.name)).size).toBe(2);
    const marks = new Set(result.map((file) => file.mark));
    expect(marks.size).toBeGreaterThan(0);
  });

  it('gives identical millimetre values for a document in metres', () => {
    const base = createEmptyDocument();
    const metres = hall();
    const asMetres = execute({ ...base, units: 'm' }, 'add_portal_frame_building', {
      span: 24,
      length: 30,
    }).document;
    expect(asMetres.units).toBe('m');
    const [a, b] = [files(metres), files(asMetres)];
    expect(b.map((file) => file.content)).toEqual(a.map((file) => file.content));
  });

  it('filters by memberIds and by includePlates', () => {
    const doc = hall();
    const members = Object.values(doc.building?.elements ?? {}).filter(
      (element) =>
        element.category === 'member' && element.role === 'column' && element.profile === 'HEA400',
    );
    const target = members[0];
    expect(target).toBeDefined();
    const only = run(doc, { memberIds: [(target as { id: string }).id] });
    const onlyFiles = (only.data as NcExport).files;
    expect(onlyFiles.filter((file) => file.kind === 'member')).toHaveLength(1);
    expect(onlyFiles.filter((file) => file.kind === 'plate').length).toBeGreaterThan(0);
    const noPlates = files(doc, { includePlates: false });
    expect(noPlates.every((file) => file.kind === 'member')).toBe(true);
    const level = doc.building?.levelOrder[0] as string;
    expect(files(doc, { levelId: level }).length).toBe(files(doc).length);
  });

  it('is a no-op for bad input or an empty model', () => {
    const empty = createEmptyDocument();
    for (const params of [
      {},
      { memberIds: ['nope'] },
      { memberIds: [] },
      { memberIds: 'member-1' },
      { includePlates: 'yes' },
      { levelId: 'ghost' },
    ]) {
      const doc = params.levelId || params.memberIds || params.includePlates ? hall() : empty;
      const result = run(doc, params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.data).toBeUndefined();
      expect(result.summary).toMatch(/^export_nc_files/);
    }
  });

  it('skips members with an unknown profile or zero length', () => {
    const doc = hall();
    const building = doc.building as NonNullable<CadDocument['building']>;
    const elements = Object.fromEntries(
      Object.entries(building.elements).map(([id, element]) => [
        id,
        element.category === 'member' ? { ...element, profile: 'NOPE' } : element,
      ]),
    );
    const broken = { ...doc, building: { ...building, elements } };
    expect(run(broken).data).toBeUndefined();
  });

  it('keeps every plate hole inside the plate contour', () => {
    const plates = files(hall()).filter((file) => file.kind === 'plate');
    expect(plates.length).toBeGreaterThan(0);
    for (const file of plates) {
      const [length, width] = [8, 9].map((i) => Number(stField(file, i)));
      const contour = block(file, 'AK');
      const maxX = Math.max(...contour.map((row) => Number(row[1])));
      const maxY = Math.max(...contour.map((row) => Number(row[2])));
      expect([maxX, maxY]).toEqual([length, width]);
      for (const [, x, y] of block(file, 'BO')) {
        expect(Number(x)).toBeGreaterThan(0);
        expect(Number(x)).toBeLessThan(maxX);
        expect(Number(y)).toBeGreaterThan(0);
        expect(Number(y)).toBeLessThan(maxY);
      }
    }
  });

  it('cuts rafters back to the end plates at eaves and apex', () => {
    const doc = hall();
    const elements = Object.values(doc.building?.elements ?? {});
    const rafter = elements.find(
      (e) => e.category === 'member' && e.role === 'rafter',
    ) as SteelMemberElement;
    const node = Math.hypot(
      rafter.end[0] - rafter.start[0],
      rafter.end[1] - rafter.start[1],
      rafter.end[2] - rafter.start[2],
    );
    const eaves = elements.find(
      (e) => e.category === 'connection' && e.kind === 'eaves' && e.rafterId === rafter.id,
    ) as MomentConnectionElement;
    const column = doc.building?.elements[eaves.otherId] as SteelMemberElement;
    const hcol = findProfile(column.profile)?.h ?? 0;
    const cos = Math.hypot(rafter.end[0] - rafter.start[0], rafter.end[1] - rafter.start[1]) / node;
    const eavesCut = (hcol / 2 + eaves.plateThickness) / cos;
    const apex = elements.find(
      (e) => e.category === 'connection' && e.kind === 'apex' && e.rafterId === rafter.id,
    ) as MomentConnectionElement | undefined;
    const apexCut = apex ? apex.plateThickness / cos : 0;
    const file = files(doc).find((f) => f.sourceIds.includes(rafter.id)) as NcFile;
    expect(file.length).toBeCloseTo(node - eavesCut - apexCut, 0);
    expect(Math.abs(file.length - (node - eavesCut - apexCut))).toBeLessThan(1);
  });
});
