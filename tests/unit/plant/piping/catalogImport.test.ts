/** Plant 01 PSC M1: catalogue import / export / check (VC-PSC-05, VC-PSC-17 for catalogues) and the `plant.catalog` document slice. */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { pipingCatalogErrors } from '@aec/plant/catalog/document';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';

const doc = createEmptyDocument();
type Issue = { code: string; status: string; rule: string; paths: string[]; ids: string[]; values: Record<string, number> };
interface Checked {
  status: string;
  issues: Issue[];
  counts: { fail: number; warn: number };
}
interface Exported {
  text: string;
  sha256: string;
  rows: number;
}

const cite = { citation: 'dodo tablez/Elbow_SCH-STD.csv BendRadius' };
const file = (over: Record<string, unknown> = {}, size: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: 'llull-piping-catalog',
  schemaVersion: 1,
  id: 'user-elbows',
  licence: 'company-proprietary',
  families: [
    {
      id: 'lr90',
      type: 'elbow90',
      radius: 'LR',
      standard: 'ASME B16.9',
      unit: 'mm',
      sizes: [{ nps: 6, outsideDiameter: 168.3, centreToEnd: 228.6, provenance: cite, ...size }],
    },
  ],
  ...over,
});
const importFile = (document: CadDocument, catalog: unknown, extra: Record<string, unknown> = {}): CadDocument =>
  apply(document, 'import_piping_catalog', { catalog, ...extra });

