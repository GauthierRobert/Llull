import { expect } from 'vitest';
import { type CadDocument, type MeshData, type MeshSolidEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { warpMesh } from '@core/geometry/deform/meshWarp';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import { orientOutward, signedMeshVolume } from '@core/geometry/meshVolume';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import type { CommandResult } from '@core/commands/types';

export type KernelKind = 'none' | 'manifold' | 'exact';

/** The kernel installed for a test: none, the real Manifold kernel, or a stub exact kernel that builds affine deform nodes only. */
export async function installKernel(kind: KernelKind): Promise<GeometryKernel | null> {
  const kernel = kind === 'none' ? null : kind === 'manifold' ? await createManifoldKernel() : stubExactKernel();
  setGeometryKernel(kernel);
  return kernel;
}

interface StubShape {
  readonly mesh: MeshData;
}

/** Exact-kernel stand-in: B-rep topology present, `deform` builds the affine law only (like the native kernel in M1), volumes exact for the stored triangles. */
function stubExactKernel(): GeometryKernel {
  const meshOf = (entityTriangles: number[]): MeshData => ({
    positions: entityTriangles,
    indices: Array.from({ length: entityTriangles.length / 3 }, (_, i) => i),
  });
  return kernelFromOps<StubShape>({
    name: 'occt',
    deformLaws: new Set(['affine']),
    solid: (entity) => ({ mesh: meshOf(entityToTriangles(entity, createEmptyDocument()).flatMap((triangle) => triangle.flat())) }),
    boolean: () => null,
    fillet: () => null,
    blend: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (shape) => shape,
    scale: (shape) => shape,
    deform: (shape, node) => {
      const warped = node.law.kind === 'affine' ? warpMesh(shape.mesh, node, { tolerance: node.output.tolerance }) : null;
      return warped?.ok === true ? { mesh: warped.mesh } : null;
    },
    tessellate: (shape) => shape.mesh,
    topology: () => ({ solids: 1, faces: [], edges: [], vertices: 0, volume: 0 }),
    massProperties: (shape) => ({
      volume: Math.abs(signedMeshVolume(shape.mesh.positions, orientOutward(shape.mesh.positions, shape.mesh.indices))),
      area: 0,
      centroid: [0, 0, 0],
      inertiaAtCentroid: [0, 0, 0, 0, 0, 0],
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    }),
    exportStep: () => null,
    release: () => undefined,
  });
}

export function addBox(size: Vec3 = [10, 10, 100], anchor: 'base-center' | 'center' = 'base-center'): { doc: CadDocument; id: string } {
  const result = execute(createEmptyDocument(), 'add_box', { size, anchor });
  return { doc: result.document, id: result.affected[0] as string };
}

export function addCylinder(radius: number, height: number): { doc: CadDocument; id: string } {
  const result = execute(createEmptyDocument(), 'add_cylinder', { radius, height, anchor: 'base-center' });
  return { doc: result.document, id: result.affected[0] as string };
}

export function meshEntity(doc: CadDocument, id: string): MeshSolidEntity {
  const entity = doc.entities[id];
  if (entity?.kind !== 'mesh') throw new Error(`entity ${id} is not a mesh`);
  return entity;
}

export function volumeOf(doc: CadDocument, id: string): number {
  const { mesh } = meshEntity(doc, id);
  return Math.abs(signedMeshVolume(mesh.positions, orientOutward(mesh.positions, mesh.indices)));
}

export function areaOf(doc: CadDocument, id: string): number {
  const { mesh } = meshEntity(doc, id);
  let area = 0;
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => (mesh.indices[t + k] as number) * 3);
    const at = (o: number, axis: number): number => mesh.positions[o + axis] as number;
    const u = [0, 1, 2].map((axis) => at(b as number, axis) - at(a as number, axis));
    const v = [0, 1, 2].map((axis) => at(c as number, axis) - at(a as number, axis));
    area +=
      0.5 *
      Math.hypot(
        (u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number),
        (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number),
        (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number),
      );
  }
  return area;
}

export function relative(measured: number, expected: number): number {
  return Math.abs(measured - expected) / Math.abs(expected);
}

/** The result's data, typed by the caller (asserts the command returned one). */
export function dataOf<T>(result: CommandResult): T {
  expect(result.data).toBeDefined();
  return result.data as T;
}

export interface RunData {
  readonly id: string;
  readonly path: 'exact' | 'mesh';
  readonly kernel: string | null;
  readonly frame: { origin: number[]; axis: number[]; reference: number[]; defaulted: string[] };
  readonly region?: { start: number; end: number; falloff: string };
  readonly tolerance: { value: number; defaulted: boolean };
  readonly jacobian: { min: number; max: number };
  readonly triangles: number;
  readonly volume: { value: number; method: 'exact' | 'mesh' };
  readonly edgeLength: number | null;
  readonly chordError: number | null;
}

export interface AnalysisData {
  readonly path: 'exact' | 'mesh';
  readonly law: { kind: string };
  readonly jacobian: { min: number; max: number; bound: { min: number; max: number } };
  readonly volume: { source: number; predicted: number; measured: number; driftRel: number; method: string };
  readonly maxDisplacement: number;
  readonly approximation: { maxError: number; tolerance: { value: number } } | null;
  readonly regionCrease: Array<{ at: string; angleRad: number; present: boolean }>;
  readonly fibres: { neutral: number; inner: number; outer: number } | null;
  readonly unverified: boolean;
}

export interface CheckData {
  readonly status: 'pass' | 'warn' | 'fail';
  readonly findings: Array<{ code: string; severity: string; ids: string[]; value: number; limit: number; unit: string }>;
  readonly tolerances: Array<{ name: string; defaulted: boolean }>;
  readonly unverified: boolean;
  readonly reviewRequired: boolean;
  readonly reviewReason?: string;
}

export const WORLD_Z = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] } as const;
