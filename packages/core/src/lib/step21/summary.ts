/**
 * What a STEP file claims about itself (XCH 04 TR-XCH-18, TR-XCH-22): FILE_SCHEMA, the global length unit with its exact factor, the
 * CAx-IF geometric validation properties (GVP) the sender embedded, per product, and an entity census. Port of
 * `docs/aerospace/04-interop-ap242-jt-iges/validation/extract_validation_properties.py`, read without OpenCascade so a check never trusts
 * the reader under test.
 * @invariant pure; units are NOT converted here: values are in the file's own length unit (`lengthUnit.mmPerUnit` converts)
 */

import { unescapeStep } from './decode';
import { entityName, leadingNames, parseRecords, referencesOf, stringsOf } from './records';

/** The file's global length unit, with the exact factor to millimetres (25.4 for inch, 304.8 for foot, ...). */
interface FileLengthUnit {
  readonly name: string;
  readonly mmPerUnit: number;
}

interface GvpValue {
  readonly item: string;
  readonly measure: string;
  readonly value: number | readonly [number, number, number];
}

/** One `geometric validation property` definition with the values its representation carries. */
export interface FileGvp {
  readonly propertyDefinition: number;
  readonly description: string;
  readonly definitionTarget: string | null;
  /** Record id of the target: the properties of one product / solid share it. */
  readonly target: number | null;
  /** The product (name, else id) the property describes; null when the chain of references could not be followed. */
  readonly product: string | null;
  readonly values: readonly GvpValue[];
  /** The length unit of the representation that carries the values (its GLOBAL_UNIT_ASSIGNED_CONTEXT); null when it names none, so the file's global unit applies. */
  readonly lengthUnit: FileLengthUnit | null;
}

export interface Step21Summary {
  readonly fileSchema: string | null;
  readonly lengthUnit: FileLengthUnit | null;
  readonly validationPropertyCounts: { readonly geometric: number; readonly pmi: number; readonly attribute: number };
  readonly geometricValidationProperties: readonly FileGvp[];
  readonly entityCensus: Readonly<Record<string, number>>;
  readonly products: readonly string[];
  readonly records: number;
}

/** A Part 21 REAL: `8.`, `1.E+03`, `.5`, `-0.25E-2`. */
const NUMBER = String.raw`[-+]?(?:\d{1,64}(?:\.\d{0,64})?|\.\d{1,64})(?:[Ee][-+]?\d{1,6})?`;

const SI_PREFIX_MM: Readonly<Record<string, number>> = { $: 1000, KILO: 1_000_000, CENTI: 10, MILLI: 1, MICRO: 0.001, NANO: 1e-6 };
const CONVERSION_NAME_MM: Readonly<Record<string, number>> = { INCH: 25.4, FOOT: 304.8, MILE: 1_609_344, MIL: 0.0254 };
const CONVERSION_ALIAS: Readonly<Record<string, string>> = {
  MILLIMETRE: 'mm',
  MILLIMETER: 'mm',
  CENTIMETRE: 'cm',
  CENTIMETER: 'cm',
  METRE: 'm',
  METER: 'm',
};
const UNIT_LABEL: Readonly<Record<string, string>> = { $: 'm', MILLI: 'mm', CENTI: 'cm', MICRO: 'um', KILO: 'km', NANO: 'nm' };

/** The PMI / tessellation / B-rep / assembly types the census counts (same list as the Python reference). */
const CENSUS_TYPES: ReadonlySet<string> = new Set([
  'DATUM',
  'DATUM_FEATURE',
  'DATUM_SYSTEM',
  'DATUM_REFERENCE_COMPARTMENT',
  'PLACED_DATUM_TARGET_FEATURE',
  'DIMENSIONAL_SIZE',
  'DIMENSIONAL_LOCATION',
  'ANGULAR_SIZE',
  'ANGULAR_LOCATION',
  'GEOMETRIC_TOLERANCE',
  'FLATNESS_TOLERANCE',
  'POSITION_TOLERANCE',
  'PERPENDICULARITY_TOLERANCE',
  'PARALLELISM_TOLERANCE',
  'SURFACE_PROFILE_TOLERANCE',
  'LINE_PROFILE_TOLERANCE',
  'CYLINDRICITY_TOLERANCE',
  'CIRCULAR_RUNOUT_TOLERANCE',
  'TOTAL_RUNOUT_TOLERANCE',
  'ANGULARITY_TOLERANCE',
  'COAXIALITY_TOLERANCE',
  'CONCENTRICITY_TOLERANCE',
  'SYMMETRY_TOLERANCE',
  'STRAIGHTNESS_TOLERANCE',
  'ROUNDNESS_TOLERANCE',
  'PLUS_MINUS_TOLERANCE',
  'TOLERANCE_ZONE',
  'TESSELLATED_ANNOTATION_OCCURRENCE',
  'ANNOTATION_CURVE_OCCURRENCE',
  'DRAFT_MODEL',
  'CHARACTERIZED_OBJECT_AND_CHARACTERIZED_REPRESENTATION_AND_DRAUGHTING_MODEL_AND_REPRESENTATION',
  'COMPLEX_TRIANGULATED_SURFACE_SET',
  'TRIANGULATED_FACE',
  'TESSELLATED_SHELL',
  'TESSELLATED_SOLID',
  'ADVANCED_FACE',
  'MANIFOLD_SOLID_BREP',
  'NEXT_ASSEMBLY_USAGE_OCCURRENCE',
  'PRODUCT',
]);

