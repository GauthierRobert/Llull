/**
 * @layer ui/panels/building
 *
 * Declarative form specs for the building element tools: each tool maps form values to ONE
 * command + params (param-gathering only — the command does all document work, react R1).
 */

import { toRadians } from '@lib/angle';
import {
  FieldReader,
  checkbox,
  levelField,
  num,
  onLevel,
  placement,
  result,
  buildWith,
  select,
  txt,
  type ElementTool,
  type PlanExtent,
  type ToolField,
} from './elementToolForm';
import { GRID_FRAMING_TOOLS } from './gridFramingTools';

const MATERIALS: ReadonlyArray<readonly [string, string]> = [
  ['concrete', 'Concrete'],
  ['masonry', 'Masonry'],
  ['brick', 'Brick'],
  ['block', 'Concrete block'],
  ['timber', 'Timber'],
  ['steel', 'Steel'],
  ['gypsum', 'Gypsum board'],
];

/** Thickness / optional height / material fields shared by every wall tool. */
function wallSectionFields(thickness: string, material: string): ToolField[] {
  return [num('thickness', 'Thickness', thickness), num('height', 'Height', '', true), select('material', 'Material', material, MATERIALS)];
}

/** A wall tool: `geometry` fields + the shared section fields -> ONE `command` on the level. */
function wallTool(
  id: string,
  label: string,
  geometryFields: ToolField[],
  [thickness, material]: readonly [string, string],
  command: string,
  geometry: (reader: FieldReader) => Record<string, unknown>,
): ElementTool {
  return {
    id,
    label,
    fields: [...geometryFields, ...wallSectionFields(thickness, material)],
    build: buildWith(command, (reader, context) => ({
      ...geometry(reader),
      thickness: reader.number('thickness'),
      height: reader.optionalNumber('height'),
      material: reader.text('material'),
      ...onLevel(context),
    })),
  };
}

/** Host wall / offset / size shared by door and window; `null` when no host wall is picked. */
function hostedOpening(reader: FieldReader): {
  wallId: string;
  offset: number | undefined;
  width: number;
  height: number;
} | null {
  const wallId = reader.text('wallId');
  if (wallId === '') return null;
  return {
    wallId,
    offset: reader.optionalNumber('offset'),
    width: reader.number('width'),
    height: reader.number('height'),
  };
}

/** Door / window: host wall + offset / size fields, then `extra` params; needs a host wall. */
function hostedOpeningTool(
  id: string,
  label: string,
  [width, height]: readonly [string, string],
  extraFields: ToolField[],
  command: string,
  extra: (reader: FieldReader) => Record<string, unknown>,
): ElementTool {
  return {
    id,
    label,
    fields: [
      select('wallId', 'Host wall', '', 'hosts'),
      num('offset', 'Offset from start', '', true),
      num('width', 'Width', width),
      num('height', 'Height', height),
      ...extraFields,
    ],
    build: (values) => {
      const reader = new FieldReader(values);
      const opening = hostedOpening(reader);
      if (opening === null) return { ok: false, reason: 'Pick a host wall first.' };
      return result(reader, command, { ...opening, ...extra(reader) });
    },
  };
}

function corners([x1, y1, x2, y2]: PlanExtent): Array<[number, number]> {
  return [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ];
}

function rectangle(reader: FieldReader): Array<[number, number]> {
  return corners([...reader.point('x1', 'y1'), ...reader.point('x2', 'y2')]);
}

const RECTANGLE_FIELDS = [num('x1', 'X1', '0'), num('y1', 'Y1', '0'), num('x2', 'X2', '5000'), num('y2', 'Y2', '4000')];

/** Slab / room outline: the level's walls, or the form's rectangle. */
function outline(
  reader: FieldReader,
  wallIds: ReadonlyArray<string>,
  gridExtent: PlanExtent | null = null,
): { wallIds: string[] } | { boundary: Array<[number, number]> } | null {
  const source = reader.text('source');
  if (source === 'walls') return { wallIds: [...wallIds] };
  if (source !== 'grid') return { boundary: rectangle(reader) };
  return gridExtent === null ? null : { boundary: corners(gridExtent) };
}

