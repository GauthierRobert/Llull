/** Light planar four-bar (crank 40 mm, coupler 120 mm, rocker 80 mm, ground 100 mm; links of 30-60 g) driven at 60 rpm; build_project actions. */
export const lightFourBarActions: Record<string, unknown>[] = [
  { command: 'add_box', params: { size: [40.0, 10, 10], position: [10.0, 17.320508076, 0], rotation: [0, 0, 1.047197551] }, as: 'crankL' },
  {
    command: 'add_box',
    params: { size: [120.0, 8, 8], position: [76.940482998, 53.556126406, 0], rotation: [0, 0, 0.320722012] },
    as: 'coupL',
  },
  {
    command: 'add_box',
    params: { size: [80.0, 10, 10], position: [116.940482998, 36.23561833, 0], rotation: [0, 0, 1.133477573] },
    as: 'rockL',
  },
  { command: 'add_rigid_body', params: { id: 'crank', entityIds: ['$crankL'] } },
  { command: 'add_rigid_body', params: { id: 'coupler', entityIds: ['$coupL'] } },
  { command: 'add_rigid_body', params: { id: 'rocker', entityIds: ['$rockL'] } },
  { command: 'add_body_joint', params: { id: 'jA', kind: 'revolute', child: 'crank', anchor: [0, 0, 0], axis: [0, 0, 1], initialRpm: 60 } },
  {
    command: 'add_body_joint',
    params: { id: 'jB', kind: 'revolute', parent: 'crank', child: 'coupler', anchor: [20.0, 34.641016151, 0], axis: [0, 0, 1] },
  },
  { command: 'add_body_joint', params: { id: 'jD', kind: 'revolute', child: 'rocker', anchor: [100.0, 0, 0], axis: [0, 0, 1] } },
  {
    command: 'add_body_joint',
    params: { id: 'jC', kind: 'spherical', parent: 'coupler', child: 'rocker', anchor: [133.880965996, 72.471236661, 0] },
  },
  { command: 'add_motor', params: { id: 'mot', joint: 'jA', kind: 'speed', rpm: 60, maxTorque: 50 } },
];

/** The same four-bar with a longer crank (non-Grashof: the crank cannot turn through a full revolution), motor 60 rpm limited to 50 N·m. */
export const nonGrashofFourBarActions: Record<string, unknown>[] = [
  { command: 'set_dynamics_solver', params: { timestepS: 5e-5 } },
  { command: 'add_box', params: { size: [60.0, 10, 10], position: [15.0, 25.980762114, 0], rotation: [0, 0, 1.047197551] }, as: 'crankL' },
  {
    command: 'add_box',
    params: { size: [120.0, 8, 8], position: [87.86355352, 36.093027953, 0], rotation: [0, 0, -0.267659433] },
    as: 'coupL',
  },
  {
    command: 'add_box',
    params: { size: [50.0, 10, 10], position: [122.86355352, 10.11226584, 0], rotation: [0, 0, 0.416421799] },
    as: 'rockL',
  },
  { command: 'add_rigid_body', params: { id: 'crank', entityIds: ['$crankL'] } },
  { command: 'add_rigid_body', params: { id: 'coupler', entityIds: ['$coupL'] } },
  { command: 'add_rigid_body', params: { id: 'rocker', entityIds: ['$rockL'] } },
  { command: 'add_body_joint', params: { id: 'jA', kind: 'revolute', child: 'crank', anchor: [0, 0, 0], axis: [0, 0, 1], initialRpm: 60 } },
  {
    command: 'add_body_joint',
    params: { id: 'jB', kind: 'revolute', parent: 'crank', child: 'coupler', anchor: [30.0, 51.961524227, 0], axis: [0, 0, 1] },
  },
  { command: 'add_body_joint', params: { id: 'jD', kind: 'revolute', child: 'rocker', anchor: [100.0, 0, 0], axis: [0, 0, 1] } },
  {
    command: 'add_body_joint',
    params: { id: 'jC', kind: 'spherical', parent: 'coupler', child: 'rocker', anchor: [145.727107041, 20.22453168, 0] },
  },
  { command: 'add_motor', params: { id: 'mot', joint: 'jA', kind: 'speed', rpm: 60, maxTorque: 50 } },
];
