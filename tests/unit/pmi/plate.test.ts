/** 03 GDT: the validation plate plan end to end on the analytic plate kernel (VC-GDT-01, 02, 03, 05, 06, 50, 54, 56). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { plateKernel } from '../../helpers/pmiPlateKernel';

interface Step {
  command: string;
  params: Record<string, unknown>;
  as?: string;
}
const validation = path.resolve(__dirname, '../../../docs/aerospace/03-gdt-mbd-pmi/validation');
const load = (file: string): Step[] => JSON.parse(readFileSync(path.join(validation, file), 'utf8')) as Step[];

interface PlanData {
  ok: boolean;
  steps: { index: number; command: string; ok: boolean; summary: string }[];
}
const runActions = (actions: Step[]): { document: CadDocument; data: PlanData; result: ReturnType<typeof execute> } => {
  const result = execute(createEmptyDocument(), 'build_project', { actions, onError: 'continue' });
  return { document: result.document, data: result.data as PlanData, result };
};

interface ListData {
  items: Array<{ id: string; kind: string; text: string; measured?: number; count?: number; feature?: { surface: string } }>;
}
const list = (doc: CadDocument, params: Record<string, unknown> = {}): ListData => execute(doc, 'list_pmi', params).data as ListData;

let kernel = plateKernel();
beforeEach(() => {
  kernel = plateKernel();
  setGeometryKernel(kernel);
});
afterEach(() => setGeometryKernel(null));

/** The plan up to the sheet: the analytic plate kernel has no STEP writer (the AP242 export runs in server/tests/gdtPmiRoundTrip.test.ts). */
const platePlan = (): Step[] => load('draft_plan_gdt_plate.json').filter((step) => step.command !== 'export_step_ap242');

describe('draft_plan_gdt_plate.json', () => {
  it('builds 3 datums, 2 sizes, 4 FCFs, 1 texture, 1 saved view and checks clean (VC-GDT-01)', () => {
    const { document, data } = runActions(platePlan());
    expect(data.steps.filter((s) => !s.ok).map((s) => `${s.command}: ${s.summary}`)).toEqual([]);
    const items = Object.values(document.pmi?.items ?? {});
    const count = (kind: string): number => items.filter((i) => i.kind === kind).length;
    expect([count('datum_feature'), count('size_dimension'), count('geometric_tolerance'), count('surface_texture')]).toEqual([3, 2, 4, 1]);
    expect(document.pmi?.savedViewOrder).toHaveLength(1);
    const listed = list(document);
    const sizes = listed.items.filter((i) => i.kind === 'size_dimension');
    expect(sizes.map((s) => [s.count, s.measured])).toEqual([
      [4, 6.6],
      [1, 20],
    ]);
    expect(listed.items.find((i) => i.text.startsWith('⌖'))?.text).toBe('⌖ | Ø0.3 Ⓜ | A | B | C');
    expect(listed.items.find((i) => i.text === '[A]')?.feature?.surface).toBe('plane');
    const check = execute(document, 'check_pmi', {});
    const report = check.data as { status: string; errors: unknown[]; stats: { items: number; reviewRequired: number } };
    expect(report.errors).toEqual([]);
    expect(report.stats).toMatchObject({ items: 10, reviewRequired: 10 });
    expect(report.status).toBe('warn');
    expect(check.summary).toContain('not approved by a qualified engineer');
  });

  it('every item is review-required with a reason (VC-GDT-56)', () => {
    const { document } = runActions(platePlan());
    for (const item of Object.values(document.pmi?.items ?? {})) {
      expect(item.review.required).toBe(true);
      expect(item.review.reason).toContain('not approved');
    }
  });

  it('replays to an identical document and follows a thickness edit (VC-GDT-02, 50)', () => {
    const { document } = runActions(platePlan());
    expect(execute(document, 'replay_history', {}).document.pmi).toEqual(document.pmi);
    setGeometryKernel(plateKernel({ thickness: 16 }));
    const after = execute(document, 'replay_history', {});
    const report = execute(after.document, 'check_pmi', {}).data as { errors: unknown[] };
    expect(report.errors).toEqual([]);
    const sizes = Object.values(after.document.pmi?.items ?? {}).flatMap((i) =>
      i.kind === 'size_dimension' ? [i.feature.ofSize?.measured] : [],
    );
    expect(sizes).toEqual([6.6, 20]);
  });

  it('check_pmi catches a face that changed type after a model edit (GDT_SURFACE_TYPE_CHANGED)', () => {
    const { document } = runActions(platePlan());
    setGeometryKernel(plateKernel({ thickness: 12, bottomAsBspline: true }));
    const report = execute(document, 'check_pmi', {}).data as { status: string; errors: Array<{ code: string }> };
    expect(report.status).toBe('fail');
    expect(report.errors.map((e) => e.code)).toContain('GDT_SURFACE_TYPE_CHANGED');
  });

  it('check_pmi reports not_run without exact topology and never throws', () => {
    const { document } = runActions(platePlan());
    setGeometryKernel(plateKernel({ thickness: 12, noFaceQuery: true }));
    const data = execute(document, 'check_pmi', {}).data as { resolution: string; errors: unknown[] };
    expect(data.resolution).toBe('not_run');
    expect(data.errors).toEqual([]);
  });
});

