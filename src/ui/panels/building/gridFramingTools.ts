/**
 * @layer ui/panels/building
 *
 * Form specs for the grid framing tools (columns / beams / bracing laid out from the structural
 * grid): each maps form values to ONE command (param-gathering only, react R1).
 */

import {
  FieldReader,
  defaultedSelect,
  levelField,
  num,
  radians,
  result,
  select,
  textList,
  txt,
  type ElementTool,
  type ToolField,
} from './elementToolForm';
import { ALL_PROFILES, BASE_OPTIONS, JOINT_OPTIONS } from './steelProfileOptions';

const profile = (defaultValue: string): ToolField =>
  select('profile', 'Profile', defaultValue, ALL_PROFILES);

const gradeField = (): ToolField => txt('material', 'Steel grade (blank = default)', '', true);

/** Level selector whose blank option is the given text (default: the active level). */
function levelSelect(key: string, label: string, blankLabel: string): ToolField {
  return { ...select(key, label, '', 'levels'), blankLabel };
}

function levelParam(reader: FieldReader, key: string): Record<string, string> {
  const chosen = reader.text(key);
  return chosen === '' ? {} : { [key]: chosen };
}

export const GRID_FRAMING_TOOLS: ReadonlyArray<ElementTool> = [
  {
    id: 'gridColumns',
    label: 'Columns on grid',
    fields: [
      profile('HEB300'),
      levelField(),
      levelSelect('topLevelId', 'Up to level', 'One storey'),
      txt('axes', 'Axes (comma-separated, blank = all)', '', true),
      txt('exclude', 'Skip intersections (e.g. A/1, B/2)', '', true),
      num('roll', 'Roll (°)', '0'),
      select('baseFixity', 'Base fixity', 'pinned', BASE_OPTIONS),
      gradeField(),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      const roll = reader.number('roll');
      const levelId = reader.text('levelId') || context.levelId;
      return result(reader, 'add_grid_columns', {
        profile: reader.text('profile'),
        ...(levelId === null ? {} : { levelId }),
        ...levelParam(reader, 'topLevelId'),
        axes: textList(reader, 'axes'),
        exclude: textList(reader, 'exclude'),
        roll: roll === 0 ? undefined : radians(roll),
        baseFixity: reader.text('baseFixity'),
        material: reader.text('material') || undefined,
      });
    },
  },
  {
    id: 'gridBeams',
    label: 'Beams on grid',
    fields: [
      profile('IPE300'),
      levelField(),
      txt('axes', 'Axes (comma-separated, blank = all)', '', true),
      num('topOffset', 'Top of steel vs floor ({unit})', '0'),
      defaultedSelect('startJoint', 'Start joint', 'Default (pinned)', JOINT_OPTIONS),
      defaultedSelect('endJoint', 'End joint', 'Default (pinned)', JOINT_OPTIONS),
      gradeField(),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      const levelId = reader.text('levelId') || context.levelId;
      return result(reader, 'add_grid_beams', {
        profile: reader.text('profile'),
        ...(levelId === null ? {} : { levelId }),
        axes: textList(reader, 'axes'),
        topOffset: reader.number('topOffset'),
        startJoint: reader.text('startJoint') || undefined,
        endJoint: reader.text('endJoint') || undefined,
        material: reader.text('material') || undefined,
      });
    },
  },
  {
    id: 'gridBracing',
    label: 'Bracing on grid',
    fields: [
      profile('CHS139.7x5'),
      txt('axis', 'Axis (e.g. A)', 'A'),
      txt('from', 'From axis (e.g. 1)', '1'),
      txt('to', 'To axis (e.g. 2)', '2'),
      levelField(),
      select('pattern', 'Pattern', 'x', [
        ['x', 'Cross (X)'],
        ['diagonal', 'Single diagonal'],
      ]),
      num('bottomOffset', 'Bottom offset vs floor ({unit})', '0', true),
      num('topOffset', 'Top offset vs floor above ({unit})', '0', true),
      gradeField(),
    ],
    build: (values, context) => {
      const reader = new FieldReader(values);
      for (const key of ['axis', 'from', 'to']) {
        if (reader.text(key) === '') return { ok: false, reason: `Check: ${key}` };
      }
      const levelId = reader.text('levelId') || context.levelId;
      return result(reader, 'add_grid_bracing', {
        profile: reader.text('profile'),
        axis: reader.text('axis'),
        from: reader.text('from'),
        to: reader.text('to'),
        ...(levelId === null ? {} : { levelId }),
        pattern: reader.text('pattern'),
        bottomOffset: reader.optionalNumber('bottomOffset'),
        topOffset: reader.optionalNumber('topOffset'),
        material: reader.text('material') || undefined,
      });
    },
  },
];
