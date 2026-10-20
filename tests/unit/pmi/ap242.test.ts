/** 03 GDT M6: apply_pmi_set, the xcafMapping tables and the PMI write stage of export_step_ap242 (VC-GDT-20, 21, 25 on the analytic plate kernel). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import type { PmiItem } from '@core/model/pmi';
import type { ExchangePmi, ExchangeWriteRequest } from '@core/geometry/kernelExchange';
import type { GeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { fromExchangePmi, toExchangePmi } from '@core/commands/pmi/xcafMapping';
import { plateKernel } from '../../helpers/pmiPlateKernel';

const BOTTOM = [30, 10, 0] as const;
const FRONT = [60, 0, 6] as const;
const HOLE = [16.7, 20, 6] as const;
const BORE = [50, 40, 6] as const;
const TOP = [10, 10, 12] as const;

let written: ExchangeWriteRequest | null = null;
const exchangeKernel = (): GeometryKernel => {
  const kernel = plateKernel();
  return Object.assign(kernel, {
    writeExchange: (request: ExchangeWriteRequest): string => {
      written = request;
      return "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
    },
  });
};

beforeEach(() => {
  written = null;
  setGeometryKernel(exchangeKernel());
});
afterEach(() => setGeometryKernel(null));

function plate(): { document: CadDocument; id: string } {
  const box = execute(createEmptyDocument(), 'add_box', { size: [120, 80, 12] });
  return { document: box.document, id: box.affected[0] as string };
}

const items = (doc: CadDocument): PmiItem[] => (doc.pmi?.order ?? []).map((id) => doc.pmi!.items[id]!);

const bracket = (id: string): Record<string, unknown> => ({
  entityId: id,
  source: 'bracket.stp',
  items: [
    { kind: 'datum_feature', label: 'A', facesNear: [BOTTOM] },
    {
      kind: 'size_dimension',
      sizeKind: 'diameter',
      tolerance: { type: 'plusMinus', upper: 0.1, lower: -0.05 },
      nominal: 20,
      facesNear: [BORE],
    },
    { kind: 'geometric_tolerance', characteristic: 'position', zone: { value: 0.3, diametral: true }, datums: ['A'], facesNear: [HOLE] },
    { kind: 'geometric_tolerance', characteristic: 'flatness', zone: { value: 0.05 }, facesNear: [TOP] },
    { kind: 'location_dimension', measure: 'distance', tolerance: { type: 'basic' }, nominal: 12, from: [BOTTOM], to: [TOP] },
  ],
});

describe('apply_pmi_set', () => {
  it('adds the items in order, measures the nominals from the B-rep, requires review and records the import', () => {
    const { document, id } = plate();
    const result = execute(document, 'apply_pmi_set', bracket(id));
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toHaveLength(5);
    expect(result.document.pmi?.order).toEqual(result.affected);
    expect(result.data).toEqual({ created: 5, unresolved: 0, unverified: 0 });
    expect(result.document.pmi?.import).toEqual({ source: 'bracket.stp', items: 5, unresolved: 0, unmapped: 0 });
    const [datum, size, position, flatness, location] = items(result.document);
    expect(datum).toMatchObject({ kind: 'datum_feature', label: 'A', feature: { surface: 'plane', faceIndices: [0] } });
    expect(size).toMatchObject({
      kind: 'size_dimension',
      sizeKind: 'diameter',
      count: 1,
      feature: { ofSize: { kind: 'cylinder', measured: 20 } },
    });
    expect(position).toMatchObject({ characteristic: 'position', zone: { value: 0.3, diametral: true }, datums: [{ label: 'A' }] });
    expect(flatness).toMatchObject({ characteristic: 'flatness', datums: [] });
    expect(location).toMatchObject({ measure: 'distance', measured: 12, tolerance: { type: 'basic' } });
    expect(items(result.document).every((item) => item.review.required && item.review.reason?.includes('bracket.stp'))).toBe(true);
    expect(items(result.document).every((item) => item.unverified === undefined)).toBe(true);
  });

  it('is pure', () => {
    const { document, id } = plate();
    const before = JSON.stringify(document);
    execute(document, 'apply_pmi_set', bracket(id));
    expect(JSON.stringify(document)).toBe(before);
  });

  it('keeps an unresolved feature with no face, unverified and counted', () => {
    const { document, id } = plate();
    const result = execute(document, 'apply_pmi_set', {
      entityId: id,
      items: [{ kind: 'datum_feature', label: 'A', facesNear: [[500, 500, 500]] }],
    });
    expect(result.affected).toHaveLength(1);
    const [datum] = items(result.document);
    expect(datum?.kind === 'datum_feature' && datum.feature.faceIndices).toEqual([]);
    expect(datum?.unverified?.reason).toContain('no face');
    expect(result.document.pmi?.import).toMatchObject({ items: 1, unresolved: 1 });
  });

  it('flags a stated nominal the B-rep disagrees with, and a frame naming an undefined datum', () => {
    const { document, id } = plate();
    const result = execute(document, 'apply_pmi_set', {
      entityId: id,
      items: [
        { kind: 'size_dimension', sizeKind: 'diameter', tolerance: { type: 'basic' }, nominal: 25, facesNear: [BORE] },
        { kind: 'geometric_tolerance', characteristic: 'position', zone: { value: 0.3 }, datums: ['Q'], facesNear: [HOLE] },
        { kind: 'location_dimension', measure: 'distance', nominal: 99, from: [BOTTOM], to: [FRONT] },
      ],
    });
    const [size, position, location] = items(result.document);
    expect(size?.unverified?.reason).toContain('states nominal 25');
    expect(position?.unverified?.reason).toContain('datum Q is not defined');
    expect(location?.unverified?.reason).toContain('cannot measure');
    expect(location).toMatchObject({ measured: 99 });
    expect(result.data).toMatchObject({ created: 3, unverified: 3 });
  });

  it('refuses a missing solid, a duplicate datum label, an inverted tolerance and a mesh kernel without changing the document', () => {
    const { document, id } = plate();
    const missing = execute(document, 'apply_pmi_set', {
      entityId: 'nope',
      items: [{ kind: 'datum_feature', label: 'A', facesNear: [BOTTOM] }],
    });
    expect(missing.error?.code).toBe('GDT_ENTITY_NOT_SOLID');
    expect(missing.document).toBe(document);
    const twice = execute(document, 'apply_pmi_set', {
      entityId: id,
      items: [
        { kind: 'datum_feature', label: 'A', facesNear: [BOTTOM] },
        { kind: 'datum_feature', label: 'A', facesNear: [FRONT] },
      ],
    });
    expect(twice.error?.code).toBe('GDT_DATUM_DUPLICATE');
    expect(twice.affected).toEqual([]);
    const first = execute(document, 'apply_pmi_set', bracket(id));
    const again = execute(first.document, 'apply_pmi_set', {
      entityId: id,
      items: [{ kind: 'datum_feature', label: 'A', facesNear: [BOTTOM] }],
    });
    expect(again.error?.code).toBe('GDT_DATUM_DUPLICATE');
    const inverted = execute(document, 'apply_pmi_set', {
      entityId: id,
      items: [{ kind: 'size_dimension', sizeKind: 'diameter', tolerance: { type: 'limits', upper: 1, lower: 2 }, facesNear: [BORE] }],
    });
    expect(inverted.error?.code).toBe('GDT_LIMITS_INVERTED');
    setGeometryKernel(Object.assign(plateKernel(), { faceQuery: undefined }));
    const noTopology = execute(document, 'apply_pmi_set', bracket(id));
    expect(noTopology.error?.code).toBe('GDT_KERNEL_NO_TOPOLOGY');
    expect(noTopology.document).toBe(document);
  });
});

/** The transport PMI of `doc` for the plate, as the writer would receive it. */
const transportOf = (doc: CadDocument): ReturnType<typeof toExchangePmi> => toExchangePmi(items(doc), (feature) => feature.faceIndices);

