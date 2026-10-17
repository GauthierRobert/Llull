/** 08 MAT M9: joint_capacity (VC-MAT-21 basis propagation with synthetic records; capacity arithmetic closed-form). */
import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { propagateBasis } from '@aero/fasteners/jointBasis';
import { expectPure } from '../../../helpers/expectNoOp';
import { ctxWith, dataOf, docWith, inchDocument, ok, sampleCatalogFile } from './fixtures';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/aero/fasteners/jointCapacity.test.ts' };
const record = (doc: CadDocument, id: string): CadDocument =>
  ok(doc, 'define_material_record', { id, designation: id, specs: [], licence: 'company-proprietary', exportMarking: { regime: 'none' } })
    .document;
const value = (doc: CadDocument, material: string, extra: Record<string, unknown>): CadDocument =>
  ok(doc, 'set_material_property', { material, source: SOURCE, unit: 'ksi', ...extra }).document;

interface Joint {
  doc: CadDocument;
  stackId: string;
}

/** Two plates (0.25 and 0.26 in) in an inch document with a NAS6203-9 stack; sheet 1 / sheet 2 / the bolt get the given Fbru / Fsu bases. */
function joint(bases: { bolt: string; sheet1: string; sheet2: string }): Joint {
  let doc = docWith(sampleCatalogFile(), inchDocument());
  const first = ok(doc, 'add_box', { size: [2, 1, 0.25], anchor: 'min', position: [0, 0, 0] });
  const second = ok(first.document, 'add_box', { size: [2, 1, 0.26], anchor: 'min', position: [0, 0, 0.25] });
  doc = second.document;
  const ids = [first.affected[0] as string, second.affected[0] as string];
  doc = value(record(doc, 'bolt'), 'bolt', { property: 'Fsu', value: 95, basis: bases.bolt });
  for (const [name, basis, bru, id] of [
    ['sheet1', bases.sheet1, 100, ids[0]],
    ['sheet2', bases.sheet2, 120, ids[1]],
  ] as const) {
    doc = value(record(doc, name), name, { property: 'Fbru', value: bru, basis, edOverD: 1.5, direction: 'L' });
    doc = ok(doc, 'assign_material', { entityIds: [id], materialName: name }).document;
  }
  const placed = ok(
    doc,
    'insert_fastener_stack',
    {
      family: 'NAS6203-6220',
      diameterDash: '3',
      stackIds: ids,
      axisPoint: [1, 0.5, 0],
      axis: [0, 0, 1],
      nut: 'MS21042',
      washer: 'NAS1149',
      holeMode: 'none',
    },
    ctxWith(kernel),
  );
  const stackId = Object.keys(placed.document.fasteners?.stacks ?? {})[0] as string;
  return { doc: placed.document, stackId };
}

const query = (stackId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  stackId,
  fastenerMaterial: 'bolt',
  fastenerBasis: 'A',
  sheetBasis: 'A',
  edOverD: 1.5,
  sheetDirection: 'L',
  ...extra,
});

