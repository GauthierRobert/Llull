/** The four handover registers (plant 08 DAT §5.15) as rows keyed by logical column: pure functions of the document, rows in natural tag order. */

import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { resolvedOrNull } from '../classes';
import { currentStatus } from '../deliverables';
import { deliverableContent } from '../deliverableContent';
import { pathOf } from '../hierarchy';
import { getPlantData, type PlantObject, type PlantValue } from '../model';
import { isEquipmentObject } from '../plantReports/equipmentList';
import { tagRegister } from '../plantReports/tagRegister';
import { objectRegistry } from '../registry';
import type { HandoverProfile } from './profiles';

export type RegisterRow = Readonly<Record<string, PlantValue>>;

const text = (value: PlantValue | undefined): string => (typeof value === 'string' ? value : '');

/** The class id of `className` in the profile's external scheme: the id given with the export first, else the class's own externalIds entry (ids are not inherited); null when none. */
export function externalClassId(
  doc: CadDocument,
  profile: HandoverProfile,
  className: string,
  given: Readonly<Record<string, string>> = {},
): string | null {
  return (
    given[className] ?? getPlantData(doc).classes[className]?.externalIds?.find((entry) => entry.scheme === profile.scheme)?.id ?? null
  );
}

/** The tag of the object that owns `object`: its process line, else the equipment a nozzle belongs to. */
function parentTagOf(doc: CadDocument, object: PlantObject): string {
  const data = getPlantData(doc);
  if (object.lineId !== undefined) return data.objects[object.lineId]?.tag ?? '';
  if (object.target.kind === 'provider' && object.target.provider === 'nozzle') {
    const equipmentId = object.target.id.slice(0, Math.max(0, object.target.id.lastIndexOf(':')));
    const holder = objectRegistry(data).byTarget.get(`buildingElement:${equipmentId}`);
    return holder === undefined ? '' : (data.objects[holder]?.tag ?? '');
  }
  return '';
}

export function tagRegisterRows(
  doc: CadDocument,
  profile: HandoverProfile,
  objects: readonly PlantObject[],
  given: Readonly<Record<string, string>>,
): RegisterRow[] {
  const data = getPlantData(doc);
  const status = new Map(tagRegister(doc, objects, false).rows.map((row) => [String(row['id']), String(row['status'])]));
  return objects.map((object) => ({
    tag: object.tag,
    class: object.className,
    classId: externalClassId(doc, profile, object.className, given) ?? '',
    parentTag: parentTagOf(doc, object),
    hierarchy: pathOf(data, object.hierarchyId),
    description: text(object.properties['Description']),
    status: status.get(object.id) ?? '',
  }));
}

export const equipmentRegisterRows = (doc: CadDocument, objects: readonly PlantObject[]): RegisterRow[] =>
  objects
    .filter((object) => isEquipmentObject(doc, object))
    .map((object) => ({
      tag: object.tag,
      manufacturer: text(object.properties['Manufacturer']),
      model: text(object.properties['Model']),
      serialNumber: text(object.properties['SerialNumber']),
    }));

/** One row per stored value, in the declaration order of the class properties; empty values are not rows. */
export function tagPropertyRows(doc: CadDocument, objects: readonly PlantObject[]): RegisterRow[] {
  const data = getPlantData(doc);
  return objects.flatMap((object) =>
    (resolvedOrNull(data, object.className)?.properties ?? []).flatMap((definition) => {
      const value = object.properties[definition.name];
      if (value === undefined || value === null) return [];
      const unverified = object.provenance?.[definition.name]?.unverified === true;
      return [{ tag: object.tag, property: definition.name, value, unit: definition.unit ?? '', unverified }];
    }),
  );
}

/**
 * One row per revision: its current status, the stored hash, the scope, the signer, and whether the content still hashes to the stored value (true / false;
 * empty for a superseded revision and when the content cannot be rebuilt). Only the current step of each revision is listed.
 */
export function documentRegisterRows(doc: CadDocument, ctx: ExecutionContext | undefined, confirmExportControlled: unknown): RegisterRow[] {
  const data = getPlantData(doc);
  const rebuilt = new Map<string, string | null>();
  const hashNow = (deliverable: string, hierarchyId: string | undefined): string | null => {
    const key = `${deliverable}|${hierarchyId ?? ''}`;
    if (!rebuilt.has(key)) {
      const built = deliverableContent(doc, deliverable, hierarchyId, ctx, confirmExportControlled);
      rebuilt.set(key, built.ok ? built.content.sha256 : null);
    }
    return rebuilt.get(key) ?? null;
  };
  return Object.keys(data.deliverables ?? {})
    .sort()
    .flatMap((id) =>
      (data.deliverables?.[id]?.revisions ?? []).map((revision): RegisterRow => {
        const step = revision.steps.at(-1);
        const status = currentStatus(revision);
        const now = status === 'superseded' ? null : hashNow(id, revision.hierarchyId);
        return {
          deliverable: id,
          revision: revision.label,
          status,
          contentSha256: step?.contentSha256 ?? '',
          scope: revision.hierarchyId === undefined ? '' : pathOf(data, revision.hierarchyId),
          signedBy: step?.signer ?? '',
          signatureId: step?.signatureId ?? '',
          contentCurrent: now === null ? '' : now === step?.contentSha256,
        };
      }),
    );
}
