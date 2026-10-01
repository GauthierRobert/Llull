/**
 * @layer ui/panels/building
 *
 * Declarative form specs for the building element tools: each tool maps form values to ONE
 * command + params (param-gathering only — the command does all document work, react R1).
 */

export type FieldKind = 'number' | 'text' | 'select' | 'checkbox';

export interface ToolField {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly defaultValue: string;
  /** For 'select': [value, label] pairs; 'walls' is filled with the active level's walls. */
  readonly options?: ReadonlyArray<readonly [string, string]> | 'walls';
  /** Optional numeric fields may be left blank → the command default applies. */
  readonly optional?: boolean;
}

export interface ToolContext {
  readonly levelId: string | null;
  readonly wallIds: ReadonlyArray<string>;
}

export type ToolCommand =
  | { readonly ok: true; readonly command: string; readonly params: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

export interface ElementTool {
  readonly id: string;
  readonly label: string;
  readonly fields: ReadonlyArray<ToolField>;
  readonly build: (values: Readonly<Record<string, string>>, context: ToolContext) => ToolCommand;
}

const MATERIALS: ReadonlyArray<readonly [string, string]> = [
  ['concrete', 'Concrete'],
  ['masonry', 'Masonry'],
  ['brick', 'Brick'],
  ['block', 'Concrete block'],
  ['timber', 'Timber'],
  ['steel', 'Steel'],
  ['gypsum', 'Gypsum board'],
];

function num(key: string, label: string, defaultValue = '', optional = false): ToolField {
  return { key, label, kind: 'number', defaultValue, optional };
}

class FieldReader {
  readonly missing: string[] = [];

  constructor(private readonly values: Readonly<Record<string, string>>) {}

  number(key: string): number {
    const value = Number(this.values[key]);
    if (this.values[key]?.trim() === '' || !Number.isFinite(value)) this.missing.push(key);
    return value;
  }

  optionalNumber(key: string): number | undefined {
    const raw = this.values[key]?.trim() ?? '';
    if (raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) this.missing.push(key);
    return value;
  }

  text(key: string): string {
    return this.values[key]?.trim() ?? '';
  }

  flag(key: string): boolean {
    return this.values[key] === 'true';
  }

  numberList(key: string): number[] {
    const parts = this.text(key)
      .split(/[,;\s]+/)
      .filter((part) => part !== '')
      .map(Number);
    if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) this.missing.push(key);
    return parts;
  }
}

function result(
  reader: FieldReader,
  command: string,
  params: Record<string, unknown>,
): ToolCommand {
  if (reader.missing.length > 0)
    return { ok: false, reason: `Check: ${reader.missing.join(', ')}` };
  const cleaned = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
  return { ok: true, command, params: cleaned };
}

function onLevel(context: ToolContext): Record<string, unknown> {
  return context.levelId === null ? {} : { levelId: context.levelId };
}

function rectangle(reader: FieldReader): Array<[number, number]> {
  const [x1, y1, x2, y2] = [
    reader.number('x1'),
    reader.number('y1'),
    reader.number('x2'),
    reader.number('y2'),
  ];
  return [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ];
}

const RECTANGLE_FIELDS = [
  num('x1', 'X1', '0'),
  num('y1', 'Y1', '0'),
  num('x2', 'X2', '5000'),
  num('y2', 'Y2', '4000'),
];

