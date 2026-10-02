/**
 * @layer ui/panels/building
 *
 * Declarative form specs for the industrial (steel hall / plant) tools: each maps form values to
 * ONE command + params (param-gathering only, react R1).
 */

import { STEEL_PROFILES } from '@core/commands/building/steel/profiles';
import {
  FieldReader,
  num,
  onLevel,
  result,
  type ElementTool,
  type ToolField,
} from './elementTools';

const GROUP = 'Industrial / steel';

const ALL_PROFILES: ReadonlyArray<readonly [string, string]> = STEEL_PROFILES.map(
  (profile): readonly [string, string] => [
    profile.name,
    `${profile.name} · ${profile.massPerMetre} kg/m`,
  ],
);

const I_PROFILES = ALL_PROFILES.filter(([name]) => /^(IPE|HEA|HEB)/.test(name));

function profileField(key: string, label: string, defaultValue: string, iOnly = false): ToolField {
  return {
    key,
    label,
    kind: 'select',
    defaultValue,
    options: iOnly ? I_PROFILES : ALL_PROFILES,
  };
}

const degrees = (value: number): number => (value * Math.PI) / 180;

export const INDUSTRIAL_TOOLS: ReadonlyArray<ElementTool> = [
  {
    id: 'hall',
    label: 'Steel portal hall',
    group: GROUP,
    fields: [
      num('x', 'Origin X', '0'),
      num('y', 'Origin Y', '0'),
      num('span', 'Span (X)', '24000'),
      { key: 'spans', label: 'Multi-span widths', kind: 'text', defaultValue: '' },
      num('length', 'Length (Y)', '48000'),
      num('baySpacing', 'Bay spacing', '6000'),
      num('eaveHeight', 'Eave height', '7000'),
      num('roofPitch', 'Roof pitch (°)', '6'),
      {
        key: 'roofType',
        label: 'Roof type',
        kind: 'select',
        defaultValue: 'duopitch',
        options: [
          ['duopitch', 'Duopitch'],
          ['monopitch', 'Monopitch (low eaves left)'],
        ],
      },
      profileField('columnProfile', 'Columns', 'HEA400', true),
      profileField('rafterProfile', 'Rafters', 'IPE450', true),
      num('craneRailHeight', 'Crane rail height', '', true),
      num('craneCapacity', 'Crane capacity (t)', '10'),
      { key: 'cladding', label: 'Roof & wall cladding', kind: 'checkbox', defaultValue: 'true' },
      { key: 'footings', label: 'Pad footings', kind: 'checkbox', defaultValue: 'true' },
      { key: 'basePlates', label: 'Base plates + anchors', kind: 'checkbox', defaultValue: 'true' },
      {
        key: 'columnBase',
        label: 'Column bases',
        kind: 'select',
        defaultValue: 'pinned',
        options: [
          ['pinned', 'Pinned'],
          ['fixed', 'Fixed (moment bases)'],
        ],
      },
      { key: 'connections', label: 'Moment connections', kind: 'checkbox', defaultValue: 'true' },
      { key: 'floorSlab', label: 'Ground slab', kind: 'checkbox', defaultValue: 'true' },
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      const railHeight = reader.optionalNumber('craneRailHeight');
      return result(reader, 'add_portal_frame_building', {
        origin: [reader.number('x'), reader.number('y')],
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
      {
        key: 'role',
        label: 'Role',
        kind: 'select',
        defaultValue: 'beam',
        options: [
          ['column', 'Column'],
          ['beam', 'Beam'],
          ['rafter', 'Rafter'],
          ['brace', 'Brace'],
          ['purlin', 'Purlin'],
          ['rail', 'Side rail'],
          ['crane', 'Crane beam'],
        ],
      },
      profileField('profile', 'Profile', 'IPE300'),
      num('x1', 'Start X', '0'),
      num('y1', 'Start Y', '0'),
      num('z1', 'Start Z', '4000'),
      num('x2', 'End X', '6000'),
      num('y2', 'End Y', '0'),
      num('z2', 'End Z', '4000'),
      num('roll', 'Roll (°)', '0'),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      return result(reader, 'add_steel_member', {
        role: reader.text('role'),
        profile: reader.text('profile'),
        start: [reader.number('x1'), reader.number('y1'), reader.number('z1')],
        end: [reader.number('x2'), reader.number('y2'), reader.number('z2')],
        roll: degrees(reader.number('roll')),
        ...onLevel(context),
      });
    },
  },
  {
    id: 'footing',
    label: 'Pad footing',
    group: GROUP,
    fields: [
      { key: 'underColumns', label: 'Under every column', kind: 'checkbox', defaultValue: 'true' },
      num('x', 'X', '0', true),
      num('y', 'Y', '0', true),
      num('width', 'Width', '1500'),
      num('thickness', 'Thickness', '600'),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      const placement = reader.flag('underColumns')
        ? { underColumns: true }
        : { location: [reader.number('x'), reader.number('y')] };
      return result(reader, 'add_footing', {
        ...placement,
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
      {
        key: 'corners',
        label: 'Corners x,y,z; …',
        kind: 'text',
        defaultValue: '0,0,0; 6000,0,0; 6000,0,4000; 0,0,4000',
      },
      {
        key: 'role',
        label: 'Role',
        kind: 'select',
        defaultValue: 'wall',
        options: [
          ['wall', 'Wall'],
          ['roof', 'Roof'],
        ],
      },
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
        start: [reader.number('x1'), reader.number('y1')],
        end: [reader.number('x2'), reader.number('y2')],
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
      { key: 'name', label: 'Name', kind: 'text', defaultValue: 'Machine' },
      num('x', 'Centre X', '6000'),
      num('y', 'Centre Y', '6000'),
      num('length', 'Length', '3000'),
      num('width', 'Width', '2000'),
      num('height', 'Height', '2000'),
      num('angle', 'Rotation (°)', '0'),
      num('clearance', 'Clearance', '800'),
      num('weight', 'Weight (kg)', '', true),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      if (reader.text('name') === '') return { ok: false, reason: 'Equipment needs a name.' };
      return result(reader, 'add_equipment', {
        name: reader.text('name'),
        location: [reader.number('x'), reader.number('y')],
        size: [reader.number('length'), reader.number('width'), reader.number('height')],
        angle: degrees(reader.number('angle')),
        clearance: reader.number('clearance'),
        weight: reader.optionalNumber('weight'),
        ...onLevel(context),
      });
    },
  },
  {
    id: 'pipe',
    label: 'Pipe run',
    group: GROUP,
    fields: [
      {
        key: 'points',
        label: 'Route x,y,z; …',
        kind: 'text',
        defaultValue: '2000,3000,4000; 20000,3000,4000',
      },
      num('diameter', 'Outside Ø', '114.3'),
      { key: 'service', label: 'Service', kind: 'text', defaultValue: 'compressed air' },
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      return result(reader, 'add_pipe_run', {
        points: reader.pointList('points', 2),
        diameter: reader.number('diameter'),
        service: reader.text('service') || undefined,
        ...onLevel(context),
      });
    },
  },
  {
    id: 'tray',
    label: 'Cable tray',
    group: GROUP,
    fields: [
      {
        key: 'points',
        label: 'Route x,y,z; …',
        kind: 'text',
        defaultValue: '2000,4000,5000; 20000,4000,5000',
      },
      num('width', 'Width', '300'),
      num('height', 'Side height', '60'),
      { key: 'system', label: 'System', kind: 'text', defaultValue: 'power' },
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      return result(reader, 'add_cable_tray', {
        points: reader.pointList('points', 2),
        width: reader.number('width'),
        height: reader.number('height'),
        system: reader.text('system') || undefined,
        ...onLevel(context),
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
