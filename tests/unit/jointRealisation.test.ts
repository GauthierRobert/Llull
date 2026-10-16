/** Joint realisation with a fake kernel that serves canned cylinder faces (the OCC end-to-end case is in server/tests). */
import { describe, expect, it } from 'vitest';
import type { GeometryKernel, ShapeFace, ShapeHandle, ShapeTopology } from '@core/geometry/kernel';
import { realiseJoint } from '@core/geometry/assemblyCheck/jointRealisation';
import type { Vec3 } from '@core/model/types';

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

const joint = { id: 'hinge', anchor: [0, 0, 0] as Vec3, axis: [0, 0, 1] as Vec3, mmPerUnit: 1 };

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
