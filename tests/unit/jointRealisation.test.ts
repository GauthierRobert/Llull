/** Joint realisation with a fake kernel that serves canned cylinder faces (the OCC end-to-end case is in server/tests). */
import { describe, expect, it } from 'vitest';
import type { GeometryKernel, ShapeFace, ShapeHandle, ShapeTopology } from '@core/geometry/kernel';
import { realiseJoint } from '@core/geometry/assemblyCheck/jointRealisation';
import type { MeshData, Vec3 } from '@core/model/types';

const handle = (name: string): ShapeHandle => name as unknown as ShapeHandle;

const cylinder = (radius: number, convex: boolean, span: [number, number], extra: { origin?: Vec3; direction?: Vec3 } = {}): ShapeFace => ({
  index: 0,
  surface: 'cylinder',
  area: 1,
  convex,
  axis: { origin: extra.origin ?? [0, 0, 0], direction: extra.direction ?? [0, 0, 1], radius, span },
});

function kernelOf(faces: Record<string, readonly ShapeFace[] | null>): GeometryKernel {
  return {
    supports: () => true,
    evaluate: () => null,
    tessellate: () => null,
    exportStep: () => null,
    topology: (shape) => {
      const list = faces[shape as unknown as string];
      return list === null || list === undefined ? null : ({ solids: 1, faces: list, edges: [], vertices: 0, volume: 1 } as ShapeTopology);
    },
  };
}

const joint = {
  id: 'hinge',
  anchor: [0, 0, 0] as Vec3,
  axis: [0, 0, 1] as Vec3,
  mmPerUnit: 1,
  parentMeshes: [] as MeshData[],
  childMeshes: [] as MeshData[],
};

describe('realiseJoint', () => {
  it('reports clearance and engagement of a coaxial pin in a bore', () => {
    const kernel = kernelOf({ pin: [cylinder(5, true, [-10, 10])], housing: [cylinder(5.01, false, [-20, 20])] });
    const item = realiseJoint(kernel, { ...joint, parentShapes: [handle('housing')], childShapes: [handle('pin')] });
    expect(item.code).toBe('FPR_JOINT_REALISED');
    expect(item.values['diametralClearanceMm']).toBeCloseTo(0.02, 9);
    expect(item.values['engagementMm']).toBeCloseTo(20, 9);
    const swapped = realiseJoint(kernel, { ...joint, parentShapes: [handle('pin')], childShapes: [handle('housing')] });
    expect(swapped.code).toBe('FPR_JOINT_REALISED');
  });

  it('measures axial ranges along the joint axis whichever way the face axis points', () => {
    const kernel = kernelOf({
      pin: [cylinder(5, true, [0, 10], { origin: [0, 0, 20], direction: [0, 0, -1] })],
      housing: [cylinder(5.01, false, [0, 30])],
    });
    const item = realiseJoint(kernel, { ...joint, parentShapes: [handle('housing')], childShapes: [handle('pin')] });
    expect(item.values['engagementMm']).toBeCloseTo(10, 9);
  });

  it('a pin and bore that do not overlap along the axis are not a realised joint', () => {
    const kernel = kernelOf({ pin: [cylinder(5, true, [0, 10])], housing: [cylinder(5.01, false, [20, 40])] });
    const item = realiseJoint(kernel, { ...joint, parentShapes: [handle('housing')], childShapes: [handle('pin')] });
    expect(item.code).toBe('FPR_JOINT_NOT_REALISED');
    expect(item.note).toContain('do not overlap');
  });

  it('a bore smaller than the pin is interference, not a joint', () => {
    const kernel = kernelOf({ pin: [cylinder(5, true, [0, 10])], housing: [cylinder(4.9, false, [0, 10])] });
    const item = realiseJoint(kernel, { ...joint, parentShapes: [handle('housing')], childShapes: [handle('pin')] });
    expect(item.code).toBe('FPR_JOINT_NOT_REALISED');
    expect(item.note).toContain('interference');
  });

  it('a 2 mm pin in a 40 mm bore is too loose to be a fit', () => {
    const kernel = kernelOf({ pin: [cylinder(1, true, [0, 10])], housing: [cylinder(20, false, [0, 10])] });
    const item = realiseJoint(kernel, { ...joint, parentShapes: [handle('housing')], childShapes: [handle('pin')] });
    expect(item.code).toBe('FPR_JOINT_NOT_REALISED');
    expect(item.note).toContain('10 %');
  });

  it('a world parent has no counterpart surface; faces off the axis or not parallel are ignored', () => {
    const kernel = kernelOf({
      pin: [cylinder(5, true, [0, 10])],
      offset: [cylinder(5.01, false, [0, 10], { origin: [3, 0, 0] })],
      tilted: [cylinder(5.01, false, [0, 10], { direction: [1, 0, 0] })],
    });
    expect(realiseJoint(kernel, { ...joint, parentShapes: [], childShapes: [handle('pin')] }).note).toContain('no coaxial');
    expect(realiseJoint(kernel, { ...joint, parentShapes: [handle('offset')], childShapes: [handle('pin')] }).code).toBe(
      'FPR_JOINT_NOT_REALISED',
    );
    expect(realiseJoint(kernel, { ...joint, parentShapes: [handle('tilted')], childShapes: [handle('pin')] }).code).toBe(
      'FPR_JOINT_NOT_REALISED',
    );
  });

  it('a kernel without topology is not_run', () => {
    const kernel = kernelOf({ pin: null, housing: [cylinder(5.01, false, [0, 10])] });
    const item = realiseJoint(kernel, { ...joint, parentShapes: [handle('housing')], childShapes: [handle('pin')] });
    expect(item.code).toBe('FPR_KERNEL_UNSUPPORTED');
    expect(item.status).toBe('not_run');
  });
});

