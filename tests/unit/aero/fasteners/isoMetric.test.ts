/** Metric ISO set (ISO 4762 / 4014 / 4032 / 7089 / 273): import, M8 selection, M8 stack insert with clearance hole, layout check. */
import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import type { FastenerStack } from '@core/model/fasteners';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { ctxWith, dataOf, docWith, ok } from './fixtures';
import { isoMetricCatalogFile } from './isoMetric';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

const m8 = { family: 'ISO4762', diameterDash: '8', nut: 'ISO4032', washer: 'ISO7089' };

function plates(): { doc: CadDocument; ids: string[] } {
  const first = ok(docWith(isoMetricCatalogFile()), 'add_box', { size: [60, 60, 10], anchor: 'min', position: [0, 0, 0] });
  const second = ok(first.document, 'add_box', { size: [60, 60, 8], anchor: 'min', position: [0, 0, 10] });
  return { doc: second.document, ids: [first.affected[0] as string, second.affected[0] as string] };
}

describe('ISO metric catalogue', () => {
  it('imports, lists M4-M12 for both bolt families and marks every value typical/unverified', () => {
    const doc = docWith(isoMetricCatalogFile());
    const families = Object.values(doc.fasteners?.catalogs ?? {});
    expect(families.map((f) => f.id).sort()).toEqual(['ISO4014', 'ISO4032', 'ISO4762', 'ISO7089']);
    const bolt = families.find((f) => f.id === 'ISO4762');
    expect(bolt?.sizes.map((s) => s.dash)).toEqual(['4', '5', '6', '8', '10', '12']);
    expect(bolt?.provenance?.note).toContain('typical/nominal');
    expect(bolt?.sizes[3]?.dims['clearanceHoleDiameter']).toMatchObject({ min: 8.4, nominal: 9, max: 10 });
    expect(bolt?.sizes[3]?.dims['clearanceHoleDiameter']?.provenance?.citation).toContain('ISO 273');
  });

  it('select_fastener picks the M8 grip, length, no shim and checks protrusion for an 18 mm stack', () => {
    const { doc } = plates();
    const result = ok(doc, 'select_fastener', { ...m8, stack: { value: 18, unit: 'mm' } });
    const data = dataOf(result);
    expect(data['partNumber']).toBe('ISO4762-M8x18');
    expect(data['gripIn']).toBeCloseTo(18 / 25.4, 6);
    expect(data['lengthIn']).toBeCloseTo((18 + 22) / 25.4, 6);
    expect(data['washers']).toEqual([]);
    expect((data['nut'] as { partNumber: string }).partNumber).toBe('ISO4032-M8');
    expect((data['protrusion'] as { status: string }).status).toBe('ok');
  });

  it('shims a sub-grip gap with an ISO 7089 washer and refuses a stack beyond the catalogue grip range', () => {
    const { doc } = plates();
    const shimmed = ok(doc, 'select_fastener', { ...m8, stack: { value: 17.5, unit: 'mm' } });
    expect(dataOf(shimmed)['partNumber']).toBe('ISO4762-M8x18');
    expect((dataOf(shimmed)['washers'] as Array<{ partNumber: string }>).map((w) => w.partNumber)).toEqual(['ISO7089(1.6)']);
    const far = execute(doc, 'select_fastener', { ...m8, stack: { value: 400, unit: 'mm' } });
    expect(far.error?.code).toBe('FAST_STACK_OUT_OF_RANGE');
    expect(far.affected).toEqual([]);
  });

  it('inserts an M8 stack with the ISO 273 medium clearance hole (9 mm), then check_fastener_layout passes', () => {
    const { doc, ids } = plates();
    const result = ok(
      doc,
      'insert_fastener_stack',
      { ...m8, stackIds: ids, axisPoint: [30, 30, 0], holeMode: 'cut_clearance' },
      ctxWith(kernel),
    );
    const stack = dataOf(result)['stack'] as FastenerStack;
    expect(stack.holeDiameter).toBeCloseTo(9, 9);
    expect(stack.fastener.partNumber).toBe('ISO4762-M8x18');
    expect(stack.nut?.partNumber).toBe('ISO4032-M8');
    expect(stack.layers.map((l) => l.entityId)).toEqual(ids);
    const check = ok(result.document, 'check_fastener_layout', {});
    expect(dataOf(check)['status']).toBe('pass');
  });

  it('refuses close-tolerance cutting for ISO sizes (no close-tolerance hole listed) and changes nothing', () => {
    const { doc, ids } = plates();
    const result = execute(
      doc,
      'insert_fastener_stack',
      { ...m8, stackIds: ids, axisPoint: [30, 30, 0], holeMode: 'cut_close_tolerance' },
      ctxWith(kernel),
    );
    expect(result.error?.code).toBe('FAST_HOLE_DIAMETER_UNKNOWN');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });
});
