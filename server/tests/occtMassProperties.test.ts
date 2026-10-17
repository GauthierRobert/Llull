/** Live OpenCascade: exact `massProperties` (TR-KRN-40/41, VC-KRN-02) against closed forms, also at 70 m, and through `mass_properties`. */
import { describe, expect, it } from 'vitest';
import type { Entity, Vec3 } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExactMassProperties } from '@core/geometry/kernelPorts';
import { liveKernels } from './kernelTestSupport';

const kernels = liveKernels();

const shape = (kind: string, fields: Record<string, unknown>): Entity =>
  ({ id: 'e', kind, rotation: [0, 0, 0], layerId: 'layer-default', color: '#888888', ...fields }) as unknown as Entity;

const massOf = (entity: Entity): ExactMassProperties | null => {
  const handle = kernels.occt.evaluate({ op: 'solid', entity });
  return handle === null ? null : (kernels.occt.massProperties?.(handle) ?? null);
};
const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);

describe('occt exact mass properties', () => {
  it('box 100x50x20: volume, area, centroid and centroidal inertia match the closed forms to 1e-12', () => {
    const props = massOf(shape('box', { position: [0, 0, 0], size: [100, 50, 20] }));
    expect(props).not.toBeNull();
    const volume = 100000;
    expect(relative(props?.volume ?? 0, volume)).toBeLessThan(1e-12);
    expect(relative(props?.area ?? 0, 16000)).toBeLessThan(1e-12);
    const [ixx, iyy, izz, ixy, ixz, iyz] = props?.inertiaAtCentroid ?? [];
    expect(relative(ixx ?? 0, (volume * (50 * 50 + 20 * 20)) / 12)).toBeLessThan(1e-12);
    expect(relative(iyy ?? 0, (volume * (100 * 100 + 20 * 20)) / 12)).toBeLessThan(1e-12);
    expect(relative(izz ?? 0, (volume * (100 * 100 + 50 * 50)) / 12)).toBeLessThan(1e-12);
    for (const product of [ixy, ixz, iyz]) expect(Math.abs(product ?? 1)).toBeLessThan(1e-6);
  });

  it('the same box at x = 70 000 mm keeps the inertia to 1e-12 and shifts the centroid (VC-KRN-02)', () => {
    const props = massOf(shape('box', { position: [70000, 0, 0], size: [100, 50, 20] }));
    expect(props?.centroid[0]).toBeCloseTo(70000, 6);
    const volume = 100000;
    expect(relative(props?.inertiaAtCentroid[0] ?? 0, (volume * (50 * 50 + 20 * 20)) / 12)).toBeLessThan(1e-12);
    expect(relative(props?.inertiaAtCentroid[1] ?? 0, (volume * (100 * 100 + 20 * 20)) / 12)).toBeLessThan(1e-12);
    expect(relative(props?.inertiaAtCentroid[2] ?? 0, (volume * (100 * 100 + 50 * 50)) / 12)).toBeLessThan(1e-12);
    expect(props?.bounds.min[0]).toBeCloseTo(69950, 6);
  });

  it('cylinder and sphere agree with the closed forms to 1e-9', () => {
    const radius = 10;
    const height = 40;
    const cylinder = massOf(shape('cylinder', { position: [0, 0, 0], radius, height }));
    const volume = Math.PI * radius * radius * height;
    expect(relative(cylinder?.volume ?? 0, volume)).toBeLessThan(1e-9);
    expect(relative(cylinder?.area ?? 0, 2 * Math.PI * radius * (radius + height))).toBeLessThan(1e-9);
    expect(relative(cylinder?.inertiaAtCentroid[2] ?? 0, (volume * radius * radius) / 2)).toBeLessThan(1e-9);
    expect(relative(cylinder?.inertiaAtCentroid[0] ?? 0, (volume * (3 * radius * radius + height * height)) / 12)).toBeLessThan(1e-9);
    const sphere = massOf(shape('sphere', { position: [30, -20, 5], radius: 7 }));
    const sphereVolume = (4 / 3) * Math.PI * 7 ** 3;
    expect(relative(sphere?.volume ?? 0, sphereVolume)).toBeLessThan(1e-9);
    expect(relative(sphere?.inertiaAtCentroid[0] ?? 0, 0.4 * sphereVolume * 49)).toBeLessThan(1e-9);
    const centroid: Vec3 = sphere?.centroid ?? [0, 0, 0];
    expect(centroid[0]).toBeCloseTo(30, 7);
    expect(centroid[1]).toBeCloseTo(-20, 7);
    expect(centroid[2]).toBeCloseTo(5, 7);
  });

  it('mass_properties on an OCC kernel result reports method exact with the exact inertia', () => {
    const base = createEmptyDocument();
    const box = execute(base, 'add_box', { size: [100, 50, 20], position: [70000, 0, 0] });
    const id = box.affected[0] ?? '';
    const source = box.document.entities[id];
    expect(source).toBeDefined();
    const handle = kernels.occt.evaluate({ op: 'solid', entity: source as Entity });
    const mesh = kernels.occt.tessellate(handle!);
    const solid = { ...(source as Entity), id: 'k', kind: 'mesh', mesh, brep: { op: 'solid', entity: source } } as unknown as Entity;
    const doc = { ...box.document, entities: { ...box.document.entities, k: solid }, order: [...box.document.order, 'k'] };
    const result = execute(doc, 'mass_properties', { entityId: 'k' }, { ...defaultContext(), kernel: kernels.occt });
    const data = result.data as { method: string; inertia: { atCentroid: number[][] }; centroid: number[] };
    expect(data.method).toBe('exact');
    expect(relative(data.inertia.atCentroid[0]?.[0] ?? 0, (100000 * (50 * 50 + 20 * 20)) / 12)).toBeLessThan(1e-12);
    expect(data.centroid[0]).toBeCloseTo(70000, 6);
  });
});
