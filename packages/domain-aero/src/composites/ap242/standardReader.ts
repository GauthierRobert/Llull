/**
 * Reads the CAx-IF composite structure `writeStandard` writes (ply laminate table, sequences, plies, material and orientation links, ply pieces,
 * composite validation properties by their practice names) back out of a Part 21 text, independently of OpenCascade, so that a file can be checked
 * against the model it came from. Only what llull writes is understood: it is a checker, not a general reader of other systems' composite files.
 * @invariant pure; never throws; absent structure answers `present: false`
 */

import { entityName, parseRecords, stringsOf } from '@lib/step21/records';
import { itemValue, referencesOutsideStrings as referencesOf } from './lex';
import { unquoted } from './part21';
import { RECPRAC_ID } from './standard';

export interface StandardPly {
  readonly name: string;
  readonly sequence: string;
  readonly material?: string;
  readonly rosette?: string;
  /** Degrees, from the ply's own rosette. */
  readonly angle?: number;
  readonly thickness?: number;
  readonly pieces: readonly string[];
}

export interface StandardValidationValue {
  readonly level: 'part' | 'table' | 'sequence' | 'ply' | 'rosette' | 'material';
  readonly subject: string;
  readonly name: string;
  readonly value: number | string;
}

export interface StandardRead {
  readonly present: boolean;
  readonly recPracId: boolean;
  readonly table: string;
  readonly sequences: readonly { readonly name: string; readonly plies: readonly string[] }[];
  /** Plies in stacking order (sequence by sequence). */
  readonly plies: readonly StandardPly[];
  readonly rosettes: readonly string[];
  readonly materials: readonly string[];
  readonly validation: readonly StandardValidationValue[];
}

const ABSENT: StandardRead = {
  present: false,
  recPracId: false,
  table: '',
  sequences: [],
  plies: [],
  rosettes: [],
  materials: [],
  validation: [],
};

const STOCK = new Set([
  'filament_assembly',
  'woven_assembly',
  'stock_core',
  'isotropic_material',
  'anisotropic_material',
  'discontinuous_fiber_assembly',
]);

type Bodies = ReadonlyMap<number, string>;

/** The product-category names each product belongs to. */
function categoryMap(bodies: Bodies): Map<number, Set<string>> {
  const categories = new Map<number, Set<string>>();
  for (const body of bodies.values()) {
    if (entityName(body) !== 'PRODUCT_RELATED_PRODUCT_CATEGORY') continue;
    const name = unquoted(stringsOf(body)[0] ?? '');
    for (const product of referencesOf(body)) categories.set(product, new Set([...(categories.get(product) ?? []), name]));
  }
  return categories;
}

