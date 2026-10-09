/**
 * Civil object management: list the civil model, delete objects (with their dependents on request).
 * @layer domain-aec/civil
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { CIVIL_CATEGORIES } from '@core/model/civil';
import { getCivil, withoutObjects } from './model';
import { dependentsOf, referencesOf } from './integrity';
import { regenerateCivil } from './evaluate';

/**
 * @command describe_civil
 * @pure
 * @affects none (read-only)
 */
export const describeCivil = defineCommand({
  name: 'describe_civil',
  description:
    'List the civil / site model: point groups, surfaces, platforms, alignments, manholes and pipes ' +
    'with their ids, names and the objects they reference. Optional `category` filter.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    category: z.enum(CIVIL_CATEGORIES).optional().describe('Only list objects of this category.'),
  }),
  run: (doc, { category }): CommandResult => {
    const civil = getCivil(doc);
    const objects = civil.order
      .map((id) => civil.objects[id])
      .filter((object) => object !== undefined && (category === undefined || object.category === category))
      .map((object) => ({
        id: object?.id ?? '',
        category: object?.category ?? 'pointGroup',
        name: object?.name ?? '',
        references: object ? referencesOf(object) : [],
        entities: object?.entityIds.length ?? 0,
      }));
    const counts = CIVIL_CATEGORIES.map((name) => [
      name,
      objects.filter((object) => object.category === name).length,
    ]).filter(([, count]) => (count as number) > 0);
    return {
      document: doc,
      summary:
        objects.length === 0
          ? 'The civil model is empty.'
          : `Civil model: ${counts.map(([name, count]) => `${count} ${name}`).join(', ')}. ` +
            objects.map((object) => `${object.id} "${object.name}"`).join('; '),
      affected: [],
      data: { objects },
    };
  },
});

/**
 * @command delete_civil_object
 * @pure
 * @affects removes the object(s) and their generated entities
 * @failure unknown id / referenced without `cascade` -> no-op
 */
export const deleteCivilObject = defineCommand({
  name: 'delete_civil_object',
  description:
    'Delete a civil object (point group, surface, platform, alignment, manhole or pipe) and its ' +
    'generated geometry. Refused when other objects reference it unless `cascade` is true, which ' +
    'deletes those dependents too (e.g. the pipes of a manhole).',
  annotations: { destructive: true },
  params: z.object({
    id: z.string().describe('Civil object id, e.g. "manhole-2".'),
    cascade: z.boolean().optional().describe('Also delete dependent objects. Default false.'),
  }),
  run: (doc, { id, cascade = false }): CommandResult => {
    const civil = getCivil(doc);
    const object = civil.objects[id];
    if (!object) return noop(doc, `delete_civil_object failed: no civil object ${id}.`);
    const doomed = new Set<string>([id]);
    const queue = [id];
    while (queue.length > 0) {
      for (const dependent of dependentsOf(civil, queue.pop() as string)) {
        if (doomed.has(dependent)) continue;
        doomed.add(dependent);
        queue.push(dependent);
      }
    }
    if (doomed.size > 1 && !cascade) {
      const others = [...doomed].filter((other) => other !== id);
      return noop(
        doc,
        `delete_civil_object refused: ${others.join(', ')} reference ${id}. Delete them first or pass cascade: true.`,
      );
    }
    const document = regenerateCivil(doc, withoutObjects(civil, doomed));
    return {
      document,
      summary: `Deleted ${[...doomed].join(', ')}.`,
      affected: [...doomed],
    };
  },
});
