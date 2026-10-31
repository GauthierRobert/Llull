/**
 * Providers for the sibling gaps (plant 08 DAT M5): the nozzles of 03 EQP (`nozzle`, id `<equipment element id>:<mark>`) and the instruments of the 04 PID
 * (`pidInstrument`, id = the P&ID item id). A nozzle has no tag of its own in the model, so the plant object owns it (the provider accepts any tag and writes nothing);
 * a P&ID instrument carries its tag, which the registry treats as taken (a plant tag may not equal it) and which an assignment adopts (read-only). Only instruments
 * are claimed from the P&ID: equipment and valves exist in 3D too and share their tag with it (`check_pid_3d` pairs them), so they are not reserved against 3D.
 */

import { elementsOf, getBuilding } from '@aec/building/model';
import type { EquipmentElement } from '@aec/building/types';
import type { CadDocument } from '@core/model/types';
import { getPid } from '../pid/state';
import type { PidInstrument } from '../pid/model';
import type { PlantObjectProvider, ProviderElement } from './providers';

const SEPARATOR = ':';

const nozzleElementId = (equipmentId: string, mark: string): string => `${equipmentId}${SEPARATOR}${mark}`;

function describeNozzle(equipment: EquipmentElement, mark: string): ProviderElement {
  return {
    id: nozzleElementId(equipment.id, mark),
    category: 'nozzle',
    label: `nozzle ${equipment.mark}${SEPARATOR}${mark} (${equipment.id})`,
    tagUnique: false,
    needsClass: false,
  };
}

function nozzleOf(doc: CadDocument, id: string): { readonly equipment: EquipmentElement; readonly mark: string } | undefined {
  const split = id.indexOf(SEPARATOR);
  if (split < 1) return undefined;
  const element = getBuilding(doc).elements[id.slice(0, split)];
  const mark = id.slice(split + 1);
  return element?.category === 'equipment' && element.plant?.nozzles.some((nozzle) => nozzle.mark === mark) === true
    ? { equipment: element, mark }
    : undefined;
}

export const nozzleProvider: PlantObjectProvider = {
  id: 'nozzle',
  element: (doc, id) => {
    const found = nozzleOf(doc, id);
    return found === undefined ? undefined : describeNozzle(found.equipment, found.mark);
  },
  elements: (doc) =>
    elementsOf(getBuilding(doc), 'equipment').flatMap((equipment) =>
      (equipment.plant?.nozzles ?? []).map((nozzle) => describeNozzle(equipment, nozzle.mark)),
    ),
  dn: (doc, id) => {
    const found = nozzleOf(doc, id);
    return found?.equipment.plant?.nozzles.find((nozzle) => nozzle.mark === found.mark)?.dn;
  },
  seeds: (doc, id) => {
    const found = nozzleOf(doc, id);
    const nozzle = found?.equipment.plant?.nozzles.find((candidate) => candidate.mark === found.mark);
    return nozzle === undefined
      ? {}
      : {
          nominalSize: nozzle.dn,
          rating: nozzle.rating,
          facing: nozzle.facing,
          ...(nozzle.service === undefined ? {} : { Service: nozzle.service }),
        };
  },
  writeTags: (doc) => doc,
};

const instrumentOf = (doc: CadDocument, id: string): PidInstrument | undefined => {
  const item = getPid(doc).items[id];
  return item?.kind === 'instrument' ? item : undefined;
};

function describeInstrument(item: PidInstrument): ProviderElement {
  return {
    id: item.id,
    category: 'instrument',
    label: `P&ID instrument ${item.tag ?? item.id} (${item.id})`,
    ...(item.tag === undefined ? {} : { tag: item.tag }),
    tagUnique: true,
    needsClass: false,
  };
}

export const pidInstrumentProvider: PlantObjectProvider = {
  id: 'pidInstrument',
  element: (doc, id) => {
    const item = instrumentOf(doc, id);
    return item === undefined ? undefined : describeInstrument(item);
  },
  elements: (doc) => {
    const pid = getPid(doc);
    return pid.itemOrder.flatMap((id) => {
      const item = pid.items[id];
      return item?.kind === 'instrument' && item.tag !== undefined ? [describeInstrument(item)] : [];
    });
  },
};
