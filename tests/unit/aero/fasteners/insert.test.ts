/**
 * 08 MAT M6: insert_fastener_stack, delete_fastener_stack and the BOM on the Manifold kernel (VC-MAT-10, 11, 19). Volumes are mesh volumes
 * here (tolerance 2 %); the exact OpenCascade check is server/tests/aeroFasteners.occt.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import { signedMeshVolume } from '@core/geometry/meshVolume';
import type { CadDocument, MeshSolidEntity } from '@core/model/types';
import type { FastenerStack } from '@core/model/fasteners';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { expectPure } from '../../../helpers/expectNoOp';
import { ctxWith, dataOf, docWith, inchDocument, ok, readValidation, sampleCatalogFile } from './fixtures';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

const HOLE = { value: 0.19, unit: 'in' };
const planStep = (
  readValidation('plans/fastener_stack_nas6203_proposed.json') as { actions: Array<{ command: string; params: Record<string, unknown> }> }
).actions.find((step) => step.command === 'insert_fastener_stack');

interface Scene {
  doc: CadDocument;
  a: string;
  b: string;
}

/** Two plates of the proposed plan (0.25 + 0.26 in, z 0 .. 0.51) with 7075 assigned, in an inch document. */
function twoPlates(material = true): Scene {
  let doc = docWith(sampleCatalogFile(), inchDocument());
  const first = ok(doc, 'add_box', { size: [2, 1, 0.25], anchor: 'min', position: [0, 0, 0] });
  const second = ok(first.document, 'add_box', { size: [2, 1, 0.26], anchor: 'min', position: [0, 0, 0.25] });
  doc = second.document;
  const a = first.affected[0] as string;
  const b = second.affected[0] as string;
  if (material) {
    doc = ok(doc, 'create_material', {
      name: 'al7075',
      density: 2.81,
      densityUnit: 'g/cm^3',
      color: '#b8bcc2',
      metalness: 1,
      roughness: 0.35,
    }).document;
    doc = ok(doc, 'assign_material', { entityIds: [a, b], materialName: 'al7075' }).document;
  }
  return { doc, a, b };
}

const stackParams = (scene: { a: string; b: string }, point: [number, number, number] = [1, 0.5, 0]): Record<string, unknown> => ({
  family: 'NAS6203-6220',
  diameterDash: '3',
  stackIds: [scene.a, scene.b],
  axisPoint: point,
  axis: [0, 0, 1],
  nut: 'MS21042',
  washer: 'NAS1149',
  holeMode: 'cut_close_tolerance',
  holeDiameter: HOLE,
});

const meshVolume = (doc: CadDocument, id: string): number =>
  Math.abs(signedMeshVolume((doc.entities[id] as MeshSolidEntity).mesh.positions, (doc.entities[id] as MeshSolidEntity).mesh.indices));
const stackOf = (result: { data?: unknown }): FastenerStack => dataOf(result as never)['stack'] as FastenerStack;

