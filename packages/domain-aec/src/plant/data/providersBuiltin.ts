/**
 * The providers DAT ships (plant 08 DAT §2): building elements (equipment mark, legacy pipe line number), routed lines (`plant.piping`, the line
 * number of the RTE template), inline components (valves and reducers of a run, read-only), tie-in points (read-only, the battery limits), and, from M5,
 * the 03 EQP nozzles and the 04 PID instruments (`providersSibling.ts`).
 * These are the existing tag fields of the model: the registry reads them, `assign_plant_object` writes the plant tag back into them, so there is
 * one tag system.
 */

import type { BuildingElement, BuildingModel } from '@aec/building/types';
import { getBuilding } from '@aec/building/model';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { PipingModel } from '../types';
import { renamedReference } from '../equipment/commands/renameEquipmentTag';
import { getPiping } from '../piping/model';
import { inlineInfoOf } from './inlineInfo';
import { copyObject, getPlantData, withPlantData } from './model';
import { registerPlantObjectProvider, type PlantObjectProvider, type ProviderElement } from './providers';
import type { PlantValueInput } from './properties';
import { nozzleProvider, pidInstrumentProvider } from './providersSibling';

const TAGGED_CATEGORIES = ['equipment', 'pipe'] as const;
type TaggedCategory = (typeof TAGGED_CATEGORIES)[number];

const isTagged = (element: BuildingElement): element is Extract<BuildingElement, { category: TaggedCategory }> =>
  (TAGGED_CATEGORIES as readonly string[]).includes(element.category);

function describeElement(element: Extract<BuildingElement, { category: TaggedCategory }>): ProviderElement {
  const named = element.category === 'equipment' ? ` "${element.name}"` : '';
  return {
    id: element.id,
    category: element.category,
    label: `${element.category} ${element.id}${named}`,
    ...(element.category === 'pipe'
      ? element.line === undefined || element.line === ''
        ? {}
        : { tag: element.line }
      : { tag: element.mark }),
    tagUnique: element.category === 'equipment',
    needsClass: element.category === 'equipment' || element.category === 'pipe',
  };
}

/** Equipment tags go through rename_equipment_tag (tag grammar, uniqueness, pipe and line end references), legacy pipe line numbers through set_pipe_line_number. */
/** The `from` / `to` properties of plant objects that name a renamed equipment (`<tag>` or `<tag>:<nozzle>`) follow the rename, in the same document. */
function followRename(doc: CadDocument, renames: ReadonlyMap<string, string>): CadDocument {
  if (renames.size === 0) return doc;
  const data = getPlantData(doc);
  let objects = data.objects;
  for (const id of data.objectOrder) {
    const object = data.objects[id];
    if (object === undefined) continue;
    const changes: Record<string, string> = {};
    for (const end of ['from', 'to']) {
      const value = object.properties[end];
      const next = typeof value === 'string' ? renamedReference(value, renames) : undefined;
      if (next !== undefined) changes[end] = next;
    }
    if (Object.keys(changes).length > 0)
      objects = { ...objects, [id]: copyObject(object, { properties: { ...object.properties, ...changes } }) };
  }
  return objects === data.objects ? doc : withPlantData(doc, { ...data, objects });
}

function writeBuildingTags(
  doc: CadDocument,
  tags: readonly { readonly id: string; readonly tag: string }[],
  ctx: ExecutionContext | undefined,
): CadDocument | string {
  const elements = getBuilding(doc).elements;
  const renames = tags
    .filter((entry) => elements[entry.id]?.category === 'equipment')
    .map((entry) => ({ equipment: entry.id, tag: entry.tag }));
  const pipes = tags.filter((entry) => elements[entry.id]?.category === 'pipe').map((entry) => ({ pipeId: entry.id, line: entry.tag }));
  let current = doc;
  if (renames.length > 0) {
    const result = execute(current, 'rename_equipment_tag', { renames }, ctx);
    if (result.rejected === true) return result.summary;
    current = followRename(
      result.document,
      new Map(
        renames.flatMap((entry) => {
          const old = (elements[entry.equipment] as { mark: string }).mark;
          return old === entry.tag ? [] : [[old, entry.tag] as const];
        }),
      ),
    );
  }
  if (pipes.length > 0) {
    const result = execute(current, 'set_pipe_line_number', { pipes }, ctx);
    if (result.rejected === true) return result.summary;
    current = result.document;
  }
  return current;
}

