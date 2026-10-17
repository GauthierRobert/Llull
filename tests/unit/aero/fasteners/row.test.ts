/** 08 MAT M7: insert_fastener_row (VC-MAT-12) and check_fastener_layout (regrip, pitch, missing layers). Manifold kernel. */
import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { expectPure } from '../../../helpers/expectNoOp';
import { ctxWith, dataOf, docWith, inchDocument, ok, sampleCatalogFile } from './fixtures';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

interface Sheets {
  doc: CadDocument;
  ids: string[];
}

/** Two 0.0625 in sheets (3 x 1 in) stacked: a 0.125 in rivet stack. */
function sheets(): Sheets {
  const first = ok(docWith(sampleCatalogFile(), inchDocument()), 'add_box', { size: [3, 1, 0.0625], anchor: 'min', position: [0, 0, 0] });
  const second = ok(first.document, 'add_box', { size: [3, 1, 0.0625], anchor: 'min', position: [0, 0, 0.0625] });
  return { doc: second.document, ids: [first.affected[0] as string, second.affected[0] as string] };
}

const rowParams = (ids: string[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  family: 'MS20470',
  diameterDash: '4',
  codes: { material: 'AD' },
  stackIds: ids,
  from: [0.5, 0.5, 0],
  to: [1.4, 0.5, 0],
  holeDiameter: { value: 0.129, unit: 'in' },
  ...extra,
});