describe('insert_fastener_stack (VC-MAT-10)', () => {
  it('cuts the hole, places bolt + washer + nut in ONE step, records the stack with a step-scoped id', () => {
    const { doc, a, b } = twoPlates();
    const result = ok(doc, 'insert_fastener_stack', stackParams({ a, b }), ctxWith(kernel));
    const stack = stackOf(result);
    expect(planStep?.params['holeMode']).toBe('cut_close_tolerance');
    expect(result.document.featureHistory.length).toBe(doc.featureHistory.length + 1);
    expect(result.document.featureHistory.at(-1)?.name).toBe('insert_fastener_stack');
    expect(stack.id).toMatch(/^fst-\d+\.\d+$/);
    expect(stack.id.startsWith(`fst-${doc.nextStepNumber}.`)).toBe(true);
    expect(result.document.fasteners?.stacks[stack.id]).toEqual(stack);
    expect(stack.fastener).toMatchObject({ family: 'NAS6203-6220', partNumber: 'NAS6203-9', diameterDash: '3' });
    expect(stack.washers).toEqual([expect.objectContaining({ partNumber: 'NAS1149(.063)', side: 'nut' })]);
    expect(stack.nut?.partNumber).toBe('MS21042L3');
    expect(stack.stackThickness).toBeCloseTo(0.51, 6);
    expect(stack.holeDiameter).toBeCloseTo(0.19, 9);
    expect(result.summary).toContain(stack.id);
    expect(result.affected).toEqual([
      stack.fastener.instanceId,
      stack.washers[0]?.instanceId,
      stack.nut?.instanceId,
      ...stack.layers.map((l) => l.entityId),
    ]);
  });

  it('reduces each plate volume by pi r^2 t and cuts the plates in place (same ids, cut meshes, material carried over)', () => {
    // A millimetre document: Manifold facets a 0.1 in hole coarsely in inch documents (its default segment count follows the radius in mm).
    let doc = docWith();
    const first = ok(doc, 'add_box', { size: [50.8, 25.4, 6.35], anchor: 'min', position: [0, 0, 0] });
    const second = ok(first.document, 'add_box', { size: [50.8, 25.4, 6.604], anchor: 'min', position: [0, 0, 6.35] });
    doc = ok(second.document, 'create_material', {
      name: 'al7075',
      density: 0.00281,
      color: '#b8bcc2',
      metalness: 1,
      roughness: 0.35,
    }).document;
    doc = ok(doc, 'assign_material', { entityIds: [first.affected[0], second.affected[0]], materialName: 'al7075' }).document;
    const params = {
      ...stackParams({ a: first.affected[0] as string, b: second.affected[0] as string }, [25.4, 12.7, 0]),
      holeDiameter: { value: 4.826, unit: 'mm' },
    };
    const result = ok(doc, 'insert_fastener_stack', params, ctxWith(kernel));
    const [one, two] = stackOf(result).layers;
    expect(one?.entityId).toBe(first.affected[0]);
    expect(two?.entityId).toBe(second.affected[0]);
    expect(result.document.entities[one?.entityId as string]?.kind).toBe('mesh');
    const hole = (thickness: number): number => Math.PI * (4.826 / 2) ** 2 * thickness;
    const removed = (id: string | undefined, whole: number): number => whole - meshVolume(result.document, id as string);
    expect(removed(one?.entityId, 50.8 * 25.4 * 6.35) / hole(6.35)).toBeGreaterThan(0.97);
    expect(removed(one?.entityId, 50.8 * 25.4 * 6.35) / hole(6.35)).toBeLessThan(1.001);
    expect(removed(two?.entityId, 50.8 * 25.4 * 6.604) / hole(6.604)).toBeGreaterThan(0.97);
    expect(removed(two?.entityId, 50.8 * 25.4 * 6.604) / hole(6.604)).toBeLessThan(1.001);
    expect(result.document.entities[one?.entityId as string]?.materialId).toBe('al7075');
    expect(result.document.entities[two?.entityId as string]?.materialId).toBe('al7075');
  });

  it('creates one component per part number (once) and instances of them; representative parts are flagged', () => {
    const { doc, a, b } = twoPlates();
    const result = ok(doc, 'insert_fastener_stack', stackParams({ a, b }), ctxWith(kernel));
    const components = Object.values(result.document.components);
    expect(components.map((c) => c.partRef?.partNumber).sort()).toEqual(['MS21042L3', 'NAS1149(.063)', 'NAS6203-9']);
    expect(components.find((c) => c.partRef?.partNumber === 'NAS6203-9')?.partRef).toMatchObject({
      representative: true,
      family: 'NAS6203-6220',
    });
    expect(components.find((c) => c.partRef?.partNumber === 'MS21042L3')?.partRef?.representative).toBeUndefined();
    const warnings = dataOf(result)['warnings'] as Array<{ code: string; message: string }>;
    expect(warnings.map((w) => w.code)).toContain('FAST_GEOMETRY_REPRESENTATIVE');
    expect(Object.values(result.document.entities).filter((e) => e.kind === 'instance')).toHaveLength(3);
  });

  it('positions bolt, washer and nut along the axis (washer on the nut side, nut after it)', () => {
    const { doc, a, b } = twoPlates();
    const stack = stackOf(ok(doc, 'insert_fastener_stack', stackParams({ a, b }), ctxWith(kernel)));
    const result = ok(doc, 'insert_fastener_stack', stackParams({ a, b }), ctxWith(kernel));
    const z = (id: string | undefined): number => (result.document.entities[id ?? '']?.position ?? [0, 0, NaN])[2];
    expect(z(stack.fastener.instanceId)).toBeCloseTo(0, 6);
    expect(z(result.affected[0])).toBeCloseTo(0, 6);
    expect(z(result.affected[1])).toBeCloseTo(0.51, 6);
    expect(z(result.affected[2])).toBeCloseTo(0.573, 6);
  });

  it('puts washers under the head when washerSide is "head"', () => {
    const { doc, a, b } = twoPlates();
    const result = ok(doc, 'insert_fastener_stack', { ...stackParams({ a, b }), washerSide: 'head' }, ctxWith(kernel));
    const z = (id: string | undefined): number => (result.document.entities[id ?? '']?.position ?? [0, 0, NaN])[2];
    expect(z(result.affected[0])).toBeCloseTo(-0.063, 6);
    expect(z(result.affected[1])).toBeCloseTo(-0.063, 6);
    expect(z(result.affected[2])).toBeCloseTo(0.51, 6);
  });

  it('tilts the instances with the axis for a non-vertical stack', () => {
    let doc = docWith(sampleCatalogFile(), inchDocument());
    const plate = ok(doc, 'add_box', { size: [0.5, 1, 1], anchor: 'min', position: [0, 0, 0] });
    doc = plate.document;
    const result = ok(
      doc,
      'insert_fastener_stack',
      {
        family: 'NAS6203-6220',
        diameterDash: '3',
        stackIds: plate.affected,
        axisPoint: [0, 0.5, 0.5],
        axis: [1, 0, 0],
        washer: 'NAS1149',
        holeMode: 'cut_close_tolerance',
        holeDiameter: HOLE,
      },
      ctxWith(kernel),
    );
    const bolt = result.document.entities[stackOf(result).fastener.instanceId];
    expect(bolt?.rotation[1]).toBeCloseTo(Math.PI / 2, 6);
    expect(bolt?.position[0]).toBeCloseTo(0, 6);
  });

  it('holeMode "none" places the fastener without touching the plates', () => {
    const { doc, a, b } = twoPlates();
    const result = ok(
      doc,
      'insert_fastener_stack',
      { ...stackParams({ a, b }), holeMode: 'none', holeDiameter: undefined },
      ctxWith(kernel),
    );
    expect(result.document.entities[a]).toBe(doc.entities[a]);
    expect(stackOf(result).holeDiameter).toBe(0);
    expect(stackOf(result).layers.map((layer) => layer.entityId)).toEqual([a, b]);
  });

  it('takes the hole diameter from the catalogue (close tolerance: midpoint; clearance dim) when none is given', () => {
    const file = sampleCatalogFile();
    const bolt = (file['families'] as Array<{ id: string; sizes: Array<Record<string, unknown>> }>).find((f) => f.id === 'NAS6203-6220');
    const size = bolt?.sizes[0] as Record<string, unknown>;
    size['holeDiameter'] = { min: 0.1895, max: 0.1905, unit: 'in', provenance: { citation: 'fixture' } };
    size['dims'] = { clearanceHoleDiameter: { nominal: 0.201, unit: 'in', provenance: { citation: 'fixture' } } };
    let doc = docWith(file, inchDocument());
    const plate = ok(doc, 'add_box', { size: [2, 1, 0.5625], anchor: 'min', position: [0, 0, 0] });
    doc = plate.document;
    const params = { family: 'NAS6203-6220', diameterDash: '3', stackIds: plate.affected, axisPoint: [1, 0.5, 0], axis: [0, 0, 1] };
    expect(stackOf(ok(doc, 'insert_fastener_stack', params, ctxWith(kernel))).holeDiameter).toBeCloseTo(0.19, 9);
    expect(stackOf(ok(doc, 'insert_fastener_stack', { ...params, holeMode: 'cut_clearance' }, ctxWith(kernel))).holeDiameter).toBeCloseTo(
      0.201,
      9,
    );
  });

  it('is pure, undoable (the previous document is untouched) and replays id-stably', () => {
    const { doc, a, b } = twoPlates();
    expectPure(doc, () => execute(doc, 'insert_fastener_stack', stackParams({ a, b }), ctxWith(kernel)));
    const result = ok(doc, 'insert_fastener_stack', stackParams({ a, b }), ctxWith(kernel));
    expect(JSON.stringify(doc)).toBe(JSON.stringify(twoPlatesCopy(doc)));
    const replayed = ok(result.document, 'replay_history', {}, ctxWith(kernel)).document;
    expect(Object.keys(replayed.entities).sort()).toEqual(Object.keys(result.document.entities).sort());
    expect(Object.keys(replayed.components).sort()).toEqual(Object.keys(result.document.components).sort());
    expect(replayed.fasteners?.stacks).toEqual(result.document.fasteners?.stacks);
  });
});

