import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument, type CadDocument, type Entity, type Vec3 } from '@core/model/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExactMassProperties } from '@core/geometry/kernelPorts';
import { meshMassProperties } from '@core/geometry/massProperties';
import { solidTriangles } from '@core/geometry/solidTriangles';
import { bodyMassProperties } from '@core/geometry/bodyMassProperties';
import { symmetricEigen, type Symmetric3 } from '@lib/symmetricEigen';
import { fakeKernel, TETRA } from '../helpers/fakeKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

interface AnalyticCase {
  id: string;
  volume_mm3: number;
  area_mm2?: number;
  inertia_rho1_mm5: [number, number, number] | null;
}
const corpus = JSON.parse(readFileSync('docs/aerospace/01-exact-brep-kernel/validation/analytic_solids.json', 'utf8')) as {
  cases: AnalyticCase[];
};
const analytic = (id: string): AnalyticCase => {
  const found = corpus.cases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
};
const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);

const solid = (doc: CadDocument, name: string, params: Record<string, unknown>): { doc: CadDocument; id: string } => {
  const result = execute(doc, name, params);
  return { doc: result.document, id: result.affected[0] ?? '' };
};
type Row = [number, number, number];
interface MassData {
  method: string;
  volume: number;
  area: number;
  areaUnit: string;
  centroid: Vec3;
  relErrorEstimate?: number;
  inertia: { unit: string; frame: string; atCentroid: [Row, Row, Row]; atOrigin: [Row, Row, Row]; principal: { moments: number[] } };
  provenance: { method: string; kernel: { name: string }; inputs: { entityIds: string[]; recipeKey?: string; densitySource: string } };
  reviewRequired: { value: boolean; reasons: string[] };
  warnings?: { code: string; entityIds: string[] }[];
  unverified?: boolean;
  unverifiedReasons?: string[];
}
const dataOf = (doc: CadDocument, params: Record<string, unknown>): MassData => execute(doc, 'mass_properties', params).data as MassData;

describe('symmetricEigen (Jacobi)', () => {
  it('returns ascending moments and identity axes for a diagonal matrix', () => {
    const result = symmetricEigen([3, 1, 2, 0, 0, 0]);
    expect(result?.moments).toEqual([1, 2, 3]);
    expect(result?.axes).toEqual([
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ]);
  });

  it('diagonalises a full tensor: A v = lambda v, orthonormal and right-handed', () => {
    const matrix: Symmetric3 = [4, 5, 6, -1, 0.5, 2];
    const result = symmetricEigen(matrix);
    expect(result).not.toBeNull();
    const [xx, yy, zz, xy, xz, yz] = matrix;
    const apply = (v: Vec3): Vec3 => [
      xx * v[0] + xy * v[1] + xz * v[2],
      xy * v[0] + yy * v[1] + yz * v[2],
      xz * v[0] + yz * v[1] + zz * v[2],
    ];
    result?.axes.forEach((axis, k) => {
      const moment = result.moments[k] ?? 0;
      const image = apply(axis);
      for (let i = 0; i < 3; i++) expect(image[i]).toBeCloseTo(moment * (axis[i] ?? 0), 12);
      expect(Math.hypot(...axis)).toBeCloseTo(1, 12);
    });
    const [a, b, c] = result?.axes ?? [];
    const cross: Vec3 = [
      (a?.[1] ?? 0) * (b?.[2] ?? 0) - (a?.[2] ?? 0) * (b?.[1] ?? 0),
      (a?.[2] ?? 0) * (b?.[0] ?? 0) - (a?.[0] ?? 0) * (b?.[2] ?? 0),
      (a?.[0] ?? 0) * (b?.[1] ?? 0) - (a?.[1] ?? 0) * (b?.[0] ?? 0),
    ];
    expect(cross[0] * (c?.[0] ?? 0) + cross[1] * (c?.[1] ?? 0) + cross[2] * (c?.[2] ?? 0)).toBeCloseTo(1, 12);
    expect(result?.moments[0]).toBeLessThanOrEqual(result?.moments[1] ?? 0);
    expect(result?.moments[1]).toBeLessThanOrEqual(result?.moments[2] ?? 0);
  });

  it('is deterministic and handles a degenerate (sphere) tensor', () => {
    const matrix: Symmetric3 = [2, 2, 2, 0, 0, 0];
    expect(symmetricEigen(matrix)).toEqual(symmetricEigen(matrix));
    expect(symmetricEigen(matrix)?.moments).toEqual([2, 2, 2]);
  });

  it('refuses a non-finite tensor', () => {
    expect(symmetricEigen([Number.NaN, 1, 1, 0, 0, 0])).toBeNull();
  });
});

