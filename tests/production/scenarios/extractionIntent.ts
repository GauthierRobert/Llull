import type { Vec3 } from '@core/model/types';
import { section } from '../oracle/steel';
import {
  gridCoordinates,
  type IntentMember,
  type IntentPipe,
  type PlantIntent,
} from '../plant/intent';

/**
 * @layer tests/production/scenarios
 *
 * Solvent extraction building of a soybean crushing plant — the typical first deliverable of a
 * process-plant engineering office: a 4 × 2-bay multi-storey steel structure with gratings,
 * carrying the extractor, the desolventizer-toaster, the miscella tank and the conditioner, with
 * the main process lines and access stairs.
 */

const X = gridCoordinates([6000, 6000, 6000, 6000]); // axes 1–5
const Y = gridCoordinates([7500, 7500]); // axes A–C
const FLOORS = [6000, 12000, 18000];
const GRATING = 30;
const MAIN_BEAM = 'IPE450'; // along Y, carries the floor
const SECONDARY_BEAM = 'IPE300'; // along X
/** Main beams under the extractor (+6.00, bay A–B), upsized after check_steel_members (deflection). */
const EXTRACTOR_BEAM = 'IPE500';
const EXTRACTOR_AXES = [6000, 12000, 18000];
const mainBeam = (floorIndex: number, x: number, bay: number): string =>
  floorIndex === 0 && bay === 0 && EXTRACTOR_AXES.includes(x) ? EXTRACTOR_BEAM : MAIN_BEAM;
const COLUMN = 'HEB300';
const BRACE = 'CHS139.7x5';

const depth = (profile: string): number => section(profile)?.h ?? 0;
/** Beam axis below top of steel; top of steel = FFL − grating. */
const axisZ = (floor: number, profile: string): number => floor - GRATING - depth(profile) / 2;

function members(): IntentMember[] {
  const result: IntentMember[] = [];
  for (const x of X) {
    for (const y of Y) {
      result.push({
        role: 'column',
        profile: COLUMN,
        start: [x, y, 0],
        end: [x, y, 18000],
        level: 0,
      });
    }
  }
  FLOORS.forEach((floor, index) => {
    const level = index + 1;
    for (const x of X) {
      for (let j = 0; j + 1 < Y.length; j++) {
        const profile = mainBeam(index, x, j);
        const z = axisZ(floor, profile);
        const start: Vec3 = [x, Y[j] ?? 0, z];
        const end: Vec3 = [x, Y[j + 1] ?? 0, z];
        result.push({ role: 'beam', profile, start, end, level });
      }
    }
    for (const y of Y) {
      for (let i = 0; i + 1 < X.length; i++) {
        const z = axisZ(floor, SECONDARY_BEAM);
        const start: Vec3 = [X[i] ?? 0, y, z];
        const end: Vec3 = [X[i + 1] ?? 0, y, z];
        result.push({ role: 'beam', profile: SECONDARY_BEAM, start, end, level });
      }
    }
  });
  // X-bracing: bays 1–2 and 4–5 on axes A and C; bay A–B on axes 1 and 5; every storey.
  const nodes = [0, ...FLOORS.map((floor) => axisZ(floor, SECONDARY_BEAM))];
  for (let storey = 0; storey < FLOORS.length; storey++) {
    const bottom = nodes[storey] ?? 0;
    const top = nodes[storey + 1] ?? 0;
    const cross = (a: [number, number], b: [number, number]): void => {
      result.push({
        role: 'brace',
        profile: BRACE,
        start: [...a, bottom],
        end: [...b, top],
        level: storey,
      });
      result.push({
        role: 'brace',
        profile: BRACE,
        start: [...b, bottom],
        end: [...a, top],
        level: storey,
      });
    };
    for (const y of [Y[0] ?? 0, Y[2] ?? 0]) {
      cross([X[0] ?? 0, y], [X[1] ?? 0, y]);
      cross([X[3] ?? 0, y], [X[4] ?? 0, y]);
    }
    for (const x of [X[0] ?? 0, X[4] ?? 0]) cross([x, Y[0] ?? 0], [x, Y[1] ?? 0]);
  }
  return result;
}

const PIPES: IntentPipe[] = [
  {
    line: 'L-101',
    service: 'miscella',
    dn: 100,
    from: 'E-301',
    to: 'E-501',
    route: [
      [20000, 5000, 6500],
      [20000, 6600, 6500],
      [20000, 6600, 4500],
      [17000, 6600, 4500],
      [17000, 11000, 4500],
      [15500, 11000, 4500],
      [15500, 11000, 3000],
    ],
  },
  {
    line: 'L-102',
    service: 'steam',
    dn: 150,
    from: 'TI-1',
    to: 'E-401',
    route: [
      [24500, 14200, 4500],
      [3000, 14200, 4500],
      [3000, 12000, 4500],
    ],
  },
  {
    line: 'L-103',
    service: 'hexane',
    dn: 80,
    from: 'E-501',
    to: 'E-301',
    route: [
      [16000, 10500, 2000],
      [17500, 10500, 2000],
      [17500, 4500, 2000],
      [17500, 4500, 6500],
    ],
  },
  {
    line: 'L-104',
    service: 'DT vapours',
    dn: 300,
    from: 'E-401',
    to: 'TI-2',
    route: [
      [3000, 11250, 10500],
      [3000, 11250, 16000],
      [-500, 11250, 16000],
    ],
  },
];

export const extractionIntent: PlantIntent = {
  project: {
    name: 'Soybean extraction plant 2000 t/d',
    client: 'Desmet',
    author: 'llull BE',
    drawingNumber: 'EXT-S-101',
    revision: 'A',
    date: '2026-10-05',
  },
  levels: [
    { name: 'Ground +0.00', elevation: 0, height: 6000 },
    { name: 'Floor +6.00', elevation: 6000, height: 6000 },
    { name: 'Floor +12.00', elevation: 12000, height: 6000 },
    { name: 'Top +18.00', elevation: 18000, height: 3000 },
  ],
  grid: { xSpacings: [6000, 6000, 6000, 6000], ySpacings: [7500, 7500] },
  members: members(),
  floors: [1, 2, 3].map((level) => ({
    level,
    boundary: [
      [0, 0],
      [24000, 0],
      [24000, 15000],
      [0, 15000],
    ],
    thickness: GRATING,
    material: 'grating',
  })),
  equipment: [
    {
      tag: 'E-301',
      name: 'Extractor',
      level: 1,
      location: [13500, 3750],
      size: [15000, 3200, 4000],
      weight: 60000,
      clearance: 800,
    },
    {
      tag: 'E-401',
      name: 'Desolventizer-toaster',
      level: 0,
      location: [3000, 11250],
      size: [4000, 4000, 11000],
      weight: 55000,
      clearance: 800,
    },
    {
      tag: 'E-501',
      name: 'Miscella tank',
      level: 0,
      location: [15000, 11250],
      size: [2500, 2500, 3500],
      weight: 22000,
      clearance: 800,
    },
    {
      tag: 'E-201',
      name: 'Conditioner',
      level: 2,
      location: [15000, 12500],
      size: [8000, 2500, 2500],
      weight: 25000,
      clearance: 800,
    },
  ],
  pipes: PIPES,
  tieIns: { 'TI-1': [24500, 14200, 4500], 'TI-2': [-500, 11250, 16000] },
  stairs: [
    { level: 0, start: [7000, 8500], angle: 0, width: 1000 },
    { level: 1, start: [16900, 9600], angle: Math.PI, width: 1000 },
  ],
};