describe('import_piping_catalog (VC-PSC-05)', () => {
  it('imports a catalogue, stores millimetres with provenance and makes it lookup-able', () => {
    const result = ok(doc, 'import_piping_catalog', { catalog: file() });
    expect(result.rejected).toBeUndefined();
    expect(result.summary).toContain('user-elbows@1');
    const stored = result.document.plant?.catalog;
    expect(stored?.catalogOrder).toEqual(['user-elbows']);
    expect(stored?.catalogs['user-elbows']?.families[0]?.sizes[0]?.dims['centreToEnd']).toEqual({
      value: 228.6,
      unit: 'mm',
      verified: false,
      provenance: cite,
    });
    const row = data<Record<string, unknown>>(result.document, 'lookup_piping_component', {
      catalogId: 'user-elbows',
      type: 'elbow90',
      nps: 6,
    });
    expect(row['centreToEndMm']).toBe(228.6);
    expect(row['verified']).toBe(false);
    expect(
      data<{ catalogs: Array<{ id: string; origin: string }> }>(result.document, 'list_piping_catalogs', {}).catalogs.map((c) => c.origin),
    ).toEqual(['bundled', 'document']);
  });

  it('converts inches, honours verified / verifiedDims and per-dimension provenance', () => {
    const next = importFile(
      doc,
      file(
        {},
        {
          nps: 4,
          outsideDiameter: 4.5,
          centreToEnd: 6,
          verifiedDims: ['centreToEnd'],
          dimProvenance: { outsideDiameter: { sourceId: 'S2' } },
        },
      ),
    );
    expect(next.plant?.catalog?.catalogs['user-elbows']).toBeDefined();
    const inch = importFile(doc, {
      ...file(),
      families: [
        {
          ...(file()['families'] as Array<Record<string, unknown>>)[0],
          unit: 'in',
          sizes: [{ nps: 4, centreToEnd: 6, boltCount: 8, verified: true, provenance: cite }],
        },
      ],
    });
    const dims = inch.plant?.catalog?.catalogs['user-elbows']?.families[0]?.sizes[0]?.dims;
    expect(dims?.['centreToEnd']?.value).toBe(152.4);
    expect(dims?.['centreToEnd']?.verified).toBe(true);
    expect(dims?.['boltCount']).toMatchObject({ value: 8, unit: 'count' });
  });

  it('refuses a value without citation (PSC_PROVENANCE_MISSING) at the value path', () => {
    const catalog = file({ id: 'user-nocite' }, { provenance: undefined });
    const result = expectRefusal(doc, 'import_piping_catalog', { catalog }, 'PSC_PROVENANCE_MISSING');
    expect(result.error?.paths).toContain('families.0.sizes.0.centreToEnd');
    expect(result.error?.paths).toContain('families.0.sizes.0.outsideDiameter');
  });

  it('refuses a structure error with the JSON path, a bad unit, bad numbers and an uncited size set', () => {
    expectRefusal(doc, 'import_piping_catalog', { catalog: { format: 'nope' } }, 'PSC_CATALOG_INVALID');
    const badUnit = file();
    (badUnit['families'] as Array<Record<string, unknown>>)[0]!['unit'] = 'furlong';
    expectRefusal(doc, 'import_piping_catalog', { catalog: badUnit }, 'PSC_UNIT_INVALID', 'families.0.unit');
    expectRefusal(
      doc,
      'import_piping_catalog',
      { catalog: file({}, { centreToEnd: -1 }) },
      'PSC_CATALOG_INVALID',
      'families.0.sizes.0.centreToEnd',
    );
    expectRefusal(
      doc,
      'import_piping_catalog',
      { catalog: file({}, { centreToEnd: 'big' }) },
      'PSC_CATALOG_INVALID',
      'families.0.sizes.0.centreToEnd',
    );
    expectRefusal(doc, 'import_piping_catalog', { catalog: file({}, { nps: 'x' }) }, 'PSC_CATALOG_INVALID', 'families.0.sizes.0.nps');
    expectRefusal(doc, 'import_piping_catalog', { catalog: file({}, { dn: 100 }) }, 'PSC_CATALOG_INVALID', 'families.0.sizes.0');
    expectRefusal(
      doc,
      'import_piping_catalog',
      { catalog: file({}, { outsideDiameter: undefined, centreToEnd: undefined }) },
      'PSC_CATALOG_INVALID',
    );
    expectRefusal(doc, 'import_piping_catalog', { catalog: file({ id: 'bad id!' }) }, 'PSC_CATALOG_INVALID', 'id');
    expectRefusal(doc, 'import_piping_catalog', { catalog: file({}, { smallDn: 'x' }) }, 'PSC_CATALOG_INVALID');
    const first = execute(doc, 'import_piping_catalog', { catalog: file({}, { centreToEnd: -1 }) });
    expect((first.data as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
  });

  it('refuses licensed-no-redistribution data and the reserved bundled id', () => {
    expectRefusal(
      doc,
      'import_piping_catalog',
      { catalog: file({ licence: 'licensed-no-redistribution' }) },
      'PSC_LICENCE_EMBED_FORBIDDEN',
      'licence',
    );
    expectRefusal(doc, 'import_piping_catalog', { catalog: file({ id: 'llull-open-piping' }) }, 'PSC_CATALOG_CONFLICT', 'id');
  });

  it('is idempotent for identical content, refuses a different one without replace, overwrites with replace', () => {
    const first = importFile(doc, file());
    const again = ok(first, 'import_piping_catalog', { catalog: file() });
    expect(again.document).toBe(first);
    expect(again.summary).toContain('nothing changed');
    const changedFile = file({}, { centreToEnd: 230 });
    expectRefusal(first, 'import_piping_catalog', { catalog: changedFile }, 'PSC_CATALOG_CONFLICT');
    const replaced = importFile(first, changedFile, { replace: true });
    expect(replaced.plant?.catalog?.catalogOrder).toEqual(['user-elbows']);
    expect(replaced.plant?.catalog?.catalogs['user-elbows']?.families[0]?.sizes[0]?.dims['centreToEnd']?.value).toBe(230);
  });

  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'import_piping_catalog', { catalog: file() }));
  });
});

