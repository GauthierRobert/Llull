import type { Vec3 } from '@core/model/types';
import type { RackRules } from '../criteria/pipeRack';
import { PIPE_OD, section } from '../oracle/steel';
import {
  gridCoordinates,
  type IntentMember,
  type IntentPipe,
  type IntentTray,
  type PlantIntent,
} from '../plant/intent';

/**
 * @layer tests/production/scenarios
 *
 * Inter-unit pipe rack of an oilseed extraction plant: 9 bays of 6 m (54 m, 10 portal bents),
 * two pipe tiers on IPE300 tier beams between HEB240 columns, longitudinal struts and vertical
 * X-bracing in bay 1, nine process / utility lines running battery limit to battery limit, a cable
 * tray on the upper tier and a 5 m wide road crossing in bay 5.
 */

const X = gridCoordinates(Array.from({ length: 9 }, () => 6000)); // bents 1–10
const WIDTH = 4500; // column line A (y = 0) to B
const TIERS = [5000, 6500] as const; // top of steel (TOS) of the lower and upper tier
const COLUMN = 'HEB240';
const TIER_BEAM = 'IPE300';
const STRUT = 'IPE200';
const BRACE = 'CHS114.3x5';
const TRAY_Y = 800; // centre of the 600 wide cable tray on the upper tier
const EDGE_GAP = 500; // first line edge from column line A
const LINE_GAP = 150; // clear gap between adjacent outside diameters as designed
const WEST_BATTERY_LIMIT = -1500;
const EAST_BATTERY_LIMIT = 55500;

/** Rules the office states in the brief and the criteria check. */
export const RACK_RULES = {
  /** Minimum clear height under the rack over the road (lowest steel / pipe / tray underside). */
  roadClearHeight: 4500,
  /** Road crossing in plan along X (the road runs along Y across the whole rack). */
  road: { xMin: 24500, xMax: 29500 },
  /** Minimum clear gap between the outside diameters / edges of adjacent lines on a tier. */
  minLineGap: 75,
  /** A line rests on top of steel: its underside is within this of TOS. */
  supportTolerance: 5,
  batteryLimits: { west: WEST_BATTERY_LIMIT, east: EAST_BATTERY_LIMIT },
} as const satisfies RackRules;

const depth = (profile: string): number => section(profile)?.h ?? 0;
const axisZ = (tos: number, profile: string): number => tos - depth(profile) / 2;
const mm1 = (value: number): number => Math.round(value * 10) / 10;

function members(): IntentMember[] {
  const result: IntentMember[] = [];
  const topOfColumns = TIERS[1];
  for (const x of X) {
    for (const y of [0, WIDTH]) {
      result.push({
        role: 'column',
        profile: COLUMN,
        start: [x, y, 0],
        end: [x, y, topOfColumns],
        level: 0,
        // Strong axis in the bent plane: each bent is a moment frame across the rack.
        roll: Math.PI / 2,
        baseFixity: 'pinned',
      });
    }
    for (const tos of TIERS) {
      const z = axisZ(tos, TIER_BEAM);
      result.push({
        role: 'beam',
        profile: TIER_BEAM,
        start: [x, 0, z],
        end: [x, WIDTH, z],
        level: 0,
        startJoint: 'rigid',
        endJoint: 'rigid',
      });
    }
  }
  // Bay 1 (bents 1–2): longitudinal struts on both column lines at both tiers, and X-bracing below
  // the lower tier in both column planes (work points: column base, strut axis of the lower tier).
  for (const y of [0, WIDTH]) {
    for (const tos of TIERS) {
      const z = axisZ(tos, STRUT);
      result.push({
        role: 'beam',
        profile: STRUT,
        start: [X[0] ?? 0, y, z],
        end: [X[1] ?? 0, y, z],
        level: 0,
      });
    }
    const top = axisZ(TIERS[0], STRUT);
    const a: Vec3 = [X[0] ?? 0, y, 0];
    const b: Vec3 = [X[1] ?? 0, y, 0];
    result.push({ role: 'brace', profile: BRACE, start: a, end: [b[0], y, top], level: 0 });
    result.push({ role: 'brace', profile: BRACE, start: b, end: [a[0], y, top], level: 0 });
    // Between the tiers (struts as chords), in the column-line planes outside the pipes.
    const upper = axisZ(TIERS[1], STRUT);
    result.push({
      role: 'brace',
      profile: BRACE,
      start: [a[0], y, top],
      end: [b[0], y, upper],
      level: 0,
    });
    result.push({
      role: 'brace',
      profile: BRACE,
      start: [b[0], y, top],
      end: [a[0], y, upper],
      level: 0,
    });
  }
  return result;
}

interface LineSpec {
  line: string;
  service: string;
  dn: number;
}

