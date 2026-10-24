/** delete_field and regenerate_implicit_bodies: removing nodes with their dependents, and re-deriving stale bodies (05 IMP 4.1, 4.3). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { refuseImplicit } from './codes';
import { fieldOf, implicitOf } from './model';
import { dependentsOf, isStale, rederiveBodies } from './rederive';

/**
 * @affects removes field node `id`; with cascade also every node that reads it and every implicit body that depends on it (their mesh entities leave the document)
 * @invariant a node that is still read by another node or by a body is never removed silently
 * @failure unknown id -> IMP_FIELD_NOT_FOUND; referenced and not cascade -> IMP_FIELD_IN_USE (ids = the referrers)
 */
export const deleteField = defineCommand({
  name: 'delete_field',
  description:
    'Delete an implicit field node. It is refused while another field node or an implicit body reads it (IMP_FIELD_IN_USE lists the referrers); with cascade true the node, every node that reads it ' +
    'and every body that depends on it are removed together (the body meshes leave the document; solids hidden by create_implicit_body hideSource stay on their hidden layer). Sources stay untouched. ' +
    "Deleting a body's own field this way is how a body is removed (bodies cannot be deleted directly).",
  params: z.object({
    id: z.string().describe('Id of the field node to delete.'),
    cascade: z.boolean().optional().describe('Also delete everything that depends on the node (default false: refuse instead).'),
  }),
  run: (doc, { id, cascade = false }): CommandResult => {
    if (fieldOf(doc, id) === undefined)
      return refuseImplicit(doc, 'delete_field', 'IMP_FIELD_NOT_FOUND', `no field '${id}'`, [id], ['params.id']);
    const model = implicitOf(doc);
    const readers = dependentsOf(model, id);
    const bodies = Object.keys(model.bodies).filter((body) => [id, ...readers].includes(model.bodies[body]?.field ?? ''));
    if ((readers.length > 0 || bodies.length > 0) && !cascade)
      return refuseImplicit(
        doc,
        'delete_field',
        'IMP_FIELD_IN_USE',
        `'${id}' is read by ${readers.length} field node(s) (${readers.join(', ') || 'none'}) and ${bodies.length} implicit body(ies) (${bodies.join(', ') || 'none'}); delete them first or pass cascade: true`,
        [id, ...readers, ...bodies],
        ['params.cascade'],
      );
    const removedFields = new Set([id, ...readers]);
    const removedBodies = new Set(bodies);
    const fields = Object.fromEntries(Object.entries(model.fields).filter(([key]) => !removedFields.has(key)));
    const kept = Object.fromEntries(Object.entries(model.bodies).filter(([key]) => !removedBodies.has(key)));
    const entities = Object.fromEntries(Object.entries(doc.entities).filter(([key]) => !removedBodies.has(key)));
    const next: CadDocument = {
      ...doc,
      entities,
      order: doc.order.filter((key) => !removedBodies.has(key)),
      selection: doc.selection.filter((key) => !removedBodies.has(key)),
      implicit: { ...model, fields, bodies: kept },
    };
    return {
      document: next,
      summary: `delete_field: removed ${removedFields.size} field node(s) (${[...removedFields].join(', ')}) and ${removedBodies.size} implicit body(ies)${removedBodies.size > 0 ? ` (${[...removedBodies].join(', ')})` : ''}.`,
      affected: [...removedFields, ...removedBodies],
      data: { removedFields: [...removedFields], removedBodies: [...removedBodies], unit: doc.units },
    };
  },
});

/**
 * @affects re-derives the mesh and content hash of every implicit body that is stale (or of the listed ids); bodies whose recomputed hash equals their record are untouched
 * @invariant identical field + grid + engine give an identical mesh; the work is done in creation order, so a body built on another body sees the updated one
 * @failure unknown id -> IMP_FIELD_NOT_FOUND; a body the engine refuses -> its IMP_* code (document unchanged)
 */
export const regenerateImplicitBodies = defineCommand({
  name: 'regenerate_implicit_bodies',
  description:
    'Re-derive implicit bodies from their field recipes: the meshes of bodies whose content hash no longer matches what the current engine would produce (e.g. after loading a document on another machine or engine, ' +
    'or after the source solids changed), or of the bodies you list. Bodies that are up to date are left alone. Replayable: the result depends only on the recipe, voxel and engine. Reports which bodies changed.',
  params: z.object({
    ids: z.array(z.string()).optional().describe('Ids of the bodies to re-derive regardless of staleness. Default: every stale body.'),
  }),
  run: (doc, { ids }, ctx): CommandResult => {
    const model = implicitOf(doc);
    const missing = ids?.find((id) => !Object.hasOwn(model.bodies, id));
    if (missing !== undefined)
      return refuseImplicit(
        doc,
        'regenerate_implicit_bodies',
        'IMP_FIELD_NOT_FOUND',
        `no implicit body '${missing}'`,
        [missing],
        ['params.ids'],
      );
    let current = doc;
    const changed: string[] = [];
    const unchanged: string[] = [];
    for (const id of Object.keys(model.bodies)) {
      if (ids !== undefined && !ids.includes(id)) continue;
      const body = implicitOf(current).bodies[id];
      if (body === undefined || (ids === undefined && !isStale(current, body, ctx))) {
        unchanged.push(id);
        continue;
      }
      const done = rederiveBodies(current, [id], ctx);
      if (!done.ok) return refuseImplicit(doc, 'regenerate_implicit_bodies', done.code, done.message, done.ids);
      current = done.document;
      (done.changed.length > 0 ? changed : unchanged).push(id);
    }
    return {
      document: current,
      summary: `regenerate_implicit_bodies: ${changed.length} body(ies) re-derived${changed.length > 0 ? ` (${changed.join(', ')})` : ''}, ${unchanged.length} up to date.`,
      affected: changed,
      data: { rederived: changed, upToDate: unchanged, unit: doc.units },
    };
  },
});