describe('insert_fastener_row (VC-MAT-12)', () => {
  it('refuses a row below 3 D pitch and 2 D edge distance with both reasons, changing nothing', () => {
    const { doc, ids } = sheets();
    const result = execute(
      doc,
      'insert_fastener_row',
      rowParams(ids, { pitch: { value: 0.3, unit: 'in' }, edgeDistance: { value: 0.2, unit: 'in' } }),
      ctxFor(),
    );
    expect(result.document).toBe(doc);
    expect(result.error).toMatchObject({ code: 'FAST_PITCH', paths: ['pitch', 'edgeDistance'] });
    expect(result.error?.remediation).not.toBe('');
    const violations = dataOf(result)['violations'] as Array<{ code: string; valueIn: number; minIn: number }>;
    expect(violations.map((v) => v.code)).toEqual(['FAST_PITCH', 'FAST_EDGE_DISTANCE']);
    expect(violations[0]).toMatchObject({ valueIn: 0.3, minIn: 0.375 });
    expect(violations[1]).toMatchObject({ valueIn: 0.2, minIn: 0.25 });
    expect(result.summary).toContain('3 D');
    expect(result.summary).toContain('2 D');
  });

  it('with allowViolations places the row and reports the two warnings; stacks share a rowId and follow the cut plates', () => {
    const { doc, ids } = sheets();
    const result = ok(
      doc,
      'insert_fastener_row',
      rowParams(ids, { pitch: { value: 0.3, unit: 'in' }, edgeDistance: { value: 0.2, unit: 'in' }, allowViolations: true }),
      ctxFor(),
    );
    const data = dataOf(result);
    expect((data['warnings'] as Array<{ code: string }>).map((w) => w.code)).toEqual(['FAST_PITCH', 'FAST_EDGE_DISTANCE']);
    expect(data['count']).toBe(4);
    const stacks = (data['stackIds'] as string[]).map((id) => result.document.fasteners?.stacks[id]);
    expect(stacks).toHaveLength(4);
    expect(new Set(stacks.map((stack) => stack?.rowId)).size).toBe(1);
    expect(stacks[0]?.rowId).toBe(data['rowId']);
    expect(result.document.featureHistory.at(-1)?.name).toBe('insert_fastener_row');
    expect(result.document.featureHistory.length).toBe(doc.featureHistory.length + 1);
    const lastLayers = stacks[3]?.layers.map((layer) => layer.entityId);
    for (const stack of stacks) expect(stack?.layers.map((layer) => layer.entityId)).toEqual(lastLayers);
    for (const id of lastLayers ?? []) expect(result.document.entities[id]?.kind).toBe('mesh');
    expect(ids.every((id) => result.document.entities[id] === undefined)).toBe(true);
    const positions = stacks.map((stack) => result.document.entities[stack?.fastener.instanceId ?? '']?.position[0] ?? 0);
    expect(positions.map((x) => Math.round(x * 1000) / 1000)).toEqual([0.5, 0.8, 1.1, 1.4]);
    const layout = dataOf(execute(result.document, 'check_fastener_layout', {}));
    expect(layout['status']).toBe('warn');
    expect((layout['items'] as Array<{ code: string }>).filter((item) => item.code === 'FAST_PITCH')).toHaveLength(3);
  });

  it('places a conforming row by count, with no warnings and a derived pitch; is pure', () => {
    const { doc, ids } = sheets();
    const params = rowParams(ids, { count: 3, edgeDistance: { value: 0.3, unit: 'in' } });
    const result = ok(doc, 'insert_fastener_row', params, ctxFor());
    const data = dataOf(result);
    expect(data).toMatchObject({ count: 3, minPitchIn: 0.375, minEdgeDistanceIn: 0.25, warnings: [] });
    expect(data['pitchIn']).toBeCloseTo(0.45, 9);
    expect(result.affected.length).toBe(3 * 1 + 3 * 2);
    expect(result.summary).toContain('3 × MS20470AD4-5');
    expectPure(doc, () => execute(doc, 'insert_fastener_row', params, ctxFor()));
    const one = ok(doc, 'insert_fastener_row', rowParams(ids, { count: 1 }), ctxFor());
    expect(dataOf(one)['pitchIn']).toBeNull();
  });

  it('checks bolt rows only against minPitch / minEdgeDistance when given', () => {
    const { doc, ids } = sheets();
    const bolts = (extra: Record<string, unknown>): Record<string, unknown> => ({
      family: 'NAS6203-6220',
      diameterDash: '3',
      stackIds: ids,
      from: [0.5, 0.5, 0],
      to: [1.4, 0.5, 0],
      holeMode: 'none',
      washer: 'NAS1149',
      ...extra,
    });
    const unchecked = ok(doc, 'insert_fastener_row', bolts({ pitch: { value: 0.2, unit: 'in' } }), ctxFor());
    expect(dataOf(unchecked)['minPitchIn']).toBeNull();
    const refused = execute(
      doc,
      'insert_fastener_row',
      bolts({
        pitch: { value: 0.2, unit: 'in' },
        minPitch: { value: 0.5, unit: 'in' },
        edgeDistance: { value: 0.1, unit: 'in' },
        minEdgeDistance: { value: 0.3, unit: 'in' },
      }),
      ctxFor(),
    );
    expect(refused.error?.code).toBe('FAST_PITCH');
    expect((dataOf(refused)['violations'] as unknown[]).length).toBe(2);
    expect(refused.document).toBe(doc);
  });

  it('refuses malformed rows with FAST_ROW_INVALID', () => {
    const { doc, ids } = sheets();
    const code = (extra: Record<string, unknown>): string | undefined =>
      execute(doc, 'insert_fastener_row', rowParams(ids, extra), ctxFor()).error?.code;
    expect(code({})).toBe('FAST_ROW_INVALID');
    expect(code({ pitch: { value: 0.5, unit: 'in' }, count: 2 })).toBe('FAST_ROW_INVALID');
    expect(code({ count: 0 })).toBe('FAST_ROW_INVALID');
    expect(code({ count: 501 })).toBe('FAST_ROW_INVALID');
    expect(code({ pitch: { value: 0, unit: 'in' } })).toBe('FAST_ROW_INVALID');
    expect(code({ pitch: { value: 0.0001, unit: 'in' } })).toBe('FAST_ROW_INVALID');
    expect(code({ pitch: { value: 1, unit: 'furlong' } })).toBe('FAST_ROW_INVALID');
    expect(code({ count: 2, from: [1, 1, 0], to: [1, 1, 0] })).toBe('FAST_ROW_INVALID');
  });

  it('refuses a failing selection, an unknown hole diameter, a position that misses the plates and a failing cut, placing nothing', () => {
    const { doc, ids } = sheets();
    const run = (extra: Record<string, unknown>, ctx = ctxFor()): ReturnType<typeof execute> =>
      execute(doc, 'insert_fastener_row', rowParams(ids, { count: 2, ...extra }), ctx);
    expect(run({ family: 'NOPE' }).error?.code).toBe('FAST_FAMILY_UNKNOWN');
    expect(run({ holeDiameter: undefined }).error?.code).toBe('FAST_HOLE_DIAMETER_UNKNOWN');
    const off = run({ to: [5, 0.5, 0] });
    expect(off.error?.code).toBe('FAST_AXIS_MISS');
    expect(off.summary).toContain('position 2');
    expect(off.document).toBe(doc);
    const broken: GeometryKernel = { ...kernel, evaluate: (recipe) => (recipe.op === 'boolean' ? null : kernel.evaluate(recipe)) };
    const failed = run({}, ctxFor(broken));
    expect(failed.error?.code).toBe('FAST_HOLE_CUT_FAILED');
    expect(failed.document).toBe(doc);
    expect(execute(doc, 'insert_fastener_row', rowParams(ids, { count: 2 }), ctxWith(null)).error?.code).toBe('CMD_KERNEL_UNAVAILABLE');
  });
});

const codesOf = (result: ReturnType<typeof execute>): string[] =>
  (dataOf(result)['items'] as Array<{ code: string }>).map((item) => item.code);