describe('draft_plan_gdt_rejections.json (VC-GDT-03, 54)', () => {
  it('accepts the first datum and rejects 5 actions with stable codes', () => {
    const { data, document } = runActions(load('draft_plan_gdt_rejections.json'));
    const codes = data.steps.filter((s) => !s.ok).map((s) => /(GDT_[A-Z_]+)/.exec(s.summary)?.[1]);
    expect(codes).toEqual([
      'GDT_DATUM_DUPLICATE',
      'GDT_DATUM_UNDEFINED',
      'GDT_MC_ON_NON_FOS',
      'GDT_ZONE_NON_POSITIVE',
      'GDT_POINT_NOT_ON_FACE',
    ]);
    expect(Object.values(document.pmi?.items ?? {})).toHaveLength(1);
  });
});

describe('location dimensions (VC-GDT-06)', () => {
  const part = (): { document: CadDocument; id: string } => {
    const built = runActions(platePlan().slice(0, 11));
    return { document: built.document, id: built.document.order.at(-1) as string };
  };

  it('measures plane to axis 20 and plane to plane 80, basic', () => {
    const { document, id } = part();
    const axis = execute(document, 'add_location_dimension', {
      entityId: id,
      from: [[60, 0, 6]],
      to: [[16.7, 20, 6]],
      measure: 'distance',
    });
    const planes = execute(axis.document, 'add_location_dimension', {
      entityId: id,
      from: [[60, 0, 6]],
      to: [[60, 80, 6]],
      measure: 'distance',
    });
    const items = list(planes.document, { kind: 'location_dimension' }).items;
    expect(items.map((i) => [i.measured, i.text])).toEqual([
      [20, '[20]'],
      [80, '[80]'],
    ]);
  });

  it('angle between perpendicular planes is 90 degrees; refuses a skew distance and the same feature', () => {
    const { document, id } = part();
    const angle = execute(document, 'add_location_dimension', { entityId: id, from: [[60, 0, 6]], to: [[0, 40, 6]], measure: 'angle' });
    expect(list(angle.document, { kind: 'location_dimension' }).items[0]?.measured).toBeCloseTo(90, 9);
    expect(
      execute(document, 'add_location_dimension', { entityId: id, from: [[60, 0, 6]], to: [[0, 40, 6]], measure: 'distance' }).error?.code,
    ).toBe('GDT_LOCATION_INVALID');
    expect(
      execute(document, 'add_location_dimension', { entityId: id, from: [[60, 0, 6]], to: [[30, 0, 3]], measure: 'distance' }).error?.code,
    ).toBe('GDT_LOCATION_SAME_FEATURE');
  });
});
