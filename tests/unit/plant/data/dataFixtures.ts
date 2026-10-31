/** Fixtures of the 08 DAT tests: documents with a hierarchy, the default class library, equipment and pipes (the SC-DAT-01 / 03 scene). */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { getPlantData, type PlantDataModel, withPlantData } from '@aec/plant/data/model';
import { apply } from '../../../helpers/commandAssertions';

export const PACK = path.resolve(__dirname, '../../../../docs/plant/08-plant-data-reports-interop/validation');

export const packJson = <T = Record<string, unknown>>(file: string): T => JSON.parse(readFileSync(path.join(PACK, file), 'utf8')) as T;

/** mm document with the site S1, plants P1 and P2, and the unit U10 (areaNumber "1") under P1. */
export function hierarchyDocument(): CadDocument {
  const mm = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  const level = apply(mm, 'add_level', { name: 'Grade', elevation: 0, height: 6000 });
  return apply(level, 'define_plant_hierarchy', {
    nodes: [
      { code: 'S1', kind: 'site', name: 'Site 1' },
      { code: 'P1', kind: 'plant', name: 'Demo plant', parent: 'S1' },
      { code: 'P2', kind: 'plant', name: 'Second plant', parent: 'S1' },
      { code: 'U10', kind: 'unit', name: 'Feed unit', parent: 'P1', properties: { areaNumber: '1' } },
    ],
  });
}

/** hierarchyDocument() + the default process library. */
export function libraryDocument(): CadDocument {
  return apply(hierarchyDocument(), 'load_plant_class_library', { library: 'llull-default-process' });
}

/** Adds an equipment block; returns its element id. */
export function addEquipment(doc: CadDocument, params: Record<string, unknown> = {}): { doc: CadDocument; id: string } {
  const next = apply(doc, 'add_equipment', { name: 'Pump A', location: [0, 0], size: [1000, 500, 800], ...params });
  return {
    doc: next,
    id: Object.keys(next.building?.elements ?? {})
      .filter((key) => key.startsWith('equipment'))
      .at(-1) as string,
  };
}

/** Adds a legacy pipe run; returns its element id. */
export function addPipe(doc: CadDocument, params: Record<string, unknown> = {}): { doc: CadDocument; id: string } {
  const next = apply(doc, 'add_pipe_run', {
    points: [
      [0, 0, 400],
      [2000, 0, 400],
    ],
    dn: 50,
    ...params,
  });
  return {
    doc: next,
    id: Object.keys(next.building?.elements ?? {})
      .filter((key) => key.startsWith('pipe'))
      .at(-1) as string,
  };
}

/** Assigns a pump P-1xx in U10 through the command; returns the plant object id. */
export function assignPump(doc: CadDocument, target: string, extra: Record<string, unknown> = {}): { doc: CadDocument; objectId: string } {
  const next = apply(doc, 'assign_plant_object', {
    target,
    className: 'CentrifugalPump',
    hierarchy: 'U10',
    nextSequence: true,
    properties: { Description: 'A pump', DesignPressure: 10 },
    ...extra,
  });
  return { doc: next, objectId: getPlantData(next).objectOrder.at(-1) as string };
}

/** Rebuilds the plant data of `doc` with `change` applied (to plant a state the commands refuse, e.g. a duplicate tag). */
export function withData(doc: CadDocument, change: (current: PlantDataModel) => PlantDataModel): CadDocument {
  return withPlantData(doc, change(getPlantData(doc)));
}

/** SC-DAT-01 steps 0-14 of the validation pack (tank T-101, pump P-101, lines 150-P-1001-A1A and 100-P-1002-A1A, classified and tagged). */
export function scDat01Document(): CadDocument {
  const plan = packJson<{ actions: Array<{ command: string; params: Record<string, unknown>; as?: string; unbuilt?: boolean }> }>(
    'plans/sc-dat-01-tank-pump-mvp.json',
  );
  const aliases = new Map<string, string>();
  const bind = (value: unknown): unknown => {
    if (typeof value === 'string') return value.startsWith('$') ? (aliases.get(value.slice(1)) ?? value) : value;
    if (Array.isArray(value)) return value.map(bind);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item)]));
    return value;
  };
  let doc = createEmptyDocument();
  for (const action of plan.actions.slice(0, 15)) {
    const result = execute(doc, action.command, bind(action.params));
    if (result.rejected === true) throw new Error(`${action.command}: ${result.summary}`);
    doc = result.document;
    if (action.as !== undefined && result.affected[0] !== undefined) aliases.set(action.as, result.affected[0]);
  }
  return doc;
}
