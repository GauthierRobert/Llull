/**
 * @layer ui/panels/building
 *
 * Declarative form specs for the industrial (steel hall / plant) tools: each maps form values to
 * ONE command + params (param-gathering only, react R1).
 */

import { PIPE_OUTSIDE_DIAMETER_MM } from '@aec/industrial/pipeSizes';
import { PIPE_SUPPORT_TOOL } from './pipeSupportTool';
import {
  ALL_PROFILES,
  BASE_OPTIONS as BASES,
  I_PROFILES,
  JOINT_OPTIONS as JOINTS,
  MEMBER_ROLE_OPTIONS,
} from './steelProfileOptions';
import {
  FieldReader,
  INDUSTRIAL_TOOL_GROUP as GROUP,
  checkbox,
  defaultedSelect,
  levelField,
  num,
  onLevel,
  placement,
  radians,
  result,
  select,
  txt,
  type ElementTool,
  type ToolField,
} from './elementToolForm';

function profileField(key: string, label: string, defaultValue: string, iOnly = false): ToolField {
  return select(key, label, defaultValue, iOnly ? I_PROFILES : ALL_PROFILES);
}

const DN_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['', 'Custom Ø (enter below)'],
  ...Object.entries(PIPE_OUTSIDE_DIAMETER_MM).map(([dn, diameter]): readonly [string, string] => [
    dn,
    `DN${dn} · Ø${diameter}`,
  ]),
];

const BEAM_ONLY = { key: 'role', values: ['beam'] } as const;
const COLUMN_ONLY = { key: 'role', values: ['column'] } as const;

