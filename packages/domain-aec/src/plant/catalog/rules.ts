/**
 * Catalogue rules (TR-PSC-13): dimensional rules of the standards checked against a catalogue's rows, each finding with a stable code, the
 * file path of the offending value (`families.0.sizes.0.centreToEnd`), expected and found. Pure; reads the catalogue only.
 */

import { bundledCatalog } from './bundled';
import { dnToNps, en10220OutsideDiameter, npsToDn } from './nominal';
import { remediationFor } from './codes';
import type { ComponentFamily, ComponentSize, ComponentType, PipingCatalog } from './types';

export const CATALOG_RULES = ['b169.lr90', 'b169.sr90', 'b165.hole', 'pipe.odMatch', 'monotonic', 'provenance', 'verified'] as const;
export type CatalogRule = (typeof CATALOG_RULES)[number];

export interface CatalogFinding {
  readonly code: string;
  readonly status: 'fail' | 'warn' | 'info';
  readonly rule: CatalogRule;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly findingKey: string;
  readonly values: Readonly<Record<string, number>>;
  readonly message: string;
  readonly remediation: string;
}

const MM_PER_INCH = 25.4;
/** B16.9 centre-to-end tolerance for NPS 2..8 (S9 extract). */
const CENTRE_TO_END_TOLERANCE_MM = 2;
const HOLE_CLEARANCE_MM = 3.175;
const HOLE_TOLERANCE_MM = 0.1;
/** Fitting end OD against the dimensional standard's pipe OD. */
const END_OD_TOLERANCE_MM = 0.2;
const BUTT_WELD_TYPES: ReadonlySet<ComponentType> = new Set([
  'elbow90',
  'elbow45',
  'tee',
  'reducingTee',
  'reducerConcentric',
  'reducerEccentric',
  'cap',
]);
const MONOTONIC_DIMS = ['outsideDiameter', 'centreToEnd', 'centreToEndRun', 'boltCircle'] as const;

const sizeKey = (size: ComponentSize): string =>
  [size.size.key, size.smallSize?.key, size.schedule, size.class, size.pn, size.facing].filter((part) => part !== undefined).join('|');

function finding(
  rule: CatalogRule,
  code: string,
  status: CatalogFinding['status'],
  family: ComponentFamily,
  size: ComponentSize | undefined,
  path: string,
  message: string,
  values: Record<string, number> = {},
): CatalogFinding {
  const ids = [size === undefined ? family.id : `${family.id}/${sizeKey(size)}`];
  return {
    code,
    status,
    rule,
    ids,
    paths: [path],
    findingKey: `catalog:${code}:${rule}:${path}`,
    values,
    message,
    remediation: remediationFor(code),
  };
}

function elbowRule(rule: 'b169.lr90' | 'b169.sr90', family: ComponentFamily, familyIndex: number): CatalogFinding[] {
  const long = rule === 'b169.lr90';
  const factor = long ? 1.5 : 1;
  const minimum = long ? 0.75 : 1;
  const applies = family.type === 'elbow90' && /B16\.9/.test(family.standard) && family.radius === (long ? 'LR' : 'SR');
  if (!applies) return [];
  return family.sizes.flatMap((size, index) => {
    const dim = size.dims['centreToEnd'];
    if (dim === undefined || size.size.system !== 'NPS' || size.size.value < minimum) return [];
    const expected = Math.round(factor * size.size.value * MM_PER_INCH * 1e6) / 1e6;
    if (Math.abs(dim.value - expected) <= CENTRE_TO_END_TOLERANCE_MM) return [];
    return [
      finding(
        rule,
        'PSC_CATALOG_DIM_MISMATCH',
        'fail',
        family,
        size,
        `families.${familyIndex}.sizes.${index}.centreToEnd`,
        `${family.standard} ${family.radius} 90 NPS ${size.size.key}: centreToEnd ${dim.value} mm, rule ${factor} x NPS = ${expected} mm (+/- ${CENTRE_TO_END_TOLERANCE_MM})`,
        {
          expectedMm: expected,
          foundMm: dim.value,
          deltaMm: Math.round((dim.value - expected) * 1e6) / 1e6,
          toleranceMm: CENTRE_TO_END_TOLERANCE_MM,
        },
      ),
    ];
  });
}

function holeRule(family: ComponentFamily, familyIndex: number): CatalogFinding[] {
  if (!/B16\.5/.test(family.standard)) return [];
  return family.sizes.flatMap((size, index) => {
    const hole = size.dims['boltHole'];
    const bolt = size.dims['boltDiameter'];
    if (hole === undefined || bolt === undefined) return [];
    const expected = bolt.value + HOLE_CLEARANCE_MM;
    if (Math.abs(hole.value - expected) <= HOLE_TOLERANCE_MM) return [];
    return [
      finding(
        'b165.hole',
        'PSC_CATALOG_DIM_MISMATCH',
        'fail',
        family,
        size,
        `families.${familyIndex}.sizes.${index}.boltHole`,
        `${family.standard} NPS ${size.size.key}: hole ${hole.value} mm, expected bolt ${bolt.value} + 1/8 in = ${expected} mm`,
        { expectedMm: expected, foundMm: hole.value },
      ),
    ];
  });
}

