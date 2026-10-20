/** 03 GDT M6: the PMI read stage of import_step_exact (TR-GDT-15) on a scripted XDE import over the analytic plate face query. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExchangePmi, ImportedExchange } from '@core/geometry/kernelExchange';
import { createEmptyDocument } from '@core/model/types';
import type { PmiItem } from '@core/model/pmi';
import { fakeBrep, fakeStepText, fakeXdeKernel, importedBody, singlePartTree } from '../../helpers/fakeXdeKernel';
import { plateKernel } from '../../helpers/pmiPlateKernel';

const PART = { volume: 1000, area: 600, centroid: [5, 5, 5] as [number, number, number] };
const body = (): ReturnType<typeof importedBody> => importedBody(fakeBrep(PART.volume, PART.area, PART.centroid), { name: 'Plate' });
const text = fakeStepText([{ name: 'Plate', ...PART }]);

/** The XDE fake with the plate's exact topology and face query on every imported solid (11 faces: 6 planes and 5 cylinders, see plateKernel). */
function kernelFor(tree: ImportedExchange, plate = true): GeometryKernel {
  const kernel = fakeXdeKernel({ stepImport: tree }).kernel;
  if (!plate) return kernel;
  const analytic = plateKernel();
  return Object.assign(kernel, { faceQuery: analytic.faceQuery, topology: analytic.topology, tessellate: analytic.tessellate });
}

const withPmi = (pmi: ExchangePmi, solids = [body()], extra: Partial<ImportedExchange> = {}): ImportedExchange => {
  const tree = singlePartTree('Plate', solids);
  return { ...tree, products: [{ ...(tree.products[0] as ImportedExchange['products'][number]), pmi }], pmiUnmapped: 0, ...extra };
};

const run = (tree: ImportedExchange, params: Record<string, unknown> = {}, plate = true): CommandResult =>
  execute(
    createEmptyDocument(),
    'import_step_exact',
    { text, fileName: 'plate.stp', ...params },
    { ...defaultContext(), kernel: kernelFor(tree, plate) },
  );

const items = (result: CommandResult): PmiItem[] => (result.document.pmi?.order ?? []).map((id) => result.document.pmi!.items[id]!);
const reportOf = (result: CommandResult): { pmi?: Record<string, number>; reviewRequired: { reasons: string[] } } =>
  (result.data as { report: { pmi?: Record<string, number>; reviewRequired: { reasons: string[] } } }).report;

const PMI: ExchangePmi = {
  datums: [{ label: 'A', faces: [0] }],
  tolerances: [
    { characteristic: 'flatness', value: 0.05, diameterZone: false, faces: [1], datums: [] },
    { characteristic: 'position', value: 0.3, diameterZone: true, faces: [6], datums: ['A'] },
  ],
  dimensions: [
    { type: 'size_diameter', value: 6.6, tolerance: { plus: 0.3, minus: 0 }, faces: [6] },
    { type: 'location_linear_distance', value: 12, faces: [0], facesSecond: [1] },
  ],
};

