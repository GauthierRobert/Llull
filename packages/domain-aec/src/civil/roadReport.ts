/**
 * Alignment analysis shared by the report and the long / cross-section drawings: ground and design
 * elevations, cross-section areas and average-end-area earthwork volumes at stations.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import type { AlignmentObject, CivilModel } from '@core/model/civil';
import { endStation, pointAtStation } from './alignmentGeometry';
import { designElevation, validateProfile } from './profileGeometry';
import {
  crossSectionAt,
  sectionAreas,
  type RoadCrossSection,
  type SectionAreas,
} from './roadSection';
import { surfaceTinById } from './surfaceTin';
import { elevationAt } from './tin';
import { crossSlopesAt, hasSuperelevation, superelevationRate } from './superelevation';
import { formatStation, fromMetres } from './model';
import { toMetres } from '../model';

export interface StationAnalysis {
  readonly station: number;
  readonly designZ: number | null;
  readonly groundZ: number | null;
  readonly cross: RoadCrossSection | null;
  readonly areas: SectionAreas | null;
}

export interface ReportRow {
  readonly station: number;
  readonly stationText: string;
  readonly x: number;
  readonly y: number;
  readonly groundM: number | null;
  readonly designM: number | null;
  /** Design minus ground: positive = fill, negative = cut. */
  readonly cutFillM: number | null;
  readonly cutAreaM2: number | null;
  readonly fillAreaM2: number | null;
  readonly cumulativeCutM3: number;
  readonly cumulativeFillM3: number;
  /** Cumulative cut minus cumulative fill (no bulking / shrinkage). */
  readonly massHaulM3: number;
  /** Signed superelevation (+ = banked for a left-hand curve); null without a superelevation design. */
  readonly superelevationPercent: number | null;
}

const roundTo = (value: number, digits: number): number => Number(value.toFixed(digits));

/** Start, every `interval` from the start, end. */
export function reportStations(alignment: AlignmentObject, interval: number): number[] {
  const start = alignment.startStation;
  const end = endStation(alignment);
  const stations = [start];
  const step = Math.max(interval, (end - start) / 1000);
  for (let s = start + step; s < end - 1e-6; s += step) stations.push(s);
  if (end - start > 1e-9) stations.push(end);
  return stations;
}

/** Ground, design and cross-section data at each station (section areas need profile + section + surface). */
export function analyseStations(
  doc: CadDocument,
  civil: CivilModel,
  alignment: AlignmentObject,
  stations: ReadonlyArray<number>,
): StationAnalysis[] {
  const tin = alignment.surfaceId ? surfaceTinById(civil, alignment.surfaceId) : null;
  const profileOk = validateProfile(alignment.profile) === null;
  const unitsPerMetre = 1 / toMetres(doc, 1);
  const step = 0.5 * unitsPerMetre;
  return stations.map((station) => {
    const placed = pointAtStation(alignment, station);
    const groundZ = tin && placed ? elevationAt(tin, placed.point) : null;
    const designZ = profileOk ? designElevation(alignment.profile, station) : null;
    const cross =
      alignment.section && designZ !== null
        ? crossSectionAt(alignment, alignment.section, tin, station, designZ, unitsPerMetre)
        : null;
    const areas = cross && tin ? sectionAreas(cross, tin, step) : null;
    return { station, designZ, groundZ, cross, areas };
  });
}

/** Report rows with average-end-area cumulative volumes (m3) and the mass-haul ordinate. */
export function reportRows(
  doc: CadDocument,
  alignment: AlignmentObject,
  analysis: ReadonlyArray<StationAnalysis>,
): ReportRow[] {
  const metre = toMetres(doc, 1);
  const areaFactor = metre * metre;
  let cut = 0;
  let fill = 0;
  let previous: StationAnalysis | null = null;
  const crossfall = alignment.section?.crossfall ?? 0.025;
  const laneWidth = alignment.section?.laneWidth ?? fromMetres(doc, 3.5);
  return analysis.map((entry) => {
    if (previous?.areas && entry.areas) {
      const length = (entry.station - previous.station) * metre;
      cut += ((previous.areas.cutArea + entry.areas.cutArea) / 2) * areaFactor * length;
      fill += ((previous.areas.fillArea + entry.areas.fillArea) / 2) * areaFactor * length;
    }
    previous = entry;
    const placed = pointAtStation(alignment, entry.station);
    const designM = entry.designZ === null ? null : toMetres(doc, entry.designZ);
    const groundM = entry.groundZ === null ? null : toMetres(doc, entry.groundZ);
    return {
      station: roundTo(toMetres(doc, entry.station), 3),
      stationText: formatStation(toMetres(doc, entry.station)),
      x: roundTo(toMetres(doc, placed?.point[0] ?? 0), 3),
      y: roundTo(toMetres(doc, placed?.point[1] ?? 0), 3),
      groundM: groundM === null ? null : roundTo(groundM, 3),
      designM: designM === null ? null : roundTo(designM, 3),
      cutFillM: designM === null || groundM === null ? null : roundTo(designM - groundM, 3),
      cutAreaM2: entry.areas ? roundTo(entry.areas.cutArea * areaFactor, 3) : null,
      fillAreaM2: entry.areas ? roundTo(entry.areas.fillArea * areaFactor, 3) : null,
      cumulativeCutM3: roundTo(cut, 2),
      cumulativeFillM3: roundTo(fill, 2),
      massHaulM3: roundTo(cut - fill, 2),
      superelevationPercent: hasSuperelevation(alignment)
        ? roundTo(
            superelevationRate(crossSlopesAt(alignment, crossfall, laneWidth, entry.station)) * 100,
            3,
          )
        : null,
    };
  });
}

const CSV_COLUMNS = [
  'station',
  'x',
  'y',
  'groundM',
  'designM',
  'cutFillM',
  'cutAreaM2',
  'fillAreaM2',
  'cumulativeCutM3',
  'cumulativeFillM3',
  'massHaulM3',
  'superelevationPercent',
] as const;

export function reportCsv(rows: ReadonlyArray<ReportRow>): string {
  const lines = rows.map((row) =>
    [row.stationText, ...CSV_COLUMNS.slice(1).map((column) => row[column] ?? '')].join(','),
  );
  return [CSV_COLUMNS.join(','), ...lines].join('\n');
}
