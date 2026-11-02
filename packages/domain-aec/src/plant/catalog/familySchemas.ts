/**
 * Family schemas of the import-only standards (plant 01 PSC M4, decision D9): ASME B16.11 socket-weld / threaded fittings, MSS SP-97 olets, EN 10253
 * butt-weld fittings and ASME B16.47 large-diameter flanges have no free data source, so llull ships no rows for them; what it ships is the shape
 * a catalogue file must have to claim the standard. A family whose `standard` names one of them is validated at import (`PSC_CATALOG_INVALID`
 * with the path of the missing dimension, class or size) and `component_shape` / `resolve_joint` read these dimension names.
 * Dimension names are llull's (millimetres); a schema constrains structure, never the values.
 * @invariant pure; a schema applies to a family only when both its standard pattern and one of its component types match
 */

import type { ComponentFamily, ComponentSize, ComponentType, EndType } from './types';

export interface FamilySchema {
  readonly id: string;
  /** Matches `family.standard`. */
  readonly standard: RegExp;
  readonly standardName: string;
  readonly types: readonly ComponentType[];
  /** Dimension names every size must carry, per component type. */
  readonly required: Readonly<Partial<Record<ComponentType, readonly string[]>>>;
  readonly optional: readonly string[];
  /** Allowed pressure classes: a `class` a size carries must be one of them; absent = the schema does not use `class`. */
  readonly classes?: (ends: readonly EndType[]) => readonly number[];
  /** Every size must carry a class (B16.47 rows are class-keyed; the 02 RTE B16.11 / olet stubs are not). */
  readonly classRequired?: boolean;
  /** Sizes must be NPS within these bounds (inclusive). */
  readonly npsRange?: { readonly min: number; readonly max: number };
  /** Sizes are keyed by DN (the EN designation). */
  readonly system?: 'DN';
  /** Olets: the branch size is part of the key. */
  readonly needsSmallSize?: boolean;
  /** The family `standard` text must also match this (B16.47 series). */
  readonly standardDetail?: { readonly pattern: RegExp; readonly message: string };
}

const SOCKET_CLASSES = [3000, 6000, 9000] as const;
const THREADED_CLASSES = [2000, 3000, 6000] as const;
const B1611_TYPES = ['elbow90', 'elbow45', 'tee', 'coupling', 'cap', 'union'] as const satisfies readonly ComponentType[];

/** B16.11 classes by the family's end types (socket weld 3000 / 6000 / 9000, threaded 2000 / 3000 / 6000). */
const b1611Classes = (ends: readonly EndType[]): readonly number[] =>
  [
    ...new Set([
      ...(ends.includes('SW') || ends.length === 0 ? SOCKET_CLASSES : []),
      ...(ends.includes('THD') || ends.length === 0 ? THREADED_CLASSES : []),
    ]),
  ].sort((a, b) => a - b);

