/**
 * VC-MAT-17 (FR-MAT-15/16): 10^4 instances of 3 part numbers. bill_of_materials and mass_properties run in about a second or less on a
 * mid laptop (TECHNICAL_SPEC §8); the budget is the pack's 1 s (best of three runs) and the document grows <= 1 KB per instance. The 10^4 instances are
 * written straight into the document: the budget is for the queries and the footprint, not for 10^4 inserts.
 */
import { describe, expect, it } from 'vitest';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import type { FastenerStack, PartRef } from '@core/model/fasteners';
import { type CadDocument, createEmptyDocument, type Entity } from '@core/model/types';

const COUNT = 10_000;
const PARTS = ['NAS6204-10', 'MS21042L4', 'NAS1149F0463P'] as const;
/** The pack budget (VC-MAT-17): BOM <= 1 s and mass <= 1 s. The best of three runs absorbs scheduler noise, not a looser budget. */
const BUDGET_MS = 1000;
const RUNS = 3;
const BYTES_PER_INSTANCE = 1024;

function run(doc: CadDocument, name: string, params: Record<string, unknown>): { doc: CadDocument; ids: string[] } {
  const result = execute(doc, name, params);
  expect(result.rejected, result.summary).toBeUndefined();
  return { doc: result.document, ids: result.affected };
}

/** Three components (one 10 mm cube each, with a part reference) and one template instance of the first. */
function base(): { doc: CadDocument; template: Entity } {
  let doc: CadDocument = createEmptyDocument();
  for (const [index, partNumber] of PARTS.entries()) {
    const cube = run(doc, 'add_box', { size: [10, 10, 10] });
    const created = run(cube.doc, 'create_component', { name: partNumber, entityIds: cube.ids, componentId: `part${index}` });
    const component = created.doc.components[`part${index}`];
    if (component === undefined) throw new Error('component missing');
    const partRef: PartRef = { family: 'F', partNumber, unitMass: { value: 5 + index, unit: 'g' } };
    doc = { ...created.doc, components: { ...created.doc.components, [`part${index}`]: { ...component, partRef } } };
  }
  const inserted = run(doc, 'insert_instance', { componentId: 'part0' });
  const template = inserted.doc.entities[inserted.ids[0] ?? ''];
  if (template === undefined || template.kind !== 'instance') throw new Error('template instance missing');
  return { doc, template };
}

/** `COUNT` instances spread over the three components, ids `inst-<k>`, laid out on a grid. */
function instances(template: Entity): Entity[] {
  return Array.from({ length: COUNT }, (_, k) => {
    const id = `inst-${k}`;
    return { ...template, id, componentId: `part${k % PARTS.length}`, position: [(k % 100) * 12, Math.floor(k / 100) * 12, 0] } as Entity;
  });
}

const stackRecord = (id: string, k: number): FastenerStack => ({
  id,
  axis: { origin: [(k % 100) * 12, Math.floor(k / 100) * 12, 0], direction: [0, 0, 1] },
  layers: [
    { entityId: 'box-1.1', thickness: 0.25 },
    { entityId: 'box-2.1', thickness: 0.26 },
  ],
  fastener: { family: 'NAS6203-6220', partNumber: 'NAS6203-9', instanceId: `inst-${3 * k}`, diameterDash: '3' },
  washers: [{ partNumber: 'NAS1149(.063)', instanceId: `inst-${3 * k + 1}`, side: 'nut' }],
  nut: { partNumber: 'MS21042L3', instanceId: `inst-${3 * k + 2}` },
  stackThickness: 0.51,
  holeMode: 'cut_close_tolerance',
  holeDiameter: 0.19,
});

const timed = <T>(fn: () => T): { value: T; ms: number } => {
  let best = Number.POSITIVE_INFINITY;
  let value: T | undefined;
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    value = fn();
    best = Math.min(best, performance.now() - start);
  }
  return { value: value as T, ms: best };
};

describe('VC-MAT-17: 10^4 instances of 3 part numbers', () => {
  it('bill_of_materials groups them in budget and the document grows <= 1 KB per instance', () => {
    const { doc, template } = base();
    const placed = instances(template);
    // One stack record per three instances (bolt + washer + nut), as insert_fastener_stack writes them.
    const stacks = Object.fromEntries(
      Array.from({ length: Math.ceil(COUNT / 3) }, (_, k): [string, FastenerStack] => [`fst-${k}.1`, stackRecord(`fst-${k}.1`, k)]),
    );
    const big: CadDocument = {
      ...doc,
      fasteners: { catalogs: {}, stacks },
      entities: { ...doc.entities, ...Object.fromEntries(placed.map((entity) => [entity.id, entity])) },
      order: [...doc.order, ...placed.map((entity) => entity.id)],
    };
    const growth = (serializeDocument(big).length - serializeDocument(doc).length) / COUNT;
    expect(growth).toBeLessThanOrEqual(BYTES_PER_INSTANCE);

    const { value, ms } = timed(() => execute(big, 'bill_of_materials', {}));
    const parts = (value.data as { standardParts: Array<{ partNumber: string; count: number }> }).standardParts;
    expect(Object.fromEntries(parts.map((row) => [row.partNumber, row.count]))).toEqual({
      // create_component leaves one instance of each part behind
      'NAS6204-10': 3334 + 1,
      MS21042L4: 3333 + 1,
      NAS1149F0463P: 3333 + 1,
    });
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('mass_properties of an assembly of 10^4 fastener instances stays in budget', () => {
    const { doc, template } = base();
    const placed = instances(template);
    const assembly = {
      id: 'asm',
      name: 'assembly',
      entities: Object.fromEntries(placed.map((entity) => [entity.id, entity])),
      order: placed.map((entity) => entity.id),
    };
    const withAssembly: CadDocument = { ...doc, components: { ...doc.components, asm: assembly } };
    const top = run(withAssembly, 'insert_instance', { componentId: 'asm' });
    const { value, ms } = timed(() => execute(top.doc, 'mass_properties', { entityId: top.ids[0] ?? '', density: 2.8e-3 }));
    const data = value.data as { volume: number; massG: number };
    expect(data.volume).toBeCloseTo(COUNT * 1000, 6);
    expect(data.massG).toBeCloseTo(COUNT * 1000 * 2.8e-3, 6);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