export const ELEMENT_TOOLS: ReadonlyArray<ElementTool> = [
  {
    id: 'grid',
    label: 'Structural grid',
    fields: [
      txt('xSpacings', 'X bay spans ({unit}, comma-separated)', '6000, 6000'),
      txt('ySpacings', 'Y bay spans ({unit}, comma-separated)', '5000'),
    ],
    build: buildWith('add_grid_system', (reader) => ({
      xSpacings: reader.numberList('xSpacings'),
      ySpacings: reader.numberList('ySpacings'),
    })),
  },
  ...GRID_FRAMING_TOOLS,
  wallTool(
    'perimeter',
    'Perimeter walls',
    [num('x1', 'X1', '0'), num('y1', 'Y1', '0'), num('x2', 'X2', '10000'), num('y2', 'Y2', '8000')],
    ['300', 'masonry'],
    'draw_walls',
    (reader) => ({ points: rectangle(reader), closed: true }),
  ),
  wallTool(
    'wall',
    'Wall',
    [num('x1', 'Start X', '0'), num('y1', 'Start Y', '0'), num('x2', 'End X', '5000'), num('y2', 'End Y', '0')],
    ['200', 'concrete'],
    'draw_walls',
    (reader) => ({ points: [reader.point('x1', 'y1'), reader.point('x2', 'y2')] }),
  ),
  wallTool(
    'curvedWall',
    'Curved wall',
    [
      num('x1', 'Start X', '0'),
      num('y1', 'Start Y', '0'),
      num('xm', 'Through X', '3000'),
      num('ym', 'Through Y', '1500'),
      num('x2', 'End X', '6000'),
      num('y2', 'End Y', '0'),
    ],
    ['200', 'concrete'],
    'add_curved_wall',
    (reader) => ({
      start: reader.point('x1', 'y1'),
      through: reader.point('xm', 'ym'),
      end: reader.point('x2', 'y2'),
    }),
  ),
  {
    id: 'wallLayers',
    label: 'Wall build-up',
    fields: [
      checkbox('allWalls', 'Every wall of the level', true),
      select('wallId', 'Wall', '', 'walls'),
      txt('layers', 'Layers (outside → inside)', '20 render finish; 120 mineral-wool insulation; 200 concrete structure; 13 gypsum finish'),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      const wallIds = reader.flag('allWalls') ? [...context.wallIds] : reader.text('wallId') === '' ? [] : [reader.text('wallId')];
      if (wallIds.length === 0) return { ok: false, reason: 'Pick a wall first.' };
      const layers = reader
        .text('layers')
        .split(';')
        .map((part) => part.trim().split(/\s+/))
        .filter((words) => words.length >= 2)
        .map(([thickness, material, fn]) => ({
          thickness: Number(thickness),
          material: material ?? '',
          function: fn ?? 'structure',
        }));
      if (layers.length === 0 || layers.some((layer) => !(layer.thickness > 0)))
        return { ok: false, reason: 'Check: layers ("thickness material function; …")' };
      return result(reader, 'set_wall_layers', { wallIds, layers });
    },
  },
  hostedOpeningTool(
    'door',
    'Door',
    ['900', '2100'],
    [
      select('swing', 'Hinge', 'left', [
        ['left', 'Left'],
        ['right', 'Right'],
      ]),
    ],
    'add_door',
    (reader) => ({ swing: reader.text('swing') }),
  ),
  hostedOpeningTool('window', 'Window', ['1200', '1200'], [num('sillHeight', 'Sill height', '900')], 'add_window', (reader) => ({
    sillHeight: reader.number('sillHeight'),
  })),
  {
    id: 'slab',
    label: 'Slab / roof',
    fields: [
      select('source', 'Outline', 'walls', [
        ['walls', 'Enclosed by level walls'],
        ['grid', 'Grid extent (min/max of grid lines)'],
        ['rectangle', 'Rectangle'],
      ]),
      ...RECTANGLE_FIELDS,
      num('thickness', 'Thickness', '200'),
      num('offset', 'Top offset', '0'),
      select('role', 'Role', 'floor', [
        ['floor', 'Floor'],
        ['roof', 'Roof'],
        ['foundation', 'Foundation'],
      ]),
      txt('material', 'Material (concrete, grating…)', '', true),
      levelField(),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      const shape = outline(reader, context.wallIds, context.gridExtent ?? null);
      if (shape === null) return { ok: false, reason: 'No structural grid to take the extent from.' };
      return result(reader, 'add_slab', {
        ...shape,
        thickness: reader.number('thickness'),
        offset: reader.number('offset'),
        role: reader.text('role'),
        material: reader.text('material') || undefined,
        ...placement(reader, context),
      });
    },
  },
  {
    id: 'slabOpening',
    label: 'Slab opening',
    fields: [
      select('source', 'Opening', 'stair', [
        ['stair', 'Stair well (slab above)'],
        ['rectangle', 'Rectangle in slab'],
      ]),
      select('stairId', 'Stair', '', 'stairs'),
      select('slabId', 'Slab', '', 'slabs'),
      num('x1', 'X1', '1000'),
      num('y1', 'Y1', '1000'),
      num('x2', 'X2', '3000'),
      num('y2', 'Y2', '2000'),
      num('margin', 'Margin', '100'),
    ],
    build: (values) => {
      const reader = new FieldReader(values);
      if (reader.text('source') === 'stair') {
        if (reader.text('stairId') === '') return { ok: false, reason: 'Pick a stair first.' };
        return result(reader, 'add_slab_opening', {
          stairId: reader.text('stairId'),
          margin: reader.number('margin'),
        });
      }
      if (reader.text('slabId') === '') return { ok: false, reason: 'Pick a slab first.' };
      return result(reader, 'add_slab_opening', {
        slabId: reader.text('slabId'),
        boundary: rectangle(reader),
      });
    },
  },
  {
    id: 'column',
    label: 'Column',
    fields: [
      checkbox('atGrid', 'At every grid intersection', false),
      num('x', 'X', '0', true),
      num('y', 'Y', '0', true),
      select('shape', 'Shape', 'rectangular', [
        ['rectangular', 'Rectangular'],
        ['circular', 'Circular'],
      ]),
      num('width', 'Width / Ø', '300'),
      levelField(),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      const position = reader.flag('atGrid') ? { atGridIntersections: true } : { location: reader.point('x', 'y') };
      return result(reader, 'add_column', {
        ...position,
        shape: reader.text('shape'),
        width: reader.number('width'),
        ...placement(reader, context),
      });
    },
  },
  {
    id: 'beam',
    label: 'Beam',
    fields: [
      num('x1', 'Start X', '0'),
      num('y1', 'Start Y', '0'),
      num('x2', 'End X', '6000'),
      num('y2', 'End Y', '0'),
      num('width', 'Width', '300'),
      num('depth', 'Depth', '500'),
      levelField(),
    ],
    build: buildWith('add_beam', (reader, context) => ({
      start: reader.point('x1', 'y1'),
      end: reader.point('x2', 'y2'),
      width: reader.number('width'),
      depth: reader.number('depth'),
      ...placement(reader, context),
    })),
  },
  {
    id: 'stair',
    label: 'Stair',
    fields: [
      num('x', 'Start X', '0'),
      num('y', 'Start Y', '0'),
      num('direction', 'Direction (°)', '0'),
      num('width', 'Width', '1000'),
      num('treadDepth', 'Tread', '280'),
      levelField(),
    ],
    build: buildWith('add_stair', (reader, context) => ({
      start: reader.point('x', 'y'),
      angle: toRadians(reader.number('direction')),
      width: reader.number('width'),
      treadDepth: reader.number('treadDepth'),
      ...placement(reader, context),
    })),
  },
  {
    id: 'room',
    label: 'Room',
    fields: [
      txt('name', 'Name', 'Room'),
      txt('number', 'Number'),
      select('source', 'Outline', 'rectangle', [
        ['rectangle', 'Rectangle'],
        ['walls', 'Inside level walls'],
      ]),
      ...RECTANGLE_FIELDS,
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      if (reader.text('name') === '') return { ok: false, reason: 'A room needs a name.' };
      return result(reader, 'add_room', {
        name: reader.text('name'),
        number: reader.text('number') || undefined,
        ...outline(reader, context.wallIds),
        ...onLevel(context),
      });
    },
  },
];