const twoPlatesCopy = (doc: CadDocument): CadDocument => JSON.parse(JSON.stringify(doc)) as CadDocument;

describe('insert_fastener_stack refusals', () => {
  const { doc, a, b } = twoPlates();
  const refused = (params: Record<string, unknown>, ctx = ctxWith(kernel)): { code: string | undefined; unchanged: boolean } => {
    const result = execute(doc, 'insert_fastener_stack', params, ctx);
    return { code: result.error?.code, unchanged: result.document === doc && result.affected.length === 0 };
  };

  it('refuses a selection that fails (stack beyond the grip range) and a missing family', () => {
    const thick = ok(doc, 'add_box', { size: [2, 1, 5], anchor: 'min', position: [0, 0, 0] });
    const tooThick = execute(
      thick.document,
      'insert_fastener_stack',
      { ...stackParams({ a, b }), stackIds: thick.affected },
      ctxWith(kernel),
    );
    expect(tooThick.error?.code).toBe('FAST_STACK_OUT_OF_RANGE');
    expect(tooThick.document).toBe(thick.document);
    expect(refused({ ...stackParams({ a, b }), family: 'NOPE' })).toEqual({ code: 'FAST_FAMILY_UNKNOWN', unchanged: true });
  });

  it('refuses a bare stack thickness, an unknown hole diameter and a missing kernel', () => {
    expect(refused({ ...stackParams({ a, b }), stackIds: undefined, stack: { value: 0.51, unit: 'in' } })).toEqual({
      code: 'FAST_STACK_MISSING',
      unchanged: true,
    });
    expect(refused({ ...stackParams({ a, b }), holeDiameter: undefined })).toEqual({ code: 'FAST_HOLE_DIAMETER_UNKNOWN', unchanged: true });
    expect(refused({ ...stackParams({ a, b }), holeDiameter: { value: -1, unit: 'in' } }).code).toBe('FAST_HOLE_DIAMETER_UNKNOWN');
    expect(refused({ ...stackParams({ a, b }), holeMode: 'cut_clearance', holeDiameter: undefined }).code).toBe(
      'FAST_HOLE_DIAMETER_UNKNOWN',
    );
    const noKernel = execute(doc, 'insert_fastener_stack', stackParams({ a, b }), ctxWith(null));
    expect(noKernel.error?.code).toBe('CMD_KERNEL_UNAVAILABLE');
    expect(noKernel.document).toBe(doc);
  });

  it('refuses when the kernel boolean fails, without a partial result', () => {
    const broken: GeometryKernel = { ...kernel, evaluate: (recipe) => (recipe.op === 'boolean' ? null : kernel.evaluate(recipe)) };
    expect(refused(stackParams({ a, b }), ctxWith(broken))).toEqual({ code: 'FAST_HOLE_CUT_FAILED', unchanged: true });
  });
});

