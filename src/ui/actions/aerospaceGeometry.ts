// Aerospace starter geometry (UAV propulsion pod): hollow carbon Clark-Y wing stub with a skin access cutout, 7075 doubler,
// machined pylon fitting (truss pocket, Ø12 shaft bore, tapped M4 motor bolt circle), outrunner motor, lofted 16x8 propeller
// and spinner, 2024-T3 sheet-metal ESC bracket with flanged lightening holes. Coordinates in mm, flight direction +X.

export interface PlanAction {
  command: string;
  params: Record<string, unknown>;
  as?: string;
}

type Vec2 = readonly [number, number];

/** Wing lower surface (flat from 0.2 c aft), mm. Flight direction is +X, the leading edge at x = 0. */
const WING_Z = 300;
const CHORD = 400;
const SPAN = 700;
const SKIN = 1.5;
/** Motor axis and propeller plane. */
export const AXIS_Z = 240;
export const PROP_X = 112;
/** Fitting side profile, extruded across y in [-FIT_HALF_WIDTH, FIT_HALF_WIDTH]. */
export const FIT_HALF_WIDTH = 24;
export const FLANGE_TOP = 294;
export const FLANGE_BOTTOM = 286;
const FLANGE_REAR = -250;
export const WEB_FRONT = 52;
const WEB_BACK = 44;
const WEB_BOTTOM = 195;
const STRUT_TOP_X = -140;
/** Doubler under the lower skin, bridging the fitting access cutout. */
const DOUBLER_MIN: readonly [number, number, number] = [-255, -40, WING_Z - 6];
const DOUBLER_SIZE: readonly [number, number, number] = [160, 80, 6];

