import type { ExplodeOffset, ExplodedView } from '../../model/joints';
import type { CadDocument, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { idOrNext, idTaken } from '../../lib/explicitId';
import { isValidAxis } from '../../lib/axis';
import { unitAxis } from '../motion/rigidMotion';
import { scale3 } from '../../lib/vec3';
import { changed, noop } from '../noop';

const AXIS = z.union([z.string(), z.array(z.number())]);

/** Instance ids in creation order (the assembly order). */
const assemblyOrder = (doc: CadDocument): string[] => doc.order.filter((id) => doc.entities[id]?.kind === 'instance');

/**
 * @affects adds 1 entry to doc.explodedViews; real entity placements are never changed
 * @invariant each target appears at most once; manual offsets win over auto offsets for the same target
 * @failure unknown target id / invalid axis / zero spacing / no targets / taken id -> no-op, affected:[]
 */
export const createExplodedView = defineCommand({
  name: 'create_exploded_view',
  description:
    "Create a named exploded view: display-only offsets that pull parts apart for inspection and drawings. The parts' real positions are NOT " +
    'changed (stored as document data, applied by the viewport only while the view is active: set_active_exploded_view). ' +
    'Give "offsets" (explicit per-entity vectors) and/or "auto" (explode instances by assembly order along an axis: the i-th instance moves ' +
    'i * spacing along the axis, the first stays put, instance i appears in step i). Each offset has a 1-based "step" so the explosion can be shown progressively. ' +
    'Returns the view id in affected[0].',
  params: z.object({
    name: z.string().describe('Name of the view, e.g. "service".'),
    offsets: z
      .array(
        z.object({
          target: z.string().describe('Entity id (instance or solid) to displace.'),
          vector: vec3('Displacement [x,y,z] in document units, world axes.'),
          step: z.number().int().min(1).optional().describe('1-based explode step in which the part moves. Default 1.'),
        }),
      )
      .optional()
      .describe('Explicit offsets.'),
    auto: z
      .object({
        axis: AXIS.describe('Explode direction: "x"|"y"|"z" or [x,y,z].'),
        spacing: z.number().describe('Distance between consecutive parts along the axis, document units (non-zero).'),
        order: z.array(z.string()).optional().describe('Entity ids in assembly order. Default: all instances in creation order.'),
      })
      .optional()
      .describe('Auto-explode along an axis in assembly order.'),
    id: z.string().optional().describe('Optional explicit view id (no-op if taken).'),
  }),
  run: (doc, { name, offsets = [], auto, id }): CommandResult => {
    const merged = new Map<string, ExplodeOffset>();
    if (auto !== undefined) {
      if (!isValidAxis(auto.axis) || !Number.isFinite(auto.spacing) || auto.spacing === 0)
        return noop(doc, 'create_exploded_view: auto needs a valid axis and a finite non-zero spacing.');
      const direction = unitAxis(auto.axis);
      (auto.order ?? assemblyOrder(doc)).forEach((target, index) => {
        if (index > 0) merged.set(target, { target, vector: scale3(direction, auto.spacing * index), step: index });
      });
    }
    for (const { target, vector, step } of offsets) merged.set(target, { target, vector: vector as Vec3, step: step ?? 1 });
    const missing = [...merged.keys()].find((target) => doc.entities[target] === undefined);
    if (missing !== undefined) return noop(doc, `create_exploded_view: entity '${missing}' does not exist.`);
    if (merged.size === 0) return noop(doc, 'create_exploded_view: nothing to explode (no offsets, and fewer than 2 parts for auto).');
    const viewId = idOrNext(id, 'explode');
    if (idTaken(doc.explodedViews ?? {}, viewId)) return noop(doc, `create_exploded_view: view '${viewId}' already exists.`);
    const view: ExplodedView = { id: viewId, name, offsets: [...merged.values()] };
    const steps = Math.max(...view.offsets.map((offset) => offset.step));
    return changed(
      { ...doc, explodedViews: { ...doc.explodedViews, [viewId]: view } },
      `create_exploded_view: '${viewId}' (${name}) with ${view.offsets.length} offset part(s) in ${steps} step(s); placements unchanged.`,
      [viewId],
    );
  },
});

/**
 * @affects sets or clears doc.activeExplodedView
 * @failure unknown view id, step < 1 -> no-op, affected:[]
 */
export const setActiveExplodedView = defineCommand({
  name: 'set_active_exploded_view',
  description:
    'Show an exploded view in the viewport (and exploded drawings), or none. Omit "id" to switch the explosion off. "step" limits the ' +
    'explosion to steps 1..step (progressive reveal); omit it for the full explosion. Real part placements are never modified.',
  params: z.object({
    id: z.string().optional().describe('Exploded view id; omit to show the assembled model.'),
    step: z.number().int().min(1).optional().describe('Show only offsets with step <= this. Default: all.'),
  }),
  run: (doc, { id, step }): CommandResult => {
    if (id === undefined) {
      const rest: CadDocument = { ...doc };
      delete rest.activeExplodedView;
      return changed(rest, 'set_active_exploded_view: exploded view off (assembled model shown).', []);
    }
    if (!Object.hasOwn(doc.explodedViews ?? {}, id)) return noop(doc, `set_active_exploded_view: exploded view '${id}' does not exist.`);
    return changed(
      { ...doc, activeExplodedView: { id, ...(step !== undefined ? { step } : {}) } },
      `set_active_exploded_view: showing '${id}'${step === undefined ? '' : ` up to step ${step}`}.`,
      [id],
    );
  },
});

/**
 * @affects removes 1 entry from doc.explodedViews; clears doc.activeExplodedView when it showed that view
 * @failure unknown view id -> no-op, affected:[]
 */
export const deleteExplodedView = defineCommand({
  name: 'delete_exploded_view',
  annotations: { destructive: true },
  description: 'Remove an exploded view by id (switches the explosion off if it was showing). Parts are untouched.',
  params: z.object({ id: z.string().describe('Exploded view id.') }),
  run: (doc, { id }): CommandResult => {
    if (!Object.hasOwn(doc.explodedViews ?? {}, id)) return noop(doc, `delete_exploded_view: exploded view '${id}' does not exist.`);
    const { activeExplodedView, ...rest } = doc;
    const explodedViews = Object.fromEntries(Object.entries(doc.explodedViews ?? {}).filter(([key]) => key !== id));
    const next = { ...rest, explodedViews, ...(activeExplodedView && activeExplodedView.id !== id ? { activeExplodedView } : {}) };
    return changed(next, `delete_exploded_view: removed '${id}'.`, [id]);
  },
});
