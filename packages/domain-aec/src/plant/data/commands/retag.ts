/**
 * Regenerating tags (plant 08 DAT §4): a tag-driving property edit (`set_plant_properties`) or a new class format with `retag` (`set_tag_format`)
 * gives some objects another tag. All new tags are generated, checked for uniqueness together, written into the model objects, or the whole
 * change is refused.
 */

import type { CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { copyObject, providerIdOf, withPlantData, type PlantDataModel, type PlantObject } from '../model';
import { expectedTag } from '../objectTag';
import { elementOf, foreignTagHolders, getProvider } from '../providers';
import { collidingHolders, objectRegistry, type ScopeInfo } from '../registry';
import { failure, type Outcome } from './params';

export interface TagChange {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/** `data` holds the edited objects / classes with their OLD tags; `ids` are the objects whose tag must be re-generated. */
export function retagObjects(
  doc: CadDocument,
  data: PlantDataModel,
  ids: readonly string[],
  ctx: ExecutionContext | undefined,
): Outcome<{ readonly document: CadDocument; readonly changes: readonly TagChange[] }> {
  const changes: TagChange[] = [];
  for (const id of ids) {
    const object = data.objects[id];
    if (object === undefined) continue;
    const generated = expectedTag(data, object);
    if (!generated.ok) return failure(generated.code, `${object.tag} (${id}): ${generated.message}`, [`objects.${id}`], [id]);
    if (generated.tag !== object.tag) changes.push({ id, from: object.tag, to: generated.tag });
  }
  if (changes.length === 0) return { ok: true, document: withPlantData(doc, data), changes };
  const objects = { ...data.objects };
  for (const change of changes) objects[change.id] = copyObject(objects[change.id] as PlantObject, { tag: change.to });
  const next: PlantDataModel = { ...data, objects };
  const registry = objectRegistry(next);
  for (const change of changes) {
    const holders = collidingHolders(next, registry, registry.scopeOf.get(change.id) as ScopeInfo, change.to);
    const model = elementOf(doc, objects[change.id]?.target ?? { kind: 'reserved' });
    const problem =
      model?.provider.writeTags === undefined ? null : (model.provider.tagProblem?.(doc, model.element.id, change.to) ?? null);
    if (problem !== null)
      return failure('DAT_TAG_FORMAT', `${change.to} (${change.id}): ${problem}`, [`objects.${change.id}.tag`], [change.id]);
    const foreign = foreignTagHolders(doc, change.to).filter(
      (holder) => !(model !== null && holder.element.id === model.element.id && holder.provider === model.provider.id),
    );
    if (holders.length > 1 || foreign.length > 0) {
      const clash = [...holders.filter((holder) => holder !== change.id), ...foreign.map((holder) => holder.element.id)];
      return failure(
        'DAT_TAG_DUPLICATE',
        `${change.from} would become ${change.to}, which ${clash.join(', ')} already holds`,
        [`objects.${change.id}.tag`],
        [change.id, ...clash],
      );
    }
  }
  let document = withPlantData(doc, next);
  const byProvider = new Map<string, Array<{ id: string; tag: string }>>();
  for (const change of changes) {
    const object = objects[change.id];
    const model = object === undefined ? null : elementOf(document, object.target);
    if (object === undefined || model === null || model.element.tag === change.to) continue;
    const key = providerIdOf(object.target) as string;
    byProvider.set(key, [...(byProvider.get(key) ?? []), { id: model.element.id, tag: change.to }]);
  }
  for (const [providerId, tags] of byProvider) {
    const provider = getProvider(providerId);
    const written = provider?.writeTags?.(document, tags, ctx) ?? `provider ${providerId} cannot rename its objects`;
    if (typeof written === 'string')
      return failure(
        'DAT_TARGET_TAG_READONLY',
        written,
        ['objects'],
        tags.map((entry) => entry.id),
      );
    document = written;
  }
  return { ok: true, document, changes };
}