describe('xcafMapping', () => {
  it('maps the model onto the neutral transport vocabulary, deviations as magnitudes', () => {
    const { document, id } = plate();
    const applied = execute(document, 'apply_pmi_set', bracket(id)).document;
    const { pmi, written: ids, skipped, lossy } = transportOf(applied);
    expect(skipped).toEqual([]);
    expect(lossy).toEqual([]);
    expect(ids).toHaveLength(5);
    expect(pmi?.datums).toEqual([{ label: 'A', faces: [0] }]);
    expect(pmi?.tolerances).toEqual([
      { characteristic: 'position', value: 0.3, diameterZone: true, faces: [6], datums: ['A'] },
      { characteristic: 'flatness', value: 0.05, diameterZone: false, faces: [1], datums: [] },
    ]);
    expect(pmi?.dimensions).toEqual([
      { type: 'size_diameter', value: 20, tolerance: { plus: 0.1, minus: 0.05 }, faces: [10] },
      { type: 'location_linear_distance', value: 12, faces: [0], facesSecond: [1] },
    ]);
  });

  it('maps limits to deviations around the nominal, radius to half the diameter, roundness to circularity', () => {
    const { document, id } = plate();
    let next = execute(document, 'add_size_dimension', {
      entityId: id,
      facesNear: [BORE],
      sizeKind: 'radius',
      tolerance: { type: 'limits', upper: 10.2, lower: 9.9 },
    }).document;
    next = execute(next, 'add_geometric_tolerance', {
      characteristic: 'roundness',
      zone: { value: 0.02 },
      entityId: id,
      facesNear: [BORE],
    }).document;
    const { pmi } = transportOf(next);
    expect(pmi?.dimensions[0]?.type).toBe('size_radius');
    expect(pmi?.dimensions[0]?.value).toBe(10);
    expect(pmi?.dimensions[0]?.tolerance?.plus).toBeCloseTo(0.2, 12);
    expect(pmi?.dimensions[0]?.tolerance?.minus).toBeCloseTo(0.1, 12);
    expect(pmi?.tolerances[0]?.characteristic).toBe('circularity');
  });

  it('lists what it cannot write: unresolved features, unknown datums, notes; and what it writes lossily', () => {
    const { document, id } = plate();
    let next = execute(document, 'apply_pmi_set', {
      entityId: id,
      items: [
        { kind: 'datum_feature', label: 'A', facesNear: [[500, 500, 500]] },
        { kind: 'geometric_tolerance', characteristic: 'position', zone: { value: 0.3 }, datums: ['A'], facesNear: [HOLE] },
      ],
    }).document;
    next = execute(next, 'add_pmi_note', { text: 'BREAK EDGES' }).document;
    next = execute(next, 'add_datum_feature', { entityId: id, facesNear: [FRONT], label: 'B' }).document;
    next = execute(next, 'add_geometric_tolerance', {
      characteristic: 'perpendicularity',
      zone: { value: 0.1 },
      entityId: id,
      facesNear: [TOP],
      datums: [{ label: 'B', boundary: 'MMB' }],
      modifiers: ['tangent_plane'],
    }).document;
    const { skipped, lossy, written: ids } = transportOf(next);
    expect(skipped.map((entry) => entry.reason)).toEqual([
      'the feature resolves to no face',
      'datum A is not a written datum feature',
      'a note has no semantic AP242 transport form',
    ]);
    expect(lossy).toEqual([{ id: ids[ids.length - 1], lost: ['modifiers', 'datum boundary'] }]);
  });

  it('reads a transport set back into the same semantic items (ids aside), counting what has no model form', () => {
    const { document, id } = plate();
    const original = execute(document, 'apply_pmi_set', bracket(id)).document;
    const { pmi } = transportOf(original);
    const faces = plateKernel().faceQuery!.faceDetails({} as never)!;
    const pointsOf = (indices: readonly number[]): readonly [number, number, number][] | null =>
      indices.every((index) => faces[index] !== undefined)
        ? indices.map((index) => faces[index]!.samples[0] as [number, number, number])
        : null;
    const extended: ExchangePmi = {
      ...(pmi as ExchangePmi),
      dimensions: [
        ...(pmi as ExchangePmi).dimensions,
        { type: 'size_curve_length', value: 5, faces: [0] },
        { type: 'size_diameter', value: 1, faces: [99] },
      ],
    };
    const { drafts, unmapped } = fromExchangePmi(extended, pointsOf);
    expect(unmapped).toBe(2);
    const reapplied = execute(plate().document, 'apply_pmi_set', { entityId: id, items: drafts }).document;
    const dropped = new Set(['id', 'placement', 'review', 'facesNear', 'unverified']);
    const strip = (item: PmiItem): unknown =>
      JSON.parse(JSON.stringify(item, (key, value: unknown) => (dropped.has(key) ? undefined : value))) as unknown;
    const canonical = (doc: CadDocument): string[] =>
      items(doc)
        .map((item) => JSON.stringify(strip(item)))
        .sort();
    expect(canonical(reapplied)).toEqual(canonical(original));
  });
});