describe('joint_capacity', () => {
  it('computes single shear and bearing per layer from the sourced allowables (closed form)', () => {
    const { doc, stackId } = joint({ bolt: 'A', sheet1: 'A', sheet2: 'A' });
    const result = ok(doc, 'joint_capacity', query(stackId));
    const data = dataOf(result);
    const d = 0.1875;
    const shearLbf = 95000 * ((Math.PI * d * d) / 4);
    expect((data['shear'] as { lbf: number }).lbf).toBeCloseTo(shearLbf, 4);
    expect((data['shear'] as { N: number }).N).toBeCloseTo(shearLbf * 4.4482216152605, 3);
    const bearing = data['bearing'] as Array<{ lbf: number; thicknessIn: number }>;
    expect(bearing[0]?.lbf).toBeCloseTo(100000 * d * 0.25, 4);
    expect(bearing[1]?.lbf).toBeCloseTo(120000 * d * 0.26, 4);
    expect(data['governing']).toMatchObject({ mode: 'shear' });
    expect(data).toMatchObject({ basis: 'A', unverified: false, reviewRequired: true, stackId });
    expect(result.summary).toContain(`joint_capacity ${stackId}`);
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  });

  it('VC-MAT-21: basis A + A -> A, A + B -> B, B + S -> mixed with the per-input list; never upgraded', () => {
    const cases = [
      [{ bolt: 'A', sheet1: 'A', sheet2: 'A' }, 'A'],
      [{ bolt: 'A', sheet1: 'B', sheet2: 'B' }, 'B'],
      [{ bolt: 'B', sheet1: 'S', sheet2: 'S' }, 'mixed'],
    ] as const;
    for (const [bases, expected] of cases) {
      const { doc, stackId } = joint(bases);
      const data = dataOf(ok(doc, 'joint_capacity', query(stackId, { fastenerBasis: bases.bolt, sheetBasis: bases.sheet1 })));
      expect(data['basis']).toBe(expected);
      expect((data['inputs'] as Array<{ basis: string }>).map((input) => input.basis)).toEqual([bases.bolt, bases.sheet1, bases.sheet2]);
    }
  });

  it('never substitutes a basis: a sheet that only has S when A is asked refuses', () => {
    const { doc, stackId } = joint({ bolt: 'B', sheet1: 'A', sheet2: 'S' });
    const refused = execute(doc, 'joint_capacity', query(stackId, { fastenerBasis: 'B', sheetBasis: 'A' }));
    expect(refused.error?.code).toBe('MAT_ALLOWABLE_NOT_AVAILABLE');
  });

  it('computes but flags unverified inputs (typical basis) and still demands review', () => {
    const { doc, stackId } = joint({ bolt: 'typical', sheet1: 'typical', sheet2: 'typical' });
    const result = ok(doc, 'joint_capacity', query(stackId, { fastenerBasis: 'typical', sheetBasis: 'typical' }));
    const data = dataOf(result);
    expect(data).toMatchObject({ basis: 'typical', unverified: true, reviewRequired: true });
    expect((data['unverifiedReasons'] as string[]).length).toBe(3);
    expect(result.summary).toContain('UNVERIFIED');
  });

  it('fails without changing the document: unknown stack, missing allowable, unassigned layer material', () => {
    const { doc, stackId } = joint({ bolt: 'A', sheet1: 'A', sheet2: 'A' });
    const unknown = execute(doc, 'joint_capacity', query('fst-0.0'));
    expect(unknown.error?.code).toBe('FAST_STACK_NOT_FOUND');
    expect(unknown.affected).toEqual([]);
    const wrongEd = execute(doc, 'joint_capacity', query(stackId, { edOverD: 2 }));
    expect(wrongEd.error?.code).toBe('MAT_ALLOWABLE_NOT_AVAILABLE');
    const wrongBolt = execute(doc, 'joint_capacity', query(stackId, { fastenerMaterial: 'ghost' }));
    expect(wrongBolt.error?.code).toBe('MAT_RECORD_NOT_FOUND');
    const stack = doc.fasteners?.stacks[stackId];
    const layer = stack?.layers[0]?.entityId as string;
    const { materialId: _material, ...bare } = doc.entities[layer] as unknown as Record<string, unknown>;
    void _material;
    const stripped = { ...doc, entities: { ...doc.entities, [layer]: bare } } as unknown as CadDocument;
    expect(execute(stripped, 'joint_capacity', query(stackId)).error?.code).toBe('FAST_LAYER_MISSING');
  });

  it('is pure', () => {
    const { doc, stackId } = joint({ bolt: 'A', sheet1: 'A', sheet2: 'A' });
    expectPure(doc, () => execute(doc, 'joint_capacity', query(stackId)));
  });
});

describe('propagateBasis (TECHNICAL_SPEC §5.6)', () => {
  const of = (...bases: Array<'A' | 'B' | 'S' | 'typical'>): string => propagateBasis(bases.map((basis) => ({ role: 'x', basis })));
  it('A only if all A; B if all in {A,B}; shared other basis kept; else mixed; empty is mixed', () => {
    expect(of('A', 'A')).toBe('A');
    expect(of('A', 'B')).toBe('B');
    expect(of('B', 'B')).toBe('B');
    expect(of('B', 'S')).toBe('mixed');
    expect(of('A', 'S')).toBe('mixed');
    expect(of('S', 'S')).toBe('S');
    expect(of('S', 'typical')).toBe('mixed');
    expect(of()).toBe('mixed');
  });
});