/** Clark Y ordinates y/c at x/c (upper and lower surfaces). */
const CLARK_Y_UPPER: readonly Vec2[] = [
  [0, 0.035],
  [0.0125, 0.0545],
  [0.025, 0.065],
  [0.05, 0.079],
  [0.1, 0.096],
  [0.15, 0.105],
  [0.2, 0.113],
  [0.3, 0.117],
  [0.4, 0.114],
  [0.5, 0.104],
  [0.6, 0.092],
  [0.7, 0.076],
  [0.8, 0.057],
  [0.9, 0.035],
  [1, 0.0125],
];
const CLARK_Y_LOWER: readonly Vec2[] = [
  [0, 0.035],
  [0.0125, 0.0165],
  [0.025, 0.011],
  [0.05, 0.0055],
  [0.1, 0.0015],
  [0.2, 0],
  [1, 0],
];

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Catmull-Rom through the table points, `perSegment` samples per segment, the last point included. */
function smoothSamples(table: readonly Vec2[], perSegment: number): Vec2[] {
  const at = (i: number): Vec2 => table[Math.min(Math.max(i, 0), table.length - 1)] ?? [0, 0];
  const samples: Vec2[] = [];
  for (let i = 0; i < table.length - 1; i += 1) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let k = 0; k < perSegment; k += 1) {
      const t = k / perSegment;
      const blend = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
      samples.push([blend(p0[0], p1[0], p2[0], p3[0]), blend(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  samples.push(at(table.length - 1));
  return samples;
}

/**
 * Closed airfoil loop for extrude_profile along +Y: local x = world x (TE at -chord), local -y = height above the wing bottom.
 * `inset` > 0 gives the skin's inner loop between x/c 0.03 and 0.85 (the leading and trailing edges stay solid).
 */
function airfoilLoop(inset: number): number[][] {
  const t = inset / CHORD;
  const keep = ([x]: Vec2): boolean => inset === 0 || (x >= 0.03 && x <= 0.85);
  const upper = smoothSamples(CLARK_Y_UPPER, 4)
    .filter(keep)
    .map(([x, y]): Vec2 => [x, y - t]);
  const nose = smoothSamples(
    CLARK_Y_LOWER.filter(([x]) => x <= 0.2),
    4,
  );
  const lowerFlat: Vec2[] = inset === 0 ? [[1, 0]] : [[0.85, 0]];
  const lower = [...lowerFlat, ...nose.reverse().slice(0, -1)].filter(keep).map(([x, y]): Vec2 => [x, y + t]);
  return [...upper, ...lower].map(([x, y]) => [round3(-x * CHORD), round3(-y * CHORD)]);
}

/** 16x8 propeller stations: radius, chord, thickness (mm); blade angle tan(beta) = P / (2 pi r). */
export const PROP_DIAMETER = 406.4;
const PROP_PITCH = 203.2;
const BLADE_STATIONS: readonly (readonly [number, number, number])[] = [
  [8, 20, 9],
  [30, 30, 6],
  [70, 34, 4.2],
  [120, 29, 3.2],
  [170, 21, 2.4],
  [PROP_DIAMETER / 2 - 2, 10, 1.6],
];

function bladeSections(sign: 1 | -1): Record<string, unknown>[] {
  return BLADE_STATIONS.map(([radius, chord, thickness]) => {
    const beta = Math.atan(PROP_PITCH / (2 * Math.PI * radius));
    return {
      center: [PROP_X, 0, round3(AXIS_Z + sign * radius)],
      rotation: [0, 0, round3(sign * (Math.PI / 2 - beta))],
      radiusX: chord / 2,
      radiusY: thickness / 2,
    };
  });
}

/** Pylon attachment: one row of NAS6203-3 bolts on the fitting centreline, x from BOLT_X_FIRST to BOLT_X_LAST. */
export const BOLT_X_FIRST = -238;
export const BOLT_X_LAST = -150;

/** Fitting side face (normal +Y): face frame u = world x, v = -world z. */
const sideFace = (x: number, z: number): number[] => [x, -z];

function airframeActions(): PlanAction[] {
  return [
    {
      command: 'extrude_profile',
      params: { profile: airfoilLoop(0), depth: SPAN, position: [0, -SPAN / 2, WING_Z], axis: [0, 1, 0] },
      as: 'wingBlank',
    },
    {
      command: 'extrude_profile',
      params: { profile: airfoilLoop(SKIN), depth: SPAN - 2 * SKIN, position: [0, -SPAN / 2 + SKIN, WING_Z], axis: [0, 1, 0] },
      as: 'wingCore',
    },
    { command: 'boolean', params: { op: 'subtract', a: '$wingBlank', b: '$wingCore' }, as: 'wingSkin' },
    { command: 'add_box', params: { size: [136, 60, 4], position: [-246, -30, WING_Z - 1], anchor: 'min' }, as: 'accessCutout' },
    { command: 'boolean', params: { op: 'subtract', a: '$wingSkin', b: '$accessCutout' }, as: 'wing' },
    { command: 'set_entity_name', params: { id: '$wing', name: 'Wing stub (CFRP, Clark Y 400)', tags: ['airframe'] } },
    { command: 'add_box', params: { size: [...DOUBLER_SIZE], position: [...DOUBLER_MIN], anchor: 'min', color: '#9aa4ad' }, as: 'doubler' },
    { command: 'set_entity_name', params: { id: '$doubler', name: 'Pylon doubler', tags: ['airframe', 'primary-structure'] } },
  ];
}

function fittingActions(): PlanAction[] {
  return [
    {
      command: 'extrude_profile',
      params: {
        profile: [
          [FLANGE_REAR, -FLANGE_TOP],
          [WEB_FRONT, -FLANGE_TOP],
          [WEB_FRONT, -WEB_BOTTOM],
          [WEB_BACK, -WEB_BOTTOM],
          [STRUT_TOP_X, -FLANGE_BOTTOM],
          [FLANGE_REAR, -FLANGE_BOTTOM],
        ],
        depth: 2 * FIT_HALF_WIDTH,
        position: [0, -FIT_HALF_WIDTH, 0],
        axis: [0, 1, 0],
        color: '#b8c2cc',
      },
      as: 'fittingBlank',
    },
    {
      command: 'add_pocket',
      params: {
        target: '$fittingBlank',
        face: { near: [-60, FIT_HALF_WIDTH, 290] },
        outline: { kind: 'polygon', points: [sideFace(-112, 280), sideFace(38, 280), sideFace(38, 206)] },
        through: true,
        cornerRadius: 3,
        floorFillet: 0,
        toolDiameter: 6,
      },
      as: 'fittingPocketed',
    },
    {
      command: 'add_hole',
      params: {
        target: '$fittingPocketed',
        face: { near: [WEB_FRONT, 0, 270] },
        points: [[WEB_FRONT, 0, AXIS_Z]],
        pointsFrame: 'world',
        hole: { kind: 'simple', diameter: 12 },
        extent: { kind: 'up_to_next' },
      },
      as: 'fittingBored',
    },
    {
      command: 'add_hole',
      params: {
        target: '$fittingBored',
        face: { near: [WEB_FRONT, 0, 270] },
        points: [45, 135, 225, 315].map((deg) => [
          WEB_FRONT,
          round3(25 * Math.cos((deg * Math.PI) / 180)),
          round3(AXIS_Z + 25 * Math.sin((deg * Math.PI) / 180)),
        ]),
        pointsFrame: 'world',
        hole: { kind: 'simple', diameter: 3.3, thread: { designation: 'M4x0.7-6H', depth: 10 } },
        extent: { kind: 'up_to_next' },
      },
      as: 'fitting',
    },
  ];
}

function propulsionActions(): PlanAction[] {
  return [
    {
      command: 'add_cylinder',
      params: { radius: 30, height: 6, axis: [1, 0, 0], position: [WEB_FRONT + 3, 0, AXIS_Z], color: '#3b3f46' },
      as: 'stator',
    },
    { command: 'set_entity_name', params: { id: '$stator', name: 'Motor stator mount', tags: ['propulsion'] } },
    {
      command: 'add_cylinder',
      params: { radius: 35, height: 42, axis: [1, 0, 0], position: [WEB_FRONT + 27, 0, AXIS_Z], color: '#a3312a' },
      as: 'bell',
    },
    { command: 'set_entity_name', params: { id: '$bell', name: 'Outrunner bell (rotor)', tags: ['propulsion', 'rotor'] } },
    {
      command: 'add_cylinder',
      params: { radius: 13, height: 20, axis: [1, 0, 0], position: [PROP_X, 0, AXIS_Z], color: '#1d1f23' },
      as: 'hub',
    },
    { command: 'loft_sections', params: { sections: bladeSections(1), color: '#1d1f23' }, as: 'bladeA' },
    { command: 'loft_sections', params: { sections: bladeSections(-1), color: '#1d1f23' }, as: 'bladeB' },
    { command: 'boolean', params: { op: 'union', a: '$hub', b: '$bladeA' }, as: 'hubBlade' },
    { command: 'boolean', params: { op: 'union', a: '$hubBlade', b: '$bladeB' }, as: 'propeller' },
    { command: 'set_entity_name', params: { id: '$propeller', name: 'Propeller 16x8 (2-blade)', tags: ['propulsion', 'rotor'] } },
    {
      command: 'revolve_profile',
      params: {
        profile: [
          [0, 0],
          [17, 0],
          [16, 10],
          [13, 20],
          [8, 29],
          [0, 34],
        ],
        axis: 'x',
        position: [PROP_X + 10, 0, AXIS_Z],
        segments: 48,
        color: '#e8e8e8',
      },
      as: 'spinner',
    },
    { command: 'set_entity_name', params: { id: '$spinner', name: 'Spinner', tags: ['propulsion', 'rotor'] } },
  ];
}

const ESC_BRACKET_MIN: Vec2 = [-235, 66];
const ESC_BRACKET_SIZE: Vec2 = [100, 68];
/** Bends grow outside the base outline: a flange's mid-plane sits R + T/2 beyond it. */
const FLANGE_MID_OFFSET = 4.8 + 0.8;

function systemsActions(): PlanAction[] {
  const [x0, y0] = ESC_BRACKET_MIN;
  const [width, depth] = ESC_BRACKET_SIZE;
  return [
    {
      command: 'create_sheet_metal_rule',
      params: {
        name: 'AL2024-T3 1.6',
        material: '2024',
        temper: 'T3',
        thickness: 1.6,
        insideRadius: 4.8,
        kFactor: 0.44,
        kFactorStandard: 'ansi',
        relief: { type: 'rectangular', widthRatio: 0.5 },
      },
    },
    { command: 'draw_rectangle', params: { width, height: depth, position: [x0, y0, WING_Z] }, as: 'escOutline' },
    { command: 'add_sheet_metal_base', params: { profileId: '$escOutline', rule: 'AL2024-T3 1.6', side: 'down' }, as: 'escBracket' },
    ...[y0, y0 + depth].map(
      (y): PlanAction => ({
        command: 'add_flange',
        params: {
          id: '$escBracket',
          edge: { near: [x0 + width / 2, y, WING_Z - 0.8] },
          angle: 90,
          length: 36,
          lengthReference: 'outside_mold_line',
          position: 'material_outside',
          direction: 'down',
        },
      }),
    ),
    ...[y0 - FLANGE_MID_OFFSET, y0 + depth + FLANGE_MID_OFFSET].map(
      (y): PlanAction => ({
        command: 'add_flanged_hole',
        params: {
          id: '$escBracket',
          face: { near: [x0 + width / 2, y, WING_Z - 20] },
          center: [x0 + width / 2, y, WING_Z - 20],
          holeDiameter: 14,
          flangeHeight: 3,
          flangeAngle: 90,
          lipRadius: 1,
          direction: 'up',
        },
      }),
    ),
    {
      command: 'add_box',
      params: { size: [80, 46, 16], position: [x0 + 10, y0 + depth / 2 - 23, WING_Z - 1.6 - 16], anchor: 'min', color: '#22262b' },
      as: 'esc',
    },
    { command: 'set_entity_name', params: { id: '$esc', name: 'ESC 80 A', tags: ['systems'] } },
  ];
}

/** Aliases bound: wing, doubler, fitting, stator, bell, propeller, spinner, escBracket, esc. */
export function aerospaceGeometryActions(): PlanAction[] {
  return [...airframeActions(), ...fittingActions(), ...propulsionActions(), ...systemsActions()];
}
