/**
 * PHY-21 reference engine (validation/README §4, VC-FPR-24): the single-cylinder demonstrator — one cylinder of the Rotax 912 (bore 84,
 * stroke 61 = crank radius 30.5, rod 130 mm unverified [E-R8], CR 10.8), crankcase main bearing, crankshaft (journal, web, crank pin),
 * connecting rod with big- and small-end bores, piston with its wrist pin, 21/51 reduction at eta 0.99 to a two-blade propeller with real
 * blade thickness, al_4032 piston and steel_4340 crank / rod / pin, Chen-Flynn losses (test constants, stated source) and a single-zone
 * cylinder calibrated to the per-cylinder brake share of the rated point (BMEP 11.2477 bar at 5800 rpm). Every pin sits in a bore with a
 * 0.02 mm diametral clearance; the faceted kernels see pin and bore overlap, so each pair is declared with allow_interference.
 * Lengths in mm; the crank turns about +Z, the piston travels along +X, the propeller turns about +Z at z = 600.
 */
/** One build_project action (structurally a GoldenAction; not imported to keep plans.ts free of an import cycle). */
interface PlanAction {
  readonly command: string;
  readonly params: Record<string, unknown>;
  readonly as?: string;
}

const PIN_Z = 10;
const CRANK_RADIUS = 30.5;
const WRIST_X = CRANK_RADIUS + 130;
const CLEARANCE_RADIAL = 0.01;

