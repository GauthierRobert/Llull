import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { BuildingElement, PipeElement } from '@core/model/building';
import { buildPlanDrawing } from '@aec/planDrawing';
import { outsideDiameterMm } from '@aec/industrial/pipeSizes';
import { buildingErrors } from '@aec/validate';
import type { IfcExport } from '@aec/ifcBuild';
import type { DxfExport } from '@aec/dxfExport';
interface ScheduleTable {
  columns: string[];
  rows: unknown[][];
}
import type { PlanSheet } from '@aec/sheet';

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

const ROUTE = [
  [0, 0, 3000],
  [6000, 0, 3000],
];

describe('add_pipe_run line-list data', () => {
  it('stores line, DN, from and to and takes the OD from the DN table', () => {
    const result = execute(createEmptyDocument(), 'add_pipe_run', {
      points: ROUTE,
      service: 'cooling water',
      line: ' L-101 ',
      dn: 100,
      from: 'EQ1',
      to: 'BL-1',
    });
    expect(result.summary).toMatch(/pipe PL1 \(pipe-1\) line L-101 DN100 Ø114\.3, 6\.00 m/);
    expect(result.summary).toMatch(/EQ1 → BL-1/);
    expect(element(result.document, 'pipe-1')).toMatchObject({
      line: 'L-101',
      dn: 100,
      from: 'EQ1',
      to: 'BL-1',
      diameter: 114.3,
    });
  });

  it.each([
    [15, 21.3],
    [25, 33.7],
    [50, 60.3],
    [150, 168.3],
    [400, 406.4],
  ])('DN%i has outside diameter %f mm', (dn, od) => {
    expect(outsideDiameterMm(dn)).toBe(od);
    const doc = run(createEmptyDocument(), 'add_pipe_run', { points: ROUTE, dn });
    expect((element(doc, 'pipe-1') as PipeElement).diameter).toBe(od);
  });

  it('converts the table OD to the document units and lets diameter override it', () => {
    const metric = { ...createEmptyDocument(), units: 'cm' as const };
    const converted = run(metric, 'add_pipe_run', {
      points: [
        [0, 0, 0],
        [100, 0, 0],
      ],
      dn: 100,
    });
    expect((element(converted, 'pipe-1') as PipeElement).diameter).toBeCloseTo(11.43, 5);
    const explicit = run(createEmptyDocument(), 'add_pipe_run', {
      points: ROUTE,
      dn: 100,
      diameter: 120,
    });
    expect(element(explicit, 'pipe-1')).toMatchObject({ diameter: 120, dn: 100 });
  });

  it('keeps an untabulated DN when an explicit diameter is given', () => {
    const doc = run(createEmptyDocument(), 'add_pipe_run', {
      points: ROUTE,
      dn: 90,
      diameter: 101.6,
    });
    expect(element(doc, 'pipe-1')).toMatchObject({ dn: 90, diameter: 101.6 });
  });

  it('is a graceful no-op for an unknown DN without diameter or an invalid DN', () => {
    const doc = createEmptyDocument();
    const unknown = execute(doc, 'add_pipe_run', { points: ROUTE, dn: 90 });
    expect(unknown.affected).toEqual([]);
    expect(unknown.document).toBe(doc);
    expect(unknown.summary).toMatch(/DN90 is not in the pipe size table.*explicit diameter/);
    for (const dn of [0, -50, 100.5]) {
      const result = execute(doc, 'add_pipe_run', { points: ROUTE, dn, diameter: 100 });
      expect(result.affected, String(dn)).toEqual([]);
      expect(result.summary).toMatch(/dn must be a positive integer/);
    }
  });

  it('prints a line list in the pipe schedule with Mark first', () => {
    let doc = run(createEmptyDocument(), 'add_pipe_run', {
      points: ROUTE,
      line: 'L-101',
      dn: 100,
      from: 'EQ1',
      to: 'EQ2',
    });
    doc = run(doc, 'add_pipe_run', { points: ROUTE, from: 'EQ3' });
    const table = execute(doc, 'building_schedule', { kind: 'pipe' }).data as ScheduleTable;
    const header = table.columns;
    expect(header[0]).toBe('Mark');
    expect(header).toEqual(expect.arrayContaining(['Line', 'DN', 'From', 'To']));
    const cell = (row: number, column: string): unknown =>
      table.rows[row]?.[header.indexOf(column)];
    expect(cell(0, 'Line')).toBe('L-101');
    expect(cell(0, 'DN')).toBe('DN100');
    expect(cell(0, 'From')).toBe('EQ1');
    expect(cell(0, 'To')).toBe('EQ2');
    expect(cell(1, 'Line')).toBe('');
    expect(cell(1, 'DN')).toBe('');
    expect(cell(1, 'From')).toBe('EQ3');
    expect(cell(1, 'To')).toBe('');
  });

  it('exports the line number in the IFC description and keeps the mark as name', () => {
    const doc = run(createEmptyDocument(), 'add_pipe_run', {
      points: ROUTE,
      service: 'steam',
      line: 'L-101',
    });
    const ifc = (execute(doc, 'export_ifc', {}).data as IfcExport).ifc;
    expect(ifc).toMatch(/IFCPIPESEGMENT\('[^']{22}',\$,'PL1','L-101 steam'/);
    const plain = run(createEmptyDocument(), 'add_pipe_run', { points: ROUTE, service: 'steam' });
    expect((execute(plain, 'export_ifc', {}).data as IfcExport).ifc).toMatch(
      /IFCPIPESEGMENT\('[^']{22}',\$,'PL1','steam'/,
    );
  });

  it('validates the optional fields of a loaded document', () => {
    const doc = run(createEmptyDocument(), 'add_pipe_run', {
      points: ROUTE,
      line: 'L-1',
      dn: 50,
      from: 'A',
      to: 'B',
    });
    const copy = JSON.parse(JSON.stringify(doc.building)) as {
      elements: Record<string, Record<string, unknown>>;
    };
    expect(buildingErrors(copy)).toEqual([]);
    const pipe = copy.elements['pipe-1'] as Record<string, unknown>;
    pipe['dn'] = 12.5;
    pipe['line'] = 7;
    expect(buildingErrors(copy).join('\n')).toMatch(/dn must be a positive integer/);
    expect(buildingErrors(copy).join('\n')).toMatch(/line must be a string/);
  });
});

function plant(): CadDocument {
  let doc = run(createEmptyDocument(), 'add_equipment', {
    name: 'Reactor',
    location: [4000, 3000],
    size: [2000, 2000, 5000],
    weight: 55000,
    clearance: 900,
    mark: 'R-101',
  });
  doc = run(doc, 'add_equipment', {
    name: 'Pump',
    location: [8000, 3000],
    size: [1000, 800, 900],
    weight: 450,
    mark: 'P-101',
  });
  return doc;
}

describe('IFC equipment property set', () => {
  it('relates a Pset_llullEquipment with weight and clearance to each equipment', () => {
    const ifc = (execute(plant(), 'export_ifc', {}).data as IfcExport).ifc;
    expect(ifc.match(/IFCPROPERTYSET\(/g)).toHaveLength(2);
    expect(ifc.match(/IFCRELDEFINESBYPROPERTIES\(/g)).toHaveLength(2);
    const record = (type: string): string[] =>
      ifc.split('\n').filter((line) => new RegExp(`^#\\d+=${type}\\(`).test(line));
    const proxy = record('IFCBUILDINGELEMENTPROXY').find((line) => line.includes("'equipment-1'"));
    const proxyRef = /^(#\d+)=/.exec(proxy ?? '')?.[1];
    expect(proxyRef).toBeDefined();
    expect(record('IFCRELDEFINESBYPROPERTIES').some((line) => line.includes(`(${proxyRef})`))).toBe(
      true,
    );
    expect(ifc).toContain("'Pset_llullEquipment'");
    expect(ifc).toContain(
      "IFCPROPERTYSINGLEVALUE('OperatingWeight','Operating weight in kg',IFCMASSMEASURE(55000.),$)",
    );
    expect(ifc).toContain(
      "IFCPROPERTYSINGLEVALUE('OperatingWeight','Operating weight in kg',IFCMASSMEASURE(450.),$)",
    );
    expect(ifc).toContain(
      "IFCPROPERTYSINGLEVALUE('MaintenanceClearance','Free space around the footprint, mm',IFCLENGTHMEASURE(900.),$)",
    );
  });

  it('derives GlobalIds from the element id (+ suffix), stable across revisions', () => {
    const guids = (doc: CadDocument): string[] =>
      (execute(doc, 'export_ifc', {}).data as IfcExport).ifc
        .split('\n')
        .filter((line) =>
          /^#\d+=IFC(BUILDINGELEMENTPROXY|PROPERTYSET|RELDEFINESBYPROPERTIES)\(/.test(line),
        )
        .map((line) => /\('([^']{22})'/.exec(line)?.[1] ?? '');
    const base = plant();
    const before = guids(base);
    expect(before).toHaveLength(6);
    expect(new Set(before).size).toBe(6);
    const revised = run(base, 'update_equipment', { currentMark: 'R-101', weight: 61000 });
    expect(guids(revised)).toEqual(before);
    const added = run(revised, 'add_equipment', {
      name: 'Extra',
      location: [0, 0],
      size: [1, 1, 1],
    });
    expect(guids(added).slice(0, 6)).toEqual(before);
  });
});

describe('update_equipment', () => {
  it('edits by element id keeping the id, mark and position in order', () => {
    const doc = plant();
    const snapshot = JSON.stringify(doc);
    const result = execute(doc, 'update_equipment', {
      elementId: 'equipment-1',
      name: 'Reactor v2',
      location: [4500, 3000],
      size: [2200, 2000, 5500],
      angle: 0.5,
      clearance: 1000,
      weight: 61000,
    });
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(result.affected[0]).toBe('equipment-1');
    expect(result.affected).toContain('equipment-1:body');
    expect(result.summary).toMatch(/Updated equipment R-101 "Reactor v2" \(equipment-1\)/);
    expect(element(result.document, 'equipment-1')).toMatchObject({
      name: 'Reactor v2',
      mark: 'R-101',
      location: [4500, 3000],
      size: [2200, 2000, 5500],
      angle: 0.5,
      clearance: 1000,
      weight: 61000,
    });
    expect(result.document.building?.elementOrder).toEqual(doc.building?.elementOrder);
    expect(result.document.entities['equipment-1:body']).toMatchObject({
      position: [4500, 3000, 2750],
    });
  });

  it('edits by current tag, renames the tag and moves level', () => {
    let doc = run(plant(), 'add_level', { name: 'Mezzanine' });
    const level = doc.building?.levelOrder[1] as string;
    doc = run(doc, 'update_equipment', { currentMark: 'P-101', mark: 'P-201', levelId: level });
    expect(element(doc, 'equipment-2')).toMatchObject({ mark: 'P-201', levelId: level });
    const noChange = run(doc, 'update_equipment', { elementId: 'equipment-2', mark: 'P-201' });
    expect(element(noChange, 'equipment-2').mark).toBe('P-201');
  });

  it('is a graceful no-op for bad targets and values', () => {
    const doc = run(run(plant(), 'add_pipe_run', { points: ROUTE }), 'add_equipment', {
      name: 'Twin',
      location: [0, 0],
      size: [1, 1, 1],
      mark: 'DUP',
    });
    const twin = run(doc, 'add_equipment', {
      name: 'Twin2',
      location: [0, 5],
      size: [1, 1, 1],
      mark: 'DUP',
    });
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /give elementId or currentMark/],
      [{ elementId: 'nope' }, /no element 'nope'/],
      [{ elementId: 'pipe-1', name: 'x' }, /is a pipe, not equipment/],
      [{ currentMark: 'NOPE' }, /no equipment tagged 'NOPE'/],
      [{ elementId: 'equipment-1', size: [1, 0, 1] }, /size must be/],
      [{ elementId: 'equipment-1', size: [1, 1] }, /rejected: invalid params/],
      [{ elementId: 'equipment-1', location: [1] }, /rejected: invalid params/],
      [{ elementId: 'equipment-1', clearance: -1 }, /clearance >= 0/],
      [{ elementId: 'equipment-1', weight: -1 }, /weight >= 0/],
      [{ elementId: 'equipment-1', name: '  ' }, /cannot be empty/],
      [{ elementId: 'equipment-1', mark: ' ' }, /cannot be empty/],
      [{ elementId: 'equipment-1', mark: 'P-101' }, /already used by equipment-2/],
      [{ elementId: 'equipment-1', levelId: 'nope' }, /unknown level 'nope'/],
    ];
    for (const [params, message] of cases) {
      const result = execute(twin, 'update_equipment', params);
      expect(result.affected, JSON.stringify(params)).toEqual([]);
      expect(result.document).toBe(twin);
      expect(result.summary).toMatch(message);
    }
    const ambiguous = execute(twin, 'update_equipment', { currentMark: 'DUP' });
    expect(ambiguous.summary).toMatch(/ambiguous/);
  });
});

function tower(): CadDocument {
  let doc = createEmptyDocument();
  for (const name of ['GF', 'F1', 'F2']) doc = run(doc, 'add_level', { name, height: 6000 });
  doc = run(doc, 'add_steel_member', {
    profile: 'HEB300',
    role: 'column',
    start: [1000, 2000, 0],
    end: [1000, 2000, 18000],
    levelId: doc.building?.levelOrder[0],
  });
  doc = run(doc, 'add_steel_member', {
    profile: 'HEB300',
    role: 'column',
    start: [5000, 2000, 0],
    end: [5000, 2000, 6000],
    levelId: doc.building?.levelOrder[0],
  });
  doc = run(doc, 'add_steel_member', {
    profile: 'HEB300',
    role: 'beam',
    start: [0, 0, 0],
    end: [6000, 0, 0],
    levelId: doc.building?.levelOrder[0],
  });
  doc = run(doc, 'add_column', {
    location: [8000, 2000],
    width: 400,
    height: 14000,
    levelId: doc.building?.levelOrder[0],
  });
  return doc;
}

const near = (point: readonly number[] | undefined, x: number): boolean =>
  point !== undefined && Math.abs((point[0] as number) - x) < 400;

describe('columns on upper-floor plans', () => {
  const doc = tower();
  const [ground, first, second] = doc.building?.levelOrder as [string, string, string];
  const columnsAt = (levelId: string): number[] =>
    buildPlanDrawing(doc, levelId)!
      .primitives.filter((p) => p.layer === 'S-COLS' && p.type === 'polygon' && p.style === 'cut')
      .map((p) => (p.type === 'polygon' ? (p.points[0]?.[0] as number) : 0))
      .sort((a, b) => a - b);

  it('draws a continuous steel column on every level plan its extent crosses', () => {
    const [x0, x1, x2] = [first, second, ground].map(columnsAt);
    expect(x2?.some((x) => near([x], 1000))).toBe(true);
    expect(x0?.some((x) => near([x], 1000))).toBe(true);
    expect(x1?.some((x) => near([x], 1000))).toBe(true);
  });

  it('omits columns that end below the cut and beams of other levels', () => {
    expect(columnsAt(ground).filter((x) => near([x], 5000))).toHaveLength(1);
    expect(columnsAt(first).filter((x) => near([x], 5000))).toHaveLength(0);
    expect(buildPlanDrawing(doc, second)!.primitives.some((p) => p.type === 'line')).toBe(false);
  });

  it('draws a tall concrete column on upper levels only while it crosses the cut', () => {
    const concrete = (levelId: string): boolean =>
      buildPlanDrawing(doc, levelId)!.primitives.some(
        (p) => p.layer === 'S-COLS' && p.type === 'polygon' && p.fill === 'hatch',
      );
    expect(concrete(ground)).toBe(true);
    expect(concrete(first)).toBe(true);
    expect(concrete(second)).toBe(true);
    const short = run(createEmptyDocument(), 'add_level', { height: 3000 });
    const twoLevel = run(
      run(short, 'add_column', { location: [0, 0], width: 300 }),
      'add_level',
      {},
    );
    const upper = twoLevel.building?.levelOrder[1] as string;
    expect(buildPlanDrawing(twoLevel, upper)!.primitives.some((p) => p.layer === 'S-COLS')).toBe(
      false,
    );
  });

  it('shows them in export_dxf and export_plan_sheet of the upper level', () => {
    const dxf = (execute(doc, 'export_dxf', { levelId: second }).data as DxfExport).dxf;
    expect(dxf).toContain('S-COLS');
    const sheet = (execute(doc, 'export_plan_sheet', { levelId: second }).data as PlanSheet).svg;
    expect(sheet).toContain('class="cut"');
    const base = (execute(doc, 'export_dxf', { levelId: ground }).data as DxfExport).dxf;
    expect(base.length).toBeGreaterThan(dxf.length);
  });

  it('ignores a column whose home level is unknown', () => {
    const broken = structuredClone(doc);
    const member = Object.values(broken.building!.elements).find(
      (e) => e.category === 'member' && e.role === 'column',
    )!;
    (member as { levelId: string }).levelId = 'ghost';
    expect(() => buildPlanDrawing(broken, first)).not.toThrow();
  });
});
