/**
 * The providers DAT ships (plant 08 DAT §2): building elements (equipment mark, legacy pipe line number), routed lines (`plant.piping`, the line
 * number of the RTE template), inline components (valves and reducers of a run, read-only) and tie-in points (read-only, the battery limits).
 * These are the existing tag fields of the model: the registry reads them, `assign_plant_object` writes the plant tag back into them, so there is
 * one tag system.
 */

import type { BuildingElement, BuildingModel } from '@aec/building/types';
import { commitBuilding } from '@aec/building/evaluate/evaluateElements';
import { getBuilding } from '@aec/building/model';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { getPiping } from '../piping/model';
import { registerPlantObjectProvider, type PlantObjectProvider, type ProviderElement } from './providers';
import type { PlantValueInput } from './properties';

const TAGGED_CATEGORIES = ['equipment', 'pipe', 'tray', 'pipeSupport', 'member'] as const;
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

function writeBuildingTags(doc: CadDocument, tags: readonly { readonly id: string; readonly tag: string }[]): CadDocument | string {
  const building = getBuilding(doc);
  const elements: Record<string, BuildingElement> = { ...building.elements };
  for (const { id, tag } of tags) {
    const element = elements[id];
    if (element === undefined || !isTagged(element)) return `no building element "${id}" to tag`;
    elements[id] = element.category === 'pipe' ? { ...element, line: tag } : { ...element, mark: tag };
  }
  const marks = new Map<string, string>();
  for (const element of Object.values(elements)) {
    if (element.category !== 'equipment') continue;
    const twin = marks.get(element.mark);
    if (twin !== undefined) return `equipment mark "${element.mark}" would be used by ${twin} and ${element.id}`;
    marks.set(element.mark, element.id);
  }
  const model: BuildingModel = { ...building, elements };
  return commitBuilding(
    doc,
    model,
    tags.map((entry) => entry.id),
    '',
  ).document;
}

const buildingElementProvider: PlantObjectProvider = {
  id: 'buildingElement',
  element: (doc, id) => {
    const element = getBuilding(doc).elements[id];
    return element !== undefined && isTagged(element) ? describeElement(element) : undefined;
  },
  elements: (doc) => {
    const building = getBuilding(doc);
    return building.elementOrder.flatMap((id) => {
      const element = building.elements[id];
      return element !== undefined && isTagged(element) && (element.category === 'equipment' || element.category === 'pipe')
        ? [describeElement(element)]
        : [];
    });
  },
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
  writeTags: (doc, tags) => writeBuildingTags(doc, tags),
};

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
    return piping.lineOrder.flatMap((id) => {
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
    let current = doc;
    for (const { id, tag } of tags) {
      const result = execute(current, 'update_pipeline', { lineId: id, lineNumber: tag }, ctx);
      if (result.rejected === true) return `update_pipeline ${id} "${tag}": ${result.summary}`;
      current = result.document;
    }
    return current;
  },
};

const inlineComponentProvider: PlantObjectProvider = {
  id: 'inlineComponent',
  element: (doc, id) => inlineElements(doc).find((element) => element.id === id),
  elements: (doc) => inlineElements(doc).filter((element) => element.tag !== undefined),
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

/** Registers the four providers (idempotent): the plugin's `onInstall`. */
export function registerBuiltinProviders(): void {
  for (const provider of [buildingElementProvider, pipeLineProvider, inlineComponentProvider, tieInProvider])
    registerPlantObjectProvider(provider);
}
