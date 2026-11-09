/** list_fastener_stacks (08 MAT): the read-only stack listing other plugins compose through execute (PHY-06 joint_from_fastener_stack). */
import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { expectPure } from '../../../helpers/expectNoOp';
import { ctxWith, dataOf, docWith, inchDocument, ok, sampleCatalogFile } from './fixtures';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

function placed(): { doc: ReturnType<typeof inchDocument>; stackId: string; plates: string[] } {
  const first = ok(docWith(sampleCatalogFile(), inchDocument()), 'add_box', { size: [2, 1, 0.25], anchor: 'min', position: [0, 0, 0] });
  const second = ok(first.document, 'add_box', { size: [2, 1, 0.26], anchor: 'min', position: [0, 0, 0.25] });
  const plates = [first.affected[0] as string, second.affected[0] as string];
  const result = ok(
    second.document,
    'insert_fastener_stack',
    {
      family: 'NAS6203-6220',
      diameterDash: '3',
      stackIds: plates,
      axisPoint: [1, 0.5, 0],
      axis: [0, 0, 1],
      nut: 'MS21042',
      washer: 'NAS1149',
      holeMode: 'cut_close_tolerance',
      holeDiameter: { value: 0.19, unit: 'in' },
    },
    ctxWith(kernel),
  );
  return { doc: result.document, stackId: (dataOf(result)['stack'] as { id: string }).id, plates };
}

describe('list_fastener_stacks', () => {
  it('lists the placed stack as plain data (units of the document, catalogue diameter converted), pure', () => {
    const { doc, stackId, plates } = placed();
    const result = execute(doc, 'list_fastener_stacks', {});
    expect(result.error).toBeUndefined();
    expectPure(doc, () => execute(doc, 'list_fastener_stacks', {}));
    const [entry] = dataOf(result)['stacks'] as Record<string, unknown>[];
    expect(entry).toMatchObject({
      id: stackId,
      familyId: 'NAS6203-6220',
      diameterDash: '3',
      washerCount: 1,
      hasNut: true,
      axis: { origin: [1, 0.5, 0], direction: [0, 0, 1] },
    });
    expect(entry?.['nominalDiameter']).toBeCloseTo(0.1875, 9);
    expect(entry?.['holeDiameter']).toBeCloseTo(0.19, 9);
    expect((entry?.['layers'] as { entityId: string }[]).map((layer) => layer.entityId)).toEqual(plates);
    expect(result.summary).toContain(stackId);
  });

  it('filters by stackId and names an unknown one (empty list, no error)', () => {
    const { doc, stackId } = placed();
    expect((dataOf(execute(doc, 'list_fastener_stacks', { stackId }))['stacks'] as unknown[]).length).toBe(1);
    const missing = execute(doc, 'list_fastener_stacks', { stackId: 'fst-9.9' });
    expect(missing.error).toBeUndefined();
    expect(dataOf(missing)['stacks']).toEqual([]);
    expect(missing.summary).toContain("no stack 'fst-9.9'");
  });

  it('reports a null nominal diameter when the catalogue does not hold the size', () => {
    const { doc, stackId } = placed();
    const stripped = { ...doc, fasteners: { ...doc.fasteners, catalogs: {}, stacks: doc.fasteners?.stacks ?? {} } };
    const [entry] = dataOf(execute(stripped, 'list_fastener_stacks', { stackId }))['stacks'] as Record<string, unknown>[];
    expect(entry?.['nominalDiameter']).toBeNull();
  });

  it('an empty document lists nothing', () => {
    const result = execute(inchDocument(), 'list_fastener_stacks', {});
    expect(dataOf(result)['stacks']).toEqual([]);
    expect(result.summary).toContain('no stack');
  });
});
