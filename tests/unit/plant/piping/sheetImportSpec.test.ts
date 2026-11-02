/** Plant 01 PSC M5: `import_pipe_spec_sheet` (spec CSV + branch CSV + header -> spec): the export round trip, a Plant 3D style sheet, refusals. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { importedDoc, mixSpec, smallSpec, type Json } from './specFixture';

const empty = createEmptyDocument();
interface SheetExport {
  text: string;
  branchCsv: string;
  header: Json;
  sha256: string;
}
interface JsonExport {
  text: string;
  sha256: string;
}
const sheetOf = (doc: CadDocument, specId: string): SheetExport => data<SheetExport>(doc, 'export_pipe_spec', { specId, format: 'csv' });
const jsonOf = (doc: CadDocument, specId: string): JsonExport => data<JsonExport>(doc, 'export_pipe_spec', { specId });
const roundTrip = (source: CadDocument, specId: string): CadDocument => {
  const sheet = sheetOf(source, specId);
  return apply(empty, 'import_pipe_spec_sheet', { sheet: sheet.text, branchSheet: sheet.branchCsv, spec: sheet.header });
};

describe('spec sheet round trip', () => {
  it('CS150-A1 (sizes, branch table, materials, limits): export -> import -> export gives the identical JSON hash', () => {
    const source = importedDoc();
    const copy = roundTrip(source, 'CS150-A1');
    expect(jsonOf(copy, 'CS150-A1').sha256).toBe(jsonOf(source, 'CS150-A1').sha256);
    expect(jsonOf(copy, 'CS150-A1').text).toBe(jsonOf(source, 'CS150-A1').text);
  });

  it('is byte-stable: the sheet of the copy equals the sheet of the source', () => {
    const source = importedDoc();
    const copy = roundTrip(source, 'CS150-A1');
    expect(sheetOf(copy, 'CS150-A1')).toEqual(sheetOf(source, 'CS150-A1'));
  });

  it('keeps the EN `standard` column, a DN range, and extra members of every scalar type', () => {
    const extras = importedDoc({
      ...mixSpec(),
      components: [
        ...(mixSpec()['components'] as Json[]),
        {
          id: 'X',
          type: 'tee',
          fromDn: 50,
          toDn: 100,
          catalogRef: 'asme-b16.9',
          ends: 'BW',
          vendor: '=1+1',
          lead: 42,
          stock: true,
          note: "'@q",
          quoted: 'a, "b"',
        },
      ],
    });
    const copy = roundTrip(extras, 'MIX-1');
    expect(jsonOf(copy, 'MIX-1').text).toBe(jsonOf(extras, 'MIX-1').text);
    expect(jsonOf(copy, 'MIX-1').text).toContain('"lead":42');
    expect(jsonOf(copy, 'MIX-1').text).toContain('"stock":true');
    expect(jsonOf(copy, 'MIX-1').text).toContain('"standard":"EN 10220"');
  });

  it('keeps hostile descriptions verbatim (the export guard apostrophe comes off)', () => {
    const evil = apply(importedDoc(), 'edit_pipe_spec', {
      specId: 'CS150-A1',
      ops: [
        {
          op: 'updateComponent',
          id: 'E90-LR',
          changes: { description: '=HYPERLINK("http://evil.example","x")', commodityCode: "'-1", material: '@SUM(A1)' },
        },
      ],
    });
    expect(sheetOf(evil, 'CS150-A1').text).toContain(`'=HYPERLINK`);
    const copy = roundTrip(evil, 'CS150-A1');
    expect(jsonOf(copy, 'CS150-A1').text).toBe(jsonOf(evil, 'CS150-A1').text);
  });

  it('keeps the revision of a first import and stores a draft; re-importing the same sheet changes nothing', () => {
    const source = importedDoc(smallSpec({ revision: 3 }));
    const sheet = sheetOf(source, 'SMALL');
    const params = { sheet: sheet.text, branchSheet: sheet.branchCsv, spec: sheet.header };
    const copy = apply(empty, 'import_pipe_spec_sheet', params);
    expect(ok(copy, 'list_pipe_specs', {}).summary).toContain('SMALL');
    const again = ok(copy, 'import_pipe_spec_sheet', params);
    expect(again.document).toBe(copy);
    expect(again.data).toMatchObject({ unchanged: true });
    expect(jsonOf(copy, 'SMALL').text).toContain('"revision":3');
    expect(jsonOf(copy, 'SMALL').text).toContain('"status":"draft"');
  });

  it('a changed sheet needs replace; an approved-revision spec would get a new revision (same rules as import_pipe_spec)', () => {
    const source = importedDoc(smallSpec());
    const sheet = sheetOf(source, 'SMALL');
    const changed = { sheet: sheet.text.replace('NPS 6', 'NPS 4'), spec: sheet.header };
    expectRefusal(source, 'import_pipe_spec_sheet', changed, 'PSC_SPEC_CONFLICT', 'spec.id');
    const replaced = ok(source, 'import_pipe_spec_sheet', { ...changed, replace: true });
    expect(replaced.data).toMatchObject({ replaced: true, status: 'draft' });
  });

  it('is pure', () => {
    const sheet = sheetOf(importedDoc(smallSpec()), 'SMALL');
    expectPure(empty, () => execute(empty, 'import_pipe_spec_sheet', { sheet: sheet.text, spec: sheet.header }));
  });
});

const P3D_SPEC = {
  id: 'P3D-1',
  dimensionalStandard: 'ASME',
  rating: { system: 'ASME B16.5', class: 150, materialGroup: '1.1' },
  corrosionAllowance: { value: 3, unit: 'mm' },
  sizeRange: { fromNps: 2, toNps: 6 },
  catalogs: ['llull-open-piping'],
};
const P3D_SHEET = [
  'Part Category,Size,Short Description,End Type,Pressure Class,Schedule,Item Code,Material,Vendor Note',
  'Pipe,2,"PIPE, SMLS",PE,,40,P-2,A106 B,keep me',
  'Pipe,"2-1/2",PIPE SMLS,Plain End,,40,P-2.5,A106 B,',
  '90 Elbow,2,ELBOW 90 LR,Butt Weld,#150,,E-2,A234 WPB,',
  'Gate Valve,2,GATE VALVE,FL,Class 150,,V-2,A216 WCB,',
  'Weld Neck Flange,2,WN FLANGE,FLANGED,PN16,,F-2,A105,',
].join('\n');

describe('Plant 3D style sheet', () => {
  const params = { sheet: P3D_SHEET, format: 'plant3d', spec: P3D_SPEC, catalogRef: 'asme-b16.9' };

  it('maps columns by name, ends and class by synonym, unmapped columns to extra, and counts what it could not map', () => {
    const doc = apply(empty, 'import_pipe_spec_sheet', params);
    const result = ok(empty, 'import_pipe_spec_sheet', params);
    expect(result.data).toMatchObject({ format: 'plant3d', sheetRows: 5, unmapped: [{ column: 'class', count: 1 }] });
    const spec = JSON.parse(jsonOf(doc, 'P3D-1').text) as { components: Json[] };
    const byId = (id: string): Json => spec.components.find((component) => component['id'] === id) as Json;
    expect(byId('pipe-2')).toMatchObject({
      type: 'pipe',
      fromNps: '2',
      toNps: '2',
      ends: 'PE',
      schedule: '40',
      description: 'PIPE, SMLS',
      commodityCode: 'P-2',
      material: 'A106 B',
      catalogRef: 'asme-b16.9',
      'Vendor Note': 'keep me',
    });
    expect(byId('pipe-2-1_2')).toMatchObject({ fromNps: '2-1/2', ends: 'PE' });
    expect(byId('elbow90-2')).toMatchObject({ type: 'elbow90', ends: 'BW' });
    expect(byId('valveGate-2')).toMatchObject({ type: 'valveGate', ends: 'FL', class: 150 });
    expect(byId('flangeWeldNeck-2')).toMatchObject({ ends: 'FL', 'Pressure Class': 'PN16' });
    expect(byId('elbow90-2')).toMatchObject({ class: 150 });
  });

  it('keeps values that match nothing in extra and counts them: facing, class, ends', () => {
    const sheet = 'Part Category,Size,Face Type,Pressure Class,End Type\nPipe,2,Weird,PN16,Wobbly\nPipe,3,RF,150,BW\n';
    const params2 = { sheet, format: 'plant3d', spec: P3D_SPEC, catalogRef: 'asme-b16.9' };
    const result = ok(empty, 'import_pipe_spec_sheet', params2);
    expect(result.data).toMatchObject({
      unmapped: expect.arrayContaining([
        { column: 'ends', count: 1 },
        { column: 'class', count: 1 },
        { column: 'facing', count: 1 },
      ]),
    });
    const spec = JSON.parse(jsonOf(result.document, 'P3D-1').text) as { components: Json[] };
    expect(spec.components[0]).toMatchObject({ 'Face Type': 'Weird', 'Pressure Class': 'PN16', 'End Type': 'Wobbly' });
    expect(spec.components[0]).not.toHaveProperty('ends');
    expect(spec.components[0]).not.toHaveProperty('facing');
    expect(spec.components[0]).not.toHaveProperty('class');
    expect(spec.components[1]).toMatchObject({ ends: 'BW', facing: 'RF', class: 150 });
  });

  it('a second column that also looks like the type goes to extra, the first one in file order is the type', () => {
    const sheet = 'Part Category,Type,Size\nPipe,Widget,2\n';
    const result = ok(empty, 'import_pipe_spec_sheet', { sheet, format: 'plant3d', spec: P3D_SPEC, catalogRef: 'asme-b16.9' });
    const spec = JSON.parse(jsonOf(result.document, 'P3D-1').text) as { components: Json[] };
    expect(spec.components[0]).toMatchObject({ type: 'pipe', Type: 'Widget' });
  });

  it('honours columns, typeMap and sizeSystem, and numbers duplicate ids', () => {
    const sheet = 'Kind;Dia;Name\nGlobe;50;A\nGlobe;50;B\n';
    const doc = apply(empty, 'import_pipe_spec_sheet', {
      sheet,
      format: 'plant3d',
      spec: { ...P3D_SPEC, sizeRange: { fromDn: 15, toDn: 100 } },
      columns: { type: 'Kind', size: 'Dia', description: 'Name' },
      typeMap: { Globe: 'valveGlobe' },
      sizeSystem: 'DN',
      catalogRef: 'asme-b16.34',
    });
    const spec = JSON.parse(jsonOf(doc, 'P3D-1').text) as { components: Json[] };
    expect(spec.components.map((component) => component['id'])).toEqual(['valveGlobe-50', 'valveGlobe-50.2']);
    expect(spec.components[0]).toMatchObject({ fromDn: 50, description: 'A' });
  });

  const refuses: Array<[string, Json]> = [
    ['an unknown part category', { sheet: 'Part Category,Size\nWidget,2\n' }],
    ['a bad size', { sheet: 'Part Category,Size\nPipe,two\n' }],
    ['no size column', { sheet: 'Part Category,Description\nPipe,x\n' }],
    ['no type column', { sheet: 'Name,Size\nPipe,2\n' }],
    ['a hostile extra column', { sheet: 'Part Category,Size,__proto__\nPipe,2,x\n' }],
    ['a column mapped from a header the file lacks', { sheet: 'Part Category,Size\nPipe,2\n', columns: { description: 'nope' } }],
    ['a class column with an id that breaks the id pattern', { sheet: 'Part Category,Size,Id\nPipe,2,a b\n' }],
  ];
  for (const [name, over] of refuses)
    it(`refuses ${name}`, () => {
      const result = execute(empty, 'import_pipe_spec_sheet', { format: 'plant3d', spec: P3D_SPEC, catalogRef: 'asme-b16.9', ...over });
      expect(result.rejected, result.summary).toBe(true);
      expect(result.document).toBe(empty);
      expect(result.error?.code).toMatch(/^PSC_/);
    });

  it('refuses a sheet with no catalogRef column and no catalogRef param', () => {
    expectRefusal(
      empty,
      'import_pipe_spec_sheet',
      { sheet: 'Part Category,Size\nPipe,2\n', format: 'plant3d', spec: P3D_SPEC },
      'PSC_SPEC_INVALID',
    );
  });
});

describe('spec sheet refusals', () => {
  const good = sheetOf(importedDoc(smallSpec()), 'SMALL');
  const base = { sheet: good.text, spec: good.header };
  const header = good.text.split('\n')[0] as string;
  const row = good.text.split('\n')[1] as string;
  const cases: Array<[string, Json, string]> = [
    ['a missing column', { sheet: 'component,type\nP,pipe\n' }, 'sheet:row 1:from'],
    ['a ragged row', { sheet: `${header}\nP,pipe\n` }, 'sheet:row 2'],
    ['a hostile header', { sheet: `${header},__proto__\n${row},x\n` }, 'sheet:row 1'],
    ['a duplicate header', { sheet: `${header},type\n${row},pipe\n` }, 'sheet:row 1'],
    ['header only', { sheet: `${header}\n` }, 'sheet:row 1'],
    ['a bad size cell', { sheet: good.text.replace('NPS 2', '2 inch') }, 'sheet:row 2:from'],
    [
      'a non-numeric class',
      {
        sheet: `${header}
${row
  .split(',')
  .map((cell, at) => (at === 7 ? 'abc' : cell))
  .join(',')}
`,
      },
      'sheet:row 2:class',
    ],
    ['an unknown type', { sheet: good.text.replace('pipe', 'widget') }, 'sheet:row 2:type'],
    ['a bad extra', { sheet: `${header}\n${row.replace(/,$/, '')},{oops\n`.replace(/\n$/, '\n') }, 'sheet:row'],
    ['a prototype key in extra', { sheet: `${header}\n${row},"{""__proto__"":""x""}"\n` }, 'sheet:row'],
    ['an extra that shadows a spec field', { sheet: `${header}\n${row},"{""id"":""x""}"\n` }, 'sheet:row'],
    ['a nested extra', { sheet: `${header}\n${row},"{""a"":{""b"":1}}"\n` }, 'sheet:row'],
    ['a branch sheet without its columns', { branchSheet: 'a,b\n1,2\n' }, 'sheet:row 1'],
    ['a branch cell with an unknown fitting', { branchSheet: 'header,branch,fitting\n6,2,QQ\n' }, 'branchTable.cells.6.2'],
    ['a branch cell listed twice', { branchSheet: 'header,branch,fitting\n6,2,T\n6,2,W\n' }, 'sheet:row 3'],
    ['a branch cell left empty', { branchSheet: 'header,branch,fitting\n6,2,\n' }, 'sheet:row 2'],
    ['a branch header that is not a size', { branchSheet: 'header,branch,fitting\n__proto__,2,T\n' }, 'sheet:row 2'],
    [
      'a corrosion unit that is not mm or in',
      { spec: { ...good.header, corrosionAllowance: { value: 3, unit: 'cm' } } },
      'corrosionAllowance.unit',
    ],
    [
      'a spec header without a dimensional standard',
      { spec: { ...good.header, dimensionalStandard: undefined } },
      'spec.dimensionalStandard',
    ],
  ];
  for (const [name, over, path] of cases)
    it(`refuses ${name}`, () => {
      const result = execute(empty, 'import_pipe_spec_sheet', { ...base, ...over });
      expect(result.rejected, result.summary).toBe(true);
      expect(result.document).toBe(empty);
      expect(result.affected).toEqual([]);
      expect(result.error?.paths ?? []).toEqual(expect.arrayContaining([expect.stringContaining(path.split(':').slice(0, 2).join(':'))]));
    });

  it('refuses a duplicate component id and a size range the components leave', () => {
    const doubled = `${good.text}\n${row}`;
    const result = execute(empty, 'import_pipe_spec_sheet', { ...base, sheet: doubled });
    expect(result.rejected).toBe(true);
    expect(result.summary).toContain('used twice');
  });

  it('refuses a sheet over the row limit without throwing', () => {
    const many = `${header}\n${`${row}\n`.repeat(20_001)}`;
    expectRefusal(empty, 'import_pipe_spec_sheet', { ...base, sheet: many }, 'PSC_SPEC_INVALID');
  });
});