describe('export_step_ap242 includePmi', () => {
  const stepOf = (doc: CadDocument, params: Record<string, unknown>): ReturnType<typeof execute> =>
    execute(doc, 'export_step_ap242', { includeValidationProperties: false, ...params });

  it('attaches the PMI of a loose solid to its product and reports every item, flagging unreviewed items', () => {
    const { document, id } = plate();
    const applied = execute(document, 'apply_pmi_set', bracket(id)).document;
    const noted = execute(applied, 'add_pmi_note', { text: 'FREE TEXT' }).document;
    const result = stepOf(noted, { includePmi: true });
    expect(result.rejected).toBeUndefined();
    expect(result.document).toBe(noted);
    const product = written?.products[0];
    expect(product?.pmi?.datums).toEqual([{ label: 'A', faces: [0] }]);
    expect(product?.pmi?.tolerances).toHaveLength(2);
    expect(product?.pmi?.dimensions).toHaveLength(2);
    const data = result.data as {
      pmi: { requested: number; written: string[]; skipped: { reason: string }[]; reviewRequired: string[] };
      reviewRequired: unknown;
    };
    expect(data.pmi.requested).toBe(6);
    expect(data.pmi.written).toHaveLength(5);
    expect(data.pmi.skipped.map((entry) => entry.reason)).toEqual(['the item has no resolvable target solid']);
    expect(data.pmi.reviewRequired).toHaveLength(5);
    expect(data.reviewRequired).toEqual({ value: true, reasons: ['pmi_review_required'] });
    expect(result.summary).toContain('PMI 5/6 item(s) written');
  });

  it('writes a frame that targets a size dimension on the dimension faces, and lists an attached note and a dangling target', () => {
    const { document, id } = plate();
    const size = execute(document, 'add_size_dimension', {
      entityId: id,
      facesNear: [BORE],
      sizeKind: 'diameter',
      tolerance: { type: 'basic' },
    });
    const frame = execute(size.document, 'add_geometric_tolerance', {
      characteristic: 'position',
      targetPmiId: size.affected[0],
      zone: { value: 0.1, diametral: true },
    });
    const noted = execute(frame.document, 'add_pmi_note', { text: 'ON FACE', entityId: id, facesNear: [FRONT] });
    expect(noted.rejected).toBeUndefined();
    const result = stepOf(noted.document, { includePmi: true });
    expect(written?.products[0]?.pmi?.tolerances).toEqual([
      { characteristic: 'position', value: 0.1, diameterZone: true, faces: [10], datums: [] },
    ]);
    const skipped = (result.data as { pmi: { skipped: { reason: string }[] } }).pmi.skipped;
    expect(skipped.map((entry) => entry.reason)).toEqual(['a note has no semantic AP242 transport form']);
    const dangling = { ...frame.document, pmi: { ...frame.document.pmi!, items: { ...frame.document.pmi!.items } } } as CadDocument;
    delete (dangling.pmi!.items as Record<string, PmiItem>)[size.affected[0] as string];
    const orphan = stepOf(dangling, { includePmi: true });
    expect((orphan.data as { pmi: { skipped: { reason: string }[] } }).pmi.skipped[0]?.reason).toBe(
      'the item has no resolvable target solid',
    );
  });

  it('writes no PMI by default and for an AP242 write without PMI items', () => {
    const { document, id } = plate();
    const applied = execute(document, 'apply_pmi_set', bracket(id)).document;
    expect(stepOf(applied, {}).rejected).toBeUndefined();
    expect(written?.products[0]?.pmi).toBeUndefined();
    expect(stepOf(document, { includePmi: true }).rejected).toBeUndefined();
    expect(written?.products[0]?.pmi).toBeUndefined();
    expect((stepOf(document, { includePmi: true }).data as { pmi: { requested: number } }).pmi.requested).toBe(0);
  });

  it('refuses PMI in AP214 and skips the items of a solid that is not exported', () => {
    const { document, id } = plate();
    const applied = execute(document, 'apply_pmi_set', bracket(id)).document;
    const refused = stepOf(applied, { includePmi: true, schema: 'ap214' });
    expect(refused.error?.code).toBe('XCH_PMI_SCHEMA');
    expect(refused.affected).toEqual([]);
    const second = execute(applied, 'add_box', { size: [5, 5, 5] });
    const other = second.affected[0] as string;
    const result = stepOf(second.document, { includePmi: true, entityIds: [other] });
    expect(written?.products[0]?.pmi).toBeUndefined();
    const data = result.data as { pmi: { skipped: { reason: string }[] } };
    expect(data.pmi.skipped).toHaveLength(5);
    expect(data.pmi.skipped[0]?.reason).toContain(`solid '${id}' is not written`);
  });
});
