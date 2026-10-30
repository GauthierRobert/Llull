/**
 * VC-WRP-32 (03 WRP FR-WRP-48, DES-3c) on the real native kernel: the embossed and debossed cylinders of the pack plan
 * `target_cylinder_rect_emboss_deboss` are written to STEP (AP242, the XDE writer) and read back with `import_step_exact`: the read solid has exact
 * faces (the same face count) and the same exact volume within 1e-6 relative, so the volume change of the emboss survives the exchange.
 */

import { expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { describeNative, liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
const ctx = (): ExecutionContext => ({ ...defaultContext(), kernel: kernels.occt });
const run = (doc: CadDocument, name: string, params: Record<string, unknown> = {}): CommandResult => execute(doc, name, params, ctx());

const volumeOf = (doc: CadDocument, id: string): number => {
  const measured = run(doc, 'mass_properties', { entityId: id });
  return (measured.data as { volume: number }).volume;
};
const facesOf = (doc: CadDocument, id: string): number => {
  const topology = run(doc, 'inspect_topology', { id });
  return (topology.data as { faces: unknown[] }).faces.length;
};

describeNative('STEP round trip of an embossed solid (VC-WRP-32, native kernel)', () => {
  it('emboss and deboss keep their exact faces and volume through AP242 export and exact import', () => {
    let doc = createEmptyDocument();
    const step = (name: string, params: Record<string, unknown>): string => {
      const result = run(doc, name, params);
      expect(result.affected, result.summary).toHaveLength(1);
      doc = result.document;
      return result.affected[0] as string;
    };
    const a = step('add_cylinder', { radius: 20, height: 40, position: [0, 0, 0] });
    const b = step('add_cylinder', { radius: 20, height: 40, position: [100, 0, 0] });
    const rect = step('draw_rectangle', { width: 30, height: 10, position: [-15, -5, 0] });
    const raised = step('emboss_on_face', { id: a, face: { faceNear: [20, 0, 0] }, profileIds: [rect], mode: 'emboss', depth: 1 });
    const sunk = step('emboss_on_face', { id: b, face: { faceNear: [120, 0, 0] }, profileIds: [rect], mode: 'deboss', depth: 1 });
    for (const id of [raised, sunk]) {
      const exported = run(doc, 'export_step_ap242', { entityIds: [id], timestamp: '2026-10-30T00:00:00' });
      const text = (exported.data as { step: string }).step;
      expect(text, exported.summary).toContain('ISO-10303-21');
      const back = run(createEmptyDocument(), 'import_step_exact', { text, fileName: `${id}.stp` });
      expect(back.rejected, back.summary).toBeUndefined();
      const [imported] = back.affected;
      expect(imported, back.summary).toBeDefined();
      const before = volumeOf(doc, id);
      const after = volumeOf(back.document, imported as string);
      expect(Math.abs(after - before) / before).toBeLessThan(1e-6);
      expect(facesOf(back.document, imported as string)).toBe(facesOf(doc, id));
    }
  }, 180_000);
});
