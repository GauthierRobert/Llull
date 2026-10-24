// Which parameters a command's form shows for the value of its mode selector. The freeform editing commands take one of several operations
// with disjoint parameters (`edit_nurbs` operation, `move_faces` mode): showing only the ones that apply keeps the generic form short and
// stops a stale value of another operation from being submitted. Pure; commands without a rule show every field.

import type { FormField, FormValues } from './paramForm';

interface ModeRule {
  /** The enum field that selects the operation. */
  readonly selector: string;
  /** Fields that belong to one value of the selector; a field listed under no value of the selector is always shown. */
  readonly byValue: Readonly<Record<string, readonly string[]>>;
}

const RULES: Readonly<Record<string, ModeRule>> = {
  move_faces: { selector: 'mode', byValue: { translate: ['vector'], rotate: ['axis', 'angleDeg'], offset: ['distance'] } },
  edit_nurbs: {
    selector: 'operation',
    byValue: {
      move_pole: ['index', 'to'],
      move_poles: ['indices', 'delta', 'falloff'],
      drag_point: ['u', 'displacement'],
      set_weight: ['index', 'weight'],
      insert_knot: ['u', 'times'],
      elevate_degree: ['by'],
      reverse: [],
    },
  },
  edit_nurbs_surface: {
    selector: 'operation',
    byValue: {
      move_poles: ['poles', 'rows', 'cols', 'rect', 'delta', 'falloff'],
      set_weight: ['i', 'j', 'weight'],
      drag_point: ['u', 'v', 'displacement'],
      insert_knot: ['direction', 'u', 'v', 'times'],
      elevate_degree: ['direction', 'by'],
      reverse: ['direction'],
      transpose: [],
    },
  },
};

/** The fields to show for `values`; all of them while the selector is blank or has no rule. */
export function visibleFields(command: string, fields: readonly FormField[], values: FormValues): readonly FormField[] {
  const rule = RULES[command];
  const chosen = rule === undefined ? undefined : values[rule.selector];
  if (rule === undefined || chosen === undefined || chosen === '') return fields;
  const controlled = new Set(Object.values(rule.byValue).flat());
  const shown = new Set(rule.byValue[chosen] ?? []);
  return fields.filter((field) => !controlled.has(field.name) || shown.has(field.name));
}
