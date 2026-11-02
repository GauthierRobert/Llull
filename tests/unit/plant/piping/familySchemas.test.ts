/** Plant 01 PSC M4: family schemas of the import-only standards (B16.11, MSS SP-97 olets, EN 10253, B16.47): what an imported family must carry to claim them. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument } from '@core/model/types';
import { FAMILY_SCHEMAS, familySchemaIssues, schemaFor } from '@aec/plant/catalog/familySchemas';
import type { ComponentFamily } from '@aec/plant/catalog/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';

const doc = createEmptyDocument();
const provenance = { citation: 'test table' };
type Json = Record<string, unknown>;
/** JSON round trip: an `undefined` member is absent, as in a file (the parser would otherwise report it as a non-number). */
const catalogOf = (family: Json): Json =>
  JSON.parse(
    JSON.stringify({ format: 'llull-piping-catalog', schemaVersion: 1, id: 'schema-test', licence: 'open-data', families: [family] }),
  ) as Json;
const importFamily = (family: Json): CommandResult => execute(doc, 'import_piping_catalog', { catalog: catalogOf(family) });
const refused = (family: Json, path: string): void => {
  const result = expectRefusal(doc, 'import_piping_catalog', { catalog: catalogOf(family) }, 'PSC_CATALOG_INVALID');
  expect(result.error?.paths, result.summary).toContain(path);
};

const b1611 = (size: Json = {}, over: Json = {}): Json => ({
  id: 'asme-b16.11-sw',
  type: 'elbow90',
  standard: 'ASME B16.11',
  ends: ['SW'],
  sizes: [{ nps: 1, class: 3000, centreToEnd: 38.1, socketDepth: 12.7, provenance, ...size }],
  ...over,
});

describe('ASME B16.11 socket-weld and threaded fittings', () => {
  it('imports a conforming family and keeps its dimensions in mm', () => {
    const result = importFamily(b1611());
    expect(result.rejected, result.summary).toBeUndefined();
    const stored = result.document.plant?.catalog?.catalogs['schema-test']?.families[0];
    expect(stored?.sizes[0]?.dims['centreToEnd']?.value).toBe(38.1);
  });

  it.each([
    ['a missing centre-to-end', { centreToEnd: undefined }, 'families.0.sizes.0.centreToEnd'],
    ['a threaded-only class on a socket-weld family', { class: 2000 }, 'families.0.sizes.0.class'],
    ['a class that is not a B16.11 class', { class: 4000 }, 'families.0.sizes.0.class'],
  ])('refuses %s with the path of the value', (_what, size, path) => {
    refused(b1611(size), path);
  });

  it('accepts class 2000 on a threaded family and 9000 on a socket-weld one', () => {
    expect(importFamily(b1611({ class: 2000 }, { ends: ['THD'] })).rejected).toBeUndefined();
    expect(importFamily(b1611({ class: 9000 })).rejected).toBeUndefined();
    refused(b1611({ class: 9000 }, { ends: ['THD'] }), 'families.0.sizes.0.class');
  });

  it('needs the length of couplings, not a centre-to-end, and the run length of tees (an equal tee has no branch value)', () => {
    const coupling = b1611({ centreToEnd: undefined, length: 45 }, { type: 'coupling' });
    const res = importFamily(coupling);
    expect(res.rejected, res.summary).toBeUndefined();
    refused(b1611({ centreToEnd: 38 }, { type: 'coupling' }), 'families.0.sizes.0.length');
    refused(b1611({ centreToEnd: 41 }, { type: 'tee' }), 'families.0.sizes.0.centreToEndRun');
    expect(importFamily(b1611({ centreToEnd: undefined, centreToEndRun: 41 }, { type: 'tee' })).rejected).toBeUndefined();
  });
});