describe('mass_properties against the analytic corpus (closed-form path)', () => {
  it('box 100x50x20: centroid, area, inertia and principal moments', () => {
    const { doc, id } = solid(createEmptyDocument(), 'add_box', { size: [100, 50, 20], position: [50, 25, 10] });
    const data = dataOf(doc, { entityId: id });
    const expected = analytic('box-100x50x20');
    expect(data.method).toBe('closed-form');
    expect(data.centroid).toEqual([50, 25, 10]);
    expect(data.area).toBe(16000);
    expect(data.areaUnit).toBe('mm²');
    expect(data.inertia.unit).toBe('mm⁵ (per unit density)');
    const diagonal = [data.inertia.atCentroid[0][0], data.inertia.atCentroid[1][1], data.inertia.atCentroid[2][2]];
    // add_box per unit density: mass = volume
    [0, 1, 2].forEach((k) => expect(relative(diagonal[k] ?? 0, expected.inertia_rho1_mm5?.[k] ?? 1)).toBeLessThan(1e-12));
    const sorted = [...(expected.inertia_rho1_mm5 ?? [])].sort((a, b) => a - b);
    (data.inertia.principal.moments as number[]).forEach((moment, k) => expect(relative(moment, sorted[k] ?? 1)).toBeLessThan(1e-9));
    expect(data.provenance).toMatchObject({
      method: 'closed-form',
      kernel: { name: 'none' },
      inputs: { entityIds: [id], densitySource: 'none' },
    });
  });

  it('cylinder r10 h40 and sphere r25', () => {
    const cylinder = solid(createEmptyDocument(), 'add_cylinder', { radius: 10, height: 40, position: [0, 0, 20] });
    const data = dataOf(cylinder.doc, { entityId: cylinder.id });
    const expected = analytic('cyl-r10-h40');
    expect(relative(data.inertia.atCentroid[0][0], expected.inertia_rho1_mm5?.[0] ?? 1)).toBeLessThan(1e-12);
    expect(relative(data.inertia.atCentroid[2][2], expected.inertia_rho1_mm5?.[2] ?? 1)).toBeLessThan(1e-12);
    expect(relative(data.area, expected.area_mm2 ?? 1)).toBeLessThan(1e-12);
    const sphere = solid(createEmptyDocument(), 'add_sphere', { radius: 25 });
    const sphereData = dataOf(sphere.doc, { entityId: sphere.id });
    expect(relative(sphereData.inertia.atCentroid[1][1], analytic('sphere-r25').inertia_rho1_mm5?.[1] ?? 1)).toBeLessThan(1e-12);
  });

  it('cone: closed-form volume, centroid on the axis, inertia from the scaled triangles', () => {
    const cone = solid(createEmptyDocument(), 'add_cone', { radius: 20, height: 60 });
    const data = dataOf(cone.doc, { entityId: cone.id });
    const expected = analytic('cone-r20-h60');
    expect(data.method).toBe('closed-form');
    expect(data.volume).toBeCloseTo(expected.volume_mm3, 9);
    expect(relative(data.inertia.atCentroid[2][2], expected.inertia_rho1_mm5?.[2] ?? 1)).toBeLessThan(0.05);
  });

  it('a loft is integrated from its triangles: method mesh, review required for method_mesh (unverified stays about the density)', () => {
    const loft = solid(createEmptyDocument(), 'loft_sections', {
      sections: [
        { center: [0, 0, 0], radius: 1 },
        { center: [0, 0, 2], radius: 1 },
      ],
    });
    const data = dataOf(loft.doc, { entityId: loft.id });
    expect(data.method).toBe('mesh');
    expect(data.unverified).toBeUndefined();
    expect(data.reviewRequired).toEqual({ value: true, reasons: ['method_mesh'] });
  });
});

