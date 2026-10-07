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

import type { Entity, Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { noop } from './noop';
import { entityBounds } from './sceneBounds';
import { replaceEntity } from './entityOps';

type AxisIndex = 0 | 1 | 2;

const axisIndexOf = (axis: 'x' | 'y' | 'z'): AxisIndex => (axis === 'x' ? 0 : axis === 'y' ? 1 : 2);

/** Copy of `e` translated by `delta` along one axis. */
function shiftAlong(e: Entity, axisIndex: AxisIndex, delta: number): Entity {
  const [x, y, z] = e.position;
  const position: Vec3 = [
    x + (axisIndex === 0 ? delta : 0),
    y + (axisIndex === 1 ? delta : 0),
    z + (axisIndex === 2 ? delta : 0),
  ];
  return { ...e, position };
}

const plural = (n: number): string => (n === 1 ? 'y' : 'ies');

const EDGE_PATTERN = /^(min|max|center)-([xyz])$/;

/**
 * @command align
 * @pure
 * @layer core/commands
 * @affects moves every entity in targetIds (their position is shifted along one axis)
 * @invariant all targetIds and referenceId must exist; reference entity is not moved
 * @failure missing id -> no-op, affected:[]
 */
export const align = defineCommand({
  name: 'align',
  description:
    'Move every entity in targetIds so that its bounding-box edge (or center) along the ' +
    "specified axis matches the reference entity's. " +
    'edge values: "min-x", "min-y", "min-z", "max-x", "max-y", "max-z", ' +
    '"center-x", "center-y", "center-z". ' +
    'The reference entity is not moved. Returns affected: targetIds.',
  params: z.object({
    targetIds: z
      .array(z.string())
      .describe('Ids of entities to move. Must all exist in the document.'),
    edge: z
      .string()
      .describe(
        'Which bounding-box face or center to align along: ' +
          '"min-x"|"min-y"|"min-z"|"max-x"|"max-y"|"max-z"|"center-x"|"center-y"|"center-z".',
      ),
    referenceId: z
      .string()
      .describe('Id of the entity whose bounding-box edge is the alignment target. Not moved.'),
  }),
  run: (doc, { targetIds: requestedIds, edge, referenceId }): CommandResult => {
    const targetIds = [...new Set(requestedIds)];
    if (targetIds.length === 0) return noop(doc, 'align: targetIds must be a non-empty array.');
    const refEntity = doc.entities[referenceId];
    if (!refEntity) return noop(doc, `align: reference entity "${referenceId}" not found.`);
    const missingTarget = targetIds.find((id) => !doc.entities[id]);
    if (missingTarget) return noop(doc, `align: target entity "${missingTarget}" not found.`);
    const edgeMatch = EDGE_PATTERN.exec(edge);
    if (!edgeMatch) {
      return noop(
        doc,
        `align: invalid edge "${edge}". Must be one of min-x, min-y, min-z, max-x, max-y, max-z, center-x, center-y, center-z.`,
      );
    }
    const edgeType = edgeMatch[1] as 'min' | 'max' | 'center';
    const axisIndex = axisIndexOf(edgeMatch[2] as 'x' | 'y' | 'z');
    const edgeValue = (e: Entity): number => {
      const { min, max } = entityBounds(e);
      return edgeType === 'min'
        ? min[axisIndex]
        : edgeType === 'max'
          ? max[axisIndex]
          : (min[axisIndex] + max[axisIndex]) / 2;
    };

    const refValue = edgeValue(refEntity);
    const moved: Entity[] = [];
    for (const id of targetIds) {
      const e = doc.entities[id] as Entity;
      const delta = refValue - edgeValue(e);
      if (Math.abs(delta) >= 1e-10) moved.push(shiftAlong(e, axisIndex, delta));
    }

    if (moved.length === 0) {
      return noop(
        doc,
        `align: all ${targetIds.length} entit${plural(targetIds.length)} already aligned to ${edge} of "${referenceId}".`,
      );
    }
    return {
      document: moved.reduce(replaceEntity, doc),
      summary: `align: moved ${moved.length} entit${plural(moved.length)} to ${edge} of "${referenceId}".`,
      affected: moved.map((e) => e.id),
    };
  },
});

/**
 * @command distribute
 * @pure
 * @layer core/commands
 * @affects repositions targetIds along the specified axis
 * @invariant targetIds.length >= 2; first and last entity are anchors (not moved)
 * @failure < 2 targetIds -> no-op; missing id -> no-op
 */
export const distribute = defineCommand({
  name: 'distribute',
  description:
    'Distribute 2 or more entities evenly along a single axis. ' +
    'mode="equal-spacing" (default): center-to-center step is uniform. ' +
    'mode="equal-gap": gap between AABBs is uniform. ' +
    'The first and last entity (by their current position along the axis) are the anchors ' +
    'and are not moved; all entities in between are repositioned. ' +
    'Returns affected: the ids of the entities that actually moved.',
  params: z.object({
    targetIds: z
      .array(z.string())
      .describe('Ids of entities to distribute. Must contain at least 2 existing entity ids.'),
    axis: z.string().describe('Axis along which to distribute: "x", "y", or "z".'),
    mode: z
      .string()
      .describe(
        '"equal-spacing" (default): equal center-to-center distance. ' +
          '"equal-gap": equal gap between entity bounding boxes.',
      )
      .optional(),
  }),
  run: (doc, { targetIds: requestedIds, axis, mode = 'equal-spacing' }): CommandResult => {
    const targetIds = [...new Set(requestedIds)];
    if (targetIds.length < 2) {
      return noop(doc, 'distribute: targetIds must contain at least 2 distinct entity ids.');
    }
    const missingId = targetIds.find((id) => !doc.entities[id]);
    if (missingId) return noop(doc, `distribute: entity "${missingId}" not found.`);
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
      return noop(doc, `distribute: invalid axis "${axis}". Must be "x", "y", or "z".`);
    }
    if (mode !== 'equal-spacing' && mode !== 'equal-gap') {
      return noop(
        doc,
        `distribute: invalid mode "${mode}". Must be "equal-spacing" or "equal-gap".`,
      );
    }
    const axisIndex = axisIndexOf(axis);

    const items = targetIds
      .map((id) => {
        const e = doc.entities[id] as Entity;
        const { min, max } = entityBounds(e);
        return {
          e,
          center: (min[axisIndex] + max[axisIndex]) / 2,
          halfExtent: (max[axisIndex] - min[axisIndex]) / 2,
        };
      })
      .sort((a, b) => a.center - b.center);

    const n = items.length;
    const first = items[0] as (typeof items)[number];
    const last = items[n - 1] as (typeof items)[number];
    // Target center per index; the first and last items are anchors and never move.
    const targetCenters: number[] = [];
    if (mode === 'equal-spacing') {
      const step = (last.center - first.center) / (n - 1);
      for (let i = 0; i < n; i++) targetCenters.push(first.center + step * i);
    } else {
      const totalSpan = last.center + last.halfExtent - (first.center - first.halfExtent);
      const totalWidths = items.reduce((sum, item) => sum + item.halfExtent * 2, 0);
      const gap = (totalSpan - totalWidths) / (n - 1);
      let cursor = first.center - first.halfExtent + first.halfExtent * 2 + gap;
      targetCenters.push(first.center);
      for (const item of items.slice(1, -1)) {
        targetCenters.push(cursor + item.halfExtent);
        cursor += item.halfExtent * 2 + gap;
      }
    }

    const moved: Entity[] = [];
    for (let i = 1; i < n - 1; i++) {
      const item = items[i] as (typeof items)[number];
      const delta = (targetCenters[i] as number) - item.center;
      if (Math.abs(delta) >= 1e-10) moved.push(shiftAlong(item.e, axisIndex, delta));
    }

    if (moved.length === 0) {
      return noop(
        doc,
        `distribute: ${n} entit${plural(n)} already evenly distributed along ${axis}.`,
      );
    }
    return {
      document: moved.reduce(replaceEntity, doc),
      summary: `distribute: repositioned ${moved.length} entit${plural(moved.length)} along ${axis} (mode: ${mode}).`,
      affected: moved.map((e) => e.id),
    };
  },
});

