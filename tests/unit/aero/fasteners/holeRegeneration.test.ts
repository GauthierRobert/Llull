/**
 * VC-FTR-29 (07 pack) with the real catalogue command of the 08 pack: a hole drilled from a catalogue entry (`hole.fastener`) regenerates
 * with the new hole diameter when the catalogue step is edited, and the summary names the fastener. Plain objects only; the Manifold kernel
 * cuts the hole.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import type { MeshSolidEntity } from '@core/model/types';
import { acmeCatalogFile, ctxWith, docWith, ok } from './fixtures';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
  setGeometryKernel(kernel);
});
afterAll(() => setGeometryKernel(null));

type FamilyJson = { sizes: Array<{ holeDiameter: { min: number; max: number } }> };
const withHoleDiameter = (min: number, max: number): Record<string, unknown> => {
  const file = acmeCatalogFile() as { families: FamilyJson[] };
  const size = file.families[0]?.sizes[0];
  if (size !== undefined) size.holeDiameter = { ...size.holeDiameter, min, max };
  return file as unknown as Record<string, unknown>;
};

describe('VC-FTR-29: hole from a catalogue entry regenerates when the entry changes', () => {
  it('takes the middle of the entry D, names the fastener, then follows an edit of the catalogue step', () => {
    const ctx = ctxWith(kernel);
    const catalogued = docWith(withHoleDiameter(6.1, 6.2));
    const box = ok(catalogued, 'add_box', { size: [40, 40, 10], position: [0, 0, 0], anchor: 'min' }, ctx);
    const drilled = ok(
      box.document,
      'add_hole',
      {
        target: box.affected[0],
        face: { near: [20, 20, 10] },
        points: [[20, 20]],
        pointsFrame: 'world_xy',
        hole: { kind: 'simple', fastener: { catalogId: 'ACME-100', partNumber: 'ACME-100-6-10' } },
        extent: { kind: 'through_all' },
      },
      ctx,
    );
    const holeOf = (result: { document: typeof drilled.document }, id: string): { diameter: number } =>
      (result.document.entities[id] as MeshSolidEntity & { brep: { hole: { diameter: number } } }).brep.hole;
    const id = drilled.affected[0] as string;
    expect(holeOf(drilled, id).diameter).toBeCloseTo(6.15, 12);
    expect(drilled.summary).toContain('ACME-100 ACME-100-6-10');

    const importStep = drilled.document.featureHistory.find((step) => step.name === 'import_fastener_catalog');
    expect(importStep).toBeDefined();
    const edited = execute(
      drilled.document,
      'edit_step_params',
      { stepId: importStep?.id, params: { catalog: withHoleDiameter(7, 7.2) } },
      ctx,
    );
    expect(edited.rejected, edited.summary).toBeUndefined();
    expect(holeOf(edited, id).diameter).toBeCloseTo(7.1, 12);
    // the original document is untouched (purity)
    expect(holeOf(drilled, id).diameter).toBeCloseTo(6.15, 12);
  });
});