/** Lines laid out across the tier from column line A, `LINE_GAP` between outside diameters. */
function lay(specs: LineSpec[], tos: number, firstEdge: number): IntentPipe[] {
  let edge = firstEdge;
  return specs.map(({ line, service, dn }) => {
    const od = PIPE_OD[dn] ?? 0;
    const y = Math.round(edge + od / 2);
    const z = mm1(tos + od / 2);
    edge += od + LINE_GAP;
    return {
      line,
      service,
      dn,
      from: `BL1-${line}`,
      to: `BL2-${line}`,
      route: [
        [WEST_BATTERY_LIMIT, y, z],
        [EAST_BATTERY_LIMIT, y, z],
      ],
    };
  });
}

const TRAY: IntentTray = {
  system: 'power',
  width: 600,
  height: 100,
  route: [
    [0, TRAY_Y, TIERS[1] + 50],
    [X.at(-1) ?? 0, TRAY_Y, TIERS[1] + 50],
  ],
};

const PIPES: IntentPipe[] = [
  ...lay(
    [
      { line: 'L-201', service: 'cooling water supply', dn: 300 },
      { line: 'L-202', service: 'cooling water return', dn: 300 },
      { line: 'L-203', service: 'miscella', dn: 200 },
      { line: 'L-204', service: 'hexane', dn: 100 },
      { line: 'L-205', service: 'steam', dn: 150 },
      { line: 'L-206', service: 'condensate', dn: 50 },
    ],
    TIERS[0],
    EDGE_GAP,
  ),
  ...lay(
    [
      { line: 'L-207', service: 'compressed air', dn: 80 },
      { line: 'L-208', service: 'nitrogen', dn: 50 },
      { line: 'L-209', service: 'solvent vapours', dn: 100 },
    ],
    TIERS[1],
    TRAY_Y + TRAY.width / 2 + LINE_GAP,
  ),
];

const tieIns = (): Record<string, Vec3> =>
  Object.fromEntries(
    PIPES.flatMap((pipe) => [
      [pipe.from, pipe.route[0] ?? [0, 0, 0]],
      [pipe.to, pipe.route.at(-1) ?? [0, 0, 0]],
    ]),
  );

const { roadClearHeight, road, minLineGap } = RACK_RULES;

export const pipeRackIntent: PlantIntent = {
  project: {
    name: 'Extraction plant inter-unit pipe rack PR-1',
    client: 'Desmet',
    author: 'llull BE',
    drawingNumber: 'EXT-P-201',
    revision: 'A',
    date: '2026-10-12',
  },
  levels: [{ name: 'Ground +0.00', elevation: 0, height: 8000 }],
  grid: { xSpacings: Array.from({ length: 9 }, () => 6000), ySpacings: [WIDTH] },
  members: members(),
  floors: [],
  equipment: [],
  pipes: PIPES,
  tieIns: tieIns(),
  stairs: [],
  trays: [TRAY],
  structureBrief: [
    '## Pipe rack structure (S355)',
    `- Portal bents on every numbered axis, 6000 apart: two ${COLUMN} columns (one continuous member from 0 to +${TIERS[1] / 1000} m, on axes A and B) and two ${TIER_BEAM} tier beams (h = ${depth(TIER_BEAM)} mm) between the column axes, one member per tier, along Y. Each bent is a moment frame: tier beams rigidly connected to the columns at both ends (startJoint / endJoint 'rigid'), columns with the strong axis in the bent plane (roll π/2) on pinned bases.`,
    `- Two pipe tiers with top of steel (TOS) +${TIERS[0] / 1000} m (lower) and +${TIERS[1] / 1000} m (upper). Member axes are section centroid lines, so a tier beam axis is at TOS − ${depth(TIER_BEAM) / 2}.`,
    `- Bay 1 (axes 1–2), on both column lines A and B: a ${STRUT} longitudinal strut at each tier (top of steel = TOS, axis at TOS − ${depth(STRUT) / 2}, one member per tier) and one X-bracing ${BRACE} below the lower tier (two diagonals per column line, from the column base at ground to the strut axis of the lower tier), plus one X-bracing ${BRACE} between the tiers (from the lower strut axis to the upper strut axis) on each column line.`,
    '- Lines and cable tray rest on top of steel: a pipe centreline is at TOS + OD/2, the cable tray centre at TOS + side height / 2.',
    `- A ${road.xMax - road.xMin} mm wide road crosses the rack at x = ${road.xMin} to ${road.xMax} (bay 5, no steel inside): the clear height under the rack there (lowest underside of any steel, pipe or tray) must be at least ${roadClearHeight} mm.`,
    `- Lines on a tier keep at least ${minLineGap} mm clear between adjacent outside diameters (and the cable tray edge).`,
    '- Every line runs the full rack length, battery limit to battery limit: BL1 (west, x = ' +
      `${RACK_RULES.batteryLimits.west}) to BL2 (east, x = ${RACK_RULES.batteryLimits.east}), straight, no bends.`,
    '',
  ],
};