export const referenceEnginePlan: PlanAction[] = [
  // crankcase: main bearing block with its bore
  { command: 'add_box', params: { size: [60, 60, 20], position: [0, 0, -50] }, as: 'blockBlank' },
  {
    command: 'add_cylinder',
    params: { radius: 15 + CLEARANCE_RADIAL, height: 30, axis: [0, 0, 1], position: [0, 0, -50] },
    as: 'mainBore',
  },
  { command: 'boolean', params: { op: 'subtract', a: '$blockBlank', b: '$mainBore' }, as: 'crankcase' },
  // crankshaft: main journal, web, crank pin
  { command: 'add_cylinder', params: { radius: 15, height: 50, axis: [0, 0, 1], position: [0, 0, -35] }, as: 'journal' },
  { command: 'add_cylinder', params: { radius: 50, height: 10, axis: [0, 0, 1], position: [0, 0, -5] }, as: 'web' },
  { command: 'add_cylinder', params: { radius: 10, height: 20, axis: [0, 0, 1], position: [CRANK_RADIUS, 0, PIN_Z] }, as: 'crankPin' },
  // connecting rod with the big-end and small-end bores
  { command: 'add_box', params: { size: [158, 32, 16], position: [93.5, 0, PIN_Z] }, as: 'rodBlank' },
  {
    command: 'add_cylinder',
    params: { radius: 10 + CLEARANCE_RADIAL, height: 30, axis: [0, 0, 1], position: [CRANK_RADIUS, 0, PIN_Z] },
    as: 'bigEndBore',
  },
  { command: 'boolean', params: { op: 'subtract', a: '$rodBlank', b: '$bigEndBore' }, as: 'rodBigEnd' },
  {
    command: 'add_cylinder',
    params: { radius: 8 + CLEARANCE_RADIAL, height: 30, axis: [0, 0, 1], position: [WRIST_X, 0, PIN_Z] },
    as: 'smallEndBore',
  },
  { command: 'boolean', params: { op: 'subtract', a: '$rodBigEnd', b: '$smallEndBore' }, as: 'rod' },
  // piston (bore 84) and wrist pin
  { command: 'add_cylinder', params: { radius: 8, height: 20, axis: [0, 0, 1], position: [WRIST_X, 0, PIN_Z] }, as: 'wristPin' },
  { command: 'add_cylinder', params: { radius: 42, height: 50, axis: [1, 0, 0], position: [WRIST_X + 50, 0, PIN_Z] }, as: 'piston' },
  // propeller: hub and two blades of real thickness
  { command: 'add_cylinder', params: { radius: 40, height: 40, axis: [0, 0, 1], position: [0, 0, 600] }, as: 'hub' },
  { command: 'add_box', params: { size: [1750, 120, 12], position: [0, 0, 600] }, as: 'blades' },
  // materials [E-R31][E-R32]
  { command: 'assign_material', params: { materialName: 'steel_4340', entityIds: ['$journal', '$web', '$crankPin', '$rod', '$wristPin'] } },
  { command: 'assign_material', params: { materialName: 'al_4032', entityIds: ['$piston'] } },
  // rigid bodies and joints
  { command: 'add_rigid_body', params: { entityIds: ['$crankcase'], fixed: true, massKg: 5, id: 'crankcase' } },
  { command: 'add_rigid_body', params: { entityIds: ['$journal', '$web', '$crankPin'], id: 'crank' } },
  { command: 'add_rigid_body', params: { entityIds: ['$rod'], id: 'rod' } },
  { command: 'add_rigid_body', params: { entityIds: ['$wristPin', '$piston'], id: 'piston' } },
  { command: 'add_rigid_body', params: { entityIds: ['$hub', '$blades'], massKg: 2, id: 'prop' } },
  {
    command: 'add_body_joint',
    params: { id: 'crank_j', kind: 'revolute', child: 'crank', parent: 'crankcase', anchor: [0, 0, 0], axis: [0, 0, 1], initialRpm: 5800 },
  },
  {
    command: 'add_body_joint',
    params: { id: 'rod_j', kind: 'revolute', child: 'rod', parent: 'crank', anchor: [CRANK_RADIUS, 0, PIN_Z], axis: [0, 0, 1] },
  },
  { command: 'add_body_joint', params: { id: 'wrist_j', kind: 'spherical', child: 'piston', parent: 'rod', anchor: [WRIST_X, 0, PIN_Z] } },
  {
    command: 'add_body_joint',
    params: { id: 'slide_j', kind: 'prismatic', child: 'piston', parent: 'crankcase', anchor: [WRIST_X, 0, PIN_Z], axis: [1, 0, 0] },
  },
  {
    command: 'add_body_joint',
    params: { id: 'prop_j', kind: 'revolute', child: 'prop', anchor: [0, 0, 600], axis: [0, 0, 1], initialRpm: (5800 * 21) / 51 },
  },
  { command: 'add_gear_coupling', params: { id: 'reduction', driver: 'crank_j', driven: 'prop_j', teeth: [21, 51], efficiency: 0.99 } },
  { command: 'add_motor', params: { joint: 'crank_j', kind: 'speed', rpm: 5800, maxTorque: 1e6 } },
  // pins in bores: the faceted tessellation of a 0.02 mm fit overlaps, so each fit is declared
  {
    command: 'allow_interference',
    params: { a: '$crankPin', b: '$rod', kind: 'overlap_by_design', reason: 'crank pin in the big-end bore, 0.02 mm diametral clearance' },
  },
  {
    command: 'allow_interference',
    params: {
      a: '$wristPin',
      b: '$rod',
      kind: 'overlap_by_design',
      reason: 'wrist pin in the small-end bore, 0.02 mm diametral clearance',
    },
  },
  {
    command: 'allow_interference',
    params: {
      a: '$journal',
      b: '$crankcase',
      kind: 'overlap_by_design',
      reason: 'main journal in the main bearing bore, 0.02 mm diametral clearance',
    },
  },
  // engine model: losses, calibrated cylinder, propeller, reference
  {
    command: 'set_engine_losses',
    params: {
      crank: 'crank_j',
      model: {
        kind: 'chen_flynn',
        aPa: 40000,
        bRatio: 0.005,
        cPaPerRpm: 5,
        dPaPerRpm2: 0.0000015,
        source: 'test input (not measured data)',
      },
    },
  },
  {
    command: 'add_cylinder_pressure',
    params: {
      piston: 'slide_j',
      crank: 'crank_j',
      boreMm: 84,
      compressionRatio: 10.8,
      model: {
        kind: 'single_zone',
        burn: { ca50Deg: 9, durationDeg: 50, a: 5, m: 2 },
        intakePressurePa: 95000,
        intakeTempK: 330,
        heat: { kind: 'calibrate_brake', brake: [{ rpm: 5800, brakeTorqueNm: 121.012637765 }], cylinderCount: 4 },
        source: 'test input',
      },
    },
  },
  {
    command: 'add_propeller',
    params: {
      joint: 'prop_j',
      diameter: 1.75,
      thrustCoefficient: 0.1,
      powerCoefficient: 0.05,
      airspeedMps: 20,
      inertiaKgM2: 0.25,
      table: {
        points: [
          [0, 0.1, 0.05],
          [0.4, 0.08, 0.055],
          [0.8, 0.02, 0.04],
        ],
        source: 'synthetic test table',
        grade: 'C',
      },
    },
  },
  {
    command: 'add_reference_data',
    params: {
      id: 'rated_point',
      quantity: 'bmep_bar',
      condition: { throttle: 'full', altitudeM: 0 },
      points: [{ rpm: 5800, value: 11.2477 }],
      source: 'Rotax 912 ULS datasheet, 73.5 kW at 5800 rpm [C-R23]',
      grade: 'B',
      calibrationRpm: [5800],
    },
  },
];