describe('mesh part frame (TR-KRN-41)', () => {
  it('a 100x50x20 box centred at x = 70 000 keeps its inertia to 1e-9 on the mesh path', () => {
    const { doc, id } = solid(createEmptyDocument(), 'add_box', { size: [100, 50, 20], position: [70000, 0, 0] });
    const props = meshMassProperties(solidTriangles(doc.entities[id] as Entity), 1);
    const volume = 100000;
    expect(relative(props?.inertia[0] ?? 0, (volume * (50 * 50 + 20 * 20)) / 12)).toBeLessThan(1e-9);
    expect(relative(props?.inertia[1] ?? 0, (volume * (100 * 100 + 20 * 20)) / 12)).toBeLessThan(1e-9);
    expect(relative(props?.inertia[2] ?? 0, (volume * (100 * 100 + 50 * 50)) / 12)).toBeLessThan(1e-9);
    expect(props?.centerOfMass[0]).toBeCloseTo(70000, 8);
    expect(relative(props?.volume ?? 0, volume)).toBeLessThan(1e-12);
  });
});

describe('mass_properties payload', () => {
  const boxDoc = (position: Vec3, extra: Record<string, unknown> = {}): { doc: CadDocument; id: string } =>
    solid(createEmptyDocument(), 'add_box', { size: [2, 4, 6], position, ...extra });

  it('weights the inertia by the density param: unit g·mm², mass-weighted tensors', () => {
    const { doc, id } = boxDoc([0, 0, 0]);
    const data = dataOf(doc, { entityId: id, density: 0.5 });
    expect(data.inertia.unit).toBe('g·mm²');
    expect(data.inertia.atCentroid[0][0]).toBeCloseTo((24 * (16 + 36)) / 12, 9);
    expect(data.reviewRequired.value).toBe(true);
    expect(data.provenance.inputs.densitySource).toBe('density param 0.5 g/mm³');
  });

  it("about moves 'atOrigin' by the parallel-axis theorem; atCentroid is unchanged", () => {
    const { doc, id } = boxDoc([10, 0, 0]);
    const data = dataOf(doc, { entityId: id, about: [0, 0, 0] });
    const centroidXx = (48 * (16 + 36)) / 12;
    expect(data.inertia.atCentroid[0][0]).toBeCloseTo(centroidXx, 9);
    expect(data.inertia.atOrigin[1][1]).toBeCloseTo((48 * (4 + 36)) / 12 + 48 * 100, 9);
    expect(data.inertia.atOrigin[0][1]).toBeCloseTo(0, 9);
    const aboutCentroid = dataOf(doc, { entityId: id, about: [10, 0, 0] });
    expect(aboutCentroid.inertia.atOrigin[1][1]).toBeCloseTo((48 * (4 + 36)) / 12, 9);
  });

  it("frame 'entity' expresses the centroid and the tensor in the entity axes", () => {
    const { doc, id } = boxDoc([5, 0, 0], { rotation: [0, 0, Math.PI / 2] });
    const world = dataOf(doc, { entityId: id });
    const local = dataOf(doc, { entityId: id, frame: 'entity' });
    expect(local.inertia.frame).toBe('entity');
    expect(local.centroid[0]).toBeCloseTo(0, 9);
    expect(local.inertia.atCentroid[0][0]).toBeCloseTo((48 * (16 + 36)) / 12, 9);
    expect(world.inertia.atCentroid[1][1]).toBeCloseTo((48 * (16 + 36)) / 12, 9);
  });

  it('weight-and-balance purpose requires review and says so; general does not', () => {
    const { doc, id } = boxDoc([0, 0, 0]);
    const general = execute(doc, 'mass_properties', { entityId: id });
    expect(dataOf(doc, { entityId: id }).reviewRequired).toEqual({ value: false, reasons: [] });
    expect(general.summary).not.toContain('not approved');
    const wab = execute(doc, 'mass_properties', { entityId: id, purpose: 'weight-and-balance' });
    expect((wab.data as { reviewRequired: unknown }).reviewRequired).toEqual({ value: true, reasons: ['purpose_weight_and_balance'] });
    expect(wab.summary).toContain('computed by llull, not approved — needs a qualified engineer');
  });

  it('warns KRN_PRECISION_ENVELOPE beyond 1e5 mm and marks the review', () => {
    const near = boxDoc([99000, 0, 0]);
    const { doc, id } = boxDoc([150000, 0, 0]);
    const data = dataOf(doc, { entityId: id });
    expect(data.warnings?.[0]).toMatchObject({ code: 'KRN_PRECISION_ENVELOPE', entityIds: [id] });
    expect(data.reviewRequired.reasons).toContain('outside_precision_envelope');
    expect(dataOf(near.doc, { entityId: near.id }).warnings).toBeUndefined();
  });

  it('an assembly combines its children: centroid, area and inertia of two boxes', () => {
    const a = solid(createEmptyDocument(), 'add_box', { size: [2, 2, 2], position: [-5, 0, 0] });
    const b = solid(a.doc, 'add_box', { size: [2, 2, 2], position: [5, 0, 0] });
    const component = execute(b.doc, 'create_component', { name: 'Pair', entityIds: [a.id, b.id], componentId: 'comp-pair' });
    const inserted = execute(component.document, 'insert_instance', { componentId: 'comp-pair', position: [100, 0, 0] });
    const data = dataOf(inserted.document, { entityId: inserted.affected[0] ?? '' });
    expect(data.method).toBe('closed-form');
    expect(data.volume).toBe(16);
    expect(data.area).toBe(48);
    expect(data.centroid[0]).toBeCloseTo(100, 9);
    expect(data.inertia.atCentroid[0][0]).toBeCloseTo(2 * ((8 * 8) / 12), 9);
    expect(data.inertia.atCentroid[1][1]).toBeCloseTo(2 * ((8 * 8) / 12 + 8 * 25), 9);
  });

  it('failure paths are no-ops: missing entity, 2D shape, bad about', () => {
    const { doc, id } = boxDoc([0, 0, 0]);
    expectNoOp(execute(doc, 'mass_properties', { entityId: 'nope' }), doc, 'not found');
    const circle = execute(doc, 'draw_arc', { center: [0, 0], radius: 3 });
    expect(circle.affected).toHaveLength(1);
    expect(execute(circle.document, 'mass_properties', { entityId: circle.affected[0] ?? '' }).data).toBeUndefined();
    const bad = execute(doc, 'mass_properties', { entityId: id, about: [1, 2] });
    expect(bad.affected).toEqual([]);
    expect(bad.document).toBe(doc);
    expect(bad.summary).toContain('invalid params');
    expect(execute(doc, 'mass_properties', { entityId: id, frame: 'sideways' }).summary).toContain('invalid params');
  });

  it('is pure', () => {
    const { doc, id } = boxDoc([3, 4, 5]);
    expectPure(doc, () =>
      execute(doc, 'mass_properties', { entityId: id, frame: 'entity', about: [1, 1, 1], purpose: 'weight-and-balance' }),
    );
  });
});