export const INDUSTRIAL_TOOLS: ReadonlyArray<ElementTool> = [
  {
    id: 'hall',
    label: 'Steel portal hall',
    group: GROUP,
    fields: [
      num('x', 'Origin X', '0'),
      num('y', 'Origin Y', '0'),
      num('span', 'Span (X)', '24000'),
      txt('spans', 'Multi-span widths'),
      num('length', 'Length (Y)', '48000'),
      num('baySpacing', 'Bay spacing', '6000'),
      num('eaveHeight', 'Eave height', '7000'),
      num('roofPitch', 'Roof pitch (°)', '6'),
      select('roofType', 'Roof type', 'duopitch', [
        ['duopitch', 'Duopitch'],
        ['monopitch', 'Monopitch (low eaves left)'],
      ]),
      profileField('columnProfile', 'Columns', 'HEA400', true),
      profileField('rafterProfile', 'Rafters', 'IPE450', true),
      num('craneRailHeight', 'Crane rail height', '', true),
      num('craneCapacity', 'Crane capacity (t)', '10'),
      checkbox('cladding', 'Roof & wall cladding', true),
      checkbox('footings', 'Pad footings', true),
      checkbox('basePlates', 'Base plates + anchors', true),
      select('columnBase', 'Column bases', 'pinned', [
        ['pinned', 'Pinned'],
        ['fixed', 'Fixed (moment bases)'],
      ]),
      checkbox('connections', 'Moment connections', true),
      checkbox('floorSlab', 'Ground slab', true),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      const railHeight = reader.optionalNumber('craneRailHeight');
      return result(reader, 'add_portal_frame_building', {
        origin: reader.point('x', 'y'),
        ...(reader.text('spans') === ''
          ? { span: reader.number('span') }
          : { spans: reader.numberList('spans') }),
        length: reader.number('length'),
        baySpacing: reader.number('baySpacing'),
        eaveHeight: reader.number('eaveHeight'),
        roofPitch: reader.number('roofPitch'),
        roofType: reader.text('roofType'),
        columnProfile: reader.text('columnProfile'),
        rafterProfile: reader.text('rafterProfile'),
        crane:
          railHeight === undefined
            ? undefined
            : { railHeight, capacity: reader.number('craneCapacity') },
        cladding: reader.flag('cladding'),
        footings: reader.flag('footings'),
        basePlates: reader.flag('basePlates'),
        columnBase: reader.text('columnBase'),
        connections: reader.flag('connections'),
        floorSlab: reader.flag('floorSlab'),
        ...onLevel(context),
      });
    },
  },
  {
    id: 'member',
    label: 'Steel member',
    group: GROUP,
    fields: [
      select('role', 'Role', 'beam', MEMBER_ROLE_OPTIONS),
      profileField('profile', 'Profile', 'IPE300'),
      num('x1', 'Start X', '0'),
      num('y1', 'Start Y', '0'),
      num('z1', 'Start Z', '4000'),
      num('x2', 'End X', '6000'),
      num('y2', 'End Y', '0'),
      num('z2', 'End Z', '4000'),
      num('roll', 'Roll (°)', '0'),
      defaultedSelect('startJoint', 'Start joint', 'Default (pinned)', JOINTS, BEAM_ONLY),
      defaultedSelect('endJoint', 'End joint', 'Default (pinned)', JOINTS, BEAM_ONLY),
      defaultedSelect(
        'baseFixity',
        'Base fixity',
        'Default (pinned / base plate)',
        BASES,
        COLUMN_ONLY,
      ),
      levelField(),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      const role = reader.text('role');
      const joint = (key: string): string | undefined =>
        role === 'beam' ? reader.text(key) || undefined : undefined;
      return result(reader, 'add_steel_member', {
        role: reader.text('role'),
        profile: reader.text('profile'),
        start: [reader.number('x1'), reader.number('y1'), reader.number('z1')],
        end: [reader.number('x2'), reader.number('y2'), reader.number('z2')],
        roll: radians(reader.number('roll')),
        startJoint: joint('startJoint'),
        endJoint: joint('endJoint'),
        baseFixity: role === 'column' ? reader.text('baseFixity') || undefined : undefined,
        ...placement(reader, context),
      });
    },
  },
  {
    id: 'footing',
    label: 'Pad footing',
    group: GROUP,
    fields: [
      checkbox('underColumns', 'Under every column', true),
      num('x', 'X', '0', true),
      num('y', 'Y', '0', true),
      num('width', 'Width', '1500'),
      num('thickness', 'Thickness', '600'),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      const position = reader.flag('underColumns')
        ? { underColumns: true }
        : { location: reader.point('x', 'y') };
      return result(reader, 'add_footing', {
        ...position,
        width: reader.number('width'),
        thickness: reader.number('thickness'),
        ...onLevel(context),
      });
    },
  },
  {
    id: 'panel',
    label: 'Cladding panel',
    group: GROUP,
    fields: [
      txt('corners', 'Corners x,y,z; …', '0,0,0; 6000,0,0; 6000,0,4000; 0,0,4000'),
      select('role', 'Role', 'wall', [
        ['wall', 'Wall'],
        ['roof', 'Roof'],
      ]),
      num('thickness', 'Thickness', '80'),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      return result(reader, 'add_panel', {
        corners: reader.pointList('corners', 3),
        role: reader.text('role'),
        thickness: reader.number('thickness'),
        ...onLevel(context),
      });
    },
  },
  {
    id: 'craneRunway',
    label: 'Crane runway',
    group: GROUP,
    fields: [
      num('x1', 'Start X', '1000'),
      num('y1', 'Start Y', '0'),
      num('x2', 'End X', '1000'),
      num('y2', 'End Y', '48000'),
      num('railHeight', 'Rail height', '5000'),
      num('capacity', 'Capacity (t)', '10'),
      profileField('profile', 'Runway beam', 'HEB300', true),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      return result(reader, 'add_crane_runway', {
        start: reader.point('x1', 'y1'),
        end: reader.point('x2', 'y2'),
        railHeight: reader.number('railHeight'),
        capacity: reader.number('capacity'),
        profile: reader.text('profile'),
        ...onLevel(context),
      });
    },
  },
  {
    id: 'equipment',
    label: 'Machine / equipment',
    group: GROUP,
    fields: [
      txt('mark', 'Tag (E-301…)', '', true),
      txt('name', 'Name', 'Machine'),
      num('x', 'Centre X', '6000'),
      num('y', 'Centre Y', '6000'),
      num('length', 'Length', '3000'),
      num('width', 'Width', '2000'),
      num('height', 'Height', '2000'),
      num('angle', 'Rotation (°)', '0'),
      num('clearance', 'Clearance', '800'),
      num('weight', 'Weight (kg)', '', true),
      levelField(),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      if (reader.text('name') === '') return { ok: false, reason: 'Equipment needs a name.' };
      return result(reader, 'add_equipment', {
        mark: reader.text('mark') || undefined,
        name: reader.text('name'),
        location: reader.point('x', 'y'),
        size: [reader.number('length'), reader.number('width'), reader.number('height')],
        angle: radians(reader.number('angle')),
        clearance: reader.number('clearance'),
        weight: reader.optionalNumber('weight'),
        ...placement(reader, context),
      });
    },
  },
  {
    id: 'pipe',
    label: 'Pipe run',
    group: GROUP,
    fields: [
      txt('points', 'Route x,y,z; …', '2000,3000,4000; 20000,3000,4000'),
      txt('line', 'Line number (L-101…)', '', true),
      select('dn', 'Nominal size', '100', DN_OPTIONS),
      num('diameter', 'Outside Ø (overrides DN)', '', true),
      txt('from', 'From (tag / tie-in)', '', true),
      txt('to', 'To (tag / tie-in)', '', true),
      txt('service', 'Service', 'compressed air'),
      levelField(),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      const dn = reader.text('dn');
      const diameter = reader.optionalNumber('diameter');
      if (dn === '' && diameter === undefined) {
        return { ok: false, reason: 'Pick a nominal size or give the outside Ø.' };
      }
      return result(reader, 'add_pipe_run', {
        points: reader.pointList('points', 2),
        line: reader.text('line') || undefined,
        dn: dn === '' ? undefined : Number(dn),
        diameter,
        from: reader.text('from') || undefined,
        to: reader.text('to') || undefined,
        service: reader.text('service') || undefined,
        ...placement(reader, context),
      });
    },
  },
  PIPE_SUPPORT_TOOL,
  {
    id: 'tray',
    label: 'Cable tray',
    group: GROUP,
    fields: [
      txt('points', 'Route x,y,z; …', '2000,4000,5000; 20000,4000,5000'),
      num('width', 'Width', '300'),
      num('height', 'Side height', '60'),
      txt('system', 'System', 'power'),
      levelField(),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      return result(reader, 'add_cable_tray', {
        points: reader.pointList('points', 2),
        width: reader.number('width'),
        height: reader.number('height'),
        system: reader.text('system') || undefined,
        ...placement(reader, context),
      });
    },
  },
  {
    id: 'basePlates',
    label: 'Base plates',
    group: GROUP,
    fields: [
      num('thickness', 'Thickness', '', true),
      num('margin', 'Overhang', '100'),
      num('boltCount', 'Anchor bolts', '4'),
      num('boltDiameter', 'Bolt Ø', '24'),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      return result(reader, 'add_base_plates', {
        thickness: reader.optionalNumber('thickness'),
        margin: reader.number('margin'),
        boltCount: reader.number('boltCount'),
        boltDiameter: reader.number('boltDiameter'),
        ...onLevel(context),
      });
    },
  },
  {
    id: 'connections',
    label: 'Moment connections',
    group: GROUP,
    fields: [
      num('plateThickness', 'End plate t', '', true),
      num('boltDiameter', 'Bolt Ø', '20'),
      num('haunchLength', 'Haunch length', '', true),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      return result(reader, 'add_moment_connections', {
        plateThickness: reader.optionalNumber('plateThickness'),
        boltDiameter: reader.number('boltDiameter'),
        haunchLength: reader.optionalNumber('haunchLength'),
        ...onLevel(context),
      });
    },
  },
];
