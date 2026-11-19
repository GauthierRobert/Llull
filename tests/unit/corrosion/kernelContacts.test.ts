/** COR-b M4: check_material_compatibility resolves AABB `possible` pairs of non-box solids through the kernel's distance + intersect volume. */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { kernelContacts } from '@cae/corrosion/exactContacts';
import { run, withEnvironment } from './fixtures';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

const ctxOf = (k: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel: k });
const SOURCE = { citation: 'PHY-13 galvanic_anodic_index.csv (B)' };
const TOLERANCE = { value: 0.1, unit: 'mm' };

/** A 7075 plate with a titanium-group solid added by `add` (a non-box: find_contacts gives an AABB `possible`). */
function plateWith(command: string, params: Record<string, unknown>): { doc: CadDocument; plate: string; part: string } {
  const first = execute(createEmptyDocument(), 'add_box', { size: [100, 50, 10], anchor: 'min' });
  const second = execute(first.document, command, params);
  const [plate, part] = [first.affected[0] ?? '', second.affected[0] ?? ''];
  let doc = second.document;
  for (const [name, id, group] of [
    ['m_plate', plate, 'aluminium_wrought_other'],
    ['m_part', part, 'nickel_titanium_group'],
  ] as const) {
    doc = run(doc, 'create_material', { name, density: 0.0028, color: '#cccccc', metalness: 1, roughness: 0.3 });
    doc = run(doc, 'assign_material', { materialName: name, entityIds: [id] });
    doc = run(doc, 'set_galvanic_group', { material: name, galvanicGroup: group, source: SOURCE });
  }
  return { doc: withEnvironment(doc, 'normal'), plate, part };
}

interface Data {
  items: { status: string; contact: { kind: string; source: string; approximate: boolean }; warnings: string[] }[];
  kernelContacts: { kernel: string | null; resolved: number; separated: number; unresolved: number };
}
const checkWith = (doc: CadDocument, k: GeometryKernel | null): Data =>
  execute(doc, 'check_material_compatibility', { tolerance: TOLERANCE }, ctxOf(k)).data as Data;

describe('check_material_compatibility kernel contacts (M4, kernel-optional)', () => {
  const standing = (): ReturnType<typeof plateWith> =>
    plateWith('add_cylinder', { radius: 5, height: 20, anchor: 'base-center', position: [50, 25, 10] });

  it('without a kernel a cylinder on the plate stays an AABB possible contact', () => {
    const data = checkWith(standing().doc, null);
    expect(data.items[0]?.contact).toMatchObject({ kind: 'possible', source: 'aabb', approximate: true });
    expect(data.kernelContacts).toEqual({ kernel: null, resolved: 0, separated: 0, unresolved: 0 });
  });

  it('a cylinder standing on the plate is a kernel contact (approximate on the mesh kernel), still a galvanic fail', () => {
    const data = checkWith(standing().doc, kernel);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({ status: 'fail', contact: { kind: 'contact', source: 'kernel', approximate: true } });
    expect(data.items[0]?.warnings).toContain('COR_CONTACT_APPROXIMATE');
    expect(data.kernelContacts).toEqual({ kernel: 'manifold', resolved: 1, separated: 0, unresolved: 0 });
  });

  it('the exact kernel (occt) clears the approximate flag; a sunk cylinder is an interference', () => {
    const exact: GeometryKernel = { ...kernel, name: 'occt' };
    const touching = checkWith(standing().doc, exact).items[0];
    expect(touching?.contact).toEqual({ kind: 'contact', source: 'kernel', approximate: false });
    expect(touching?.warnings).not.toContain('COR_CONTACT_APPROXIMATE');
    const sunk = plateWith('add_cylinder', { radius: 5, height: 20, anchor: 'base-center', position: [50, 25, 8] });
    expect(checkWith(sunk.doc, exact).items[0]?.contact.kind).toBe('interference');
  });

  it('a sphere whose AABB overlaps the plate corner but whose surface is 2.66 mm away is dropped (separated)', () => {
    const { doc } = plateWith('add_sphere', { radius: 6, position: [-5, -5, 15] });
    expect(checkWith(doc, null).items).toHaveLength(1);
    const data = checkWith(doc, kernel);
    expect(data.items).toEqual([]);
    expect(data.kernelContacts).toMatchObject({ resolved: 0, separated: 1 });
  });

  it('a kernel that cannot evaluate or measure leaves the pair possible (never dropped)', () => {
    const blind: GeometryKernel = { ...kernel, distance: () => null };
    expect(checkWith(standing().doc, blind).items[0]?.contact.kind).toBe('possible');
    expect(checkWith(standing().doc, blind).kernelContacts.unresolved).toBe(1);
    const refusing: GeometryKernel = { ...kernel, evaluate: () => null };
    expect(checkWith(standing().doc, refusing).items[0]?.contact.kind).toBe('possible');
    const { analyze: _analyze, ...noAnalyze } = kernel;
    void _analyze;
    const { doc } = plateWith('add_cylinder', { radius: 5, height: 20, anchor: 'base-center', position: [50, 25, 8] });
    expect(checkWith(doc, noAnalyze).items[0]?.contact.kind).toBe('contact');
    const { distance: _distance, ...noDistance } = kernel;
    void _distance;
    expect(checkWith(doc, noDistance).kernelContacts.kernel).toBeNull();
  });

  it('kernelContacts passes non-possible pairs and instance children through', () => {
    const { doc } = standing();
    const pairs = [
      { a: 'x', b: 'y', kind: 'face', source: 'closed_form', approximate: false, materials: [null, null] as const },
      { a: 'i/1', b: 'y', kind: 'possible', source: 'aabb', approximate: true, materials: [null, null] as const },
    ];
    const answer = kernelContacts(doc, pairs, 0.1, (({ name: _name, ...anonymous }) => anonymous)(kernel));
    expect(answer.pairs).toEqual(pairs);
    expect(answer).toMatchObject({ kernel: 'anonymous', resolved: 0, unresolved: 1 });
  });

  it('is pure', () => {
    const { doc } = standing();
    const before = structuredClone(doc);
    execute(doc, 'check_material_compatibility', { tolerance: TOLERANCE }, ctxOf(kernel));
    expect(doc).toEqual(before);
  });
});