describe('MSS SP-97 olets', () => {
  const olet = (size: Json = {}, over: Json = {}): Json => ({
    id: 'mss-sp-97-wol',
    type: 'weldolet',
    standard: 'MSS SP-97',
    sizes: [{ nps: 6, smallNps: 2, centreToOutlet: 144, branchBore: 40, provenance, ...size }],
    ...over,
  });

  it('imports a family keyed by header x branch size', () => {
    expect(importFamily(olet()).rejected).toBeUndefined();
    expect(
      importFamily(
        olet(
          {},
          {
            id: 'sol',
            type: 'sockolet',
            standard: 'Sockolet MSS SP-97',
            sizes: [{ nps: 6, smallNps: 1, class: 3000, centreToOutlet: 30, socketDepth: 13, provenance }],
          },
        ),
      ).rejected,
    ).toBeUndefined();
  });

  it('needs neither outlet distance nor height at import; check_piping_catalog warns about such a row', () => {
    const bare = importFamily(olet({ centreToOutlet: undefined, outsideDiameter: 100 }));
    expect(bare.rejected, bare.summary).toBeUndefined();
    const checked = data<{ issues: Array<{ rule: string; status: string; code: string; paths: string[] }> }>(
      bare.document,
      'check_piping_catalog',
      { catalogId: 'schema-test', rules: ['olet.dims'] },
    );
    expect(checked.issues).toEqual([
      expect.objectContaining({ rule: 'olet.dims', status: 'warn', code: 'PSC_CATALOG_ROW_MISSING', paths: ['families.0.sizes.0'] }),
    ]);
    const fine = importFamily(olet({ height: 60, centreToOutlet: undefined }));
    expect(
      data<{ issues: unknown[] }>(fine.document, 'check_piping_catalog', { catalogId: 'schema-test', rules: ['olet.dims'] }).issues,
    ).toEqual([]);
  });

  it('has its own class rule per olet: none for a weldolet, socket classes for a sockolet, threaded classes for a threadolet', () => {
    expect(importFamily(olet({ class: 1500 })).rejected).toBeUndefined();
    refused(olet({ class: 2000 }, { type: 'sockolet', ends: ['SW'] }), 'families.0.sizes.0.class');
    expect(importFamily(olet({ class: 9000 }, { type: 'sockolet', ends: ['SW'] })).rejected).toBeUndefined();
    refused(olet({ class: 9000 }, { type: 'threadolet', ends: ['THD'] }), 'families.0.sizes.0.class');
  });

  it('matches the standard by SP-97 or by olet type name, not by a bare "Olet"', () => {
    const named = (standard: string): string | null => schemaFor({ standard, type: 'weldolet' })?.id ?? null;
    expect(named('MSS SP-97')).toBe('mss-sp-97');
    expect(named('Bonney Forge Weldolet')).toBe('mss-sp-97');
    expect(named('Olet catalogue')).toBeNull();
  });

  it.each([
    ['no branch size', { smallNps: undefined }, 'families.0.sizes.0.smallNps'],
    ['a zero outlet distance', { centreToOutlet: 0 }, 'families.0.sizes.0.centreToOutlet'],
    ['a zero height', { centreToOutlet: undefined, height: 0 }, 'families.0.sizes.0.height'],
  ])('refuses %s', (_what, size, path) => {
    refused(olet(size), path);
  });
});

describe('EN 10253 butt-welding fittings', () => {
  const en = (size: Json = {}, over: Json = {}): Json => ({
    id: 'en-10253-e90',
    type: 'elbow90',
    standard: 'EN 10253-2',
    sizes: [{ dn: 100, outsideDiameter: 114.3, centreToEnd: 152, provenance, ...size }],
    ...over,
  });

  it('imports DN-keyed fittings and records the EN dimensional standard', () => {
    const result = importFamily(en());
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.document.plant?.catalog?.catalogs['schema-test']?.families[0]?.dimensionalStandard).toBe('EN');
  });

  it('refuses NPS designation, a missing outside diameter and the extra dimensions of the other types', () => {
    refused(en({ dn: undefined, nps: 4 }), 'families.0.sizes.0.dn');
    refused(en({ outsideDiameter: undefined }), 'families.0.sizes.0.outsideDiameter');
    refused(en({ centreToEnd: undefined }), 'families.0.sizes.0.centreToEnd');
    refused(
      en({}, { type: 'reducingTee', sizes: [{ dn: 100, smallDn: 50, outsideDiameter: 114.3, centreToEndRun: 105, provenance }] }),
      'families.0.sizes.0.centreToEndBranch',
    );
    refused(
      en({}, { type: 'reducerConcentric', sizes: [{ dn: 100, smallDn: 50, outsideDiameter: 114.3, length: 127, provenance }] }),
      'families.0.sizes.0.smallOutsideDiameter',
    );
  });
});