describe('check_fastener_layout', () => {
  function oneRivet(): { doc: CadDocument; ids: string[]; stackId: string } {
    const { doc, ids } = sheets();
    const placed = ok(
      doc,
      'insert_fastener_stack',
      {
        family: 'MS20470',
        diameterDash: '4',
        codes: { material: 'AD' },
        stackIds: ids,
        axisPoint: [0.5, 0.5, 0],
        holeDiameter: { value: 0.129, unit: 'in' },
      },
      ctxFor(),
    );
    return { doc: placed.document, ids, stackId: (dataOf(placed)['stackId'] as string) ?? '' };
  }

  it('passes on a fresh stack even though the plates now have a hole on the axis', () => {
    const { doc, stackId } = oneRivet();
    const result = execute(doc, 'check_fastener_layout', {});
    expect(dataOf(result)).toMatchObject({ status: 'pass', stacksChecked: 1, items: [] });
    expect(result.error).toBeUndefined();
    expect(execute(doc, 'check_fastener_layout', { stackIds: [stackId] }).document).toBe(doc);
    expectPure(doc, () => execute(doc, 'check_fastener_layout', {}));
  });

  it('passes trivially when there are no stacks', () => {
    expect(dataOf(execute(sheets().doc, 'check_fastener_layout', {}))).toMatchObject({ status: 'pass', stacksChecked: 0 });
  });

  it('warns FAST_REGRIP_NEEDED when a plate got thicker after the insert', () => {
    const { doc, ids } = sheets();
    const placed = ok(
      doc,
      'insert_fastener_stack',
      { family: 'MS20470', diameterDash: '4', codes: { material: 'AD' }, stackIds: ids, axisPoint: [0.5, 0.5, 0], holeMode: 'none' },
      ctxFor(),
    );
    const plate = placed.document.entities[ids[1] as string];
    if (plate?.kind !== 'box') throw new Error('expected a box');
    const thicker: CadDocument = {
      ...placed.document,
      entities: { ...placed.document.entities, [plate.id]: { ...plate, size: [3, 1, 0.1], position: [1.5, 0.5, 0.0625 + 0.05] } },
    };
    const result = execute(thicker, 'check_fastener_layout', {});
    expect(dataOf(result)['status']).toBe('warn');
    const item = (dataOf(result)['items'] as Array<{ code: string; severity: string; values: Record<string, number> }>)[0];
    expect(item).toMatchObject({ code: 'FAST_REGRIP_NEEDED', severity: 'warning' });
    expect(item?.values['recordedIn']).toBeCloseTo(0.125, 9);
    expect(item?.values['measuredIn']).toBeCloseTo(0.1625, 9);
    expect(result.error).toBeUndefined();
  });

  it('fails with FAST_LAYER_MISSING, FAST_LAYER_GAP, FAST_AXIS_MISS and FAST_INSTANCE_MISSING when the model changed under the stack', () => {
    const { doc, stackId } = oneRivet();
    const stack = doc.fasteners?.stacks[stackId];
    const [first, second] = stack?.layers.map((layer) => layer.entityId) ?? [];
    const deleted = execute(doc, 'delete_entities', { ids: [second] }).document;
    const missing = execute(deleted, 'check_fastener_layout', {});
    expect(dataOf(missing)['status']).toBe('fail');
    expect(missing.error).toBeUndefined();
    expect(
      (dataOf(missing)['items'] as Array<{ code: string; stackIds: string[] }>).find((i) => i.code === 'FAST_LAYER_MISSING')?.stackIds,
    ).toEqual([stackId]);

    const apart = execute(doc, 'move_entities', { ids: [second], delta: [0, 0, 0.3] }).document;
    const gap = execute(apart, 'check_fastener_layout', {});
    expect(gap.error).toBeUndefined();
    expect(codesOf(gap)).toContain('FAST_LAYER_GAP');

    const aside = execute(doc, 'move_entities', { ids: [first, second], delta: [10, 0, 0] }).document;
    expect(codesOf(execute(aside, 'check_fastener_layout', {}))).toContain('FAST_AXIS_MISS');

    const lost = stack?.fastener.instanceId ?? '';
    const withoutBolt: CadDocument = { ...doc, entities: Object.fromEntries(Object.entries(doc.entities).filter(([id]) => id !== lost)) };
    expect(codesOf(execute(withoutBolt, 'check_fastener_layout', {}))).toContain('FAST_INSTANCE_MISSING');
  });

  it('flags representative geometry and refuses unknown stack ids', () => {
    const { doc, ids } = sheets();
    const placed = ok(
      doc,
      'insert_fastener_stack',
      { family: 'MS20470', diameterDash: '3', codes: { material: 'AD' }, stackIds: ids, axisPoint: [0.5, 0.5, 0], holeMode: 'none' },
      ctxFor(),
    );
    const items = dataOf(execute(placed.document, 'check_fastener_layout', {}))['items'] as Array<{ code: string }>;
    expect(items.map((item) => item.code)).toEqual(['FAST_GEOMETRY_REPRESENTATIVE']);
    const unknown = execute(placed.document, 'check_fastener_layout', { stackIds: ['fst-nope'] });
    expect(unknown.error).toMatchObject({ code: 'FAST_STACK_NOT_FOUND', ids: ['fst-nope'] });
    expect(dataOf(unknown)['status']).toBe('fail');
  });
});

function ctxFor(k: GeometryKernel = kernel): ReturnType<typeof ctxWith> {
  return ctxWith(k);
}
