/**
 * Rendered three.js geometry (viewport primitive builders), core bounds (entityBounds /
 * rotatedEntityBounds) and export tessellation must all describe the same +Z-up solid.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { createEmptyDocument } from '@core/model/types';
import type { Entity, Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { entityBounds, rotatedEntityBounds } from '@core/commands/scene';
import { entityToTriangles } from '@core/commands/export';
import {
  buildConeGeometry,
  buildCylinderGeometry,
  buildPyramidGeometry,
  buildSphereGeometry,
  buildTorusGeometry,
  buildWedgeGeometry,
} from '@ui/viewport/3d/entities/primitiveGeometry';
import { __resetIdCounter } from '@lib/id';

const POSITION: Vec3 = [10, -4, 3];

function renderedBounds(geometry: THREE.BufferGeometry, position: Vec3): { min: Vec3; max: Vec3 } {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox as THREE.Box3;
  return {
    min: [box.min.x + position[0], box.min.y + position[1], box.min.z + position[2]],
    max: [box.max.x + position[0], box.max.y + position[1], box.max.z + position[2]],
  };
}

function tessellatedBounds(entity: Entity): { min: Vec3; max: Vec3 } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const triangle of entityToTriangles(entity, createEmptyDocument())) {
    for (const vertex of triangle) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, vertex[axis]!);
        max[axis] = Math.max(max[axis]!, vertex[axis]!);
      }
    }
  }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 };
}

function expectBoundsClose(
  actual: { min: Vec3; max: Vec3 },
  expected: { min: Vec3; max: Vec3 },
  tolerance: number,
): void {
  for (let axis = 0; axis < 3; axis++) {
    expect(Math.abs(actual.min[axis]! - expected.min[axis]!)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(actual.max[axis]! - expected.max[axis]!)).toBeLessThanOrEqual(tolerance);
  }
}

interface Case {
  kind: string;
  command: string;
  params: Record<string, unknown>;
  build: () => THREE.BufferGeometry;
}

const CASES: Case[] = [
  { kind: 'cylinder', command: 'add_cylinder', params: { radius: 2, height: 6 }, build: () => buildCylinderGeometry(2, 6) },
  { kind: 'cone', command: 'add_cone', params: { radius: 2, height: 6 }, build: () => buildConeGeometry(2, 6) },
  { kind: 'pyramid', command: 'add_pyramid', params: { baseWidth: 4, baseDepth: 2, height: 5 }, build: () => buildPyramidGeometry(4, 2, 5) },
  { kind: 'wedge', command: 'add_wedge', params: { size: [3, 4, 5] }, build: () => buildWedgeGeometry(3, 4, 5) },
  { kind: 'sphere', command: 'add_sphere', params: { radius: 3 }, build: () => buildSphereGeometry(3) },
  { kind: 'torus', command: 'add_torus', params: { ringRadius: 4, tubeRadius: 1 }, build: () => buildTorusGeometry(4, 1) },
];

describe('primitive bounds agreement (render / core bbox / export tessellation)', () => {
  beforeEach(() => __resetIdCounter());

  for (const testCase of CASES) {
    it(`${testCase.kind}: rendered geometry == entityBounds == rotatedEntityBounds == tessellation`, () => {
      const result = execute(createEmptyDocument(), testCase.command, { ...testCase.params, position: POSITION });
      const entity = result.document.entities[result.affected[0]!] as Entity;
      expect(entity.kind).toBe(testCase.kind);

      const core = entityBounds(entity);
      const oriented = rotatedEntityBounds(entity);
      const rendered = renderedBounds(testCase.build(), POSITION);
      const tessellated = tessellatedBounds(entity);

      expectBoundsClose(oriented, core, 1e-9);
      // Round kinds are faceted meshes: lateral extents may fall short of the analytic bound by
      // the facet sagitta (<0.15 here); the Z extent must agree tightly for every kind.
      // Torus tube segments need not land on the exact top of the tube.
      const zTolerance = testCase.kind === 'torus' ? 0.15 : 1e-5;
      expectBoundsClose(rendered, core, 0.15);
      expectBoundsClose(tessellated, core, 0.15);
      expect(Math.abs(rendered.min[2]! - core.min[2]!)).toBeLessThanOrEqual(zTolerance);
      expect(Math.abs(rendered.max[2]! - core.max[2]!)).toBeLessThanOrEqual(zTolerance);
      expect(Math.abs(tessellated.min[2]! - core.min[2]!)).toBeLessThanOrEqual(zTolerance);
      expect(Math.abs(tessellated.max[2]! - core.max[2]!)).toBeLessThanOrEqual(zTolerance);
    });
  }

  it('cylinder bbox uses the same +Z axis convention as the cone', () => {
    const cylinder = execute(createEmptyDocument(), 'add_cylinder', { radius: 2, height: 6, position: POSITION });
    const cone = execute(createEmptyDocument(), 'add_cone', { radius: 2, height: 6, position: POSITION });
    const cylinderBounds = entityBounds(cylinder.document.entities[cylinder.affected[0]!] as Entity);
    const coneBounds = entityBounds(cone.document.entities[cone.affected[0]!] as Entity);
    expect(cylinderBounds.max[2] - cylinderBounds.min[2]).toBe(6);
    expect(cylinderBounds.max[1] - cylinderBounds.min[1]).toBe(4);
    expect(cylinderBounds.min[0]).toBe(coneBounds.min[0]);
    expect(cylinderBounds.max[1]).toBe(coneBounds.max[1]);
    // Cylinder is centered on position along Z; cone's base sits at position.
    expect(cylinderBounds.min[2]).toBe(POSITION[2] - 3);
    expect(coneBounds.min[2]).toBe(POSITION[2]);
  });
});
