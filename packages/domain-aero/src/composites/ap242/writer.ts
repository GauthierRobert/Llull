/**
 * Writes the composite records of a `CompositeRecord` into an existing ISO 10303-21 text (06 CMP §6.4 V2, M5). OpenCascade's XDE writer has no composite
 * entities, so the records are appended to its output: they hang off the PRODUCT_DEFINITION of the tool product and of the explicit ply solids, and use
 * only AP242 MIM constructs that any reader accepts (PROPERTY_DEFINITION + PROPERTY_DEFINITION_REPRESENTATION + REPRESENTATION with descriptive, value,
 * measure, point, direction and polyline items). The subset is documented in 06 TECHNICAL_SPEC §13.6.
 * @invariant pure; the same record and base text give the same bytes; existing records are untouched, new ids follow the highest existing one
 */

import { MM_PER_UNIT } from '@core/model/units';
import { entityName, parseRecords, referencesOf, stringsOf } from '@lib/step21/records';
import type { CompositeRecord, PlyRecord, RosetteRecord } from './interchange';
import { quoted, real } from './part21';

/** Format tag of the llull composite encoding, written as `encoding` in the laminate property. */
export const ENCODING = 'llull-composite-1';

export const PROPERTY = {
  laminate: 'composite laminate',
  rosette: 'composite rosette',
  material: 'composite material',
  ply: 'composite ply',
  piece: 'composite ply piece',
  validation: 'composite validation property',
} as const;