describe('plugin-owned instances and delete_fastener_stack', () => {
  let inserted: ReturnType<typeof ok>;
  let stack: FastenerStack;
  beforeAll(() => {
    const { doc, a, b } = twoPlates();
    inserted = ok(doc, 'insert_fastener_stack', stackParams({ a, b }), ctxWith(kernel));
    stack = stackOf(inserted);
  });

  it('refuses direct deletion or explosion of a fastener instance (derivation guard)', () => {
    for (const result of [
      execute(inserted.document, 'delete_entities', { ids: [stack.fastener.instanceId] }),
      execute(inserted.document, 'explode_instance', { id: stack.nut?.instanceId }),
    ]) {
      expect(result.rejected).toBe(true);
      expect(result.error?.code).toBe('CMD_DERIVED_GEOMETRY');
      expect(result.summary).toContain('delete_fastener_stack');
      expect(result.document).toBe(inserted.document);
    }
  });

  it('delete_fastener_stack removes the record and its instances; holes stay', () => {
    const result = ok(inserted.document, 'delete_fastener_stack', { stackIds: [stack.id] });
    expect(result.document.fasteners?.stacks[stack.id]).toBeUndefined();
    expect(Object.values(result.document.entities).filter((entity) => entity.kind === 'instance')).toHaveLength(0);
    expect(result.document.entities[stack.layers[0]?.entityId as string]).toBeDefined();
    expect(result.affected).toHaveLength(3);
    expectPure(inserted.document, () => execute(inserted.document, 'delete_fastener_stack', { stackIds: [stack.id] }));
  });

  it('refuses unknown or empty stack ids with FAST_STACK_NOT_FOUND', () => {
    for (const stackIds of [['fst-nope'], []]) {
      const result = execute(inserted.document, 'delete_fastener_stack', { stackIds });
      expect(result.error?.code).toBe('FAST_STACK_NOT_FOUND');
      expect(result.document).toBe(inserted.document);
    }
  });
});

