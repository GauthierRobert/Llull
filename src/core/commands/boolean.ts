/**
 * Boolean solid commands — union, subtract, intersect.
 *
 * Each command consumes two 3D solid operands (by id) and produces a single
 * `MeshSolidEntity` whose geometry is evaluated by the injected GeometryKernel.
 * When the kernel is unavailable (null) or returns null, the command no-ops.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity, EntityGroup } from '../model/types';
import { is3D } from '../model/types';
import type { MeshSolidEntity } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { getGeometryKernel, type BooleanOp } from '../geometry/kernel';
import { nextId } from '../../lib/id';

// ---------------------------------------------------------------------------
// Internal helper — remove two operand ids from entities/order/selection/groups
// and add the result entity, mirroring delete_entity's group handling.
// ---------------------------------------------------------------------------

function consumeOperandsAndAdd(
  doc: CadDocument,
  idA: string,
  idB: string,
  result: MeshSolidEntity,
): CadDocument {
  // Build new entities map — remove operands, add result.
  const entities = { ...doc.entities };
  delete entities[idA];
  delete entities[idB];
  entities[result.id] = result;

  // Filter operands from order; append new mesh id.
  const order = [...doc.order.filter((id) => id !== idA && id !== idB), result.id];

  // Filter operands from selection.
  const selection = doc.selection.filter((id) => id !== idA && id !== idB);

  // Prune operand ids from groups; dissolve groups that fall below 2 members.
  const existingGroups = doc.groups ?? {};
  const nextGroups: Record<string, EntityGroup> = {};
  for (const group of Object.values(existingGroups)) {
    const prunedIds = group.memberIds.filter((mid) => mid !== idA && mid !== idB);
    if (prunedIds.length >= 2) {
      nextGroups[group.id] = { ...group, memberIds: prunedIds };
    }
    // Groups that drop below 2 members are dissolved (omitted).
  }

  return { ...doc, entities, order, selection, groups: nextGroups };
}

// ---------------------------------------------------------------------------
// Shared validation helper — returns an error result or null on success.
// ---------------------------------------------------------------------------

type NoOp = { document: CadDocument; summary: string; affected: [] };

function validateOperands(
  doc: CadDocument,
  opName: string,
  a: string,
  b: string,
): NoOp | null {
  if (a === b) {
    return {
      document: doc,
      summary: `${opName}: operands a and b must be different ids (got '${a}').`,
      affected: [],
    };
  }
  const entA = doc.entities[a];
  if (!entA) {
    return {
      document: doc,
      summary: `${opName}: entity '${a}' not found.`,
      affected: [],
    };
  }
  const entB = doc.entities[b];
  if (!entB) {
    return {
      document: doc,
      summary: `${opName}: entity '${b}' not found.`,
      affected: [],
    };
  }
  if (!is3D(entA)) {
    return {
      document: doc,
      summary: `${opName}: entity '${a}' is a 2D shape; boolean operations require 3D solids.`,
      affected: [],
    };
  }
  if (!is3D(entB)) {
    return {
      document: doc,
      summary: `${opName}: entity '${b}' is a 2D shape; boolean operations require 3D solids.`,
      affected: [],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared kernel invocation — returns NoOp or new entity.
// ---------------------------------------------------------------------------

function runBoolean(
  doc: CadDocument,
  opName: string,
  op: BooleanOp,
  a: string,
  b: string,
): CommandResult {
  const noOp = validateOperands(doc, opName, a, b);
  if (noOp) return noOp;

  const entA = doc.entities[a] as Entity;
  const entB = doc.entities[b] as Entity;

  const k = getGeometryKernel();
  if (!k) {
    return {
      document: doc,
      summary: `${opName}: geometry kernel not available. Inject a kernel via setGeometryKernel() before calling boolean commands.`,
      affected: [],
    };
  }

  const meshData = k.booleanOp(op, entA, entB);
  if (!meshData) {
    return {
      document: doc,
      summary: `${opName}: kernel returned null for operands '${a}' and '${b}'. The geometry may be degenerate or unsupported.`,
      affected: [],
    };
  }

  const newId = nextId('mesh');
  const meshEntity: MeshSolidEntity = {
    id: newId,
    kind: 'mesh',
    mesh: meshData,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: entA.layerId,
    color: entA.color,
  };

  const triangleCount = meshData.indices.length / 3;
  return {
    document: consumeOperandsAndAdd(doc, a, b, meshEntity),
    summary: `${opName}: merged '${a}' and '${b}' into mesh '${newId}' (${triangleCount} triangles). Operands consumed.`,
    affected: [newId],
  };
}

// ---------------------------------------------------------------------------
// boolean_union
// ---------------------------------------------------------------------------

interface BooleanUnionParams {
  a: string;
  b: string;
}

/**
 * @command boolean_union
 * @pure
 * @affects removes entities a and b; creates 1 mesh entity (their union)
 * @invariant both a and b must be 3D solids; geometry kernel must be injected
 * @failure missing id, 2D operand, same id, kernel absent, or kernel failure -> no-op, affected:[]
 */
