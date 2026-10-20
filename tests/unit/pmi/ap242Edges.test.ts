/** 03 GDT M6: failure and edge paths of apply_pmi_set, xcafMapping and the PMI write stage (unresolved, unmapped, lossy, unwritable). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import type { PmiFeature, PmiItem } from '@core/model/pmi';
import type { ExchangeWriteRequest } from '@core/geometry/kernelExchange';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { fromExchangePmi, toExchangePmi } from '@core/commands/pmi/xcafMapping';
import { plateKernel } from '../../helpers/pmiPlateKernel';

const BOTTOM = [30, 10, 0] as const;
const FRONT = [60, 0, 6] as const;
const TOP = [10, 10, 12] as const;
const BORE = [50, 40, 6] as const;

let written: ExchangeWriteRequest | null = null;
beforeEach(() => {
  written = null;
  setGeometryKernel(
    Object.assign(plateKernel(), {
      writeExchange: (request: ExchangeWriteRequest): string => {
        written = request;
        return "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AP242'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
      },
    }),
  );
});
afterEach(() => setGeometryKernel(null));

function plate(): { document: CadDocument; id: string } {
  const box = execute(createEmptyDocument(), 'add_box', { size: [120, 80, 12] });
  return { document: box.document, id: box.affected[0] as string };
}
const items = (doc: CadDocument): PmiItem[] => (doc.pmi?.order ?? []).map((id) => doc.pmi!.items[id]!);

describe('apply_pmi_set on a solid the kernel cannot open', () => {
  it('keeps every kind unresolved and unverified', () => {
    const { document, id } = plate();
    setGeometryKernel(Object.assign(plateKernel(), { topology: () => null }));
    const result = execute(document, 'apply_pmi_set', {
      entityId: id,
      items: [
        { kind: 'datum_feature', label: 'A', facesNear: [BOTTOM] },
        { kind: 'geometric_tolerance', characteristic: 'flatness', zone: { value: 0.1 }, facesNear: [TOP] },
        { kind: 'size_dimension', sizeKind: 'diameter', tolerance: { type: 'basic' }, facesNear: [BORE] },
        { kind: 'location_dimension', measure: 'angle', from: [BOTTOM], to: [FRONT] },
      ],
    });
    expect(result.data).toEqual({ created: 4, unresolved: 4, unverified: 4 });
    expect(items(result.document).every((item) => item.unverified?.reason.includes('cannot be opened'))).toBe(true);
    expect(result.document.pmi?.import).toMatchObject({ unresolved: 4 });
  });
});

const place = { plane: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] }, position: [0, 0], auto: true };
const feature: PmiFeature = {
  entityId: 'e',
  facesNear: [[0, 0, 0]],
  faceIndices: [3],
  surface: 'plane',
  ofSize: { kind: 'cylinder', measured: 10 },
};
const make = (item: Record<string, unknown>): PmiItem => ({ placement: place, review: { required: false }, ...item }) as unknown as PmiItem;

describe('xcafMapping edge cases', () => {
  it('maps the remaining size and location kinds, lists lossy attributes and unwritable items', () => {
    const noSize: PmiFeature = { entityId: 'e', facesNear: [[0, 0, 0]], faceIndices: [3], surface: 'sphere' };
    const none: PmiFeature = { ...feature, faceIndices: [] };
    const all: PmiItem[] = [
      make({ id: 'd', kind: 'datum_feature', label: 'A', feature }),
      make({
        id: 'r',
        kind: 'size_dimension',
        sizeKind: 'radius',
        tolerance: { type: 'fit', code: 'H7', upper: 0.02, lower: 0 },
        count: 1,
        sizeModifiers: ['E'],
        feature,
      }),
      make({ id: 'w', kind: 'size_dimension', sizeKind: 'width', tolerance: { type: 'basic' }, count: 1, feature }),
      make({ id: 'n', kind: 'size_dimension', sizeKind: 'spherical_diameter', tolerance: { type: 'basic' }, count: 1, feature: noSize }),
      make({ id: 'a', kind: 'location_dimension', measure: 'angle', measured: 90, tolerance: { type: 'basic' }, from: feature, to: none }),
      make({
        id: 'l',
        kind: 'location_dimension',
        measure: 'distance',
        measured: 5,
        tolerance: { type: 'limits', upper: 5.2, lower: 4.9 },
        from: feature,
        to: { ...feature, faceIndices: [4] },
      }),
      make({
        id: 'g',
        kind: 'geometric_tolerance',
        characteristic: 'profile_surface',
        target: { feature },
        materialCondition: 'MMC',
        modifiers: ['all_around'],
        zone: { value: 0.2, spherical: true, projectedLength: 1, unequallyDisposed: 0.1, maxValue: 0.3 },
        datums: [{ label: 'A', boundary: 'MMB' }],
        compositeOf: 'x',
      }),
      make({
        id: 'z',
        kind: 'geometric_tolerance',
        characteristic: 'flatness',
        target: { feature: none },
        materialCondition: 'RFS',
        modifiers: [],
        zone: { value: 0.1 },
        datums: [],
      }),
      make({ id: 't', kind: 'datum_target', label: 'A', targetNumber: 1, targetKind: 'point', feature }),
    ];
    const out = toExchangePmi(all, (f) => f.faceIndices);
    expect(out.pmi?.dimensions.map((d) => d.type)).toEqual(['size_radius', 'size_thickness', 'location_linear_distance']);
    expect(out.pmi?.dimensions[0]).toMatchObject({ value: 5, tolerance: { plus: 0.02 } });
    expect(out.pmi?.dimensions[2]?.tolerance?.plus).toBeCloseTo(0.2, 12);
    expect(out.lossy.find((l) => l.id === 'g')?.lost).toEqual([
      'materialCondition',
      'modifiers',
      'zone.spherical',
      'zone.projectedLength',
      'zone.unequallyDisposed',
      'zone.maxValue',
      'datum boundary',
      'compositeOf',
    ]);
    expect(out.lossy.find((l) => l.id === 'r')?.lost).toEqual(['sizeModifiers']);
    expect(out.skipped.map((s) => s.id)).toEqual(['n', 'a', 'z', 't']);
  });

  it('counts source items whose faces cannot be placed or have no model form', () => {
    const { drafts, unmapped } = fromExchangePmi(
      {
        datums: [{ label: 'A', faces: [0] }],
        tolerances: [{ characteristic: 'position', value: 1, diameterZone: false, faces: [0], datums: [] }],
        dimensions: [
          { type: 'size_radius', value: 1, faces: [0] },
          { type: 'location_angular', value: 1, faces: [0] },
          { type: 'size_angular', value: 1, faces: [0] },
        ],
      },
      () => null,
    );
    expect([drafts.length, unmapped]).toEqual([0, 5]);
    const some = fromExchangePmi(
      {
        datums: [],
        tolerances: [],
        dimensions: [
          { type: 'location_angular', value: 30, tolerance: { plus: 0, minus: 0 }, faces: [0], facesSecond: [1] },
          { type: 'size_angular', value: 1, faces: [0] },
        ],
      },
      (faces) => faces.map((): [number, number, number] => [0, 0, 0]),
    );
    expect(some.drafts).toMatchObject([{ kind: 'location_dimension', measure: 'angle', tolerance: { type: 'basic' } }]);
    expect(some.unmapped).toBe(1);
  });
});

describe('PMI write stage edge cases', () => {
  const stepOf = (doc: CadDocument): ReturnType<typeof execute> =>
    execute(doc, 'export_step_ap242', { includeValidationProperties: false, includePmi: true });

  it('lists a datum on no face and writes nothing for it', () => {
    const { document, id } = plate();
    const applied = execute(document, 'apply_pmi_set', {
      entityId: id,
      items: [{ kind: 'datum_feature', label: 'A', facesNear: [[500, 500, 500]] }],
    }).document;
    const pmi = (stepOf(applied).data as { pmi: { skipped: { reason: string }[]; written: string[] } }).pmi;
    expect(pmi.skipped.map((s) => s.reason)).toEqual(['the feature resolves to no face']);
    expect(pmi.written).toEqual([]);
    expect(written?.products[0]?.pmi).toBeUndefined();
  });

  it('skips an item whose solid is not an entity of the document and one whose frame names an unwritten datum', () => {
    const { document, id } = plate();
    const applied = execute(document, 'apply_pmi_set', {
      entityId: id,
      items: [{ kind: 'geometric_tolerance', characteristic: 'position', zone: { value: 0.1 }, datums: ['Q'], facesNear: [TOP] }],
    }).document;
    const reasons = (doc: CadDocument): string[] =>
      (stepOf(doc).data as { pmi: { skipped: { reason: string }[] } }).pmi.skipped.map((s) => s.reason);
    expect(reasons(applied)).toEqual(['datum Q is not a written datum feature']);
    const orphan = { ...applied, pmi: { ...applied.pmi!, items: { ...applied.pmi!.items } } } as CadDocument;
    const only = Object.values(orphan.pmi!.items)[0] as unknown as { target: { feature: PmiFeature } };
    (orphan.pmi!.items as Record<string, unknown>)[orphan.pmi!.order[0] as string] = {
      ...only,
      target: { feature: { ...only.target.feature, entityId: 'ghost' } },
    };
    expect(reasons(orphan)[0]).toContain("solid 'ghost' is not written");
  });
});