describe('bill_of_materials with standard parts (VC-MAT-11)', () => {
  function twoStacks(): { doc: CadDocument; stacks: FastenerStack[] } {
    const { doc, a, b } = twoPlates();
    const first = ok(doc, 'insert_fastener_stack', stackParams({ a, b }, [0.5, 0.5, 0]), ctxWith(kernel));
    const [one, two] = stackOf(first).layers;
    const second = ok(
      first.document,
      'insert_fastener_stack',
      stackParams({ a: one?.entityId as string, b: two?.entityId as string }, [1.5, 0.5, 0]),
      ctxWith(kernel),
    );
    return { doc: second.document, stacks: [stackOf(first), stackOf(second)] };
  }

  it('lists NAS6203-9 x2, MS21042L3 x2 and NAS1149(.063) x2, plus materials with the plate mass', () => {
    const { doc, stacks } = twoStacks();
    expect(stacks[0]?.layers[0]?.entityId).toBe(stacks[1]?.layers[0]?.entityId);
    expect(Object.values(doc.fasteners?.stacks ?? {}).every((s) => s.layers.every((l) => doc.entities[l.entityId] !== undefined))).toBe(
      true,
    );
    const result = execute(doc, 'bill_of_materials', { includeStandardParts: true, includeMaterials: true });
    const data = dataOf(result);
    expect(data['standardParts']).toEqual([
      expect.objectContaining({ partNumber: 'MS21042L3', count: 2, family: 'MS21042' }),
      expect.objectContaining({ partNumber: 'NAS1149(.063)', count: 2 }),
      expect.objectContaining({ partNumber: 'NAS6203-9', count: 2, representative: true }),
    ]);
    expect(data['totalInstances']).toBe(6);
    expect(data['distinctComponents']).toBe(3);
    const rows = data['rows'] as Array<{ componentName: string; count: number }>;
    expect(rows.map((row) => row.count)).toEqual([2, 2, 2]);
    const materials = data['materials'] as Array<{
      materialId: string;
      solidCount: number;
      totalVolume: number;
      totalMass: number;
      unverified: boolean;
      volumeMethod: string;
    }>;
    expect(materials).toHaveLength(1);
    const plateIds = Object.values(doc.entities)
      .filter((entity) => entity.kind === 'mesh')
      .map((entity) => entity.id);
    const volume = plateIds.reduce((sum, id) => sum + meshVolume(doc, id), 0);
    expect(materials[0]).toMatchObject({ materialId: 'al7075', solidCount: 2 });
    expect(materials[0]?.totalVolume).toBeCloseTo(volume, 9);
    expect(materials[0]?.totalMass).toBeCloseTo(volume * 2.81 * (25.4 / 10) ** 3, 3);
    expect(materials[0]?.volumeMethod).toBe('mesh');
    expect(materials[0]?.unverified).toBe(true);
    expect(result.summary).toContain('NAS6203-9 ×2');
    expect(2 * 1 * 0.51 - volume).toBeGreaterThan(0);
  });

  it('keeps the legacy rows unchanged and omits the sections that were not asked for', () => {
    const { doc, stacks } = twoStacks();
    const withParts = dataOf(execute(doc, 'bill_of_materials', {}));
    expect(Object.keys(withParts).sort()).toEqual([
      'distinctComponents',
      'rows',
      'rowsWithoutDensity',
      'standardParts',
      'totalInstances',
      'totalMassKg',
    ]);
    const without = dataOf(execute(doc, 'bill_of_materials', { includeStandardParts: false }));
    expect(Object.keys(without).sort()).toEqual(['distinctComponents', 'rows', 'rowsWithoutDensity', 'totalInstances', 'totalMassKg']);
    expect(without['rows']).toEqual(withParts['rows']);
    expect(stacks).toHaveLength(2);
  });
});