/** Pipe OD of the family's dimensional standard at the same size (EN 10220 list, or the bundled ASME B36.10M rows), or null when unknown. */
function referenceOd(family: ComponentFamily, size: ComponentSize): number | null {
  const dn = size.size.system === 'DN' ? size.size : npsToDn(size.size);
  if (family.dimensionalStandard === 'EN') return dn === null ? null : en10220OutsideDiameter(dn);
  if (family.dimensionalStandard !== 'ASME') return null;
  const nps = size.size.system === 'NPS' ? size.size : dn === null ? null : dnToNps(dn);
  const pipe = bundledCatalog().families.find((candidate) => candidate.id === 'asme-b36.10m');
  return pipe?.sizes.find((row) => row.size.key === nps?.key)?.dims['outsideDiameter']?.value ?? null;
}

function odRule(family: ComponentFamily, familyIndex: number): CatalogFinding[] {
  if (!BUTT_WELD_TYPES.has(family.type)) return [];
  return family.sizes.flatMap((size, index) => {
    const found = size.dims['outsideDiameter'];
    const expected = found === undefined ? null : referenceOd(family, size);
    if (found === undefined || expected === null || Math.abs(found.value - expected) <= END_OD_TOLERANCE_MM) return [];
    return [
      finding(
        'pipe.odMatch',
        'PSC_CATALOG_DIM_MISMATCH',
        'fail',
        family,
        size,
        `families.${familyIndex}.sizes.${index}.outsideDiameter`,
        `${family.standard} NPS ${size.size.key}: end OD ${found.value} mm, the ${family.dimensionalStandard} pipe OD is ${expected} mm (+/- ${END_OD_TOLERANCE_MM})`,
        { expectedMm: expected, foundMm: found.value },
      ),
    ];
  });
}

function monotonicRule(family: ComponentFamily, familyIndex: number): CatalogFinding[] {
  const out: CatalogFinding[] = [];
  for (const name of MONOTONIC_DIMS) {
    const groups = new Map<string, Array<{ size: ComponentSize; index: number }>>();
    family.sizes.forEach((size, index) => {
      if (size.dims[name] === undefined) return;
      const group = [size.schedule, size.class, size.pn, size.facing].map(String).join('|');
      groups.set(group, [...(groups.get(group) ?? []), { size, index }]);
    });
    for (const entries of groups.values()) {
      const ordered = [...entries].sort((a, b) => a.size.size.value - b.size.size.value);
      ordered.forEach((entry, position) => {
        const previous = ordered[position - 1];
        const value = entry.size.dims[name]?.value ?? 0;
        const before = previous?.size.dims[name]?.value ?? 0;
        if (previous === undefined || previous.size.size.value === entry.size.size.value || value >= before) return;
        out.push(
          finding(
            'monotonic',
            'PSC_CATALOG_DIM_MISMATCH',
            'warn',
            family,
            entry.size,
            `families.${familyIndex}.sizes.${entry.index}.${name}`,
            `${family.id}: ${name} falls from ${before} mm (NPS ${previous.size.size.key}) to ${value} mm (NPS ${entry.size.size.key})`,
            { previousMm: before, foundMm: value },
          ),
        );
      });
    }
  }
  return out;
}

function provenanceRule(family: ComponentFamily, familyIndex: number): CatalogFinding[] {
  return family.sizes.flatMap((size, index) =>
    Object.entries(size.dims)
      .filter(([, dim]) => dim.provenance.citation === undefined && dim.provenance.sourceId === undefined)
      .map(([name]) =>
        finding(
          'provenance',
          'PSC_PROVENANCE_MISSING',
          'fail',
          family,
          size,
          `families.${familyIndex}.sizes.${index}.${name}`,
          `${family.id}: ${name} has no citation or source id`,
        ),
      ),
  );
}

function verifiedRule(family: ComponentFamily, familyIndex: number): CatalogFinding[] {
  const unverified = family.sizes.reduce((count, size) => count + Object.values(size.dims).filter((dim) => !dim.verified).length, 0);
  if (unverified === 0) return [];
  return [
    finding(
      'verified',
      'PSC_DATA_UNVERIFIED',
      'warn',
      family,
      undefined,
      `families.${familyIndex}`,
      `${family.id}: ${unverified} of ${family.sizes.reduce((count, size) => count + Object.keys(size.dims).length, 0)} values are not grade A (verified: false)`,
      { unverifiedValues: unverified },
    ),
  ];
}

/** Findings of the selected rules over every family (all rules when `rules` is empty). */
export function checkCatalogRules(catalog: PipingCatalog, rules: readonly CatalogRule[] = []): CatalogFinding[] {
  const selected = new Set<CatalogRule>(rules.length === 0 ? CATALOG_RULES : rules);
  const run = (rule: CatalogRule, check: () => CatalogFinding[]): CatalogFinding[] => (selected.has(rule) ? check() : []);
  return catalog.families.flatMap((family, index) => [
    ...run('b169.lr90', () => elbowRule('b169.lr90', family, index)),
    ...run('b169.sr90', () => elbowRule('b169.sr90', family, index)),
    ...run('b165.hole', () => holeRule(family, index)),
    ...run('pipe.odMatch', () => odRule(family, index)),
    ...run('monotonic', () => monotonicRule(family, index)),
    ...run('provenance', () => provenanceRule(family, index)),
    ...run('verified', () => verifiedRule(family, index)),
  ]);
}