describe('closed-form surface areas (no exact kernel)', () => {
  const areaOf = (name: string, params: Record<string, unknown>): number => {
    const { doc, id } = solid(createEmptyDocument(), name, params);
    return dataOf(doc, { entityId: id }).area;
  };

  it('cone: base disc plus lateral pi r s; torus: 4 pi^2 R r', () => {
    expect(areaOf('add_cone', { radius: 3, height: 4 })).toBeCloseTo(Math.PI * 3 * 3 + Math.PI * 3 * 5, 9);
    expect(areaOf('add_torus', { ringRadius: 5, tubeRadius: 1 })).toBeCloseTo(4 * Math.PI * Math.PI * 5, 9);
  });

  it('revolution: Pappus surface of the profile edges, plus both caps on a partial turn', () => {
    const washer = [
      [2, 0],
      [3, 0],
      [3, 1],
      [2, 1],
    ];
    const full = 2 * Math.PI * (3 * 1 + 2 * 1) + 2 * Math.PI * (3 * 3 - 2 * 2);
    expect(areaOf('revolve_profile', { profile: washer, axis: 'z', angle: 2 * Math.PI })).toBeCloseTo(full, 9);
    expect(areaOf('revolve_profile', { profile: washer, axis: 'z', angle: Math.PI })).toBeCloseTo(full / 2 + 2 * 1, 9);
  });

  it('a profile that crosses its axis keeps the display-triangle area', () => {
    const crossing = [
      [-1, 0],
      [2, 0],
      [2, 1],
    ];
    expect(areaOf('revolve_profile', { profile: crossing, axis: 'z', angle: 2 * Math.PI })).toBeGreaterThan(0);
  });
});

