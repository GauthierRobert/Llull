/** add_hole with hole.fastener: the clearance diameter comes from the document catalogue (07 FTR M6, VC-FTR-29; regeneration: aero/fasteners/holeRegeneration.test.ts). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FastenerFamily, FastenerModel } from '@core/model/fasteners';
import type { CadDocument } from '@core/model/types';
import { idOf, manifoldSuite, meshOf, plate } from '../../helpers/featureSupport';

manifoldSuite();

const family = (min: number, max: number, unit = 'mm'): FastenerFamily => ({
  id: 'NAS1351',
  kind: 'bolt',
  standard: { body: 'NAS', id: '1351' },
  partNumber: [],
  sizes: [
    {
      dash: '-3',
      nominalDiameter: { value: 3, unit: 'mm' },
      dims: {},
      holeDiameter: { min, max, unit, provenance: { citation: 'test double' } },
    },
    { dash: '-4', nominalDiameter: { value: 4, unit: 'mm' }, dims: {} },
  ],
  licence: 'company-proprietary',
  provenance: { citation: 'test double' },
});

const withCatalog = (doc: CadDocument, fasteners: FastenerModel): CadDocument => ({ ...doc, fasteners });
const model = (f: FastenerFamily): FastenerModel => ({ catalogs: { [f.id]: f }, stacks: {} });

const drill = (
  doc: CadDocument,
  target: string,
  fastener: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): ReturnType<typeof execute> =>
  execute(doc, 'add_hole', {
    target,
    face: { near: [50, 30, 10] },
    points: [[10, 10]],
    hole: { kind: 'simple', fastener, ...extra },
    extent: { kind: 'through_all' },
  });

describe('hole.fastener', () => {
  it('takes the middle of the catalogued hole diameter and names the fastener in the summary', () => {
    const stock = plate();
    const doc = withCatalog(stock.doc, model(family(3.2, 3.4)));
    const result = drill(doc, stock.id, { catalogId: 'NAS1351', partNumber: 'NAS1351-3-8', fit: 'close' });
    expect(result.rejected).toBeUndefined();
    expect(result.summary).toContain('Ø3.3');
    expect(result.summary).toContain('NAS1351 NAS1351-3-8');
    expect(meshOf(result.document, idOf(result)).brep).toMatchObject({
      hole: { kind: 'simple', diameter: 3.3, fastener: { catalogId: 'NAS1351', partNumber: 'NAS1351-3-8', fit: 'close' } },
    });
  });

  it('editing the catalogue entry changes the hole the next time it is cut (regeneration)', () => {
    const stock = plate();
    const before = drill(withCatalog(stock.doc, model(family(3.2, 3.4))), stock.id, { catalogId: 'NAS1351', partNumber: 'NAS1351-3-8' });
    const after = drill(withCatalog(stock.doc, model(family(4.0, 4.2))), stock.id, { catalogId: 'NAS1351', partNumber: 'NAS1351-3-8' });
    const diameter = (r: ReturnType<typeof execute>): number =>
      (meshOf(r.document, idOf(r)).brep as unknown as { hole: { diameter: number } }).hole.diameter;
    expect([diameter(before), diameter(after)]).toEqual([3.3, 4.1]);
  });

  it('an explicit diameter wins over the catalogue; units are converted to the document unit', () => {
    const stock = plate();
    const explicit = drill(
      withCatalog(stock.doc, model(family(3.2, 3.4))),
      stock.id,
      { catalogId: 'NAS1351', partNumber: 'NAS1351-3' },
      { diameter: 5 },
    );
    expect(meshOf(explicit.document, idOf(explicit)).brep).toMatchObject({ hole: { diameter: 5 } });
    const inches = execute(withCatalog(stock.doc, model(family(0.125, 0.127, 'in'))), 'set_units', { units: 'mm' });
    const converted = drill(inches.document, stock.id, { catalogId: 'NAS1351', partNumber: 'NAS1351-3' });
    expect((meshOf(converted.document, idOf(converted)).brep as unknown as { hole: { diameter: number } }).hole.diameter).toBeCloseTo(
      3.2004,
      6,
    );
  });

  it.each([
    ['no catalogue at all', (doc: CadDocument) => doc, 'NAS1351-3', 'no fastener catalogue'],
    ['an unknown catalogue id', (doc: CadDocument) => withCatalog(doc, model(family(3, 4))), 'OTHER|X-3', 'is not in the document'],
    ['a part number without a size token', (doc: CadDocument) => withCatalog(doc, model(family(3, 4))), 'NAS1351-9', 'matches no size'],
    ['a size without a hole diameter', (doc: CadDocument) => withCatalog(doc, model(family(3, 4))), 'NAS1351-4', 'has no hole diameter'],
    ['an unconvertible unit', (doc: CadDocument) => withCatalog(doc, model(family(3, 4, 'furlong'))), 'NAS1351-3', 'cannot be converted'],
  ])('refuses %s with FTR_FASTENER_CATALOG_UNAVAILABLE', (_label, prepare, partNumber, reason) => {
    const stock = plate();
    const [catalogId, number] = partNumber.includes('|') ? partNumber.split('|') : ['NAS1351', partNumber];
    const doc = prepare(stock.doc);
    const result = drill(doc, stock.id, { catalogId, partNumber: number });
    expect(result.document).toBe(doc);
    expect(result.error).toMatchObject({ code: 'FTR_FASTENER_CATALOG_UNAVAILABLE', paths: ['hole.fastener'] });
    expect(result.summary).toContain(reason);
  });
});