describe('VC-MAT-19: MS20470AD4 head geometry', () => {
  it('builds the head within the published diameter and height ranges, not representative (mass allowed)', () => {
    let doc = docWith(sampleCatalogFile(), inchDocument());
    const sheetA = ok(doc, 'add_box', { size: [1, 1, 0.0625], anchor: 'min', position: [0, 0, 0] });
    doc = sheetA.document;
    const sheetB = ok(doc, 'add_box', { size: [1, 1, 0.0625], anchor: 'min', position: [0, 0, 0.0625] });
    doc = sheetB.document;
    const result = ok(
      doc,
      'insert_fastener_stack',
      {
        family: 'MS20470',
        diameterDash: '4',
        stackIds: [...sheetA.affected, ...sheetB.affected],
        axisPoint: [0.5, 0.5, 0],
        codes: { material: 'AD' },
        holeDiameter: { value: 0.129, unit: 'in' },
      },
      ctxWith(kernel),
    );
    const component = result.document.components['std-MS20470AD4-5'];
    expect(component?.partRef).toMatchObject({ partNumber: 'MS20470AD4-5', family: 'MS20470' });
    expect(component?.partRef?.representative).toBeUndefined();
    const head = Object.values(component?.entities ?? {}).find((entity) => entity.kind === 'cylinder' && entity.position[2] < 0);
    expect(head?.kind === 'cylinder' ? head.radius * 2 : 0).toBeGreaterThanOrEqual(0.238);
    expect(head?.kind === 'cylinder' ? head.radius * 2 : 99).toBeLessThanOrEqual(0.262);
    expect(head?.kind === 'cylinder' ? head.height : 0).toBeGreaterThanOrEqual(0.054);
    expect(head?.kind === 'cylinder' ? head.height : 99).toBeLessThanOrEqual(0.064);
    expect(stackOf(result).nut).toBeUndefined();
    expect(dataOf(result)['warnings']).toEqual([]);
  });

  it('uses placeholder proportions (head 2 D, 0.5 D) and flags an AD3 rivet representative', () => {
    let doc = docWith(sampleCatalogFile(), inchDocument());
    const sheet = ok(doc, 'add_box', { size: [1, 1, 0.064], anchor: 'min', position: [0, 0, 0] });
    doc = sheet.document;
    const result = ok(
      doc,
      'insert_fastener_stack',
      {
        family: 'MS20470',
        diameterDash: '3',
        stackIds: sheet.affected,
        axisPoint: [0.5, 0.5, 0],
        codes: { material: 'AD' },
        holeMode: 'none',
      },
      ctxWith(kernel),
    );
    const component = result.document.components['std-MS20470AD3-4'];
    expect(component?.partRef?.representative).toBe(true);
    const head = Object.values(component?.entities ?? {}).find((entity) => entity.kind === 'cylinder' && entity.position[2] < 0);
    expect(head?.kind === 'cylinder' ? head.radius * 2 : 0).toBeCloseTo(2 * 0.09375, 9);
    expect(head?.kind === 'cylinder' ? head.height : 0).toBeCloseTo(0.5 * 0.09375, 9);
    expect((dataOf(result)['warnings'] as Array<{ code: string }>).map((w) => w.code)).toContain('FAST_GEOMETRY_REPRESENTATIVE');
    const bom = dataOf(execute(result.document, 'bill_of_materials', { includeMaterials: true }));
    expect((bom['standardParts'] as Array<Record<string, unknown>>)[0]).toMatchObject({ representative: true });
    expect((bom['standardParts'] as Array<Record<string, unknown>>)[0]?.['totalMass']).toBeUndefined();
    expect(bom['materials']).toEqual([]);
  });
});