class Emitter {
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
    const kind = entityName(body);
    if (kind === 'PRODUCT') nameOfProduct.set(id, stringsOf(body)[1] || stringsOf(body)[0] || '');
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
function measureContext(bodies: ReadonlyMap<number, string>): number | null {
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

interface Units {
  readonly length: number;
  readonly area: number;
  readonly angle: number;
}

function makeUnits(out: Emitter, mmPerUnit: number): Units {
  const prefix = siPrefix(mmPerUnit);
  const exponents = (power: number): number => out.add(`DIMENSIONAL_EXPONENTS(${real(power)},0.,0.,0.,0.,0.,0.)`);
  let length: number;
  let area: number;
  if (prefix !== null) {
    length = out.add(`(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(${prefix},.METRE.))`);
    area = out.add(`(AREA_UNIT() NAMED_UNIT(*) SI_UNIT(${prefix},.SQUARE_METRE.))`);
  } else {
    const baseLength = out.add('(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))');
    const baseArea = out.add('(AREA_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.SQUARE_METRE.))');
    const name = mmPerUnit === 25.4 ? 'INCH' : 'FOOT';
    const lengthFactor = out.add(`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(${real(mmPerUnit)}),#${baseLength})`);
    const areaFactor = out.add(`AREA_MEASURE_WITH_UNIT(AREA_MEASURE(${real(mmPerUnit * mmPerUnit)}),#${baseArea})`);
    length = out.add(`(CONVERSION_BASED_UNIT('${name}',#${lengthFactor}) LENGTH_UNIT() NAMED_UNIT(#${exponents(1)}))`);
    area = out.add(`(AREA_UNIT() CONVERSION_BASED_UNIT('SQUARE ${name}',#${areaFactor}) NAMED_UNIT(#${exponents(2)}))`);
  }
  const radian = out.add('(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))');
  const degreeFactor = out.add(`PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(${real(Math.PI / 180)}),#${radian})`);
  const angle = out.add(`(CONVERSION_BASED_UNIT('DEGREE',#${degreeFactor}) NAMED_UNIT(#${exponents(0)}) PLANE_ANGLE_UNIT())`);
  return { length, area, angle };
}

interface Builder {
  readonly out: Emitter;
  readonly units: Units;
  readonly context: number;
}

const text = (name: string, value: string): string => `DESCRIPTIVE_REPRESENTATION_ITEM(${quoted(name)},${quoted(value)})`;
const value = (name: string, kind: 'COUNT_MEASURE' | 'MASS_MEASURE' | 'POSITIVE_LENGTH_MEASURE', amount: number): string =>
  `VALUE_REPRESENTATION_ITEM(${quoted(name)},${kind}(${real(amount)}))`;
const measure = (name: string, kind: string, amount: number, unit: number): string =>
  `MEASURE_REPRESENTATION_ITEM(${quoted(name)},${kind}(${real(amount)}),#${unit})`;

const isReference = (item: string): boolean => /^#\d+$/.test(item);

/** One PROPERTY_DEFINITION of `target` with its representation; an item is a record body (emitted here) or an already emitted `#n` reference. */
function attach(b: Builder, name: string, description: string, target: number, items: readonly string[]): number {
  const ids = items.map((item) => (isReference(item) ? item : `#${b.out.add(item)}`));
  const definition = b.out.add(`PROPERTY_DEFINITION(${quoted(name)},${quoted(description)},#${target})`);
  const representation = b.out.add(`REPRESENTATION('',(${ids.join(',')}),#${b.context})`);
  b.out.add(`PROPERTY_DEFINITION_REPRESENTATION(#${definition},#${representation})`);
  return definition;
}

function rosetteItems(b: Builder, rosette: RosetteRecord): string[] {
  const triple = (kind: 'CARTESIAN_POINT' | 'DIRECTION', name: string, v: readonly number[]): string =>
    `#${b.out.add(`${kind}(${quoted(name)},(${v.map(real).join(',')}))`)}`;
  const items = [text('name', rosette.name), text('method', rosette.method)];
  const geometry = [
    triple('CARTESIAN_POINT', 'origin', rosette.origin),
    triple('DIRECTION', 'axis0', rosette.axis0),
    triple('DIRECTION', 'normal', rosette.normal),
    ...(rosette.axis === undefined ? [] : [triple('DIRECTION', 'axis', rosette.axis)]),
  ];
  return [...items, ...geometry];
}

function plyItems(b: Builder, ply: PlyRecord): string[] {
  const polyline = (name: string, points: readonly (readonly number[])[]): string => {
    const ids = points.map((point) => b.out.add(`CARTESIAN_POINT('',(${point.map(real).join(',')}))`));
    return `#${b.out.add(`POLYLINE(${quoted(name)},(${ids.map((id) => `#${id}`).join(',')}))`)}`;
  };
  const boundary =
    ply.boundary.kind === 'whole_face' ? [] : ply.boundary.polygons.map((polygon, k) => polyline(`ply boundary ${k + 1}`, polygon));
  const curves = (ply.curves3d ?? []).map((curve, k) => polyline(`ply boundary curve ${k + 1}`, curve));
  return [
    text('name', ply.name),
    text('sequence', ply.sequence),
    text('material', ply.material),
    text('rosette', ply.rosette),
    text('boundary', ply.boundary.kind),
    value('order', 'COUNT_MEASURE', ply.order),
    measure('orientation', 'PLANE_ANGLE_MEASURE', ply.orientation, b.units.angle),
    measure('thickness', 'LENGTH_MEASURE', ply.thickness, b.units.length),
    measure('area', 'AREA_MEASURE', ply.area, b.units.area),
    text('data', JSON.stringify({ drape: ply.drape, cuts: ply.cuts, solids: ply.solids })),
    ...boundary,
    ...curves,
  ];
}

export type WriteOutcome =
  | { readonly ok: true; readonly text: string; readonly records: number }
  | { readonly ok: false; readonly reason: string };

/**
 * `base` with the composite records of `record` appended before the closing ENDSEC of its DATA section.
 * @failure no tool product / no representation context / no DATA section -> `{ ok: false, reason }`
 */
export function appendComposite(base: string, record: CompositeRecord): WriteOutcome {
  const { bodies } = parseRecords(base);
  const end = base.lastIndexOf('ENDSEC;');
  if (bodies.size === 0 || end < 0) return { ok: false, reason: 'the STEP text has no DATA section' };
  const definitions = definitionsByName(bodies);
  const anchor = definitions.get(record.tool.name);
  if (anchor === undefined) return { ok: false, reason: `the file has no product named "${record.tool.name}" for the tool surface` };
  const context = measureContext(bodies);
  if (context === null) return { ok: false, reason: 'the file has no representation context with global units' };
  const out = new Emitter([...bodies.keys()].reduce((max, key) => (key > max ? key : max), 0) + 1);
  const units = makeUnits(out, MM_PER_UNIT[record.units]);
  const b: Builder = { out, units, context };

  const point = (name: string, v: readonly number[]): string => `CARTESIAN_POINT(${quoted(name)},(${v.map(real).join(',')}))`;
  attach(b, PROPERTY.laminate, record.name, anchor, [
    text('encoding', ENCODING),
    text('name', record.name),
    text('unit', record.units),
    text('laminate side', record.laminateSide),
    text('tool', record.tool.name),
    text('part rosette', record.partRosette),
    point('tool face near', record.tool.faceNear),
    text(
      'data',
      JSON.stringify({
        surface: record.surface,
        outline: record.outline,
        rules: record.rules,
        plyDropRules: record.plyDropRules,
        tool: record.tool,
      }),
    ),
  ]);
  for (const rosette of record.rosettes) attach(b, PROPERTY.rosette, rosette.name, anchor, rosetteItems(b, rosette));
  for (const material of record.materials)
    attach(b, PROPERTY.material, material.name, anchor, [
      text('name', material.name),
      text('form', material.form),
      text('data', JSON.stringify(material)),
      measure('cured ply thickness', 'LENGTH_MEASURE', material.plyThickness, units.length),
    ]);
  for (const ply of record.plies) {
    attach(b, PROPERTY.ply, ply.name, anchor, plyItems(b, ply));
    ply.solids.forEach((solid) => {
      const piece = definitions.get(solid);
      if (piece !== undefined)
        attach(b, PROPERTY.piece, ply.name, piece, [
          text('ply', ply.name),
          text('laminate', record.name),
          value('order', 'COUNT_MEASURE', ply.order),
        ]);
    });
  }
  const { validation } = record;
  attach(b, PROPERTY.validation, 'laminate', anchor, [
    value('number of plies', 'COUNT_MEASURE', validation.plyCount),
    measure('laminate thickness', 'LENGTH_MEASURE', validation.thickness, units.length),
    ...(validation.mass === undefined ? [] : [value('laminate mass', 'MASS_MEASURE', validation.mass)]),
  ]);
  for (const ply of record.plies)
    attach(b, PROPERTY.validation, 'ply area', anchor, [text('ply', ply.name), measure('ply area', 'AREA_MEASURE', ply.area, units.area)]);
  return { ok: true, text: `${base.slice(0, end)}${out.lines.join('\n')}\n${base.slice(end)}`, records: out.lines.length };
}
