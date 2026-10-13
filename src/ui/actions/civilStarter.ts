// "Civil site" starter: ONE `build_project` plan over the sample survey (public/samples): metres, terrain, graded
// building pad, access road (clothoids, profile, template, superelevation), 4-manhole IDF-sized storm network, framing.

import { useStore } from '@ui/store';

const CIVIL_SAMPLE_SURVEY_URL = `${import.meta.env.BASE_URL}samples/pilot-site-survey.csv`;

/** i = a / (t + b)^c mm/h (10-year, temperate). */
const CIVIL_STARTER_IDF = { a: 1000, b: 10, c: 0.8 } as const;

/** Local site grid origin (metres). */
const ORIGIN_E = 1000;
const ORIGIN_N = 5000;
const at = (east: number, north: number): [number, number] => [ORIGIN_E + east, ORIGIN_N + north];

interface PlanAction {
  command: string;
  params: Record<string, unknown>;
}

const manhole = (
  name: string,
  location: [number, number],
  invertElevation: number,
  catchment?: { areaHa: number; c: number },
): PlanAction => ({
  command: 'add_manhole',
  params: {
    name,
    location,
    invertElevation,
    surfaceId: 'surface-1',
    ...(catchment ? { catchmentAreaHa: catchment.areaHa, runoffCoefficient: catchment.c } : {}),
  },
});

/** Ids are those minted on an empty document. */
function civilStarterActions(surveyText: string): PlanAction[] {
  return [
    { command: 'set_units', params: { units: 'm' } },
    { command: 'set_project_info', params: { name: 'Pilot site', client: 'Sample data' } },
    { command: 'import_survey_points', params: { name: 'Pilot survey', text: surveyText, format: 'PENZD', sourceUnit: 'm' } },
    { command: 'create_surface', params: { name: 'EG', contourInterval: 0.5, majorEvery: 5 } },
    {
      command: 'add_platform',
      params: {
        name: 'Building pad',
        surfaceId: 'surface-1',
        boundary: [at(150, 110), at(200, 110), at(200, 150), at(150, 150)],
        elevation: 110.5,
      },
    },
    { command: 'balance_platform', params: { platformId: 'platform-1', swellFactor: 1.1 } },
    {
      command: 'add_alignment',
      params: {
        name: 'Access road',
        points: [at(110, 5), at(175, 35), at(170, 105)],
        radii: [60],
        spirals: [40],
        stationInterval: 10,
        surfaceId: 'surface-1',
      },
    },
    {
      command: 'set_alignment_profile',
      params: {
        alignmentId: 'alignment-1',
        pvis: [
          { station: 0, elevation: 103.0 },
          { station: 70, elevation: 105.5, curveLength: 40 },
          { station: 130, elevation: 109.5 },
        ],
      },
    },
    { command: 'set_road_section', params: { alignmentId: 'alignment-1', laneWidth: 3, shoulderWidth: 1, crossfall: 0.025 } },
    { command: 'set_superelevation', params: { alignmentId: 'alignment-1', maxRate: 0.06 } },
    manhole('MH1', at(178, 100), 107.0, { areaHa: 0.2, c: 0.9 }),
    manhole('MH2', at(180, 40), 104.3, { areaHa: 0.12, c: 0.85 }),
    manhole('MH3', at(120, 12), 101.8, { areaHa: 0.6, c: 0.4 }),
    manhole('Outfall', at(72, 12), 100.45),
    { command: 'add_pipe', params: { fromId: 'manhole-1', toId: 'manhole-2' } },
    { command: 'add_pipe', params: { fromId: 'manhole-2', toId: 'manhole-3' } },
    { command: 'add_pipe', params: { fromId: 'manhole-3', toId: 'manhole-4' } },
    { command: 'size_drainage_pipes', params: { idf: CIVIL_STARTER_IDF, minVelocity: 0.6 } },
    { command: 'fit_view', params: { direction: 'iso' } },
  ];
}

/** @returns the status line (dispatch summary, or why the survey did not load) */
export async function startCivilSite(): Promise<string> {
  const { dispatch, setStatusMessage } = useStore.getState();
  let surveyText: string;
  try {
    const response = await fetch(CIVIL_SAMPLE_SURVEY_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    surveyText = await response.text();
  } catch (error) {
    const message = `Civil site starter: could not load the sample survey (${(error as Error).message}).`;
    setStatusMessage(message);
    return message;
  }
  return new Promise((resolve) => {
    dispatch('build_project', { actions: civilStarterActions(surveyText) }, { onResult: (result) => resolve(result.summary) });
  });
}
