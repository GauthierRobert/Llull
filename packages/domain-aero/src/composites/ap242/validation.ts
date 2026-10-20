/**
 * Composite validation properties (06 CMP §6.4 V2): the numbers written with the ply table (ply count, ply areas, laminate thickness, laminate mass),
 * recomputed from the plies and the tool surface, and the comparison of a file's embedded values with that recomputation (green / yellow / red /
 * not checkable, the bands of the 04 XCH geometric validation properties applied to composites).
 */

import type { CompositePart, LaminaMaterial, Ply } from '@core/model/composites';
import { MM_PER_UNIT } from '@core/model/units';
import { autoStepLength } from '../drape/plyDrape';
import { piecesOf } from '../geometry2d';
import { pieceSurfaceArea } from '../plySolid';
import type { CompositeRecord, CompositeValidation, PlyRecord } from './interchange';
import type { EmbeddedValidation } from './reader';

/** Covered area of a ply on the tool surface (every piece, ramps included), document units squared: the figure `laminate_mass` uses. */
export function plyArea(part: CompositePart, ply: Ply): number {
  const edge = autoStepLength(part) * 12.5;
  return piecesOf(ply, part).reduce((sum, piece) => sum + pieceSurfaceArea(part, piece, edge), 0);
}

/** Ply count, summed cured thickness and mass (absent when a material has no density) of plies with their `area` and material. */
export function laminateValidation(
  plies: readonly { readonly area: number; readonly thickness: number; readonly material: string }[],
  materials: ReadonlyMap<string, LaminaMaterial> | Readonly<Record<string, LaminaMaterial>>,
): CompositeValidation {
  const lookup = (name: string): LaminaMaterial | undefined =>
    materials instanceof Map ? materials.get(name) : (materials as Record<string, LaminaMaterial>)[name];
  const densities = plies.map((ply) => lookup(ply.material)?.density);
  const mass =
    densities.every((density) => density !== undefined) && plies.length > 0
      ? plies.reduce((sum, ply, index) => sum + ply.area * ply.thickness * (densities[index] as number), 0)
      : undefined;
  return { plyCount: plies.length, thickness: plies.reduce((sum, ply) => sum + ply.thickness, 0), ...(mass === undefined ? {} : { mass }) };
}

type Band = 'green' | 'yellow' | 'red' | 'not_checkable';

export interface ValidationFinding {
  readonly property: 'number of plies' | 'ply area' | 'ply table area' | 'laminate thickness' | 'laminate mass';
  readonly subject: string;
  readonly embedded: number | null;
  readonly recomputed: number;
  readonly relativeDifference: number | null;
  readonly band: Band;
}

export interface ValidationReport {
  readonly band: Band;
  readonly findings: readonly ValidationFinding[];
  readonly policy: string;
}

const GREEN = 1e-6;
const YELLOW = 1e-3;
const RANK: Readonly<Record<Band, number>> = { green: 0, not_checkable: 1, yellow: 2, red: 3 };

function compare(
  property: ValidationFinding['property'],
  subject: string,
  embedded: number | undefined,
  recomputed: number,
): ValidationFinding {
  if (embedded === undefined) return { property, subject, embedded: null, recomputed, relativeDifference: null, band: 'not_checkable' };
  const relative = Math.abs(embedded - recomputed) / Math.max(Math.abs(recomputed), 1e-300);
  const exact = embedded === recomputed;
  const band: Band = exact || relative <= GREEN ? 'green' : relative <= YELLOW ? 'yellow' : 'red';
  return { property, subject, embedded, recomputed, relativeDifference: exact ? 0 : relative, band };
}

/**
 * The embedded validation properties of a read file against the values recomputed from its plies and tool surface.
 * @invariant bands by relative difference: <= 1e-6 green, <= 1e-3 yellow, else red; an absent property is not checkable; the overall band is the worst
 */
export function checkValidation(
  record: Omit<CompositeRecord, 'validation'>,
  part: CompositePart,
  plies: readonly { readonly record: PlyRecord; readonly ply: Ply }[],
  embedded: EmbeddedValidation,
): ValidationReport {
  const areas = plies.map(({ ply }) => plyArea(part, ply));
  const materials = Object.fromEntries(record.materials.map((material) => [material.name, material]));
  const sums = laminateValidation(
    plies.map(({ record: ply }, index) => ({ area: areas[index] as number, thickness: ply.thickness, material: ply.material })),
    materials,
  );
  const findings: ValidationFinding[] = [
    compare('number of plies', record.name, embedded.plyCount, sums.plyCount),
    compare('laminate thickness', record.name, embedded.thickness, sums.thickness),
    ...(sums.mass === undefined ? [] : [compare('laminate mass', record.name, embedded.mass, sums.mass)]),
    ...plies.flatMap(({ record: ply }, index): ValidationFinding[] => [
      compare('ply area', ply.name, embedded.plyAreas[ply.name], areas[index] as number),
      compare('ply table area', ply.name, ply.area, areas[index] as number),
    ]),
  ];
  const band = findings.reduce<Band>((worst, finding) => (RANK[finding.band] > RANK[worst] ? finding.band : worst), 'green');
  return {
    band,
    findings,
    policy: `relative difference <= ${GREEN} green, <= ${YELLOW} yellow, else red; absent property not checkable (${record.units}, ${MM_PER_UNIT[record.units]} mm per unit)`,
  };
}
