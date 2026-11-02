/** Plant 01 PSC M5: `import_piping_catalog_sheet` (CSV sheet -> catalogue) and the round trip of `export_piping_catalog format csv`. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { guardCell, unguardCell } from '@aec/plant/catalog/csvGuard';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';

const empty = createEmptyDocument();
interface Exported {
  text: string;
  sha256: string;
}
const SOURCE = { citation: 'unit test sheet' };

const catalogFile = {
  format: 'llull-piping-catalog',
  schemaVersion: 1,
  id: 'src',
  version: '2.1',
  title: 'Round trip',
  licence: 'company-proprietary',
  families: [
    {
      id: 'lr90',
      type: 'elbow90',
      radius: 'LR',
      standard: 'ASME B16.9',
      dimensionalStandard: 'ASME',
      ends: ['BW'],
      unit: 'mm',
      sizes: [
        { nps: 4, outsideDiameter: 114.3, centreToEnd: 152.4, provenance: { sourceId: 'S1', citation: 'b, "quoted"' }, verified: true },
        { nps: 6, outsideDiameter: 168.3, centreToEnd: 228.6, provenance: { sourceId: 'S1', citation: 'b, "quoted"' } },
      ],
    },
    {
      id: 'wn',
      type: 'flangeWeldNeck',
      standard: 'ASME B16.5',
      ends: ['FL'],
      unit: 'mm',
      sizes: [
        { nps: 2, class: 150, facing: 'RF', outsideDiameter: 152.4, boltCount: 4, provenance: { citation: 'unit test' }, verified: true },
      ],
    },
  ],
};

const withSource = apply(empty, 'import_piping_catalog', { catalog: catalogFile });
const exportCsv = (doc = withSource, catalogId = 'src'): string =>
  data<Exported>(doc, 'export_piping_catalog', { catalogId, format: 'csv' }).text;
const exportJson = (doc: typeof withSource, catalogId: string): Exported =>
  data<Exported>(doc, 'export_piping_catalog', { catalogId, format: 'json' });
const importSheet = (sheet: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sheet,
  catalogId: 'copy',
  licence: 'company-proprietary',
  version: '2.1',
  title: 'Round trip',
  ...over,
});

describe('the formula guard is reversible', () => {
  it('unguard(guard(text)) === text for formula-like, apostrophe-led and plain texts', () => {
    for (const text of ['=1+1', "'=x", "''@y", '+3', '-3', '\tx', 'plain', "'plain", '', "it's"])
      expect(unguardCell(guardCell(text) as string)).toBe(text);
    expect(guardCell("'=x")).toBe("''=x");
    expect(unguardCell("'plain")).toBe("'plain");
  });
});

describe('catalogue CSV round trip', () => {
  it('export -> import (same provenance) -> export gives the identical JSON hash and the identical CSV bytes', () => {
    const csv = exportCsv();
    const imported = apply(empty, 'import_piping_catalog_sheet', importSheet(csv, { provenance: SOURCE }));
    // the sheet carries the row provenance, so the sheet-level one is never used
    const again = exportCsv(imported, 'copy');
    expect(again).toBe(csv);
    const a = exportJson(withSource, 'src').text.replace('"id":"src"', '"id":"copy"');
    expect(exportJson(imported, 'copy').text).toBe(a);
  });

  it('keeps unverified rows unverified and verified rows verified, in mm, and a mixed row becomes unverified (never more trusted)', () => {
    const mixed = apply(empty, 'import_piping_catalog', {
      catalog: {
        ...catalogFile,
        id: 'mixed',
        families: [
          {
            id: 'f',
            type: 'elbow90',
            radius: 'LR',
            standard: 'ASME B16.9',
            sizes: [{ nps: 4, outsideDiameter: 114.3, centreToEnd: 152.4, provenance: SOURCE, verifiedDims: ['outsideDiameter'] }],
          },
        ],
      },
    });
    const copy = apply(empty, 'import_piping_catalog_sheet', importSheet(exportCsv(mixed, 'mixed')));
    expect(exportJson(copy, 'copy').text).not.toContain('"verified":true');
    expect(exportJson(copy, 'copy').text).not.toContain('verifiedDims');
  });

  it('round trips the bundled B16.9 family: every value and verified flag survives (the sheet takes the first dimension provenance)', () => {
    const csv = data<Exported>(empty, 'export_piping_catalog', {
      catalogId: 'llull-open-piping',
      familyId: 'asme-b16.9-lr90',
      format: 'csv',
    }).text;
    const imported = apply(empty, 'import_piping_catalog_sheet', importSheet(csv, { catalogId: 'b169' }));
    const csvAgain = data<Exported>(imported, 'export_piping_catalog', { catalogId: 'b169', format: 'csv' }).text;
    expect(csvAgain).toBe(csv);
  });

  it('is byte-deterministic: the same sheet imported twice stores the same catalogue, and a re-import is a no-op', () => {
    const csv = exportCsv();
    const once = apply(empty, 'import_piping_catalog_sheet', importSheet(csv));
    const twice = ok(once, 'import_piping_catalog_sheet', importSheet(csv));
    expect(twice.document).toBe(once);
    expect(twice.data).toMatchObject({ unchanged: true });
    expect(exportJson(once, 'copy').sha256).toBe(exportJson(apply(empty, 'import_piping_catalog_sheet', importSheet(csv)), 'copy').sha256);
  });

  it('reads inches when asked, scaling lengths and not counts', () => {
    const sheet = 'family,type,standard,size,outsideDiameter,boltCount\nf,flangeWeldNeck,ASME B16.5,NPS 2,6,4\n';
    const doc = apply(empty, 'import_piping_catalog_sheet', importSheet(sheet, { unit: 'in', provenance: SOURCE }));
    const size = JSON.parse(exportJson(doc, 'copy').text).families[0].sizes[0];
    expect(size.outsideDiameter).toBe(152.4);
    expect(size.boltCount).toBe(4);
  });

  it('maps another tool columns, reads semicolons and a byte-order mark', () => {
    const sheet = '﻿Part Family;Kind;Std;Nominal Size;OD\r\nf;pipe;ASME B36.10M;NPS 2;60.3\r\n';
    const columns = { family: 'Part Family', type: 'Kind', standard: 'Std', size: 'Nominal Size', outsideDiameter: 'OD' };
    const doc = apply(empty, 'import_piping_catalog_sheet', importSheet(sheet, { columns, provenance: SOURCE }));
    expect(ok(doc, 'list_piping_catalogs', {}).summary).toContain('copy');
  });

  it('a dimension named like a fixed column travels as dim.<name>', () => {
    const odd = apply(empty, 'import_piping_catalog', {
      catalog: {
        ...catalogFile,
        id: 'odd',
        families: [
          { id: 'f', type: 'pipe', standard: 'ASME B36.10M', sizes: [{ nps: 2, ends: 5, outsideDiameter: 60.3, provenance: SOURCE }] },
        ],
      },
    });
    const csv = exportCsv(odd, 'odd');
    expect(csv.split('\n')[0]).toContain('dim.ends');
    const back = apply(empty, 'import_piping_catalog_sheet', importSheet(csv, { catalogId: 'odd2' }));
    expect(exportCsv(back, 'odd2')).toBe(csv);
  });
});

describe('catalogue sheet refusals', () => {
  const cases: Array<[string, string, Record<string, unknown>, string, string]> = [
    [
      'no provenance anywhere',
      'family,type,standard,size,outsideDiameter\nf,pipe,ASME B36.10M,NPS 2,60.3\n',
      {},
      'PSC_PROVENANCE_MISSING',
      'families.0.sizes.0.outsideDiameter',
    ],
    [
      'negative dimension',
      'family,type,standard,size,outsideDiameter\nf,pipe,ASME B36.10M,NPS 2,-60.3\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'families.0.sizes.0.outsideDiameter',
    ],
    [
      'non-numeric dimension names its cell',
      'family,type,standard,size,outsideDiameter\nf,pipe,ASME B36.10M,NPS 2,=1+1\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'sheet:row 2:outsideDiameter',
    ],
    [
      'bad size',
      'family,type,standard,size,outsideDiameter\nf,pipe,ASME B36.10M,two,60.3\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'sheet:row 2:size',
    ],
    [
      'unknown type',
      'family,type,standard,size,outsideDiameter\nf,widget,ASME B36.10M,NPS 2,60.3\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'families.0.type',
    ],
    [
      'a family whose rows disagree',
      'family,type,standard,size,outsideDiameter\nf,pipe,ASME B36.10M,NPS 2,60.3\nf,pipe,OTHER,NPS 3,88.9\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'sheet:row 3:standard',
    ],
    [
      'bad facing',
      'family,type,standard,size,facing,outsideDiameter\nf,flangeWeldNeck,ASME B16.5,NPS 2,XX,60.3\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'sheet:row 2:facing',
    ],
    [
      'non-numeric class',
      'family,type,standard,size,class,outsideDiameter\nf,flangeWeldNeck,ASME B16.5,NPS 2,abc,60.3\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'sheet:row 2:class',
    ],
    [
      'bad smallSize',
      'family,type,standard,size,smallSize,outsideDiameter\nf,reducerConcentric,ASME B16.9,NPS 2,small,60.3\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'sheet:row 2:smallSize',
    ],
    [
      'bad verified cell',
      'family,type,standard,size,outsideDiameter,verified\nf,pipe,ASME B36.10M,NPS 2,60.3,maybe\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'sheet:row 2:verified',
    ],
    [
      'a dimension column that is not a name',
      'family,type,standard,size,outside diameter\nf,pipe,ASME B36.10M,NPS 2,60.3\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'sheet:row 1:outside diameter',
    ],
    [
      'bad end type',
      'family,type,standard,size,ends,outsideDiameter\nf,pipe,ASME B36.10M,NPS 2,ZZ,60.3\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'sheet:row 2:ends',
    ],
    ['missing column', 'family,type,size\nf,pipe,NPS 2\n', { provenance: SOURCE }, 'PSC_CATALOG_INVALID', 'sheet:row 1:standard'],
    ['ragged row', 'family,type,standard,size\nf,pipe,ASME B36.10M\n', { provenance: SOURCE }, 'PSC_CATALOG_INVALID', 'sheet:row 2'],
    [
      'hostile header',
      'family,type,standard,size,__proto__\nf,pipe,ASME B36.10M,NPS 2,1\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'sheet:row 1',
    ],
    [
      'duplicate header',
      'family,type,standard,size,size\nf,pipe,ASME B36.10M,NPS 2,NPS 3\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'sheet:row 1',
    ],
    ['header only', 'family,type,standard,size\n', { provenance: SOURCE }, 'PSC_CATALOG_INVALID', 'sheet:row 1'],
    [
      'unterminated quote',
      'family,type,standard,size\n"f,pipe,ASME B36.10M,NPS 2\n',
      { provenance: SOURCE },
      'PSC_CATALOG_INVALID',
      'sheet:row 2',
    ],
    [
      'a column mapped from a header the file lacks',
      'family,type,standard,size\nf,pipe,ASME B36.10M,NPS 2\n',
      { columns: { family: 'nope' } },
      'PSC_CATALOG_INVALID',
      'columns',
    ],
    [
      'a prototype key in columns',
      'family,type,standard,size\nf,pipe,ASME B36.10M,NPS 2\n',
      JSON.parse('{"columns":{"__proto__":"family"}}') as Record<string, unknown>,
      'PSC_CATALOG_INVALID',
      'columns',
    ],
    [
      'a licence that cannot be embedded',
      'family,type,standard,size,outsideDiameter\nf,pipe,ASME B36.10M,NPS 2,60.3\n',
      { provenance: SOURCE, licence: 'licensed-no-redistribution' },
      'PSC_LICENCE_EMBED_FORBIDDEN',
      'licence',
    ],
    [
      'a unit that is not mm or in',
      'family,type,standard,size,outsideDiameter\nf,pipe,ASME B36.10M,NPS 2,60.3\n',
      { provenance: SOURCE, unit: 'cm' },
      'PSC_UNIT_INVALID',
      'families.0.unit',
    ],
    [
      'the reserved bundled id',
      'family,type,standard,size,outsideDiameter\nf,pipe,ASME B36.10M,NPS 2,60.3\n',
      { provenance: SOURCE, catalogId: 'llull-open-piping' },
      'PSC_CATALOG_CONFLICT',
      'id',
    ],
  ];
  for (const [name, sheet, over, code, path] of cases)
    it(`refuses ${name}`, () => {
      const result = expectRefusal(empty, 'import_piping_catalog_sheet', importSheet(sheet, over), code, path);
      expect(result.summary).toContain('import_piping_catalog_sheet');
    });

  it('names the sheet row of a file-parser issue', () => {
    const result = execute(
      empty,
      'import_piping_catalog_sheet',
      importSheet('family,type,standard,size,outsideDiameter\nf,pipe,ASME B36.10M,NPS 2,60.3\n'),
    );
    expect(result.summary).toContain('sheet row 2');
  });

  it('refuses a sheet over the row limit and a field over the length limit, without throwing', () => {
    const many = `family,type,standard,size,outsideDiameter\n${'f,pipe,ASME B36.10M,NPS 2,60.3\n'.repeat(20_001)}`;
    expectRefusal(empty, 'import_piping_catalog_sheet', importSheet(many, { provenance: SOURCE }), 'PSC_CATALOG_INVALID');
    const long = `family,type,standard,size,outsideDiameter\nf,pipe,${'x'.repeat(5000)},NPS 2,60.3\n`;
    expectRefusal(empty, 'import_piping_catalog_sheet', importSheet(long, { provenance: SOURCE }), 'PSC_CATALOG_INVALID');
  });

  it('a conflicting id needs replace; a reserved property name as id is refused by the engine', () => {
    const csv = exportCsv();
    const first = apply(empty, 'import_piping_catalog_sheet', importSheet(csv, { catalogId: 'other' }));
    expect(ok(first, 'list_piping_catalogs', {}).summary).toContain('other');
    const other = csv.replace('152.4', '153.4');
    expectRefusal(first, 'import_piping_catalog_sheet', importSheet(other, { catalogId: 'other' }), 'PSC_CATALOG_CONFLICT', 'id');
    const replaced = ok(first, 'import_piping_catalog_sheet', importSheet(other, { catalogId: 'other', replace: true }));
    expect(replaced.data).toMatchObject({ replaced: true });
    expectPure(first, () => execute(first, 'import_piping_catalog_sheet', importSheet(other, { catalogId: 'other', replace: true })));
    expect(execute(first, 'import_piping_catalog_sheet', importSheet(csv, { catalogId: 'constructor' })).rejected).toBe(true);
  });

  it('reads a guarded text verbatim: the apostrophe the export adds comes off', () => {
    const evil = apply(empty, 'import_piping_catalog', {
      catalog: {
        ...catalogFile,
        id: 'evil',
        families: [
          {
            id: 'f',
            type: 'pipe',
            standard: '=cmd|"/c calc"!A1',
            sizes: [{ nps: 2, outsideDiameter: 60.3, provenance: { citation: '@SUM(A1)' } }],
          },
        ],
      },
    });
    const csv = exportCsv(evil, 'evil');
    expect(csv).toContain("'=cmd");
    const back = apply(empty, 'import_piping_catalog_sheet', importSheet(csv, { catalogId: 'evil2' }));
    expect(exportJson(back, 'evil2').text.replace('evil2', 'evil')).toBe(exportJson(evil, 'evil').text);
  });
});