describe('check_piping_catalog (VC-PSC-05, TR-PSC-13)', () => {
  const bad = importFile(doc, file({}, { centreToEnd: 126.2 }));

  it('flags the dodo LR elbow (0.75 x OD = 126.2 mm at NPS 6) as PSC_CATALOG_DIM_MISMATCH at the value path', () => {
    const checked = data<Checked>(bad, 'check_piping_catalog', { catalogId: 'user-elbows' });
    expect(checked.status).toBe('fail');
    expect(checked.issues[0]).toMatchObject({
      code: 'PSC_CATALOG_DIM_MISMATCH',
      status: 'fail',
      rule: 'b169.lr90',
      paths: ['families.0.sizes.0.centreToEnd'],
    });
    expect(checked.issues[0]?.values).toMatchObject({ expectedMm: 228.6, foundMm: 126.2 });
    expect(checked.issues.some((issue) => issue.code === 'PSC_DATA_UNVERIFIED')).toBe(true);
  });

  it('passes the correct elbow with only the unverified warning', () => {
    const good = importFile(doc, file());
    const checked = data<Checked>(good, 'check_piping_catalog', { catalogId: 'user-elbows' });
    expect(checked.status).toBe('warn');
    expect(checked.counts.fail).toBe(0);
    expect(data<Checked>(good, 'check_piping_catalog', { catalogId: 'user-elbows', rules: ['b169.lr90'] }).status).toBe('pass');
  });

  it('checks SR elbows, the B16.5 hole rule, the fitting end OD and monotonic dimensions', () => {
    const catalog = file({
      id: 'user-mixed',
      families: [
        { id: 'sr', type: 'elbow90', radius: 'SR', standard: 'ASME B16.9', sizes: [{ nps: 4, centreToEnd: 90, provenance: cite }] },
        {
          id: 'fl',
          type: 'flangeWeldNeck',
          standard: 'ASME B16.5',
          sizes: [{ nps: 4, class: 150, boltDiameter: 15.875, boltHole: 22, provenance: cite }],
        },
        {
          id: 'tees',
          type: 'tee',
          standard: 'ASME B16.9',
          sizes: [
            { nps: 4, outsideDiameter: 100, centreToEndRun: 105, provenance: cite },
            { nps: 6, outsideDiameter: 168.3, centreToEndRun: 100, provenance: cite },
          ],
        },
        { id: 'en-tee', type: 'tee', standard: 'EN 10253', sizes: [{ dn: 65, outsideDiameter: 73, provenance: cite }] },
      ],
    });
    const checked = data<Checked>(importFile(doc, catalog), 'check_piping_catalog', { catalogId: 'user-mixed' });
    const byRule = (rule: string): Issue[] => checked.issues.filter((issue) => issue.rule === rule);
    expect(byRule('b169.sr90')[0]?.paths).toEqual(['families.0.sizes.0.centreToEnd']);
    expect(byRule('b165.hole')[0]?.paths).toEqual(['families.1.sizes.0.boltHole']);
    expect(byRule('pipe.odMatch').map((issue) => issue.paths[0])).toEqual([
      'families.2.sizes.0.outsideDiameter',
      'families.3.sizes.0.outsideDiameter',
    ]);
    expect(byRule('monotonic')[0]).toMatchObject({ status: 'warn', paths: ['families.2.sizes.1.centreToEndRun'] });
    expect(checked.issues[0]?.status).toBe('fail');
  });

  it('reports the bundled catalogue: no dimension failures, unverified rows flagged', () => {
    const checked = data<Checked>(doc, 'check_piping_catalog', {});
    expect(checked.counts.fail).toBe(0);
    expect(checked.issues.every((issue) => issue.code === 'PSC_DATA_UNVERIFIED' || issue.status === 'warn')).toBe(true);
    expect(checked.issues.some((issue) => issue.code === 'PSC_DATA_UNVERIFIED')).toBe(true);
  });

  it('refuses an unknown catalogue and is pure', () => {
    expectRefusal(doc, 'check_piping_catalog', { catalogId: 'nope' }, 'PSC_CATALOG_UNKNOWN', 'catalogId');
    expectPure(bad, () => execute(bad, 'check_piping_catalog', { catalogId: 'user-elbows' }));
  });
});

