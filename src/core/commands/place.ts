/**
 * Place-by-relation commands — spatial layout utilities.
 *
 * @layer core/commands
 *
 * Three pure commands that reposition entities relative to each other using
 * world-space bounding-box arithmetic. No new geometry is created; only the
 * `position` of targeted entities changes.
 *
 *   align        — snap a set of entities' bounding-box edges/centers to a reference
 *   distribute   — evenly space >2 entities along an axis (equal-spacing or equal-gap)
 *   stack_on     — translate one entity so its min face meets another entity's max face
 *
 * All three reuse `entityBounds` / `rotatedEntityBounds` from `scene.ts`; no new
 * geometry math is introduced here.
 */

import type { CadDocument, Entity, Vec3 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { entityBounds } from './scene';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return a clone of `e` with a new position (pure, never mutates). */
function moveEntityTo(e: Entity, newPosition: Vec3): Entity {
  return { ...e, position: newPosition };
}

/** Patch multiple entities into the document at once (pure). */
function withEntities(doc: CadDocument, updates: Entity[]): CadDocument {
  const newEntities = { ...doc.entities };
  for (const e of updates) {
    newEntities[e.id] = e;
  }
  return { ...doc, entities: newEntities };
}

// ---------------------------------------------------------------------------
// align
// ---------------------------------------------------------------------------

type AlignEdge =
  | 'min-x' | 'min-y' | 'min-z'
  | 'max-x' | 'max-y' | 'max-z'
  | 'center-x' | 'center-y' | 'center-z';

interface AlignParams {
  targetIds: string[];
  edge: AlignEdge;
  referenceId: string;
}

/**
 * @command align
 * @pure
 * @layer core/commands
 * @affects moves every entity in targetIds (their position is shifted along one axis)
 * @invariant all targetIds and referenceId must exist; reference entity is not moved
 * @failure missing id -> no-op, affected:[]
 */
export const align: CommandDefinition<AlignParams> = {
  name: 'align',
  description:
    'Move every entity in targetIds so that its bounding-box edge (or center) along the ' +
    'specified axis matches the reference entity\'s. ' +
    'edge values: "min-x", "min-y", "min-z", "max-x", "max-y", "max-z", ' +
    '"center-x", "center-y", "center-z". ' +
    'The reference entity is not moved. Returns affected: targetIds.',
  paramsSchema: {
    type: 'object',
    properties: {
      targetIds: {
        type: 'array',
        description: 'Ids of entities to move. Must all exist in the document.',
        items: { type: 'string' },
      },
      edge: {
        type: 'string',
        description:
          'Which bounding-box face or center to align along: ' +
          '"min-x"|"min-y"|"min-z"|"max-x"|"max-y"|"max-z"|"center-x"|"center-y"|"center-z".',
      },
      referenceId: {
        type: 'string',
        description: 'Id of the entity whose bounding-box edge is the alignment target. Not moved.',
      },
    },
    required: ['targetIds', 'edge', 'referenceId'],
  },
  run: (doc, { targetIds, edge, referenceId }): CommandResult => {
    if (!Array.isArray(targetIds) || targetIds.length === 0) {
      return { document: doc, summary: 'align: targetIds must be a non-empty array.', affected: [] };
    }
    const refEntity = doc.entities[referenceId];
    if (!refEntity) {
      return { document: doc, summary: `align: reference entity "${referenceId}" not found.`, affected: [] };
    }
    const missingTarget = targetIds.find((id) => !doc.entities[id]);
    if (missingTarget) {
      return { document: doc, summary: `align: target entity "${missingTarget}" not found.`, affected: [] };
    }

    const VALID_EDGES: ReadonlySet<string> = new Set<AlignEdge>([
      'min-x', 'min-y', 'min-z', 'max-x', 'max-y', 'max-z', 'center-x', 'center-y', 'center-z',
    ]);
    if (!VALID_EDGES.has(edge)) {
      return { document: doc, summary: `align: invalid edge "${edge}". Must be one of min-x, min-y, min-z, max-x, max-y, max-z, center-x, center-y, center-z.`, affected: [] };
    }

    const refBounds = entityBounds(refEntity);
    // Determine which axis and which face/center to use as the reference value.
    let refValue: number;
    let axis: 0 | 1 | 2;
    let edgeType: 'min' | 'max' | 'center';

    if (edge === 'min-x')      { axis = 0; edgeType = 'min'; refValue = refBounds.min[0]; }
    else if (edge === 'max-x') { axis = 0; edgeType = 'max'; refValue = refBounds.max[0]; }
    else if (edge === 'center-x') { axis = 0; edgeType = 'center'; refValue = (refBounds.min[0] + refBounds.max[0]) / 2; }
    else if (edge === 'min-y') { axis = 1; edgeType = 'min'; refValue = refBounds.min[1]; }
    else if (edge === 'max-y') { axis = 1; edgeType = 'max'; refValue = refBounds.max[1]; }
    else if (edge === 'center-y') { axis = 1; edgeType = 'center'; refValue = (refBounds.min[1] + refBounds.max[1]) / 2; }
    else if (edge === 'min-z') { axis = 2; edgeType = 'min'; refValue = refBounds.min[2]; }
    else if (edge === 'max-z') { axis = 2; edgeType = 'max'; refValue = refBounds.max[2]; }
    else { /* center-z */ axis = 2; edgeType = 'center'; refValue = (refBounds.min[2] + refBounds.max[2]) / 2; }

    const moved: Entity[] = [];
    for (const id of targetIds) {
      const e = doc.entities[id]!;
      const bounds = entityBounds(e);
      let currentValue: number;
      if (edgeType === 'min')         currentValue = bounds.min[axis];
      else if (edgeType === 'max')    currentValue = bounds.max[axis];
      else /* center */               currentValue = (bounds.min[axis] + bounds.max[axis]) / 2;

      const delta = refValue - currentValue;
      if (Math.abs(delta) < 1e-10) continue; // Already aligned; no-op for this entity.

      const newPos: Vec3 = [
        e.position[0] + (axis === 0 ? delta : 0),
        e.position[1] + (axis === 1 ? delta : 0),
        e.position[2] + (axis === 2 ? delta : 0),
      ];
      moved.push(moveEntityTo(e, newPos));
    }

    if (moved.length === 0) {
      return { document: doc, summary: `align: all ${targetIds.length} entit${targetIds.length === 1 ? 'y' : 'ies'} already aligned to ${edge} of "${referenceId}".`, affected: [] };
    }

    const newDoc = withEntities(doc, moved);
    const movedIds = moved.map((e) => e.id);
    return {
      document: newDoc,
      summary: `align: moved ${moved.length} entit${moved.length === 1 ? 'y' : 'ies'} to ${edge} of "${referenceId}".`,
      affected: movedIds,
    };
  },
};

// ---------------------------------------------------------------------------
// distribute
// ---------------------------------------------------------------------------

type DistributeAxis = 'x' | 'y' | 'z';
type DistributeMode = 'equal-spacing' | 'equal-gap';

interface DistributeParams {
  targetIds: string[];
  axis: DistributeAxis;
  mode?: DistributeMode;
}

/**
 * @command distribute
 * @pure
 * @layer core/commands
 * @affects repositions targetIds along the specified axis
 * @invariant targetIds.length >= 2; first and last entity are anchors (not moved)
 * @failure < 2 targetIds -> no-op; missing id -> no-op
 */
export const distribute: CommandDefinition<DistributeParams> = {
  name: 'distribute',
  description:
    'Distribute 2 or more entities evenly along a single axis. ' +
    'mode="equal-spacing" (default): center-to-center step is uniform. ' +
    'mode="equal-gap": gap between AABBs is uniform. ' +
    'The first and last entity (by their current position along the axis) are the anchors ' +
    'and are not moved; all entities in between are repositioned. ' +
    'Returns affected: the ids of the entities that actually moved.',
  paramsSchema: {
    type: 'object',
    properties: {
      targetIds: {
        type: 'array',
        description: 'Ids of entities to distribute. Must contain at least 2 existing entity ids.',
        items: { type: 'string' },
      },
      axis: {
        type: 'string',
        description: 'Axis along which to distribute: "x", "y", or "z".',
      },
      mode: {
        type: 'string',
        description:
          '"equal-spacing" (default): equal center-to-center distance. ' +
          '"equal-gap": equal gap between entity bounding boxes.',
      },
    },
    required: ['targetIds', 'axis'],
  },
  run: (doc, { targetIds, axis, mode = 'equal-spacing' }): CommandResult => {
    if (!Array.isArray(targetIds) || targetIds.length < 2) {
      return { document: doc, summary: 'distribute: targetIds must contain at least 2 entity ids.', affected: [] };
    }
    const missingId = targetIds.find((id) => !doc.entities[id]);
    if (missingId) {
      return { document: doc, summary: `distribute: entity "${missingId}" not found.`, affected: [] };
    }
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
      return { document: doc, summary: `distribute: invalid axis "${axis}". Must be "x", "y", or "z".`, affected: [] };
    }
    if (mode !== 'equal-spacing' && mode !== 'equal-gap') {
      return { document: doc, summary: `distribute: invalid mode "${mode}". Must be "equal-spacing" or "equal-gap".`, affected: [] };
    }

    const axisIndex: 0 | 1 | 2 = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;

    // Sort entities by their current center along the axis.
    const entities = targetIds.map((id) => {
      const e = doc.entities[id]!;
      const b = entityBounds(e);
      const center = (b.min[axisIndex] + b.max[axisIndex]) / 2;
      const halfExtent = (b.max[axisIndex] - b.min[axisIndex]) / 2;
      return { e, center, halfExtent };
    });
    entities.sort((a, b) => a.center - b.center);

    if (entities.length < 2) {
      return { document: doc, summary: 'distribute: need at least 2 entities.', affected: [] };
    }

    // The first and last are anchors.
    const firstCenter = entities[0]!.center;
    const lastCenter = entities[entities.length - 1]!.center;
    const n = entities.length;

    const moved: Entity[] = [];

    if (mode === 'equal-spacing') {
      // Equal center-to-center step.
      const step = (lastCenter - firstCenter) / (n - 1);
      for (let i = 1; i < n - 1; i++) {
        const item = entities[i]!;
        const targetCenter = firstCenter + step * i;
        const delta = targetCenter - item.center;
        if (Math.abs(delta) < 1e-10) continue;
        const pos = item.e.position;
        const newPos: Vec3 = [
          pos[0] + (axisIndex === 0 ? delta : 0),
          pos[1] + (axisIndex === 1 ? delta : 0),
          pos[2] + (axisIndex === 2 ? delta : 0),
        ];
        moved.push(moveEntityTo(item.e, newPos));
      }
    } else {
      // Equal-gap: gap between AABBs is uniform.
      // Total span = lastMax - firstMin; subtract all entity widths; divide remaining gap.
      const firstItem = entities[0]!;
      const lastItem = entities[n - 1]!;
      const totalSpan = (lastItem.center + lastItem.halfExtent) - (firstItem.center - firstItem.halfExtent);
      const totalEntityWidths = entities.reduce((sum, item) => sum + item.halfExtent * 2, 0);
      const remaining = totalSpan - totalEntityWidths;
      const gap = remaining / (n - 1);

      // Place each entity starting from the right edge of the previous.
      let cursor = firstItem.center - firstItem.halfExtent; // left edge of first entity
      cursor += firstItem.halfExtent * 2 + gap; // advance past first entity + first gap

      for (let i = 1; i < n - 1; i++) {
        const item = entities[i]!;
        const targetCenter = cursor + item.halfExtent;
        const delta = targetCenter - item.center;
        cursor += item.halfExtent * 2 + gap;
        if (Math.abs(delta) < 1e-10) continue;
        const pos = item.e.position;
        const newPos: Vec3 = [
          pos[0] + (axisIndex === 0 ? delta : 0),
          pos[1] + (axisIndex === 1 ? delta : 0),
          pos[2] + (axisIndex === 2 ? delta : 0),
        ];
        moved.push(moveEntityTo(item.e, newPos));
      }
    }

    if (moved.length === 0) {
      return {
        document: doc,
        summary: `distribute: ${n} entit${n === 1 ? 'y' : 'ies'} already evenly distributed along ${axis}.`,
        affected: [],
      };
    }

    const newDoc = withEntities(doc, moved);
    const movedIds = moved.map((e) => e.id);
    return {
      document: newDoc,
      summary: `distribute: repositioned ${moved.length} entit${moved.length === 1 ? 'y' : 'ies'} along ${axis} (mode: ${mode}).`,
      affected: movedIds,
    };
  },
};