describe('import_step_exact PMI stage', () => {
  it('attaches the transport PMI to the imported solid as review-required semantic items and records the import', () => {
    const result = run(withPmi(PMI));
    expect(result.rejected).toBeUndefined();
    const created = items(result);
    expect(created.map((item) => item.kind)).toEqual([
      'datum_feature',
      'geometric_tolerance',
      'geometric_tolerance',
      'size_dimension',
      'location_dimension',
    ]);
    expect(created.every((item) => item.review.required && item.review.reason?.includes('imported from plate.stp'))).toBe(true);
    expect(created[0]).toMatchObject({ label: 'A', feature: { entityId: 'mesh-1.1', faceIndices: [0], surface: 'plane' } });
    expect(created[2]).toMatchObject({ characteristic: 'position', zone: { value: 0.3, diametral: true }, datums: [{ label: 'A' }] });
    expect(created[3]).toMatchObject({ sizeKind: 'diameter', tolerance: { type: 'plusMinus', upper: 0.3, lower: -0 } });
    expect(created[4]).toMatchObject({ measure: 'distance', measured: 12, tolerance: { type: 'basic' } });
    expect(result.document.pmi?.import).toEqual({ source: 'plate.stp', items: 5, unresolved: 0, unmapped: 0 });
    expect(reportOf(result).pmi).toEqual({ items: 5, unresolved: 0, unmapped: 0 });
    expect(reportOf(result).reviewRequired.reasons).toContain('pmi_review_required');
    expect(result.summary).toContain('PMI: 5 semantic item(s) attached (review required), 0 unresolved, 0 unmapped.');
  });

  it('counts what it cannot attach: unknown faces, dimension types without a model form, a kernel without face queries', () => {
    const odd: ExchangePmi = {
      ...PMI,
      tolerances: [...PMI.tolerances, { characteristic: 'flatness', value: 0.1, diameterZone: false, faces: [99], datums: [] }],
      dimensions: [...PMI.dimensions, { type: 'size_curve_length', value: 5, faces: [] }],
    };
    const result = run(withPmi(odd));
    expect(items(result)).toHaveLength(5);
    expect(result.document.pmi?.import).toMatchObject({ items: 5, unmapped: 2 });
    const blind = run(withPmi(PMI), {}, false);
    expect(items(blind)).toEqual([]);
    expect(blind.document.pmi?.import).toEqual({ source: 'plate.stp', items: 0, unresolved: 0, unmapped: 5 });
    expect(blind.affected).toEqual(['mesh-1.1']);
  });

  it('numbers the faces of a product through its solids in order and attaches each item to its own solid', () => {
    const second: ExchangePmi = {
      datums: [{ label: 'A', faces: [0] }],
      tolerances: [{ characteristic: 'flatness', value: 0.05, diameterZone: false, faces: [11 + 1], datums: [] }],
      dimensions: [],
    };
    const result = run(withPmi(second, [body(), body()]));
    const [datum, flatness] = items(result);
    expect(datum?.kind === 'datum_feature' && datum.feature.entityId).toBe('mesh-1.1');
    expect(flatness?.kind === 'geometric_tolerance' && 'feature' in flatness.target && flatness.target.feature.entityId).toBe('mesh-1.2');
    expect(result.document.pmi?.import?.items).toBe(2);
  });

  it('flags a file nominal the B-rep disagrees with, and importPmi: false skips the stage entirely', () => {
    const wrong: ExchangePmi = { datums: [], tolerances: [], dimensions: [{ type: 'size_diameter', value: 9, faces: [6] }] };
    const flagged = items(run(withPmi(wrong)))[0];
    expect(flagged?.unverified?.reason).toContain('the file states nominal 9');
    const skipped = run(withPmi(PMI), { importPmi: false });
    expect(skipped.document.pmi).toBeUndefined();
    expect(reportOf(skipped).pmi).toBeUndefined();
    expect(reportOf(skipped).reviewRequired.reasons).not.toContain('pmi_review_required');
  });

  it('keeps an item unresolved when no sample of its face resolves, and counts everything unmapped when the solid cannot be opened or is inside a component', () => {
    const tree = withPmi(PMI);
    const base = kernelFor(tree);
    const analytic = plateKernel();
    const lost = Object.assign(base, {
      faceQuery: {
        ...analytic.faceQuery!,
        faceDetails: () =>
          analytic
            .faceQuery!.faceDetails({} as never)!
            .map((face) => ({ ...face, samples: [], centroid: [999, 999, 999] as [number, number, number] })),
      },
    });
    const far = execute(createEmptyDocument(), 'import_step_exact', { text, fileName: 'plate.stp' }, { ...defaultContext(), kernel: lost });
    expect(far.document.pmi?.import).toMatchObject({ items: 5, unresolved: 5 });
    const closed = Object.assign(kernelFor(tree), { topology: () => null });
    const shut = execute(
      createEmptyDocument(),
      'import_step_exact',
      { text, fileName: 'plate.stp' },
      { ...defaultContext(), kernel: closed },
    );
    expect(shut.document.pmi?.import).toMatchObject({ items: 0, unmapped: 5 });
    const single = withPmi(PMI);
    const asComponent: ImportedExchange = {
      ...single,
      products: [
        { name: 'Asm', assembly: true, layers: [], solids: [] },
        { ...(single.products[0] as ImportedExchange['products'][number]), name: 'Part' },
      ],
      occurrences: [1, 2].map((n) => ({ parent: 0, product: 1, name: `Part ${n}`, matrix: [1, 0, 0, n * 10, 0, 1, 0, 0, 0, 0, 1, 0] })),
      roots: [0],
    };
    const inside = run(asComponent);
    expect(inside.document.pmi?.import).toMatchObject({ items: 0, unmapped: 5 });
  });

  it('a product without PMI leaves the document without a pmi model', () => {
    const result = run(singlePartTree('Plate', [body()]));
    expect(result.document.pmi).toBeUndefined();
    expect(reportOf(result).pmi).toBeUndefined();
  });
});
