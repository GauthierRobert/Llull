/** Live OpenCascade: a nested, scaled assembly exports as shared products (not one baked product per instance) and re-imports faithfully. */

import { it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult } from '@core/commands/types';
import { liveKernels, describeNative } from './kernelTestSupport';

const kernels = liveKernels();

describeNative('occt export_step_ap242 nested scaled assembly', () => {
  it('shares the scaled sub-part across instances, bakes only the non-uniform instance, and re-imports at the same volumes and centroids', () => {
    const ctx = { ...defaultContext(), kernel: kernels.occt };
    const run = (doc: CadDocument, name: string, params: Record<string, unknown>): CommandResult => {
      const result = execute(doc, name, params, ctx);
      expect(result.rejected, result.summary).toBeUndefined();
      return result;
    };
    const box = run(createEmptyDocument(), 'add_box', { size: [10, 6, 4], position: [1, 2, 3] });
    const rod = run(box.document, 'create_component', { name: 'Rod', entityIds: box.affected, componentId: 'comp-rod' });
    const scaled = run(rod.document, 'insert_instance', { componentId: 'comp-rod', scale: [2, 2, 2], position: [30, 0, 0] });
    const big = run(scaled.document, 'create_component', { name: 'Big', entityIds: scaled.affected, componentId: 'comp-big' });
    let doc = big.document;
    for (const [position, rotation] of [
      [
        [100, 0, 0],
        [0, 0, 0.5],
      ],
      [
        [200, 50, 0],
        [0.3, 0.2, 1],
      ],
    ] as [Vec3, Vec3][])
      doc = run(doc, 'insert_instance', { componentId: 'comp-big', position, rotation }).document;
    doc = run(doc, 'insert_instance', { componentId: 'comp-rod', scale: [2, 1, 3], position: [0, 100, 0] }).document;

    // a nested part under a scaled parent: Pair holds an unscaled Rod at +30 in x, used at scale 2 (the nested placement must become +60)
    const holder = run(doc, 'insert_instance', { componentId: 'comp-rod', position: [30, 0, 0] });
    const pair = run(holder.document, 'create_component', { name: 'Pair', entityIds: holder.affected, componentId: 'comp-pair' });
    doc = run(pair.document, 'insert_instance', { componentId: 'comp-pair', scale: [2, 2, 2], position: [0, -100, 0] }).document;

    const exported = run(doc, 'export_step_ap242', { schema: 'ap214', includeValidationProperties: false });
    const data = exported.data as { step: string; entityIds: string[]; assembly: { products: number; occurrences: number } };
    // products: Rod, Big, Rod x2 (shared by every Big and by Pair x2), Rod 2x1x3 (baked), Pair, Pair x2
    // occurrences: Rod, 3 x Big, the skewed Rod, Pair, Pair x2
    expect(data.assembly).toEqual({ products: 6, occurrences: 7 });
    expect(data.entityIds.some((id) => id.startsWith('expanded::'))).toBe(false);
    expect(new Set(data.entityIds).size).toBe(data.entityIds.length);
    expect(data.entityIds).toEqual(doc.order.filter((id) => doc.entities[id]?.kind === 'instance'));

    const imported = run(createEmptyDocument(), 'import_step_exact', { text: data.step, assembly: false });
    const props = (d: CadDocument, id: string): { volume: number; centroid: Vec3 } =>
      run(d, 'mass_properties', { entityId: id }).data as { volume: number; centroid: Vec3 };
    expect(imported.affected).toHaveLength(7);
    const volumes = imported.affected.map((id) => props(imported.document, id).volume).sort((a, b) => a - b);
    const expected = doc.order.map((id) => props(doc, id).volume).sort((a, b) => a - b);
    volumes.forEach((volume, index) => expect(Math.abs(volume - expected[index]!) / expected[index]!).toBeLessThan(1e-6));
    const want = doc.order.map((id) => props(doc, id).centroid);
    for (const id of imported.affected) {
      const got = props(imported.document, id).centroid;
      expect(want.some((c) => c.every((v, k) => Math.abs(v - got[k]!) < 1e-5))).toBe(true);
    }
  }, 240_000);
});
