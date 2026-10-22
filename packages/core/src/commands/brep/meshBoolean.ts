/** Mesh-engine path of `boolean` (07 MSH M2, FR-MSH-17): triangle operands are combined by the mesh engine and the result stays a plain mesh (no brep). */

import type { BooleanOp, CadDocument, Entity } from '../../model/types';
import { resolveMeshEngine } from '../../geometry/mesh/engine';
import type { MeshProcessingEngine } from '../../geometry/mesh/engineTypes';
import {
  newMeshEntity,
  replaceWith,
  engineOutcome,
  isCommandResult,
  isLoadFailure,
  loadSolidMesh,
  measureMesh,
  meshRejection,
  outwardMesh,
  withConventions,
} from '../mesh/meshCommon';
import type { CommandResult } from '../types';

/** True when every operand is a triangle-only mesh (no exact recipe): the case `engine: "auto"` sends to the mesh engine. */
export function isTriangleOnly(operands: readonly Entity[]): boolean {
  return operands.every((operand) => operand.kind === 'mesh' && operand.brep === undefined);
}

/**
 * Combine `ids` (first = base) with the mesh engine; operands are consumed, the result is one new mesh entity.
 * @failure unknown / non-solid operand -> MESH_ENTITY_NOT_FOUND / MESH_NOT_A_MESH; open operand -> MESH_NON_MANIFOLD; empty result -> MESH_BOOLEAN_FAILED
 */
export function meshBoolean(
  doc: CadDocument,
  opName: string,
  op: BooleanOp,
  base: string,
  tools: readonly string[],
  extra: MeshProcessingEngine | null,
): CommandResult {
  const ids = [base, ...tools];
  const loaded = [];
  for (const id of ids) {
    const operand = loadSolidMesh(doc, id);
    if (isLoadFailure(operand)) return meshRejection(doc, opName, operand.code, operand.message, operand.ids);
    loaded.push(operand);
  }
  const [first, ...rest] = loaded as [(typeof loaded)[number], ...typeof loaded];
  const engine = resolveMeshEngine(extra);
  const outcome = engineOutcome(
    doc,
    opName,
    engine.run(
      { mesh: outwardMesh(first.mesh) },
      { op: 'boolean', kind: op, others: rest.map((tool) => ({ mesh: outwardMesh(tool.mesh) })) },
    ),
    [...ids],
  );
  if (isCommandResult(outcome)) return outcome;
  const mesh = outcome.mesh;
  const measure = mesh !== undefined ? measureMesh(mesh) : null;
  if (mesh === undefined || measure === null || mesh.indices.length === 0 || (measure.volume ?? 0) <= 0) {
    return meshRejection(
      doc,
      opName,
      'MESH_BOOLEAN_FAILED',
      `the result of '${ids[0]}' and ${ids
        .slice(1)
        .map((id) => `'${id}'`)
        .join(', ')} is empty (no volume remains); operands kept`,
      [...ids],
    );
  }
  const unverified = loaded.some((operand) => operand.unverified);
  const entity = newMeshEntity(mesh, { unverified, color: first.entity.color, layerId: first.entity.layerId });
  const replaced = replaceWith(doc, new Set(ids), entity);
  const data = withConventions(
    doc,
    {
      id: entity.id,
      operands: [...ids],
      engine: outcome.provenance.engine,
      faces: measure.faces,
      volume: measure.volume,
      area: measure.area,
    },
    { unverified, provenance: outcome.provenance },
  );
  return {
    document: replaced.document,
    summary: `${opName}: merged '${ids[0]}' and ${ids
      .slice(1)
      .map((id) => `'${id}'`)
      .join(
        ', ',
      )} into mesh '${entity.id}' (${measure.faces} triangles, mesh engine ${outcome.provenance.version}; no brep). Operands consumed.${replaced.suffix}`,
    affected: [entity.id],
    data,
  };
}
