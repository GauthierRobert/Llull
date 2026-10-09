import { readFileSync } from 'node:fs';
import type { Vec2 } from '@core/model/types';

/**
 * @layer tests/production/civil
 *
 * Design intent of the civil-office job (site development): the survey the client supplies and the
 * engineer's layout decisions. The brief, the scripted calls and the acceptance criteria are all
 * generated from it, so they cannot disagree. Survey: public/samples/pilot-site-survey.csv
 * (scripts/generate-civil-samples.mjs), local site grid in metres.
 */

export interface CivilManholeIntent {
  name: string;
  location: Vec2;
  /** Invert chosen by the scripted engineer (the brief leaves inverts to the designer). */
  invert: number;
  catchment?: { areaHa: number; runoffCoefficient: number };
}

export interface CivilIntent {
  project: { name: string; client: string; drawingNumber: string; revision: string; date: string };
  surveyFile: string;
  surveyText: string;
  pad: { name: string; boundary: Vec2[]; swellFactor: number; cutSlope: number; fillSlope: number };
  road: {
    name: string;
    points: Vec2[];
    radii: number[];
    spirals: number[];
    stationInterval: number;
    designSpeedKmh: number;
    maxSuperelevation: number;
    laneWidth: number;
    shoulderWidth: number;
    crossfall: number;
    maxGrade: number;
    /** Profile chosen by the scripted engineer (station, elevation, vertical curve length). */
    pvis: { station: number; elevation: number; curveLength?: number }[];
  };
  drainage: {
    manholes: CivilManholeIntent[];
    /** Pipes as [from index, to index] into `manholes`, flow direction. */
    pipes: [number, number][];
    idf: { a: number; b: number; c: number };
    outfallLevel: number;
    minCoverM: number;
    minVelocity: number;
    manningN: number;
    diametersMm: number[];
  };
  sheetPaper: 'A2';
}

const SURVEY_FILE = 'pilot-site-survey.csv';
const surveyText = readFileSync(
  new URL(`../../../public/samples/${SURVEY_FILE}`, import.meta.url),
  'utf8',
);

/** Local site grid origin of the survey. */
const at = (east: number, north: number): Vec2 => [1000 + east, 5000 + north];

export const civilSiteIntent: CivilIntent = {
  project: {
    name: 'Hillside business park — plot 4',
    client: 'Pilot civil office',
    drawingNumber: 'C-101',
    revision: 'A',
    date: '2026-10-09',
  },
  surveyFile: SURVEY_FILE,
  surveyText,
  pad: {
    name: 'Building pad',
    boundary: [at(150, 110), at(200, 110), at(200, 150), at(150, 150)],
    swellFactor: 1.1,
    cutSlope: 1.5,
    fillSlope: 2,
  },
  road: {
    name: 'Access road',
    points: [at(110, 5), at(175, 35), at(170, 105)],
    radii: [60],
    spirals: [40],
    stationInterval: 10,
    designSpeedKmh: 40,
    maxSuperelevation: 0.06,
    laneWidth: 3,
    shoulderWidth: 1,
    crossfall: 0.025,
    maxGrade: 0.08,
    pvis: [
      { station: 0, elevation: 103.0 },
      { station: 70, elevation: 105.5, curveLength: 40 },
      { station: 128, elevation: 109.4 },
    ],
  },
  drainage: {
    manholes: [
      {
        name: 'MH1',
        location: at(178, 100),
        invert: 107.0,
        catchment: { areaHa: 0.2, runoffCoefficient: 0.9 },
      },
      {
        name: 'MH2',
        location: at(180, 40),
        invert: 104.3,
        catchment: { areaHa: 0.12, runoffCoefficient: 0.85 },
      },
      {
        name: 'MH3',
        location: at(120, 12),
        invert: 101.8,
        catchment: { areaHa: 0.6, runoffCoefficient: 0.4 },
      },
      { name: 'Outfall', location: at(72, 12), invert: 100.45 },
    ],
    pipes: [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
    idf: { a: 1000, b: 10, c: 0.8 },
    outfallLevel: 100.75,
    minCoverM: 0.9,
    minVelocity: 0.6,
    manningN: 0.013,
    diametersMm: [150, 225, 300, 375, 450, 525, 600, 750, 900, 1050, 1200],
  },
  sheetPaper: 'A2',
};

/** Survey rows of the supplied file (header and blank lines excluded). */
export function surveyRows(
  intent: CivilIntent,
): { e: number; n: number; z: number; code: string }[] {
  return intent.surveyText
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [, e = '', n = '', z = '', code = ''] = line.split(',');
      return { e: Number(e), n: Number(n), z: Number(z), code };
    });
}