// ---------------------------------------------------------------------------
// stack_on
// ---------------------------------------------------------------------------

type StackAxis = 'x' | 'y' | 'z';

interface StackOnParams {
  movingId: string;
  baseId: string;
  axis?: StackAxis;
}

/**
 * @command stack_on
 * @pure
 * @layer core/commands
 * @affects moves movingId so its min face along axis meets baseId's max face
 * @invariant +Z up convention (W5A); default axis is 'z'
 * @failure missing id -> no-op, affected:[]
 */
export const stackOn: CommandDefinition<StackOnParams> = {
  name: 'stack_on',
  description:
    'Translate movingId so that its bounding-box minimum face along axis exactly meets the ' +
    'bounding-box maximum face of baseId. Default axis is "z" (+Z up, W5A convention). ' +
    'Use this to stack objects on top of each other without overlapping.',
  paramsSchema: {
    type: 'object',
    properties: {
      movingId: {
        type: 'string',
        description: 'Id of the entity to move.',
      },
      baseId: {
        type: 'string',
        description: 'Id of the entity acting as the base (not moved).',
      },
      axis: {
        type: 'string',
        description: 'Axis along which to stack: "x", "y", or "z" (default "z", +Z up).',
      },
    },
    required: ['movingId', 'baseId'],
  },
  run: (doc, { movingId, baseId, axis = 'z' }): CommandResult => {
    const movingEntity = doc.entities[movingId];
    if (!movingEntity) {
      return { document: doc, summary: `stack_on: moving entity "${movingId}" not found.`, affected: [] };
    }
    const baseEntity = doc.entities[baseId];
    if (!baseEntity) {
      return { document: doc, summary: `stack_on: base entity "${baseId}" not found.`, affected: [] };
    }
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
      return { document: doc, summary: `stack_on: invalid axis "${axis}". Must be "x", "y", or "z".`, affected: [] };
    }

    const axisIndex: 0 | 1 | 2 = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;

    const baseBounds = entityBounds(baseEntity);
    const movingBounds = entityBounds(movingEntity);

    // We want: movingBounds.min[axisIndex] + delta = baseBounds.max[axisIndex]
    const targetMin = baseBounds.max[axisIndex];
    const delta = targetMin - movingBounds.min[axisIndex];

    if (Math.abs(delta) < 1e-10) {
      return {
        document: doc,
        summary: `stack_on: "${movingId}" is already stacked on "${baseId}" along ${axis}.`,
        affected: [],
      };
    }

    const pos = movingEntity.position;
    const newPos: Vec3 = [
      pos[0] + (axisIndex === 0 ? delta : 0),
      pos[1] + (axisIndex === 1 ? delta : 0),
      pos[2] + (axisIndex === 2 ? delta : 0),
    ];
    const movedEntity = moveEntityTo(movingEntity, newPos);
    const newDoc = withEntities(doc, [movedEntity]);

    return {
      document: newDoc,
      summary: `stack_on: moved "${movingId}" by ${delta.toFixed(4)} along ${axis} to sit on top of "${baseId}".`,
      affected: [movingId],
    };
  },
};
