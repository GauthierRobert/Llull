/**
 * IFC (ISO 10303-21 STEP physical file) checks a BIM coordinator's viewer makes first: entity counts, unique GlobalIds, resolvable references, storeys and which
 * storey contains each element. The tokenizer is `@lib/stepRead` (promoted from this file, plant 08 DAT-M3); it shares no code with llull's IFC writer.
 */

import { readStep, stepReferences, stepString, type StepEntity, type StepFile, type StepValue } from '@lib/stepRead';

export type { StepEntity, StepValue };
export type IfcFile = StepFile;
export { stepString };

/** Parse an IFC file: header schema + DATA section entities. */
export const parseIfc = (text: string): IfcFile => readStep(text);

/** Every `#n` reference inside a value tree. */
export const references = (values: StepValue[]): number[] => stepReferences(values);

export function ofType(file: IfcFile, type: string): StepEntity[] {
  return [...file.entities.values()].filter((entity) => entity.type === type);
}

export function countByType(file: IfcFile): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entity of file.entities.values()) counts[entity.type] = (counts[entity.type] ?? 0) + 1;
  return counts;
}

const GUID_ALPHABET = /^[0-9A-Za-z_$]{22}$/;

/** IfcRoot GlobalIds (first argument of every entity that has one): malformed and duplicated. */
export function globalIdProblems(file: IfcFile): { malformed: string[]; duplicated: string[] } {
  const seen = new Set<string>();
  const malformed: string[] = [];
  const duplicated: string[] = [];
  for (const entity of file.entities.values()) {
    if (!isRooted(entity, file)) continue;
    const guid = stepString(entity.args[0]);
    if (!GUID_ALPHABET.test(guid)) malformed.push(`#${entity.id} ${entity.type} '${guid}'`);
    else if (seen.has(guid)) duplicated.push(guid);
    seen.add(guid);
  }
  return { malformed, duplicated };
}

/**
 * Rooted entities (IfcRoot subtypes) start with a quoted GlobalId, then an owner history (`$` or a
 * reference to IFCOWNERHISTORY), then a Name — decided by structure, so a GlobalId of the wrong
 * length is reported, not skipped.
 */
const NOT_ROOTED = /^IFC(PROPERTY(?!SET)|QUANTITY|COMPLEXPROPERTY|PHYSICALCOMPLEXQUANTITY|MATERIAL)/;

function isRooted(entity: StepEntity, file: IfcFile): boolean {
  const [first, owner] = entity.args;
  if (typeof first !== 'string' || !first.startsWith("'") || entity.args.length < 4) return false;
  // Properties and quantities (Name, Description, …) are resources, not IfcRoot objects.
  if (NOT_ROOTED.test(entity.type)) return false;
  if (owner === '$') return true;
  const ref = typeof owner === 'string' && /^#\d+$/.test(owner) ? Number(owner.slice(1)) : NaN;
  return file.entities.get(ref)?.type === 'IFCOWNERHISTORY';
}

/** Every number inside a value tree (typed values included), e.g. a property's nominal value. */
export function numbersIn(values: StepValue[]): number[] {
  const found: number[] = [];
  for (const value of values) {
    if (Array.isArray(value)) found.push(...numbersIn(value));
    else if (/^-?\d+(\.\d*)?(E[-+]?\d+)?$/i.test(value)) found.push(Number(value));
  }
  return found;
}

interface IfcStorey {
  id: number;
  guid: string;
  name: string;
  elevation: number;
}

/** IFCBUILDINGSTOREY(GlobalId, OwnerHistory, Name, Description, ObjectType, Placement, Representation, LongName, CompositionType, Elevation). */
function storeys(file: IfcFile): IfcStorey[] {
  return ofType(file, 'IFCBUILDINGSTOREY').map((entity) => ({
    id: entity.id,
    guid: stepString(entity.args[0]),
    name: stepString(entity.args[2]),
    elevation: Number(entity.args[9]),
  }));
}

/** Map element entity id → containing storey name (IFCRELCONTAINEDINSPATIALSTRUCTURE). */
export function containment(file: IfcFile): Map<number, string> {
  const names = new Map(storeys(file).map((storey) => [storey.id, storey.name]));
  const contained = new Map<number, string>();
  for (const rel of ofType(file, 'IFCRELCONTAINEDINSPATIALSTRUCTURE')) {
    const structure = references([rel.args[5] ?? '$'])[0];
    const storeyName = structure === undefined ? undefined : names.get(structure);
    if (storeyName === undefined) continue;
    for (const element of references([rel.args[4] ?? []])) contained.set(element, storeyName);
  }
  return contained;
}
