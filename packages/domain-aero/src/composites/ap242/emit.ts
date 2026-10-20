/** Part 21 record emitter and the representation-item / unit builders shared by the llull records and the CAx-IF composite entity writer. */

import { entityName, stringsOf } from '@lib/step21/records';
import { referencesOutsideStrings as referencesOf } from './lex';
import { quoted, real, unquoted } from './part21';

/** Hands out record ids after the highest existing one and collects the `#n=BODY;` lines. */
export class Emitter {
  private next: number;
  readonly lines: string[] = [];
  constructor(first: number) {
    this.next = first;
  }
  add(body: string): number {
    const id = this.next++;
    this.lines.push(`#${id}=${body};`);
    return id;
  }
}

/** PRODUCT_DEFINITION ids by product name (PRODUCT -> PRODUCT_DEFINITION_FORMATION -> PRODUCT_DEFINITION). */
export function definitionsByName(bodies: ReadonlyMap<number, string>): Map<string, number> {
  const productOfFormation = new Map<number, string>();
  const nameOfProduct = new Map<number, string>();
  for (const [id, body] of bodies) {
    if (entityName(body) === 'PRODUCT') nameOfProduct.set(id, unquoted(stringsOf(body)[1] ?? '') || unquoted(stringsOf(body)[0] ?? ''));
  }
  for (const [id, body] of bodies) {
    if (!entityName(body).startsWith('PRODUCT_DEFINITION_FORMATION')) continue;
    const product = referencesOf(body)[0];
    const name = product === undefined ? undefined : nameOfProduct.get(product);
    if (name !== undefined) productOfFormation.set(id, name);
  }
  const byName = new Map<string, number>();
  for (const [id, body] of bodies) {
    if (entityName(body) !== 'PRODUCT_DEFINITION') continue;
    const formation = referencesOf(body)[0];
    const name = formation === undefined ? undefined : productOfFormation.get(formation);
    if (name !== undefined && !byName.has(name)) byName.set(name, id);
  }
  return byName;
}

/** The representation context the file's own measure items use (the geometric context with its global units), or null. */
export function measureContext(bodies: ReadonlyMap<number, string>): number | null {
  for (const body of bodies.values()) {
    if (entityName(body) !== 'REPRESENTATION') continue;
    const references = referencesOf(body);
    const context = references[references.length - 1];
    if (context !== undefined && (bodies.get(context) ?? '').includes('GLOBAL_UNIT_ASSIGNED_CONTEXT')) return context;
  }
  for (const [id, body] of bodies)
    if (body.includes('GEOMETRIC_REPRESENTATION_CONTEXT') && body.includes('GLOBAL_UNIT_ASSIGNED_CONTEXT')) return id;
  return null;
}

/** SI prefix attribute (`.MILLI.`, `$`) of a length unit of `mmPerUnit` millimetres, or null for a conversion-based unit (inch, foot). */
const siPrefix = (mmPerUnit: number): string | null =>
  mmPerUnit === 1 ? '.MILLI.' : mmPerUnit === 10 ? '.CENTI.' : mmPerUnit === 1000 ? '$' : null;

export interface Units {
  readonly length: number;
  readonly area: number;
  readonly volume: number;
  readonly angle: number;
  readonly ratio: number;
}

