/** Shared fixtures of the 07 FTR feature tests: the real Manifold kernel and the machined-plate stock. */

import { beforeAll, afterAll } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { signedMeshVolume } from '@core/geometry/meshVolume';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';

/** Installs the Manifold kernel for the suite; read it inside tests via the returned getter. */
export function manifoldSuite(): () => GeometryKernel {
  let kernel: GeometryKernel | null = null;
  beforeAll(async () => {
    kernel = await createManifoldKernel();
    setGeometryKernel(kernel);
  });
  afterAll(() => setGeometryKernel(null));
  return () => kernel as GeometryKernel;
}

export const ctxWith = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });

/** A 100 x 60 x 10 plate with its min corner at the origin; returns the document and the plate id. */
export function plate(size: [number, number, number] = [100, 60, 10]): { doc: CadDocument; id: string } {
  const result = execute(createEmptyDocument(), 'add_box', { size, position: [0, 0, 0], anchor: 'min' });
  return { doc: result.document, id: result.affected[0] as string };
}

export const meshOf = (doc: CadDocument, id: string): MeshSolidEntity => doc.entities[id] as MeshSolidEntity;

/** Volume of a mesh entity's display triangles. */
export const volumeOf = (doc: CadDocument, id: string): number => {
  const { mesh } = meshOf(doc, id);
  return signedMeshVolume(mesh.positions, mesh.indices);
};

export const idOf = (result: CommandResult): string => result.affected[0] as string;
