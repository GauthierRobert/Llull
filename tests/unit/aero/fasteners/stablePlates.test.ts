/** insert_fastener_stack cuts plates in place: plate ids and order slots survive, so a build_project loop can reuse the plate aliases. */
import { beforeAll, describe, expect, it } from 'vitest';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { FastenerStack } from '@aero/fasteners/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { ctxWith, dataOf, docWith, ok } from './fixtures';
import { isoMetricCatalogFile } from './isoMetric';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

const bolt = (point: unknown): Record<string, unknown> => ({
  command: 'insert_fastener_stack',
  params: { family: 'ISO4762', diameterDash: '6', stackIds: ['$pa', '$pb'], axisPoint: point, holeMode: 'cut_clearance' },
});

describe('plate identity across fastener inserts', () => {
  it('a 4-bolt pattern in a build_project loop on the same two plates succeeds and keeps the plate ids', () => {
    const doc = docWith(isoMetricCatalogFile());
    const actions = [
      { command: 'add_box', params: { size: [80, 80, 8], anchor: 'min', position: [0, 0, 0] }, as: 'pa' },
      { command: 'add_box', params: { size: [80, 80, 6], anchor: 'min', position: [0, 0, 8] }, as: 'pb' },
      { repeat: { count: 4, as: 'i' }, actions: [bolt(['=10+20*i', 40, 0])] },
    ];
    const result = ok(doc, 'build_project', { actions }, ctxWith(kernel));
    const stacks = Object.values(result.document.fasteners?.stacks ?? {});
    expect(stacks).toHaveLength(4);
    const layerSets = new Set(stacks.map((stack) => stack.layers.map((layer) => layer.entityId).join(',')));
    expect(layerSets.size).toBe(1);
    const [plateA, plateB] = [...layerSets][0]?.split(',') as [string, string];
    expect(result.document.entities[plateA]?.kind).toBe('mesh');
    expect(result.document.entities[plateB]?.kind).toBe('mesh');
    expect(result.document.order.filter((id) => id === plateA || id === plateB)).toEqual([plateA, plateB]);
    expect(result.document.order.slice(0, 2)).toEqual([plateA, plateB]);
  });

  it('keeps plate ids, material and order slot on a single insert, and the returned stack layers are the original ids', () => {
    let doc = docWith(isoMetricCatalogFile());
    const a = ok(doc, 'add_box', { size: [40, 40, 8], anchor: 'min', position: [0, 0, 0] });
    const b = ok(a.document, 'add_box', { size: [40, 40, 6], anchor: 'min', position: [0, 0, 8] });
    doc = b.document;
    const ids = [a.affected[0] as string, b.affected[0] as string];
    const result = ok(
      doc,
      'insert_fastener_stack',
      { family: 'ISO4762', diameterDash: '6', stackIds: ids, axisPoint: [20, 20, 0], holeMode: 'cut_clearance' },
      ctxWith(kernel),
    );
    const stack = dataOf(result)['stack'] as FastenerStack;
    expect(stack.layers.map((layer) => layer.entityId)).toEqual(ids);
    expect(result.affected.slice(-2)).toEqual(ids);
    expect(result.document.order.slice(0, 2)).toEqual(ids);
    expect(Object.keys(result.document.entities).filter((id) => id.startsWith('mesh-'))).toEqual([]);
  });
});