export function makeUnits(out: Emitter, mmPerUnit: number): Units {
  const prefix = siPrefix(mmPerUnit);
  const exponents = (power: number): number => out.add(`DIMENSIONAL_EXPONENTS(${real(power)},0.,0.,0.,0.,0.,0.)`);
  let length: number;
  let area: number;
  let volume: number;
  if (prefix !== null) {
    length = out.add(`(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(${prefix},.METRE.))`);
    area = out.add(`(AREA_UNIT() NAMED_UNIT(*) SI_UNIT(${prefix},.SQUARE_METRE.))`);
    volume = out.add(`(NAMED_UNIT(*) SI_UNIT(${prefix},.CUBIC_METRE.) VOLUME_UNIT())`);
  } else {
    const baseLength = out.add('(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))');
    const baseArea = out.add('(AREA_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.SQUARE_METRE.))');
    const baseVolume = out.add('(NAMED_UNIT(*) SI_UNIT(.MILLI.,.CUBIC_METRE.) VOLUME_UNIT())');
    const name = mmPerUnit === 25.4 ? 'INCH' : 'FOOT';
    const lengthFactor = out.add(`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(${real(mmPerUnit)}),#${baseLength})`);
    const areaFactor = out.add(`AREA_MEASURE_WITH_UNIT(AREA_MEASURE(${real(mmPerUnit * mmPerUnit)}),#${baseArea})`);
    const volumeFactor = out.add(`VOLUME_MEASURE_WITH_UNIT(VOLUME_MEASURE(${real(mmPerUnit ** 3)}),#${baseVolume})`);
    length = out.add(`(CONVERSION_BASED_UNIT('${name}',#${lengthFactor}) LENGTH_UNIT() NAMED_UNIT(#${exponents(1)}))`);
    area = out.add(`(AREA_UNIT() CONVERSION_BASED_UNIT('SQUARE ${name}',#${areaFactor}) NAMED_UNIT(#${exponents(2)}))`);
    volume = out.add(`(CONVERSION_BASED_UNIT('CUBIC ${name}',#${volumeFactor}) NAMED_UNIT(#${exponents(3)}) VOLUME_UNIT())`);
  }
  const radian = out.add('(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))');
  const degreeFactor = out.add(`PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(${real(Math.PI / 180)}),#${radian})`);
  const angle = out.add(`(CONVERSION_BASED_UNIT('DEGREE',#${degreeFactor}) NAMED_UNIT(#${exponents(0)}) PLANE_ANGLE_UNIT())`);
  const ratio = out.add(`(NAMED_UNIT(#${exponents(0)}) RATIO_UNIT())`);
  return { length, area, volume, angle, ratio };
}

export interface Builder {
  readonly out: Emitter;
  readonly units: Units;
  readonly context: number;
}

export const text = (name: string, value: string): string => `DESCRIPTIVE_REPRESENTATION_ITEM(${quoted(name)},${quoted(value)})`;
export const value = (name: string, kind: 'COUNT_MEASURE' | 'MASS_MEASURE' | 'POSITIVE_LENGTH_MEASURE', amount: number): string =>
  `VALUE_REPRESENTATION_ITEM(${quoted(name)},${kind}(${real(amount)}))`;
export const measure = (name: string, kind: string, amount: number, unit: number): string =>
  `MEASURE_REPRESENTATION_ITEM(${quoted(name)},${kind}(${real(amount)}),#${unit})`;
/** INTEGER_REPRESENTATION_ITEM: the value is written as a REAL (`3.`), as the CAx-IF validation property practice requires. */
export const integer = (name: string, amount: number): string => `INTEGER_REPRESENTATION_ITEM(${quoted(name)},${real(amount)})`;
export const point = (name: string, v: readonly number[]): string => `CARTESIAN_POINT(${quoted(name)},(${v.map(real).join(',')}))`;

const isReference = (item: string): boolean => /^#\d+$/.test(item);

/** One PROPERTY_DEFINITION of `target` with its representation; an item is a record body (emitted here) or an already emitted `#n` reference. */
export function attach(
  b: Builder,
  name: string,
  description: string | null,
  target: number,
  items: readonly string[],
  representationName = '',
): number {
  const ids = items.map((item) => (isReference(item) ? item : `#${b.out.add(item)}`));
  const definition = b.out.add(`PROPERTY_DEFINITION(${quoted(name)},${description === null ? '$' : quoted(description)},#${target})`);
  const representation = b.out.add(`REPRESENTATION(${quoted(representationName)},(${ids.join(',')}),#${b.context})`);
  b.out.add(`PROPERTY_DEFINITION_REPRESENTATION(#${definition},#${representation})`);
  return definition;
}
