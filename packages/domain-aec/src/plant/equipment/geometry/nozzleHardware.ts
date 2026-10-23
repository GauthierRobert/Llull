/**
 * Nozzle hardware from the 01 PSC catalogue (decision Q7): neck outside diameter and wall by DN, flange outside diameter and thickness by
 * DN, rating and facing. No catalogue row for the flange -> a named placeholder (`EQP_FLANGE_PLACEHOLDER`), never a silent guess.
 */

import type { CadDocument } from '@core/model/types';
import { fromMm } from '@core/model/units';
import { parseDn, en10220OutsideDiameter } from '../../catalog/nominal';
import { resolveCatalogRow, type ResolvedRow } from '../../catalog/lookup';
import { allCatalogs } from '../../catalog/store';
import type { NozzleFacing, NozzleFlange } from '../plantData';

export interface NozzleHardware {
  readonly neckOutsideDiameter: number;
  readonly neckWall: number;
  readonly flange: NozzleFlange;
  /** Named defaults used (neck wall), for the command's `defaulted[]`. */
  readonly defaulted: readonly string[];
}

/** ASME B16.5 / B16.47 pressure classes and the ISO 7005 / EN 1092 PN series that are accepted. */
const ASME_CLASSES: readonly number[] = [150, 300, 400, 600, 900, 1500, 2500];
const PN_SERIES: readonly number[] = [6, 10, 16, 25, 40, 63, 100, 160, 250, 320, 400];

/** `{ class: 150 }` for `CL150`, `{ pn: 16 }` for `PN16`, null for anything else. */
export function parseRating(rating: string): { readonly class?: number; readonly pn?: number } | null {
  const match = /^\s*(CL|CLASS|PN)\s*-?\s*(\d+)\s*$/i.exec(rating);
  if (match === null) return null;
  const value = Number(match[2]);
  const series = (match[1] as string).toUpperCase() === 'PN' ? PN_SERIES : ASME_CLASSES;
  if (!series.includes(value)) return null;
  return (match[1] as string).toUpperCase() === 'PN' ? { pn: value } : { class: value };
}

/** Canonical rating text (`CL150`, `PN16`). */
export function ratingText(rating: string): string {
  const parsed = parseRating(rating);
  if (parsed === null) return rating;
  return parsed.pn !== undefined ? `PN${parsed.pn}` : `CL${parsed.class}`;
}

const dimension = (row: ResolvedRow, name: string): number | undefined => row.dims[name]?.value;

function flangeRow(doc: CadDocument, dn: number, rating: { class?: number; pn?: number }, facing: NozzleFacing): ResolvedRow | null {
  for (const catalog of allCatalogs(doc)) {
    for (const withFacing of rating.pn === undefined ? [true, false] : [false]) {
      const outcome = resolveCatalogRow(catalog, {
        type: 'flangeWeldNeck',
        dn,
        ...(rating.class === undefined ? {} : { class: rating.class }),
        ...(rating.pn === undefined ? {} : { pn: rating.pn }),
        ...(withFacing ? { facing } : {}),
      });
      if (outcome.ok && dimension(outcome.row, 'outsideDiameter') !== undefined) return outcome.row;
    }
  }
  return null;
}

function pipeWallMm(doc: CadDocument, dn: number): number | null {
  for (const catalog of allCatalogs(doc)) {
    const outcome = resolveCatalogRow(catalog, { type: 'pipe', dn, schedule: '40' });
    const wall = outcome.ok ? dimension(outcome.row, 'wall') : undefined;
    if (wall !== undefined) return wall;
  }
  return null;
}

/** Placeholder flange proportions when the catalogue has no row: OD = 1.9 x neck OD, thickness = 0.1 x neck OD (named, flagged). */
const PLACEHOLDER_OD_FACTOR = 1.9;
const PLACEHOLDER_THICKNESS_FACTOR = 0.1;
const DEFAULT_WALL_FACTOR = 0.06;

/**
 * @returns hardware in document units, or null when the DN has no outside diameter in the nominal-size table (EN 10220 series)
 * @invariant flange values come from the first catalogue (bundled first) that has a weld-neck row for the DN, rating and facing
 */
export function nozzleHardware(doc: CadDocument, dn: number, rating: string, facing: NozzleFacing): NozzleHardware | null {
  const size = parseDn(dn);
  const outsideMm = size === null ? null : en10220OutsideDiameter(size);
  const parsed = parseRating(rating);
  if (outsideMm === null || parsed === null) return null;
  const wallMm = pipeWallMm(doc, dn);
  const row = flangeRow(doc, dn, parsed, facing);
  const defaulted = wallMm === null ? ['neckWall'] : [];
  const rowThickness = row === null ? undefined : dimension(row, 'thickness');
  if (row !== null && rowThickness === undefined) defaulted.push('flange.thickness');
  const flange: NozzleFlange =
    row === null
      ? {
          outsideDiameter: fromMm(doc, outsideMm * PLACEHOLDER_OD_FACTOR),
          thickness: fromMm(doc, outsideMm * PLACEHOLDER_THICKNESS_FACTOR),
          placeholder: true,
          unverified: true,
          source: 'placeholder proportions: no 01 PSC weld-neck flange row for this DN, rating and facing',
        }
      : {
          outsideDiameter: fromMm(doc, dimension(row, 'outsideDiameter') as number),
          thickness: fromMm(doc, rowThickness ?? outsideMm * PLACEHOLDER_THICKNESS_FACTOR),
          placeholder: false,
          unverified: !row.verified || rowThickness === undefined,
          catalogRef: `${row.catalogId}@${row.catalogVersion}/${row.familyId}`,
          source: rowThickness === undefined ? `${row.standard} (thickness not in the catalogue row: 0.1 x neck OD)` : row.standard,
        };
  return {
    neckOutsideDiameter: fromMm(doc, outsideMm),
    neckWall: fromMm(doc, wallMm ?? outsideMm * DEFAULT_WALL_FACTOR),
    flange,
    defaulted,
  };
}