describe('export_piping_catalog and the document slice (VC-PSC-17)', () => {
  it('round-trips: export -> import -> export gives the identical sha256', () => {
    const source = importFile(
      doc,
      file({}, { centreToEnd: 126.2, verifiedDims: ['outsideDiameter'], dimProvenance: { outsideDiameter: { sourceId: 'S1' } } }),
    );
    const first = data<Exported>(source, 'export_piping_catalog', { catalogId: 'user-elbows' });
    const reimported = importFile(doc, JSON.parse(first.text));
    const second = data<Exported>(reimported, 'export_piping_catalog', { catalogId: 'user-elbows' });
    expect(second.sha256).toBe(first.sha256);
    expect(second.text).toBe(first.text);
    expect(reimported.plant?.catalog).toEqual(source.plant?.catalog);
  });

  it('exports the bundled catalogue as a valid file that re-imports under another id with equal content', () => {
    const all = data<Exported>(doc, 'export_piping_catalog', {});
    const renamed = { ...JSON.parse(all.text), id: 'copy' };
    const imported = importFile(doc, renamed);
    const again = data<Exported>(imported, 'export_piping_catalog', { catalogId: 'copy' });
    expect(JSON.parse(again.text)).toEqual(renamed);
    expect(data<Checked>(imported, 'check_piping_catalog', { catalogId: 'copy' }).counts.fail).toBe(0);
  });

  it('exports one family, as CSV with a column per dimension, and refuses unknown ones', () => {
    const csv = data<Exported & { families: string[] }>(doc, 'export_piping_catalog', { format: 'csv', familyId: 'asme-b16.9-lr90' });
    expect(csv.families).toEqual(['asme-b16.9-lr90']);
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toBe('family,type,standard,size,smallSize,schedule,class,pn,facing,centreToEnd,verified');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain('NPS 6');
    expect(lines[3]).toContain('228.6');
    expectRefusal(doc, 'export_piping_catalog', { catalogId: 'nope' }, 'PSC_CATALOG_UNKNOWN', 'catalogId');
    expectRefusal(doc, 'export_piping_catalog', { familyId: 'nope' }, 'PSC_CATALOG_UNKNOWN', 'familyId');
  });

  it('survives save / load and replay of the recipe', () => {
    const source = importFile(doc, file());
    const loaded = deserializeDocument(serializeDocument(source));
    expect(loaded.plant?.catalog).toEqual(source.plant?.catalog);
    expect(
      data<Record<string, unknown>>(loaded, 'lookup_piping_component', { catalogId: 'user-elbows', type: 'elbow90', nps: 6 })[
        'centreToEndMm'
      ],
    ).toBe(228.6);
  });

  it('rejects a saved file whose catalogue slice is corrupt', () => {
    expect(pipingCatalogErrors(importFile(doc, file()).plant?.catalog)).toEqual([]);
    expect(pipingCatalogErrors(5)).toEqual(['plant.catalog must be { catalogs, catalogOrder }']);
    expect(pipingCatalogErrors({ catalogs: {}, catalogOrder: ['x'] })[0]).toContain('catalogOrder');
    expect(pipingCatalogErrors({ catalogs: { a: { format: 'x' } }, catalogOrder: ['a'] })[0]).toContain('llull-piping-catalog');
    expect(
      pipingCatalogErrors({
        catalogs: { 'llull-open-piping': { format: 'llull-piping-catalog', id: 'llull-open-piping', families: [] } },
        catalogOrder: ['llull-open-piping'],
      })[0],
    ).toContain('reserved');
    const family = (sizes: unknown): unknown => ({
      catalogs: { a: { format: 'llull-piping-catalog', id: 'a', families: [{ id: 'f', sizes }] } },
      catalogOrder: ['a'],
    });
    expect(pipingCatalogErrors(family([{ size: {}, dims: { x: { value: -1 } } }]))[0]).toContain('dims.x');
    expect(pipingCatalogErrors(family([5]))[0]).toContain('size and dims');
    expect(
      pipingCatalogErrors({ catalogs: { a: { format: 'llull-piping-catalog', id: 'a', families: [5] } }, catalogOrder: ['a'] })[0],
    ).toContain('families.0');
  });

  it('the load check refuses a corrupt file through the document extension', () => {
    const good = JSON.parse(serializeDocument(importFile(doc, file())));
    good.document.plant.catalog.catalogs['user-elbows'].families[0].sizes[0].dims.centreToEnd.value = 'big';
    expect(() => deserializeDocument(JSON.stringify(good))).toThrow();
    expect(deserializeDocument(serializeDocument(doc)).plant).toBeUndefined();
  });
});
