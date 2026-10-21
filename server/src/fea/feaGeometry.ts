/**
 * Geometry of an analysed solid for the mesher: exact STEP from the kernel when it can write one (OCC), else a binary STL of its
 * tessellation (Manifold), else the stored triangles of an untransformed mesh entity. Coordinates are in document units; the bridge scales.
 */

import type { GeometryKernel } from '@core/geometry/kernel';
import { operandRecipe } from '@core/geometry/operandRecipe';
import { isCurvedPart } from '@core/geometry/curvedFaces';
import { is3D, type CadDocument, type MeshData } from '@core/model/types';

export type PartGeometry =
  | { readonly kind: 'step'; readonly stepBase64: string }
  | { readonly kind: 'stl'; readonly stlBase64: string; readonly curved: boolean };

export interface GeometryFailure {
  readonly code: 'FEA_PART_INVALID' | 'FEA_KERNEL_REQUIRED';
  readonly message: string;
}

/** Binary STL (80-byte header, count, 50 bytes per facet; normals left zero) of an indexed triangle mesh. */
function binaryStl(mesh: MeshData): Buffer {
  const count = Math.floor(mesh.indices.length / 3);
  const out = Buffer.alloc(84 + count * 50);
  out.writeUInt32LE(count, 80);
  for (let t = 0; t < count; t++) {
    const base = 84 + t * 50 + 12;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = (mesh.indices[3 * t + corner] ?? 0) * 3;
      for (let axis = 0; axis < 3; axis++) out.writeFloatLE(mesh.positions[vertex + axis] ?? 0, base + corner * 12 + axis * 4);
    }
  }
  return out;
}

const IDENTITY_TOLERANCE = 1e-12;

function storedMesh(doc: CadDocument, entityId: string): MeshData | null {
  const entity = doc.entities[entityId];
  if (entity?.kind !== 'mesh') return null;
  const placed = [...entity.position, ...entity.rotation].some((value) => Math.abs(value) > IDENTITY_TOLERANCE);
  return placed ? null : entity.mesh;
}

/**
 * @failure missing / 2D entity -> FEA_PART_INVALID; no kernel result and no untransformed stored mesh -> FEA_KERNEL_REQUIRED
 */
export function partGeometry(doc: CadDocument, entityId: string, kernel: GeometryKernel | null): PartGeometry | GeometryFailure {
  const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
  if (entity === undefined || !is3D(entity)) {
    return { code: 'FEA_PART_INVALID', message: `part '${entityId}' is not a 3D solid of the document` };
  }
  const shape = kernel?.evaluate(operandRecipe(kernel, entity)) ?? null;
  if (kernel !== null && shape !== null) {
    const step = kernel.exportStep([shape]);
    if (step !== null) return { kind: 'step', stepBase64: Buffer.from(step, 'utf8').toString('base64') };
    const mesh = kernel.tessellate(shape);
    if (mesh !== null && mesh.indices.length > 0)
      return { kind: 'stl', stlBase64: binaryStl(mesh).toString('base64'), curved: isCurvedPart(entity, mesh) };
  }
  const stored = storedMesh(doc, entityId);
  if (stored !== null && stored.indices.length > 0)
    return { kind: 'stl', stlBase64: binaryStl(stored).toString('base64'), curved: isCurvedPart(entity, stored) };
  return {
    code: 'FEA_KERNEL_REQUIRED',
    message: `no geometry kernel could build '${entityId}' (kind '${entity.kind}'); start the server with LLULL_KERNEL=manifold or occt`,
  };
}