/** First string of FILE_SCHEMA, whitespace collapsed (`AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 3 1 4 }`). */
export function fileSchemaOf(text: string): string | null {
  const match = /FILE_SCHEMA\s{0,64}\(\s{0,64}\(\s{0,64}'([^']{0,1024})'/.exec(text);
  return match?.[1] === undefined ? null : match[1].split(/\s+/).filter(Boolean).join(' ');
}

const MAX_UNIT_DEPTH = 4;

/** The length unit a unit record denotes (`( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )` or a CONVERSION_BASED_UNIT), or null. */
function unitOfBody(bodies: ReadonlyMap<number, string>, body: string | undefined, depth = 0): FileLengthUnit | null {
  if (body === undefined || depth > MAX_UNIT_DEPTH || !body.startsWith('(') || !body.includes('LENGTH_UNIT')) return null;
  const si = /SI_UNIT\(\s{0,16}(\$|\.[A-Z]{1,16}\.)\s{0,16},\s{0,16}\.METRE\.\s{0,16}\)/.exec(body);
  if (si?.[1] !== undefined) {
    const prefix = si[1].replaceAll('.', '');
    return { name: UNIT_LABEL[prefix] ?? `${prefix} m`, mmPerUnit: SI_PREFIX_MM[prefix] ?? Number.NaN };
  }
  const conversion = /CONVERSION_BASED_UNIT\(\s{0,16}'([^']{0,128})'\s{0,16},\s{0,16}#(\d{1,16})/.exec(body);
  if (conversion?.[1] === undefined) return null;
  const name = conversion[1].toUpperCase();
  const measure = bodies.get(Number(conversion[2]));
  const value =
    measure === undefined ? undefined : new RegExp(String.raw`LENGTH_MEASURE\(\s{0,16}(${NUMBER})\s{0,16}\)`).exec(measure)?.[1];
  const own = measure === undefined ? null : unitOfBody(bodies, bodies.get(referencesOf(measure).at(-1) ?? -1), depth + 1);
  const known = CONVERSION_NAME_MM[name];
  // the factor is a LENGTH_MEASURE in the unit of its own measure (0.0254 + METRE), never a bare millimetre count
  const factor = value !== undefined && own !== null && Number.isFinite(own.mmPerUnit) ? Number(value) * own.mmPerUnit : known;
  return { name: CONVERSION_ALIAS[name] ?? name.toLowerCase(), mmPerUnit: factor ?? Number.NaN };
}

/** The length unit of a representation context (`GLOBAL_UNIT_ASSIGNED_CONTEXT((#unit, ...))`), or null. */
function contextUnit(bodies: ReadonlyMap<number, string>, contextId: number | undefined): FileLengthUnit | null {
  const context = contextId === undefined ? undefined : bodies.get(contextId);
  if (context === undefined) return null;
  const assigned = /GLOBAL_UNIT_ASSIGNED_CONTEXT\s{0,16}\(\s{0,16}\(([^)]{0,2048})\)/.exec(context)?.[1];
  if (assigned === undefined) return null;
  for (const unit of referencesOf(assigned)) {
    const found = unitOfBody(bodies, bodies.get(unit));
    if (found !== null) return found;
  }
  return null;
}

/**
 * The file's global length unit: the unit of the shape representation's context (SHAPE_DEFINITION_REPRESENTATION, the geometry itself), else the
 * first representation context that names one, else the first length unit record.
 */
function lengthUnitOf(bodies: ReadonlyMap<number, string>): FileLengthUnit | null {
  const ordered = [...bodies].sort(([a], [b]) => a - b);
  for (const [, body] of ordered) {
    if (!body.startsWith('SHAPE_DEFINITION_REPRESENTATION(')) continue;
    const shape = referencesOf(body)[1];
    const references = referencesOf(bodies.get(shape ?? -1) ?? '');
    const found = contextUnit(bodies, references.at(-1));
    if (found !== null) return found;
  }
  for (const [id, body] of ordered) {
    if (!body.includes('GLOBAL_UNIT_ASSIGNED_CONTEXT')) continue;
    const found = contextUnit(bodies, id);
    if (found !== null) return found;
  }
  for (const [, body] of ordered) {
    const found = unitOfBody(bodies, body);
    if (found !== null) return found;
  }
  return null;
}

