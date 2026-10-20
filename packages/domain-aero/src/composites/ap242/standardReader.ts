/**
 * Reads the CAx-IF composite structure `writeStandard` writes (ply laminate table, sequences, plies, material and orientation links, ply pieces,
 * composite validation properties by their practice names) back out of a Part 21 text, independently of OpenCascade, so that a file can be checked
 * against the model it came from. Only what llull writes is understood: it is a checker, not a general reader of other systems' composite files.
 * @invariant pure; never throws; absent structure answers `present: false`
 */

import { entityName, parseRecords, referencesOf, stringsOf } from '@lib/step21/records';
import { unquoted } from './part21';
import { RECPRAC_ID } from './standard';

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[Ee][-+]?\d+)?`;

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

export function readStandard(text: string): StandardRead {
  const { bodies } = parseRecords(text);
  const kind = (id: number): string => entityName(bodies.get(id) ?? '');
  const tableId = [...bodies].find(([, body]) => entityName(body) === 'PLY_LAMINATE_TABLE')?.[0];
  if (tableId === undefined) return ABSENT;
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
  const categories = new Map<number, Set<string>>();
  for (const body of bodies.values()) {
    if (entityName(body) !== 'PRODUCT_RELATED_PRODUCT_CATEGORY') continue;
    const name = unquoted(stringsOf(body)[0] ?? '');
    for (const product of referencesOf(body)) categories.set(product, new Set([...(categories.get(product) ?? []), name]));
  }
  const categoryOf = (definition: number): Set<string> => categories.get(productOfDefinition(definition) ?? -1) ?? new Set();

  const children = new Map<number, number[]>();
  for (const [, body] of [...bodies].sort(([a], [b]) => a - b)) {
    if (entityName(body) !== 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') continue;
    const [relating, related] = referencesOf(body);
    if (relating !== undefined && related !== undefined) children.set(relating, [...(children.get(relating) ?? []), related]);
  }
  const materialOf = new Map<number, string>();
  for (const body of bodies.values()) {
    if (entityName(body) !== 'MAKE_FROM_USAGE_OPTION') continue;
    const [relating, related] = referencesOf(body);
    if (relating !== undefined && related !== undefined) materialOf.set(relating, nameOf(related));
  }
  const valueOf = (item: number): number | undefined => {
    const body = bodies.get(item) ?? '';
    const integer = entityName(body) === 'INTEGER_REPRESENTATION_ITEM' ? new RegExp(String.raw`,\s*(${NUMBER})\s*\)$`).exec(body) : null;
    const match = integer ?? new RegExp(String.raw`,\s*[A-Z_]+\(\s*(${NUMBER})\s*\)`).exec(body);
    return match?.[1] === undefined ? undefined : Number(match[1]);
  };
  const itemsOf = (representation: number): number[] => referencesOf(bodies.get(representation) ?? '').slice(0, -1);
  const representationOfProperty = new Map<number, number>();
  for (const body of bodies.values()) {
    if (entityName(body) !== 'PROPERTY_DEFINITION_REPRESENTATION') continue;
    const [definition, representation] = referencesOf(body);
    if (definition !== undefined && representation !== undefined) representationOfProperty.set(definition, representation);
  }
  const propertiesOf = (target: number, name: string): number[] =>
    [...bodies]
      .filter(
        ([, body]) =>
          entityName(body) === 'PROPERTY_DEFINITION' && unquoted(stringsOf(body)[0] ?? '') === name && referencesOf(body)[0] === target,
      )
      .map(([id]) => id);

  // orientation: ply -> angle representation -> (rosette basis, value)
  const basisOfAngle = new Map<number, string>();
  for (const body of bodies.values()) {
    if (entityName(body) !== 'PLY_ORIENTATION_ANGLE') continue;
    const [basis, angle] = referencesOf(body);
    if (basis !== undefined && angle !== undefined) basisOfAngle.set(angle, firstString(basis));
  }
  const plyByName = new Map<string, number>();
  const sequences: { name: string; plies: string[] }[] = [];
  const plies: StandardPly[] = [];
  let sequence: number | undefined = children.get(tableId)?.[0];
  while (sequence !== undefined && kind(sequence) === 'PLY_LAMINATE_SEQUENCE_DEFINITION') {
    const members = children.get(sequence) ?? [];
    const names: string[] = [];
    for (const member of members) {
      if (kind(member) === 'PLY_LAMINATE_SEQUENCE_DEFINITION') continue;
      const name = nameOf(member);
      names.push(name);
      plyByName.set(name, member);
      const [orientation] = propertiesOf(member, 'orientation');
      const angleRepresentation = orientation === undefined ? undefined : representationOfProperty.get(orientation);
      const [angleItem] = angleRepresentation === undefined ? [] : itemsOf(angleRepresentation);
      const [thickness] = propertiesOf(member, 'thickness');
      const thicknessRepresentation = thickness === undefined ? undefined : representationOfProperty.get(thickness);
      const [thicknessItem] = thicknessRepresentation === undefined ? [] : itemsOf(thicknessRepresentation);
      const pieces: string[] = [];
      let piece = children.get(member)?.[0];
      while (piece !== undefined) {
        pieces.push(nameOf(piece));
        piece = children.get(piece)?.[0];
      }
      const angle = angleItem === undefined ? undefined : valueOf(angleItem);
      const thick = thicknessItem === undefined ? undefined : valueOf(thicknessItem);
      const material = materialOf.get(member);
      const rosette = angleRepresentation === undefined ? undefined : basisOfAngle.get(angleRepresentation);
      plies.push({
        name,
        sequence: nameOf(sequence),
        ...(material === undefined ? {} : { material }),
        ...(rosette === undefined ? {} : { rosette }),
        ...(angle === undefined ? {} : { angle }),
        ...(thick === undefined ? {} : { thickness: thick }),
        pieces,
      });
    }
    sequences.push({ name: nameOf(sequence), plies: names });
    sequence = members.find((member) => kind(member) === 'PLY_LAMINATE_SEQUENCE_DEFINITION');
  }

  const rosettes = [...bodies.values()]
    .filter((body) => entityName(body) === 'REINFORCEMENT_ORIENTATION_BASIS')
    .map((body) => unquoted(stringsOf(body)[0] ?? ''));
  const materials = [...new Set(plies.flatMap((ply) => (ply.material === undefined ? [] : [ply.material])))];

  const validation: StandardValidationValue[] = [];
  for (const [id, body] of bodies) {
    if (entityName(body) !== 'PROPERTY_DEFINITION' || unquoted(stringsOf(body)[0] ?? '') !== 'composite validation property') continue;
    const target = referencesOf(body)[0];
    const representation = representationOfProperty.get(id);
    if (target === undefined || representation === undefined) continue;
    let level: StandardValidationValue['level'] | undefined;
    let subject = '';
    const targetKind = kind(target);
    if (targetKind === 'PLY_LAMINATE_TABLE') [level, subject] = ['table', firstString(target)];
    else if (targetKind === 'PLY_LAMINATE_SEQUENCE_DEFINITION') [level, subject] = ['sequence', firstString(target)];
    else if (targetKind === 'ITEM_IDENTIFIED_REPRESENTATION_USAGE')
      [level, subject] = ['rosette', firstString(referencesOf(bodies.get(target) ?? '')[1] ?? 0)];
    else if (targetKind === 'PRODUCT_DEFINITION') {
      const names = categoryOf(target);
      if (names.has('ply')) [level, subject] = ['ply', nameOf(target)];
      else if (names.has('part')) [level, subject] = ['part', nameOf(target)];
      else if ([...names].some((name) => STOCK.has(name))) [level, subject] = ['material', nameOf(target)];
    }
    if (level === undefined) continue;
    for (const item of itemsOf(representation)) {
      const itemBody = bodies.get(item) ?? '';
      const itemKind = entityName(itemBody);
      const name = unquoted(stringsOf(itemBody)[0] ?? '');
      if (itemKind === 'DESCRIPTIVE_REPRESENTATION_ITEM')
        validation.push({ level, subject, name, value: unquoted(stringsOf(itemBody)[1] ?? '') });
      else if (itemKind === 'ROW_REPRESENTATION_ITEM')
        validation.push({
          level,
          subject,
          name,
          value: referencesOf(itemBody)
            .map((entry) => unquoted(stringsOf(bodies.get(entry) ?? '')[1] ?? ''))
            .join('|'),
        });
      else {
        const value = valueOf(item);
        if (value !== undefined) validation.push({ level, subject, name, value });
      }
    }
  }
  return {
    present: true,
    recPracId: text.includes(RECPRAC_ID),
    table: firstString(tableId),
    sequences,
    plies,
    rosettes,
    materials,
    validation,
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
  return text.replace(/^#(\d+)\s*=\s*NEXT_ASSEMBLY_USAGE_OCCURRENCE\([^\n]*\);[ \t]*\r?\n?/gm, (line, id: string) => {
    const relating = referencesOf(bodies.get(Number(id)) ?? '')[0];
    return relating !== undefined && structural.has(relating) ? '' : line;
  });
}