const elementsMemo = new WeakMap<BuildingModel, readonly ProviderElement[]>();

const buildingElementProvider: PlantObjectProvider = {
  id: 'buildingElement',
  element: (doc, id) => {
    const element = getBuilding(doc).elements[id];
    return element !== undefined && isTagged(element) ? describeElement(element) : undefined;
  },
  elements: (doc) => {
    const building = getBuilding(doc);
    let listed = elementsMemo.get(building);
    if (listed === undefined) {
      listed = building.elementOrder.flatMap((id) => {
        const element = building.elements[id];
        return element !== undefined && isTagged(element) ? [describeElement(element)] : [];
      });
      elementsMemo.set(building, listed);
    }
    return listed;
  },
  tagProblem: (doc, id, tag) =>
    getBuilding(doc).elements[id]?.category === 'equipment' && /[:\s]/.test(tag)
      ? "an equipment tag must not contain whitespace or ':' (the port id is <tag>:<mark>): change the tag format of the class"
      : null,
  ends: (doc, id) => {
    const element = getBuilding(doc).elements[id];
    return element?.category === 'pipe'
      ? { ...(element.from === undefined ? {} : { from: element.from }), ...(element.to === undefined ? {} : { to: element.to }) }
      : {};
  },
  dn: (doc, id) => {
    const element = getBuilding(doc).elements[id];
    return element?.category === 'pipe' ? element.dn : undefined;
  },
  seeds: (doc, id) => {
    const element = getBuilding(doc).elements[id];
    if (element?.category === 'equipment')
      return { Description: element.name, ...(element.weight > 0 ? { OperatingWeight: { value: element.weight, unit: 'kg' } } : {}) };
    if (element?.category === 'pipe' && element.dn !== undefined) return { nominalSize: element.dn };
    return {};
  },
  writeTags: (doc, tags, ctx) => writeBuildingTags(doc, tags, ctx),
};

/** A line number no line holds (`held`) and no other temporary number uses. */
function temporaryNumber(held: ReadonlySet<string>, id: string): string {
  let number = `DAT-TMP-${id}`;
  while (held.has(number)) number += '_';
  return number;
}

const lineElementsMemo = new WeakMap<PipingModel, readonly ProviderElement[]>();