export const ELEMENT_TOOLS: ReadonlyArray<ElementTool> = [
  {
    id: 'grid',
    label: 'Structural grid',
    fields: [
      { key: 'xSpacings', label: 'Bays along X', kind: 'text', defaultValue: '6000, 6000' },
      { key: 'ySpacings', label: 'Bays along Y', kind: 'text', defaultValue: '5000' },
    ],
    build: (values) => {
      const reader = new FieldReader(values);
      return result(reader, 'add_grid_system', {
        xSpacings: reader.numberList('xSpacings'),
        ySpacings: reader.numberList('ySpacings'),
      });
    },
  },
  {
    id: 'perimeter',
    label: 'Perimeter walls',
    fields: [
      ...RECTANGLE_FIELDS.map((field) =>
        field.key === 'x2'
          ? { ...field, defaultValue: '10000' }
          : field.key === 'y2'
            ? { ...field, defaultValue: '8000' }
            : field,
      ),
      num('thickness', 'Thickness', '300'),
      num('height', 'Height', '', true),
      {
        key: 'material',
        label: 'Material',
        kind: 'select',
        defaultValue: 'masonry',
        options: MATERIALS,
      },
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      return result(reader, 'draw_walls', {
        points: rectangle(reader),
        closed: true,
        thickness: reader.number('thickness'),
        height: reader.optionalNumber('height'),
        material: reader.text('material'),
        ...onLevel(context),
      });
    },
  },
  {
    id: 'wall',
    label: 'Wall',
    fields: [
      num('x1', 'Start X', '0'),
      num('y1', 'Start Y', '0'),
      num('x2', 'End X', '5000'),
      num('y2', 'End Y', '0'),
      num('thickness', 'Thickness', '200'),
      num('height', 'Height', '', true),
      {
        key: 'material',
        label: 'Material',
        kind: 'select',
        defaultValue: 'concrete',
        options: MATERIALS,
      },
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      return result(reader, 'add_wall', {
        start: [reader.number('x1'), reader.number('y1')],
        end: [reader.number('x2'), reader.number('y2')],
        thickness: reader.number('thickness'),
        height: reader.optionalNumber('height'),
        material: reader.text('material'),
        ...onLevel(context),
      });
    },
  },
  {
    id: 'door',
    label: 'Door',
    fields: [
      { key: 'wallId', label: 'Host wall', kind: 'select', defaultValue: '', options: 'walls' },
      num('offset', 'Offset from start', '', true),
      num('width', 'Width', '900'),
      num('height', 'Height', '2100'),
      {
        key: 'swing',
        label: 'Hinge',
        kind: 'select',
        defaultValue: 'left',
        options: [
          ['left', 'Left'],
          ['right', 'Right'],
        ],
      },
    ],
    build: (values) => {
      const reader = new FieldReader(values);
      if (reader.text('wallId') === '') return { ok: false, reason: 'Pick a host wall first.' };
      return result(reader, 'add_door', {
        wallId: reader.text('wallId'),
        offset: reader.optionalNumber('offset'),
        width: reader.number('width'),
        height: reader.number('height'),
        swing: reader.text('swing'),
      });
    },
  },
  {
    id: 'window',
    label: 'Window',
    fields: [
      { key: 'wallId', label: 'Host wall', kind: 'select', defaultValue: '', options: 'walls' },
      num('offset', 'Offset from start', '', true),
      num('width', 'Width', '1200'),
      num('height', 'Height', '1200'),
      num('sillHeight', 'Sill height', '900'),
    ],
    build: (values) => {
      const reader = new FieldReader(values);
      if (reader.text('wallId') === '') return { ok: false, reason: 'Pick a host wall first.' };
      return result(reader, 'add_window', {
        wallId: reader.text('wallId'),
        offset: reader.optionalNumber('offset'),
        width: reader.number('width'),
        height: reader.number('height'),
        sillHeight: reader.number('sillHeight'),
      });
    },
  },
  {
    id: 'slab',
    label: 'Slab / roof',
    fields: [
      {
        key: 'source',
        label: 'Outline',
        kind: 'select',
        defaultValue: 'walls',
        options: [
          ['walls', 'Enclosed by level walls'],
          ['rectangle', 'Rectangle'],
        ],
      },
      ...RECTANGLE_FIELDS,
      num('thickness', 'Thickness', '200'),
      num('offset', 'Top offset', '0'),
      {
        key: 'role',
        label: 'Role',
        kind: 'select',
        defaultValue: 'floor',
        options: [
          ['floor', 'Floor'],
          ['roof', 'Roof'],
          ['foundation', 'Foundation'],
        ],
      },
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      const outline =
        reader.text('source') === 'walls'
          ? { wallIds: [...context.wallIds] }
          : { boundary: rectangle(reader) };
      return result(reader, 'add_slab', {
        ...outline,
        thickness: reader.number('thickness'),
        offset: reader.number('offset'),
        role: reader.text('role'),
        ...onLevel(context),
      });
    },
  },
  {
    id: 'column',
    label: 'Column',
    fields: [
      {
        key: 'atGrid',
        label: 'At every grid intersection',
        kind: 'checkbox',
        defaultValue: 'false',
      },
      num('x', 'X', '0', true),
      num('y', 'Y', '0', true),
      {
        key: 'shape',
        label: 'Shape',
        kind: 'select',
        defaultValue: 'rectangular',
        options: [
          ['rectangular', 'Rectangular'],
          ['circular', 'Circular'],
        ],
      },
      num('width', 'Width / Ø', '300'),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      const placement = reader.flag('atGrid')
        ? { atGridIntersections: true }
        : { location: [reader.number('x'), reader.number('y')] };
      return result(reader, 'add_column', {
        ...placement,
        shape: reader.text('shape'),
        width: reader.number('width'),
        ...onLevel(context),
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
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      return result(reader, 'add_beam', {
        start: [reader.number('x1'), reader.number('y1')],
        end: [reader.number('x2'), reader.number('y2')],
        width: reader.number('width'),
        depth: reader.number('depth'),
        ...onLevel(context),
      });
    },
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
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      return result(reader, 'add_stair', {
        start: [reader.number('x'), reader.number('y')],
        angle: (reader.number('direction') * Math.PI) / 180,
        width: reader.number('width'),
        treadDepth: reader.number('treadDepth'),
        ...onLevel(context),
      });
    },
  },
  {
    id: 'room',
    label: 'Room',
    fields: [
      { key: 'name', label: 'Name', kind: 'text', defaultValue: 'Room' },
      { key: 'number', label: 'Number', kind: 'text', defaultValue: '' },
      {
        key: 'source',
        label: 'Outline',
        kind: 'select',
        defaultValue: 'rectangle',
        options: [
          ['rectangle', 'Rectangle'],
          ['walls', 'Inside level walls'],
        ],
      },
      ...RECTANGLE_FIELDS,
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      if (reader.text('name') === '') return { ok: false, reason: 'A room needs a name.' };
      const outline =
        reader.text('source') === 'walls'
          ? { wallIds: [...context.wallIds] }
          : { boundary: rectangle(reader) };
      return result(reader, 'add_room', {
        name: reader.text('name'),
        number: reader.text('number') || undefined,
        ...outline,
        ...onLevel(context),
      });
    },
  },
];

export function defaultValues(tool: ElementTool): Record<string, string> {
  return Object.fromEntries(tool.fields.map((field) => [field.key, field.defaultValue]));
}