/** The related definitions of each relating one, ordered by the usage designator then the record id. */
function childMap(bodies: Bodies): Map<number, number[]> {
  const usages = new Map<number, { related: number; designator: number; id: number }[]>();
  for (const [id, body] of [...bodies].sort(([a], [b]) => a - b)) {
    if (entityName(body) !== 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') continue;
    const [relating, related] = referencesOf(body);
    const designator = Number(unquoted(stringsOf(body)[2] ?? ''));
    if (relating !== undefined && related !== undefined)
      usages.set(relating, [
        ...(usages.get(relating) ?? []),
        { related, designator: Number.isFinite(designator) ? designator : Number.POSITIVE_INFINITY, id },
      ]);
  }
  const children = new Map<number, number[]>();
  for (const [relating, list] of usages)
    children.set(
      relating,
      [...list].sort((a, b) => a.designator - b.designator || a.id - b.id).map((entry) => entry.related),
    );
  return children;
}

/** The first two references of every record of `entity` that has both, as (first -> second) pairs in record order. */
function referencePairs(bodies: Bodies, entity: string): [number, number][] {
  const pairs: [number, number][] = [];
  for (const body of bodies.values()) {
    if (entityName(body) !== entity) continue;
    const [first, second] = referencesOf(body);
    if (first !== undefined && second !== undefined) pairs.push([first, second]);
  }
  return pairs;
}

/** The lookups over the records the composite reader walks. */
interface Index {
  readonly bodies: Bodies;
  readonly kind: (id: number) => string;
  readonly firstString: (id: number) => string;
  readonly nameOf: (definition: number) => string;
  readonly categoryOf: (definition: number) => Set<string>;
  readonly children: Map<number, number[]>;
  readonly materialOf: Map<number, string>;
  readonly valueOf: (item: number) => number | undefined;
  readonly itemsOf: (representation: number) => number[];
  readonly representationOfProperty: Map<number, number>;
  readonly propertiesOf: (target: number, name: string) => number[];
  readonly basisOfAngle: Map<number, string>;
}

function indexOf(bodies: Bodies): Index {
  const kind = (id: number): string => entityName(bodies.get(id) ?? '');
  const firstString = (id: number): string => unquoted(stringsOf(bodies.get(id) ?? '')[0] ?? '');
  const productOfDefinition = (definition: number): number | undefined => {
    const formation = referencesOf(bodies.get(definition) ?? '')[0];
    return formation === undefined ? undefined : referencesOf(bodies.get(formation) ?? '')[0];
  };
  const nameOf = (definition: number): string => {
    if (kind(definition) === 'PLY_LAMINATE_SEQUENCE_DEFINITION' || kind(definition) === 'PLY_LAMINATE_TABLE')
      return firstString(definition);
    const product = productOfDefinition(definition);
    return product === undefined ? '' : firstString(product);
  };
  const categories = categoryMap(bodies);
  const materialOf = new Map<number, string>();
  for (const [relating, related] of referencePairs(bodies, 'MAKE_FROM_USAGE_OPTION')) materialOf.set(relating, nameOf(related));
  const representationOfProperty = new Map<number, number>(referencePairs(bodies, 'PROPERTY_DEFINITION_REPRESENTATION'));
  // orientation: ply -> angle representation -> (rosette basis, value)
  const basisOfAngle = new Map<number, string>();
  for (const [basis, angle] of referencePairs(bodies, 'PLY_ORIENTATION_ANGLE')) basisOfAngle.set(angle, firstString(basis));
  return {
    bodies,
    kind,
    firstString,
    nameOf,
    categoryOf: (definition) => categories.get(productOfDefinition(definition) ?? -1) ?? new Set(),
    children: childMap(bodies),
    materialOf,
    valueOf: (item) => itemValue(bodies.get(item) ?? ''),
    itemsOf: (representation) => referencesOf(bodies.get(representation) ?? '').slice(0, -1),
    representationOfProperty,
    propertiesOf: (target, name) =>
      [...bodies]
        .filter(
          ([, body]) =>
            entityName(body) === 'PROPERTY_DEFINITION' && unquoted(stringsOf(body)[0] ?? '') === name && referencesOf(body)[0] === target,
        )
        .map(([id]) => id),
    basisOfAngle,
  };
}

/** The first item value of the representation a ply property (`orientation`, `thickness`) points to, with that representation. */
function propertyValue(ix: Index, member: number, name: string): { representation: number | undefined; value: number | undefined } {
  const [property] = ix.propertiesOf(member, name);
  const representation = property === undefined ? undefined : ix.representationOfProperty.get(property);
  const [item] = representation === undefined ? [] : ix.itemsOf(representation);
  return { representation, value: item === undefined ? undefined : ix.valueOf(item) };
}

function readPly(ix: Index, member: number, sequence: number): StandardPly {
  const { representation: angleRepresentation, value: angle } = propertyValue(ix, member, 'orientation');
  const { value: thick } = propertyValue(ix, member, 'thickness');
  const pieces = (ix.children.get(member) ?? []).map(ix.nameOf);
  const material = ix.materialOf.get(member);
  const rosette = angleRepresentation === undefined ? undefined : ix.basisOfAngle.get(angleRepresentation);
  return {
    name: ix.nameOf(member),
    sequence: ix.nameOf(sequence),
    ...(material === undefined ? {} : { material }),
    ...(rosette === undefined ? {} : { rosette }),
    ...(angle === undefined ? {} : { angle }),
    ...(thick === undefined ? {} : { thickness: thick }),
    pieces,
  };
}

/** The sequences from the laminate table down (each sequence names the next as a member) and their plies in stacking order. */
function readSequences(ix: Index, tableId: number): { sequences: { name: string; plies: string[] }[]; plies: StandardPly[] } {
  const sequences: { name: string; plies: string[] }[] = [];
  const plies: StandardPly[] = [];
  let sequence: number | undefined = ix.children.get(tableId)?.[0];
  while (sequence !== undefined && ix.kind(sequence) === 'PLY_LAMINATE_SEQUENCE_DEFINITION') {
    const members = ix.children.get(sequence) ?? [];
    const names: string[] = [];
    for (const member of members) {
      if (ix.kind(member) === 'PLY_LAMINATE_SEQUENCE_DEFINITION') continue;
      const ply = readPly(ix, member, sequence);
      names.push(ply.name);
      plies.push(ply);
    }
    sequences.push({ name: ix.nameOf(sequence), plies: names });
    sequence = members.find((member) => ix.kind(member) === 'PLY_LAMINATE_SEQUENCE_DEFINITION');
  }
  return { sequences, plies };
}

/** The level and subject a composite validation property of `target` belongs to, or undefined when it is none the checker reads. */
function validationSubject(ix: Index, target: number): { level: StandardValidationValue['level']; subject: string } | undefined {
  const targetKind = ix.kind(target);
  if (targetKind === 'PLY_LAMINATE_TABLE') return { level: 'table', subject: ix.firstString(target) };
  if (targetKind === 'PLY_LAMINATE_SEQUENCE_DEFINITION') return { level: 'sequence', subject: ix.firstString(target) };
  if (targetKind === 'ITEM_IDENTIFIED_REPRESENTATION_USAGE')
    return { level: 'rosette', subject: ix.firstString(referencesOf(ix.bodies.get(target) ?? '')[1] ?? 0) };
  if (targetKind !== 'PRODUCT_DEFINITION') return undefined;
  const names = ix.categoryOf(target);
  if (names.has('ply')) return { level: 'ply', subject: ix.nameOf(target) };
  if (names.has('part')) return { level: 'part', subject: ix.nameOf(target) };
  return [...names].some((name) => STOCK.has(name)) ? { level: 'material', subject: ix.nameOf(target) } : undefined;
}

/** The validation value an item of a validation representation carries, or undefined when a numeric item has none. */
function validationValue(ix: Index, item: number): number | string | undefined {
  const itemBody = ix.bodies.get(item) ?? '';
  const itemKind = entityName(itemBody);
  if (itemKind === 'DESCRIPTIVE_REPRESENTATION_ITEM') return unquoted(stringsOf(itemBody)[1] ?? '');
  if (itemKind === 'ROW_REPRESENTATION_ITEM')
    return referencesOf(itemBody)
      .map((entry) => unquoted(stringsOf(ix.bodies.get(entry) ?? '')[1] ?? ''))
      .join('|');
  return ix.valueOf(item);
}

function readValidation(ix: Index): StandardValidationValue[] {
  const validation: StandardValidationValue[] = [];
  for (const [id, body] of ix.bodies) {
    if (entityName(body) !== 'PROPERTY_DEFINITION' || unquoted(stringsOf(body)[0] ?? '') !== 'composite validation property') continue;
    const target = referencesOf(body)[0];
    const representation = ix.representationOfProperty.get(id);
    if (target === undefined || representation === undefined) continue;
    const owner = validationSubject(ix, target);
    if (owner === undefined) continue;
    for (const item of ix.itemsOf(representation)) {
      const value = validationValue(ix, item);
      const name = unquoted(stringsOf(ix.bodies.get(item) ?? '')[0] ?? '');
      if (value !== undefined) validation.push({ ...owner, name, value });
    }
  }
  return validation;
}

export function readStandard(text: string): StandardRead {
  const { bodies } = parseRecords(text);
  const tableId = [...bodies].find(([, body]) => entityName(body) === 'PLY_LAMINATE_TABLE')?.[0];
  if (tableId === undefined) return ABSENT;
  const ix = indexOf(bodies);
  const { sequences, plies } = readSequences(ix, tableId);
  const rosettes = [...bodies.values()]
    .filter((body) => entityName(body) === 'REINFORCEMENT_ORIENTATION_BASIS')
    .map((body) => unquoted(stringsOf(body)[0] ?? ''));
  const materials = [...new Set(plies.flatMap((ply) => (ply.material === undefined ? [] : [ply.material])))];
  return {
    present: true,
    recPracId: text.includes(RECPRAC_ID),
    table: ix.firstString(tableId),
    sequences,
    plies,
    rosettes,
    materials,
    validation: readValidation(ix),
  };
}

/**
 * `text` without the assembly usages of the composite structure (laminate table -> sequence -> ply -> ply piece). OpenCascade's STEP reader attaches the
 * pieces to those shapeless products and then loses them from its free shapes, so the solids are read from the text without the usages (the usages
 * themselves are read by `readStandard`, not by OpenCascade). Usages of other assemblies are kept.
 */
export function withoutCompositeUsages(text: string): string {
  const { bodies } = parseRecords(text);
  const structural = new Set<number>();
  const productCategories = new Map<number, string[]>();
  for (const body of bodies.values()) {
    if (entityName(body) !== 'PRODUCT_RELATED_PRODUCT_CATEGORY') continue;
    const name = unquoted(stringsOf(body)[0] ?? '');
    for (const product of referencesOf(body)) productCategories.set(product, [...(productCategories.get(product) ?? []), name]);
  }
  for (const [id, body] of bodies) {
    const kind = entityName(body);
    if (kind === 'PLY_LAMINATE_TABLE' || kind === 'PLY_LAMINATE_SEQUENCE_DEFINITION') structural.add(id);
    if (kind !== 'PRODUCT_DEFINITION') continue;
    const formation = referencesOf(body)[0];
    const product = formation === undefined ? undefined : referencesOf(bodies.get(formation) ?? '')[0];
    if (product !== undefined && (productCategories.get(product) ?? []).includes('ply')) structural.add(id);
  }
  if (structural.size === 0) return text;
  const head = /^#(\d+)\s*=\s*NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/;
  return text
    .split('\n')
    .filter((line) => {
      const found = line.length < 100_000 ? head.exec(line) : null;
      if (found?.[1] === undefined) return true;
      const relating = referencesOf(bodies.get(Number(found[1])) ?? '')[0];
      return !(relating !== undefined && structural.has(relating));
    })
    .join('\n');
}