export const booleanUnion: CommandDefinition<BooleanUnionParams> = {
  name: 'boolean_union',
  description:
    'Merge two 3D solid entities into a single mesh entity using a CSG union operation. ' +
    'Both operand entities are consumed (removed) and replaced by the union mesh. ' +
    'Requires a geometry kernel to be injected (available after app initialization). ' +
    'Both operands must be 3D solids (box, cylinder, sphere, extrusion, or mesh).',
  paramsSchema: {
    type: 'object',
    properties: {
      a: { type: 'string', description: 'Id of the first 3D solid operand.' },
      b: { type: 'string', description: 'Id of the second 3D solid operand.' },
    },
    required: ['a', 'b'],
  },
  run: (doc, { a, b }): CommandResult => runBoolean(doc, 'boolean_union', 'union', a, b),
};

// ---------------------------------------------------------------------------
// boolean_subtract
// ---------------------------------------------------------------------------

interface BooleanSubtractParams {
  a: string;
  b: string;
}

/**
 * @command boolean_subtract
 * @pure
 * @affects removes entities a and b; creates 1 mesh entity (a minus b)
 * @invariant both a and b must be 3D solids; result = a − b (order matters)
 * @failure missing id, 2D operand, same id, kernel absent, or kernel failure -> no-op, affected:[]
 */
export const booleanSubtract: CommandDefinition<BooleanSubtractParams> = {
  name: 'boolean_subtract',
  description:
    'Subtract the volume of 3D solid b from 3D solid a, producing a mesh entity. ' +
    'Order matters: result = a minus b. ' +
    'Both operand entities are consumed (removed) and replaced by the result mesh. ' +
    'Requires a geometry kernel to be injected. ' +
    'Both operands must be 3D solids (box, cylinder, sphere, extrusion, or mesh).',
  paramsSchema: {
    type: 'object',
    properties: {
      a: { type: 'string', description: 'Id of the base 3D solid (the solid to subtract from).' },
      b: { type: 'string', description: 'Id of the tool 3D solid (the solid to subtract with).' },
    },
    required: ['a', 'b'],
  },
  run: (doc, { a, b }): CommandResult => runBoolean(doc, 'boolean_subtract', 'subtract', a, b),
};

// ---------------------------------------------------------------------------
// boolean_intersect
// ---------------------------------------------------------------------------

interface BooleanIntersectParams {
  a: string;
  b: string;
}

/**
 * @command boolean_intersect
 * @pure
 * @affects removes entities a and b; creates 1 mesh entity (their intersection)
 * @invariant both a and b must be 3D solids; kernel must be injected
 * @failure missing id, 2D operand, same id, kernel absent, or kernel failure -> no-op, affected:[]
 */
export const booleanIntersect: CommandDefinition<BooleanIntersectParams> = {
  name: 'boolean_intersect',
  description:
    'Compute the intersection of two 3D solid entities, producing a mesh entity that covers ' +
    'only the volume shared by both solids. ' +
    'Both operand entities are consumed (removed) and replaced by the intersection mesh. ' +
    'Requires a geometry kernel to be injected. ' +
    'Both operands must be 3D solids (box, cylinder, sphere, extrusion, or mesh).',
  paramsSchema: {
    type: 'object',
    properties: {
      a: { type: 'string', description: 'Id of the first 3D solid operand.' },
      b: { type: 'string', description: 'Id of the second 3D solid operand.' },
    },
    required: ['a', 'b'],
  },
  run: (doc, { a, b }): CommandResult => runBoolean(doc, 'boolean_intersect', 'intersect', a, b),
};