export const FAMILY_SCHEMAS: readonly FamilySchema[] = [
  {
    id: 'asme-b16.11',
    standard: /B16\.11/i,
    standardName: 'ASME B16.11 (socket-weld and threaded fittings)',
    types: B1611_TYPES,
    required: {
      elbow90: ['centreToEnd'],
      elbow45: ['centreToEnd'],
      tee: ['centreToEndRun', 'centreToEndBranch'],
      coupling: ['length'],
      cap: ['length'],
      union: ['length'],
    },
    optional: ['socketDepth', 'socketBore', 'bodyOd', 'minWall', 'threadLength'],
    classes: b1611Classes,
  },
  {
    id: 'mss-sp-97',
    standard: /SP-?97|\bolet/i,
    standardName: 'MSS SP-97 (integrally reinforced forged branch outlets)',
    types: ['weldolet', 'sockolet', 'threadolet'],
    required: { weldolet: ['centreToOutlet'], sockolet: ['centreToOutlet'], threadolet: ['centreToOutlet'] },
    optional: ['socketDepth', 'bodyOd', 'branchBore', 'baseWidth'],
    classes: b1611Classes,
    needsSmallSize: true,
  },
  {
    id: 'en-10253',
    standard: /EN\s*10253/i,
    standardName: 'EN 10253 (butt-welding fittings)',
    types: ['elbow90', 'elbow45', 'tee', 'reducingTee', 'reducerConcentric', 'reducerEccentric', 'cap'],
    required: {
      elbow90: ['outsideDiameter', 'centreToEnd'],
      elbow45: ['outsideDiameter', 'centreToEnd'],
      tee: ['outsideDiameter', 'centreToEndRun'],
      reducingTee: ['outsideDiameter', 'centreToEndRun', 'centreToEndBranch', 'smallOutsideDiameter'],
      reducerConcentric: ['outsideDiameter', 'smallOutsideDiameter', 'length'],
      reducerEccentric: ['outsideDiameter', 'smallOutsideDiameter', 'length'],
      cap: ['outsideDiameter', 'length'],
    },
    optional: ['wall', 'smallWall'],
    system: 'DN',
  },
  {
    id: 'asme-b16.47',
    standard: /B16\.47/i,
    standardName: 'ASME B16.47 (large-diameter steel flanges, NPS 26 to 60, Series A and B)',
    types: ['flangeWeldNeck', 'flangeBlind'],
    required: {
      flangeWeldNeck: ['outsideDiameter', 'thickness', 'boltCircle', 'boltCount', 'boltDiameter', 'raisedFaceDiameter'],
      flangeBlind: ['outsideDiameter', 'thickness', 'boltCircle', 'boltCount', 'boltDiameter', 'raisedFaceDiameter'],
    },
    optional: ['boltHole', 'hubOd', 'lengthThroughHub'],
    classes: () => [75, 150, 300, 400, 600, 900],
    classRequired: true,
    npsRange: { min: 26, max: 60 },
    standardDetail: {
      pattern: /Series\s*[AB]\b/i,
      message: 'the standard must name its series, e.g. "ASME B16.47 Series A" (A and B are different flanges)',
    },
  },
];

/** The schema that governs `family`, or null (the family claims no import-only standard). */
export const schemaFor = (family: Pick<ComponentFamily, 'standard' | 'type'>): FamilySchema | null =>
  FAMILY_SCHEMAS.find((schema) => schema.standard.test(family.standard) && schema.types.includes(family.type)) ?? null;

export interface SchemaIssue {
  /** Path relative to the family: `standard`, `sizes.0.centreToEnd`. */
  readonly path: string;
  readonly message: string;
}

const sizeIssues = (schema: FamilySchema, family: ComponentFamily, size: ComponentSize, at: string): SchemaIssue[] => {
  const issues: SchemaIssue[] = [];
  for (const name of schema.required[family.type] ?? [])
    if (size.dims[name] === undefined)
      issues.push({ path: `${at}.${name}`, message: `${schema.standardName} ${family.type} needs the dimension "${name}"` });
  if (schema.classes !== undefined) {
    const allowed = schema.classes(family.ends);
    if (size.class === undefined) {
      if (schema.classRequired === true)
        issues.push({ path: `${at}.class`, message: `${schema.standardName} sizes need a class (${allowed.join(', ')})` });
    } else if (!allowed.includes(size.class))
      issues.push({ path: `${at}.class`, message: `class ${size.class} is not a ${schema.standardName} class (${allowed.join(', ')})` });
  }
  if (schema.needsSmallSize === true && size.smallSize === undefined)
    issues.push({ path: `${at}.smallNps`, message: `${schema.standardName} sizes need the branch size (smallNps / smallDn)` });
  if (schema.system !== undefined && size.size.system !== schema.system)
    issues.push({ path: `${at}.dn`, message: `${schema.standardName} sizes are designated by DN` });
  if (schema.npsRange !== undefined) {
    const { min, max } = schema.npsRange;
    if (size.size.system !== 'NPS' || size.size.value < min || size.size.value > max)
      issues.push({ path: `${at}.nps`, message: `${schema.standardName} covers NPS ${min} to ${max} (smaller flanges are ASME B16.5)` });
  }
  return issues;
};

/** Structure problems of `family` against the schema it claims (empty when it claims none or satisfies it). */
export function familySchemaIssues(family: ComponentFamily): SchemaIssue[] {
  const schema = schemaFor(family);
  if (schema === null) return [];
  const detail = schema.standardDetail;
  return [
    ...(detail !== undefined && !detail.pattern.test(family.standard) ? [{ path: 'standard', message: detail.message }] : []),
    ...family.sizes.flatMap((size, index) => sizeIssues(schema, family, size, `sizes.${index}`)),
  ];
}
