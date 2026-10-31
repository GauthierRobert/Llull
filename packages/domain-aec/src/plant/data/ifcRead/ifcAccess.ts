/** Reading the attributes of the IFC entities `ifc_summary` and `check_ifc_requirements` look at, from the records of `@lib/stepRead` (positions of the IFC4 / IFC4X3_ADD2 schema). */

import { stepString, type StepEntity, type StepFile, type StepValue } from '@lib/stepRead';
import { typeChain } from './ifcNames';

export const isProduct = (entity: StepEntity): boolean => {
  const chain = typeChain(entity.type);
  return chain.includes('IFCDISTRIBUTIONELEMENT') || entity.type === 'IFCBUILDINGELEMENTPROXY';
};

/** Position of `PredefinedType` for the classes whose position this reader knows, else -1. */
export function predefinedIndex(entity: StepEntity): number {
  if (entity.type === 'IFCDISTRIBUTIONSYSTEM') return 6;
  if (entity.type === 'IFCDISTRIBUTIONPORT') return 8;
  return isProduct(entity) ? 8 : -1;
}

/** `ISOLATING` for `.ISOLATING.`; null for `$`, `*` or anything that is not an enumeration. */
export function enumOf(value: StepValue | undefined): string | null {
  return typeof value === 'string' && value.length > 2 && value.startsWith('.') && value.endsWith('.') ? value.slice(1, -1) : null;
}

/** Entity ids of a `#1` reference or a list of them. */
export function refsOf(value: StepValue | undefined): number[] {
  const one = (item: StepValue | undefined): number[] => {
    if (typeof item !== 'string' || item.charCodeAt(0) !== 35) return [];
    const id = Number(item.slice(1));
    return Number.isInteger(id) ? [id] : [];
  };
  return Array.isArray(value) ? value.flatMap(one) : one(value);
}

/** Text of a typed or plain STEP value for comparison: strings unquoted, `.T.` / `.F.` as TRUE / FALSE, numbers as written, a typed value by its content. */
export function plainText(value: StepValue | undefined): string | null {
  if (value === undefined || value === '$' || value === '*') return null;
  if (Array.isArray(value)) return value.length > 1 ? plainText(value[1]) : null;
  if (value.startsWith("'")) return stepString(value);
  if (value === '.T.') return 'TRUE';
  if (value === '.F.') return 'FALSE';
  return enumOf(value) ?? value;
}

/** Name of the type of a typed value (`IFCLABEL('x')` -> `IFCLABEL`), or ''. */
export const typeNameOf = (value: StepValue | undefined): string => (Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '');

export const NAME_INDEX = 2;
export const OBJECT_TYPE_INDEX = 4;
export const TAG_INDEX = 7;

/** Entities of the file with their type name, for one pass over a file. */
export const entitiesOf = (file: StepFile): StepEntity[] => [...file.entities.values()];