/** Side surface of a faceted cylinder about the axis through `centre` (z along the joint axis); `outward` = pin, else bore (inward normals). */
function tube(
  radius: number,
  z: [number, number],
  options: { outward: boolean; centre?: [number, number]; segments?: number; arc?: number },
): MeshData {
  const { outward, centre = [0, 0], segments = 24, arc = 2 * Math.PI } = options;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let k = 0; k <= segments; k++) {
    const theta = (arc * k) / segments;
    for (const height of z) positions.push(centre[0] + radius * Math.cos(theta), centre[1] + radius * Math.sin(theta), height);
  }
  for (let k = 0; k < segments; k++) {
    const [p0, q0, p1, q1] = [2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 3];
    indices.push(...(outward ? [p0, p1, q1, p0, q1, q0] : [p0, q1, p1, p0, q0, q1]));
  }
  return { positions, indices } as MeshData;
}

describe('realiseJoint on the tessellation (kernel without exact faces)', () => {
  const blind = kernelOf({ p: null, c: null });
  const meshed = (parentMeshes: MeshData[], childMeshes: MeshData[]): Parameters<typeof realiseJoint>[1] => ({
    ...joint,
    parentShapes: [handle('p')],
    childShapes: [handle('c')],
    parentMeshes,
    childMeshes,
  });

  it('fits a pin in a bore: realised, unverified, noted approximate, radii and engagement from the vertices', () => {
    const item = realiseJoint(blind, meshed([tube(5.01, [-20, 20], { outward: false })], [tube(5, [-10, 10], { outward: true })]));
    expect(item.code).toBe('FPR_JOINT_REALISED');
    expect(item.status).toBe('pass');
    expect(item.unverified).toBe(true);
    expect(item.note).toMatch(/approximate/);
    expect(item.values['diametralClearanceMm']).toBeCloseTo(0.02, 9);
    expect(item.values['engagementMm']).toBeCloseTo(20, 9);
    expect(item.values['pinDiameterMm']).toBeCloseTo(10, 9);
  });

  it('works with the bore on the child side too', () => {
    const item = realiseJoint(blind, meshed([tube(5, [-10, 10], { outward: true })], [tube(5.01, [-20, 20], { outward: false })]));
    expect(item.code).toBe('FPR_JOINT_REALISED');
  });

  it('a bore off the joint axis is not realised', () => {
    const item = realiseJoint(
      blind,
      meshed([tube(5.01, [-20, 20], { outward: false, centre: [1, 0] })], [tube(5, [-10, 10], { outward: true })]),
    );
    expect(item.code).toBe('FPR_JOINT_NOT_REALISED');
    expect(item.status).toBe('warn');
    expect(item.note).toMatch(/approximate/);
  });

  it('a partial arc is not a pin or a bore, and a pin alone has no counterpart', () => {
    const half = tube(5.01, [-20, 20], { outward: false, arc: Math.PI / 2 });
    expect(realiseJoint(blind, meshed([half], [tube(5, [-10, 10], { outward: true })])).code).toBe('FPR_JOINT_NOT_REALISED');
    const alone = realiseJoint(blind, meshed([], [tube(5, [-10, 10], { outward: true })]));
    expect(alone.code).toBe('FPR_JOINT_NOT_REALISED');
    expect(alone.note).toContain('no coaxial');
  });

  it('a bore smaller than the pin is interference; a surface tilted from the axis is ignored', () => {
    const interference = realiseJoint(blind, meshed([tube(4.9, [-20, 20], { outward: false })], [tube(5, [-10, 10], { outward: true })]));
    expect(interference.note).toContain('interference');
    const tilted = { ...tube(5.01, [-20, 20], { outward: false }) };
    const tiltedMesh = {
      ...tilted,
      positions: tilted.positions.map((value, i) => (i % 3 === 0 ? value + (tilted.positions[i + 2] ?? 0) * 0.1 : value)),
    } as MeshData;
    expect(realiseJoint(blind, meshed([tiltedMesh], [tube(5, [-10, 10], { outward: true })])).code).toBe('FPR_JOINT_NOT_REALISED');
  });

  it('without any tessellation the joint stays not_run', () => {
    expect(realiseJoint(blind, meshed([], [])).status).toBe('not_run');
  });
});