describe('exact kernel path', () => {
  const EXACT: ExactMassProperties = {
    volume: 7,
    area: 30,
    centroid: [0.25, 0.5, 0.75],
    inertiaAtCentroid: [1, 2, 3, 0.1, 0.2, 0.3],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    relError: 1e-12,
  };
  function kernelResult(): { doc: CadDocument; id: string; kernel: GeometryKernel } {
    const kernel: GeometryKernel = { ...fakeKernel({ boolean: TETRA }), massProperties: () => EXACT };
    const ctx = { ...defaultContext(), kernel };
    const first = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }, ctx);
    const second = execute(first.document, 'add_box', { size: [1, 1, 1] }, ctx);
    const [a, b] = second.document.order;
    const union = execute(second.document, 'boolean', { op: 'union', a, b }, ctx);
    return { doc: union.document, id: union.affected[0] ?? '', kernel };
  }

  it('uses the kernel figures for a mesh entity with a B-rep recipe and reports provenance', () => {
    const { doc, id, kernel } = kernelResult();
    const result = execute(doc, 'mass_properties', { entityId: id, density: 2 }, { ...defaultContext(), kernel });
    const data = result.data as MassData;
    expect(data.method).toBe('exact');
    expect(data.volume).toBeGreaterThan(0);
    expect(data.centroid).toEqual([0.25, 0.5, 0.75]);
    expect(data.area).toBe(30);
    expect(data.relErrorEstimate).toBe(1e-12);
    expect(data.inertia.atCentroid[0]).toEqual([2, 0.2, 0.4]);
    expect(data.provenance.kernel.name).toBe('none');
    expect(typeof data.provenance.inputs.recipeKey).toBe('string');
  });

  it('carries the kernel note (the adaptive guard tripped and the fixed rule was used) into mass_properties and inspect_topology', () => {
    const note =
      "the adaptive integration rule's error estimate (largest 0.03) exceeded 0.00001 on at least one face or volume of this shape, so the fixed Gauss rule was used there";
    const { doc, id, kernel } = kernelResult();
    const noted: GeometryKernel = {
      ...kernel,
      massProperties: () => ({ ...EXACT, note }),
      topology: () => ({ solids: 1, faces: [], edges: [], vertices: 0, volume: 7, note }),
    };
    const ctx = { ...defaultContext(), kernel: noted };
    expect((execute(doc, 'mass_properties', { entityId: id }, ctx).data as MassData & { note?: string }).note).toBe(note);
    expect(execute(doc, 'mass_properties', { entityId: id }, { ...defaultContext(), kernel }).data).not.toHaveProperty('note');
    const topology = execute(doc, 'inspect_topology', { id }, ctx);
    expect((topology.data as { note?: string }).note).toBe(note);
    expect(topology.summary).toContain('fixed Gauss rule was used there');
  });

  it('a kernel that returns null falls back to the mesh path', () => {
    const { doc, id, kernel } = kernelResult();
    const silent: GeometryKernel = { ...kernel, massProperties: () => null };
    const data = execute(doc, 'mass_properties', { entityId: id }, { ...defaultContext(), kernel: silent }).data as MassData;
    expect(data.method).toBe('mesh');
  });

  it('measure_bounding_box takes the B-rep bounds of a kernel result, alone or merged, and the mesh bounds without them', () => {
    const { doc, id, kernel } = kernelResult();
    const ctx = {
      ...defaultContext(),
      kernel: { ...kernel, massProperties: (): ExactMassProperties => ({ ...EXACT, bounds: { min: [-2, -3, -4], max: [5, 6, 7] } }) },
    };
    const one = execute(doc, 'measure_bounding_box', { entityId: id }, ctx).data as { min: Vec3; max: Vec3; size: Vec3 };
    expect(one).toEqual({ min: [-2, -3, -4], max: [5, 6, 7], size: [7, 9, 11] });
    const all = execute(doc, 'measure_bounding_box', {}, ctx).data as { min: Vec3; max: Vec3 };
    expect(all.min).toEqual([-2, -3, -4]);
    const silent = { ...defaultContext(), kernel: { ...kernel, massProperties: () => null } };
    const mesh = execute(doc, 'measure_bounding_box', { entityId: id }, silent).data as { min: Vec3; max: Vec3 };
    expect(mesh.max).not.toEqual([5, 6, 7]);
  });

  it('a kernel result moved after creation is measured from its placed recipe, not its creation frame', () => {
    const { doc, id, kernel } = kernelResult();
    const moved = execute(doc, 'move_entities', { ids: [id], delta: [10, 0, 0] }).document;
    const evaluated: string[] = [];
    const spy: GeometryKernel = {
      ...kernel,
      massProperties: () => EXACT,
      evaluate: (recipe) => {
        evaluated.push(recipe.op);
        return kernel.evaluate(recipe);
      },
    };
    const ctx = { ...defaultContext(), kernel: spy };
    execute(moved, 'measure_bounding_box', { entityId: id }, ctx);
    execute(moved, 'mass_properties', { entityId: id }, ctx);
    expect(evaluated.length).toBeGreaterThanOrEqual(2);
    expect(new Set(evaluated)).toEqual(new Set(['place']));
  });

  it('dynamics: a rigid body made of a kernel part gets the exact inertia', () => {
    const { doc, id, kernel } = kernelResult();
    const withBody = execute(doc, 'add_rigid_body', { entityIds: [id], density: 1000 }, { ...defaultContext(), kernel });
    const body = Object.values(withBody.document.dynamics?.bodies ?? {})[0];
    expect(body).toBeDefined();
    if (body === undefined) return;
    const exact = bodyMassProperties(withBody.document, body, kernel);
    const mesh = bodyMassProperties(withBody.document, body);
    expect('error' in exact || 'error' in mesh).toBe(false);
    if ('error' in exact || 'error' in mesh) return;
    expect(exact.mass).toBeGreaterThan(0);
    expect(exact.inertia[3]).not.toBe(mesh.inertia[3]);
    expect(exact.centerOfMass[0]).toBeCloseTo(0.25 * 1e-3, 12);
  });
});