describe('ASME B16.47 large-diameter flanges', () => {
  const large = (size: Json = {}, over: Json = {}): Json => ({
    id: 'asme-b16.47-a',
    type: 'flangeWeldNeck',
    standard: 'ASME B16.47 Series A',
    sizes: [
      {
        nps: 30,
        class: 150,
        facing: 'RF',
        outsideDiameter: 984,
        thickness: 66,
        boltCircle: 914,
        boltCount: 28,
        boltDiameter: 31.75,
        raisedFaceDiameter: 800,
        provenance,
        ...size,
      },
    ],
    ...over,
  });

  it('imports NPS 26 to 60 flanges of a named series and classes 75 to 900', () => {
    expect(importFamily(large()).rejected).toBeUndefined();
    expect(importFamily(large({ nps: 26, class: 75 })).rejected).toBeUndefined();
    expect(importFamily(large({ nps: 60, class: 900 })).rejected).toBeUndefined();
  });

  it('refuses sizes outside NPS 26 to 60, unknown classes, a missing series and any missing dimension', () => {
    refused(large({ nps: 24 }), 'families.0.sizes.0.nps');
    refused(large({ nps: 62 }), 'families.0.sizes.0.nps');
    refused(large({ dn: 600, nps: undefined }), 'families.0.sizes.0.nps');
    refused(large({ class: 500 }), 'families.0.sizes.0.class');
    refused(large({}, { standard: 'ASME B16.47' }), 'families.0.standard');
    refused(large({ boltCircle: undefined }), 'families.0.sizes.0.boltCircle');
    refused(large({ thickness: undefined }), 'families.0.sizes.0.thickness');
  });
});

describe('schema lookup and listing', () => {
  it('applies only to a family that names the standard and a type the schema covers', () => {
    const family = (standard: string, type: ComponentFamily['type']): Pick<ComponentFamily, 'standard' | 'type'> => ({ standard, type });
    expect(schemaFor(family('ASME B16.11', 'elbow90'))?.id).toBe('asme-b16.11');
    expect(schemaFor(family('ASME B16.11', 'weldolet'))).toBeNull();
    expect(schemaFor(family('ASME B16.9', 'elbow90'))).toBeNull();
    expect(schemaFor(family('EN 10253-4', 'tee'))?.id).toBe('en-10253');
    expect(
      familySchemaIssues({ id: 'x', type: 'elbow90', standard: 'ASME B16.9', dimensionalStandard: 'ASME', ends: [], sizes: [] }),
    ).toEqual([]);
  });

  it('lists the schemas in list_piping_catalogs so an agent can build a conforming file', () => {
    const listed = data<{
      familySchemas: Array<{ id: string; requiredDims: Json; classesByType?: Record<string, number[] | null>; types: string[] }>;
    }>(doc, 'list_piping_catalogs', {});
    expect(listed.familySchemas.map((schema) => schema.id)).toEqual(FAMILY_SCHEMAS.map((schema) => schema.id));
    const b16 = listed.familySchemas.find((schema) => schema.id === 'asme-b16.11');
    expect(b16?.classesByType?.['elbow90']).toEqual([2000, 3000, 6000, 9000]);
    const olets = listed.familySchemas.find((schema) => schema.id === 'mss-sp-97');
    expect(olets?.classesByType).toEqual({ weldolet: null, sockolet: [3000, 6000, 9000], threadolet: [2000, 3000, 6000] });
    expect(b16?.requiredDims['elbow90']).toEqual(['centreToEnd']);
  });

  it('does not change the document when an import is refused', () => {
    const result = execute(doc, 'import_piping_catalog', { catalog: catalogOf(b1611({ centreToEnd: undefined })) });
    expect(result.document).toBe(doc);
    expect(apply(doc, 'import_piping_catalog', { catalog: catalogOf(b1611()) }).plant?.catalog?.catalogOrder).toEqual(['schema-test']);
  });
});