const pipeLineProvider: PlantObjectProvider = {
  id: 'pipeLine',
  element: (doc, id) => {
    const line = getPiping(doc).lines[id];
    return line === undefined
      ? undefined
      : { id, category: 'routedLine', label: `line ${line.lineNumber} (${id})`, tag: line.lineNumber, tagUnique: true, needsClass: true };
  },
  elements: (doc) => {
    const piping = getPiping(doc);
    const memo = lineElementsMemo.get(piping);
    if (memo !== undefined) return memo;
    const listed = piping.lineOrder.flatMap((id) => {
      const line = piping.lines[id];
      return line === undefined
        ? []
        : [
            {
              id,
              category: 'routedLine',
              label: `line ${line.lineNumber} (${id})`,
              tag: line.lineNumber,
              tagUnique: true,
              needsClass: true,
            },
          ];
    });
    lineElementsMemo.set(piping, listed);
    return listed;
  },
  ends: (doc, id) => {
    const line = getPiping(doc).lines[id];
    return {
      ...(line?.from === undefined || line.from === '' ? {} : { from: line.from }),
      ...(line?.to === undefined || line.to === '' ? {} : { to: line.to }),
    };
  },
  dn: (doc, id) => getPiping(doc).lines[id]?.dn,
  seeds: (doc, id) => {
    const line = getPiping(doc).lines[id];
    if (line === undefined) return {};
    const seeds: Record<string, PlantValueInput> = { nominalSize: line.dn, fluidCode: line.service, spec: line.spec };
    if (/^\d+$/.test(line.sequence)) seeds['seq'] = Number(line.sequence);
    if (line.designPressureBarG !== undefined) seeds['DesignPressure'] = { value: line.designPressureBarG, unit: 'barg' };
    if (line.designTempC !== undefined) seeds['DesignTemperature'] = { value: line.designTempC, unit: 'degC' };
    return seeds;
  },
  writeTags: (doc, tags, ctx) => {
    // A swap of two numbers is valid but each step alone would duplicate one: go through temporary numbers when a new number is a current one.
    const current = getPiping(doc).lines;
    const held = new Set(Object.values(current).map((line) => line.lineNumber));
    const passes = tags.some((entry) => held.has(entry.tag) && current[entry.id]?.lineNumber !== entry.tag)
      ? [tags.map((entry) => ({ id: entry.id, tag: temporaryNumber(held, entry.id) })), tags]
      : [tags];
    let next = doc;
    for (const pass of passes)
      for (const { id, tag } of pass) {
        const result = execute(next, 'update_pipeline', { lineId: id, lineNumber: tag }, ctx);
        if (result.rejected === true) return `update_pipeline ${id} "${tag}": ${result.summary}`;
        next = result.document;
      }
    return next;
  },
};

const inlineComponentProvider: PlantObjectProvider = {
  id: 'inlineComponent',
  element: (doc, id) => inlineElements(doc).find((element) => element.id === id),
  elements: (doc) => inlineElements(doc).filter((element) => element.tag !== undefined),
  dn: (doc, id) => inlineInfoOf(doc, id)?.dn ?? undefined,
  seeds: (doc, id) => {
    const info = inlineInfoOf(doc, id);
    return info?.dn == null ? {} : { nominalSize: info.dn };
  },
};

function inlineElements(doc: CadDocument): ProviderElement[] {
  const piping = getPiping(doc);
  return piping.runOrder.flatMap((runId) =>
    (piping.runs[runId]?.inline ?? []).map((component) => ({
      id: component.id,
      category: component.type,
      label: `${component.type} ${component.id} on ${runId}`,
      ...(component.tag === undefined ? {} : { tag: component.tag }),
      tagUnique: true,
      needsClass: false,
    })),
  );
}

const tieInProvider: PlantObjectProvider = {
  id: 'tieIn',
  element: (doc, id) => {
    const tieIn = getPiping(doc).tieIns[id];
    return tieIn === undefined
      ? undefined
      : { id, category: tieIn.kind, label: `${tieIn.kind} ${tieIn.tag} (${id})`, tag: tieIn.tag, tagUnique: true, needsClass: false };
  },
  elements: (doc) => {
    const piping = getPiping(doc);
    return piping.tieInOrder.flatMap((id) => {
      const tieIn = piping.tieIns[id];
      return tieIn === undefined
        ? []
        : [{ id, category: tieIn.kind, label: `${tieIn.kind} ${tieIn.tag} (${id})`, tag: tieIn.tag, tagUnique: true, needsClass: false }];
    });
  },
  batteryLimits: (doc) => {
    const piping = getPiping(doc);
    return piping.tieInOrder.flatMap((id) => {
      const tieIn = piping.tieIns[id];
      return tieIn?.kind === 'battery_limit' ? [tieIn.tag] : [];
    });
  },
};

/** Registers the built-in providers and the two for the sibling gaps (nozzles of 03 EQP, instruments of 04 PID); idempotent: the plugin's `onInstall`. */
export function registerBuiltinProviders(): void {
  for (const provider of [
    buildingElementProvider,
    pipeLineProvider,
    inlineComponentProvider,
    tieInProvider,
    nozzleProvider,
    pidInstrumentProvider,
  ])
    registerPlantObjectProvider(provider);
}