describe('AF-05: the proposed plan runs as one build_project', () => {
  it('select -> insert -> BOM with aliases, one recorded step per mutating command', () => {
    const plan = (
      readValidation('plans/fastener_stack_nas6203_proposed.json') as {
        actions: Array<{ command: string; params: Record<string, unknown>; as?: string }>;
      }
    ).actions;
    const withHole = plan.map((step) =>
      step.command === 'insert_fastener_stack' ? { ...step, params: { ...step.params, holeDiameter: HOLE } } : step,
    );
    const actions = [{ command: 'import_fastener_catalog', params: { catalog: sampleCatalogFile() } }, ...withHole];
    const result = execute(inchDocument(), 'build_project', { actions }, ctxWith(kernel));
    expect(result.rejected, result.summary).toBeUndefined();
    const steps =
      (dataOf(result)['steps'] as Array<{ command: string; ok: boolean; summary: string; data?: Record<string, unknown> }>) ?? [];
    expect(
      steps.every((step) => step.ok),
      steps.map((step) => step.summary).join(' | '),
    ).toBe(true);
    expect(steps.find((step) => step.command === 'select_fastener')?.data).toMatchObject({
      ok: true,
      partNumber: 'NAS6203-9',
      washersIn: [0.063],
    });
    expect(result.document.featureHistory.map((step) => step.name)).toEqual([
      'import_fastener_catalog',
      'set_units',
      'add_box',
      'add_box',
      'insert_fastener_stack',
    ]);
    const bom = steps.find((step) => step.command === 'bill_of_materials')?.data;
    expect(
      (bom?.['standardParts'] as Array<{ partNumber: string; count: number }>).map((part) => `${part.partNumber}×${part.count}`),
    ).toEqual(['MS21042L3×1', 'NAS1149(.063)×1', 'NAS6203-9×1']);
    expect(Object.keys(dataOf(result)['aliases'] as object)).toContain('stack');
  });
});
