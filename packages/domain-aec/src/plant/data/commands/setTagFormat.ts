import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, noop } from '@core/commands/noop';
import { resolvedOrNull } from '../classes';
import { getPlantData, withPlantData, type PlantDataModel } from '../model';
import { parseTagFormat } from '../tagFormat';
import { refuse } from './params';
import { retagObjects } from './retag';

/**
 * @affects sets the tag format of 1 project class; with retag, regenerates the tags of its objects and writes them into the model objects
 * @invariant retag is atomic: a missing field or a duplicate new tag refuses the whole change; without retag the objects keep their tags and check_plant_data reports DAT_TAG_FORMAT
 * @failure unknown class, library class, bad format, retag collision or missing field -> DAT_* refusal, document unchanged
 */
export const setTagFormat = defineCommand({
  name: 'set_tag_format',
  description:
    'Change the tag format of a project class (define_plant_class; grammar: literal text and {field} / {field:width} parts, e.g. "{classCode}-{area}{seq:2}"). ' +
    'Subclasses inherit it. retag: true regenerates the tag of every object of the class (and subclasses that inherit the format) from its fields and ' +
    'writes the new tags into the model objects; the whole change is refused when a field is missing or two objects would get the same tag. Without retag ' +
    'the existing tags are kept and check_plant_data reports DAT_TAG_FORMAT for each one that does not match. Library classes are read-only: subclass them. ' +
    'Returns data = { className, tagFormat, changedTags [{ id, from, to }], divergent (objects whose tag no longer matches) }. ' +
    'Refusals: DAT_CLASS_UNKNOWN, DAT_LIBRARY_CLASS_LOCKED, DAT_TAG_FORMAT_INVALID, DAT_TAG_DUPLICATE, DAT_TAG_FIELD_MISSING.',
  params: z.object({
    className: z.string().describe('Project class name.'),
    tagFormat: z.string().min(1).describe('New tag format, e.g. "{classCode}-{area}{seq:3}".'),
    retag: z.boolean().optional().describe('true: regenerate the tags of the existing objects (default false: keep them).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const data = getPlantData(doc);
    const fail = (code: string, message: string, path: string, ids: readonly string[] = []): CommandResult =>
      refuse(doc, 'set_tag_format', { code, message, paths: [path], ids });
    const cls = data.classes[params.className];
    if (cls === undefined) return fail('DAT_CLASS_UNKNOWN', `no class "${params.className}"`, 'className');
    if (cls.source === 'library') return fail('DAT_LIBRARY_CLASS_LOCKED', `${cls.name} is a library class: subclass it`, 'className');
    const tagFormat = params.tagFormat.trim();
    const parsed = parseTagFormat(tagFormat);
    if (!parsed.ok) return fail('DAT_TAG_FORMAT_INVALID', parsed.problem, 'tagFormat');
    if (cls.tagFormat === tagFormat) return noop(doc, `set_tag_format: ${cls.name} already uses ${tagFormat}.`);
    const next: PlantDataModel = { ...data, classes: { ...data.classes, [cls.name]: { ...cls, tagFormat } } };
    const affected = data.objectOrder.filter((id) => {
      const object = data.objects[id];
      return (
        object !== undefined && resolvedOrNull(data, object.className)?.tagFormat !== resolvedOrNull(next, object.className)?.tagFormat
      );
    });
    if (params.retag !== true)
      return {
        ...changed(
          withPlantData(doc, next),
          `set_tag_format: ${cls.name} now uses ${tagFormat}; ${affected.length} object(s) keep their old tags (retag: true regenerates them).`,
          [cls.name],
        ),
        data: { className: cls.name, tagFormat, changedTags: [], divergent: affected.length },
      };
    const retagged = retagObjects(doc, next, affected, ctx);
    if (!retagged.ok) return refuse(doc, 'set_tag_format', retagged);
    return {
      ...changed(
        retagged.document,
        `set_tag_format: ${cls.name} now uses ${tagFormat}; ${retagged.changes.length} tag(s) regenerated${
          retagged.changes.length === 0
            ? ''
            : ` (${retagged.changes
                .slice(0, 5)
                .map((change) => `${change.from} -> ${change.to}`)
                .join(', ')}${retagged.changes.length > 5 ? ', ...' : ''})`
        }.`,
        [cls.name, ...retagged.changes.map((change) => change.id)],
      ),
      data: { className: cls.name, tagFormat, changedTags: retagged.changes, divergent: 0 },
    };
  },
});