/**
 * @command stack_on
 * @pure
 * @layer core/commands
 * @affects moves movingId so its min face along axis meets baseId's max face
 * @invariant +Z up convention; default axis is 'z'
 * @failure missing id or movingId === baseId -> no-op, affected:[]
 */
export const stackOn = defineCommand({
  name: 'stack_on',
  description:
    'Translate movingId so that its bounding-box minimum face along axis exactly meets the ' +
    'bounding-box maximum face of baseId. Default axis is "z" (+Z up, W5A convention). ' +
    'Use this to stack objects on top of each other without overlapping.',
  params: z.object({
    movingId: z.string().describe('Id of the entity to move.'),
    baseId: z.string().describe('Id of the entity acting as the base (not moved).'),
    axis: z
      .string()
      .describe('Axis along which to stack: "x", "y", or "z" (default "z", +Z up).')
      .optional(),
  }),
  run: (doc, { movingId, baseId, axis = 'z' }): CommandResult => {
    if (movingId === baseId) {
      return noop(
        doc,
        `stack_on: movingId and baseId are both "${movingId}"; cannot stack an entity on itself.`,
      );
    }
    const movingEntity = doc.entities[movingId];
    if (!movingEntity) return noop(doc, `stack_on: moving entity "${movingId}" not found.`);
    const baseEntity = doc.entities[baseId];
    if (!baseEntity) return noop(doc, `stack_on: base entity "${baseId}" not found.`);
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
      return noop(doc, `stack_on: invalid axis "${axis}". Must be "x", "y", or "z".`);
    }
    const axisIndex = axisIndexOf(axis);
    const delta =
      entityBounds(baseEntity).max[axisIndex] - entityBounds(movingEntity).min[axisIndex];

    if (Math.abs(delta) < 1e-10) {
      return noop(doc, `stack_on: "${movingId}" is already stacked on "${baseId}" along ${axis}.`);
    }
    return {
      document: replaceEntity(doc, shiftAlong(movingEntity, axisIndex, delta)),
      summary: `stack_on: moved "${movingId}" by ${delta.toFixed(4)} along ${axis} to sit on top of "${baseId}".`,
      affected: [movingId],
    };
  },
});