/** The product a property definition's target belongs to (name, else id), following PRODUCT_DEFINITION_SHAPE and SHAPE_ASPECT links. */
function productOf(bodies: ReadonlyMap<number, string>, target: number, depth = 0): string | null {
  const body = bodies.get(target);
  if (body === undefined || depth > 4) return null;
  const kind = entityName(body);
  if (kind === 'PRODUCT_DEFINITION' || kind === 'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS') {
    const formation = referencesOf(body)[0];
    const formationBody = formation === undefined ? undefined : bodies.get(formation);
    const product = formationBody === undefined ? undefined : referencesOf(formationBody)[0];
    const productBody = product === undefined ? undefined : bodies.get(product);
    if (productBody === undefined) return null;
    const [id = '', name = ''] = stringsOf(productBody).map(unescapeStep);
    return name !== '' ? name : id;
  }
  for (const next of referencesOf(body)) {
    const nextKind = entityName(bodies.get(next) ?? '');
    if (nextKind === 'PRODUCT_DEFINITION_SHAPE' || nextKind === 'PRODUCT_DEFINITION' || nextKind === 'SHAPE_ASPECT') {
      const found = productOf(bodies, next, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function measureValue(item: string): GvpValue | null {
  const kind = entityName(item);
  if (kind === 'MEASURE_REPRESENTATION_ITEM' || kind === 'VALUE_REPRESENTATION_ITEM') {
    const match = new RegExp(String.raw`'([^']*)'\s*,\s*([A-Z_]+)\s*\(\s*(${NUMBER})\s*\)`).exec(item);
    return match === null ? null : { item: match[1] ?? '', measure: match[2] ?? '', value: Number(match[3]) };
  }
  if (kind === 'CARTESIAN_POINT') {
    const match = new RegExp(String.raw`'([^']*)'\s*,\s*\(\s*(${NUMBER})\s*,\s*(${NUMBER})\s*,\s*(${NUMBER})\s*\)`).exec(item);
    return match === null
      ? null
      : { item: match[1] ?? '', measure: 'CARTESIAN_POINT', value: [Number(match[2]), Number(match[3]), Number(match[4])] };
  }
  return null;
}

/** Census, schema, unit and GVP of a Part 21 text. */
export function summarizeStep21(text: string): Step21Summary {
  const { bodies } = parseRecords(text);
  const representationsOf = new Map<number, number[]>();
  for (const body of bodies.values()) {
    if (entityName(body) !== 'PROPERTY_DEFINITION_REPRESENTATION') continue;
    const [definition, representation] = referencesOf(body);
    if (definition !== undefined && representation !== undefined)
      representationsOf.set(definition, [...(representationsOf.get(definition) ?? []), representation]);
  }
  const counts = { geometric: 0, pmi: 0, attribute: 0 };
  const properties: FileGvp[] = [];
  const census: Record<string, number> = {};
  const products: string[] = [];
  for (const [id, body] of [...bodies].sort(([a], [b]) => a - b)) {
    for (const name of new Set(leadingNames(body))) {
      if (CENSUS_TYPES.has(name)) census[name] = (census[name] ?? 0) + 1;
    }
    const kind = entityName(body);
    if (kind === 'PRODUCT') {
      const [productId = '', productName = ''] = stringsOf(body).map(unescapeStep);
      products.push(productName !== '' ? productName : productId);
    }
    if (kind !== 'PROPERTY_DEFINITION') continue;
    const strings = stringsOf(body);
    const name = (strings[0] ?? '').toLowerCase();
    for (const key of ['geometric', 'pmi', 'attribute'] as const) if (name === `${key} validation property`) counts[key]++;
    if (name !== 'geometric validation property') continue;
    const references = referencesOf(body);
    const target = references[references.length - 1];
    const values: GvpValue[] = [];
    let lengthUnit: FileLengthUnit | null = null;
    for (const representation of representationsOf.get(id) ?? []) {
      const references = referencesOf(bodies.get(representation) ?? '');
      lengthUnit = lengthUnit ?? contextUnit(bodies, references.at(-1));
      for (const itemId of references) {
        const value = measureValue(bodies.get(itemId) ?? '');
        if (value !== null) values.push(value);
      }
    }
    properties.push({
      propertyDefinition: id,
      description: unescapeStep(strings[1] ?? ''),
      definitionTarget: target === undefined ? null : entityName(bodies.get(target) ?? ''),
      target: target ?? null,
      product: target === undefined ? null : productOf(bodies, target),
      values,
      lengthUnit,
    });
  }
  return {
    fileSchema: fileSchemaOf(text),
    lengthUnit: lengthUnitOf(bodies),
    validationPropertyCounts: counts,
    geometricValidationProperties: properties,
    entityCensus: Object.fromEntries(Object.entries(census).sort(([a], [b]) => a.localeCompare(b))),
    products,
    records: bodies.size,
  };
}
