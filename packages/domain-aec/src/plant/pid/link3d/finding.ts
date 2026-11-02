/** A `check_pid_3d` finding, its stable key and the rule table (plant 04 PID §5.6, MVP subset). */

import { naturalCompare } from '../lists/sort';

/** The eight codes of `check_pid_3d` (plant 04 PID §5.6), in report order. */
export const P3D_RULES = [
  'P3D_TAG_AMBIGUOUS',
  'P3D_UNPLACED',
  'P3D_NOT_IN_PID',
  'P3D_SIZE_MISMATCH',
  'P3D_SPEC_MISMATCH',
  'P3D_CONNECTIVITY_MISMATCH',
  'P3D_CLASS_MISMATCH',
  'P3D_INLINE_ORDER_MISMATCH',
] as const;
export type P3dRule = (typeof P3D_RULES)[number];

export const P3D_REMEDIATION: Readonly<Record<P3dRule, string>> = {
  P3D_TAG_AMBIGUOUS:
    'Two or more objects carry the same normalised tag: rename one (update_pid_item set.tag, rename_equipment_tag) or pair the right ones with link_pid_item.',
  P3D_UNPLACED:
    'Place the 3D item (add_equipment with mark = the tag, add_pipe_run with line = the line number), or pair an existing one with link_pid_item. An inline valve / reducer is placed with route_pipe inline or insert_inline_component (tag = the P&ID tag).',
  P3D_NOT_IN_PID:
    'Draw the item on the P&ID (add_pid_equipment / add_pid_line with the same tag or line number), pair it with link_pid_item, or remove it from the 3D model.',
  P3D_SIZE_MISMATCH: 'Make the DN agree: update_pid_item set.dn on the P&ID, or re-route the 3D run with the P&ID size (add_pipe_run dn).',
  P3D_SPEC_MISMATCH:
    'Make the piping class and the 3D spec id agree: update_pid_item set.pipingClass on the P&ID, or re-create the 3D line with the spec of the P&ID class (create_pipeline spec).',
  P3D_CONNECTIVITY_MISMATCH:
    'Make the ends agree: the 3D run goes from / to the equipment (and nozzle) the P&ID line connects; correct the 3D from / to or the P&ID line.',
  P3D_CLASS_MISMATCH:
    'Make the classes agree: redraw the P&ID item with the class of the 3D object (delete_pid_item, add_pid_inline / add_pid_equipment with class), or place the 3D component / equipment of the P&ID class (insert_inline_component type, add_vessel).',
  P3D_INLINE_ORDER_MISMATCH:
    'Make the inline sequence agree: move the out-of-place components along the 3D line (move_inline_component) or reorder the P&ID items; values.lcs is the longest common sequence and values.outOfPlace the P&ID tags not in it.',
};

export interface Finding3d {
  readonly code: P3dRule;
  readonly status: 'fail';
  readonly severity: 'error';
  /** P&ID item ids, then 3D element ids (each sorted). */
  readonly ids: readonly string[];
  readonly pidIds: readonly string[];
  readonly elementIds: readonly string[];
  /** Tag or line number the finding is about. */
  readonly item: string;
  readonly message: string;
  readonly findingKey: string;
  readonly remediation: string;
  readonly values: Readonly<Record<string, string | number | boolean>>;
}

/** A comparison that could not be made, coded so it is never read as a pass. */
export interface Skip3d {
  readonly code: P3dRule;
  readonly reason: 'no_pid_class' | 'no_3d_spec' | 'class_not_mapped' | 'no_3d_class' | 'sequence_too_long';
  readonly item: string;
  readonly pidIds: readonly string[];
  readonly elementIds: readonly string[];
  readonly detail: string;
}

export interface Finding3dInit {
  readonly code: P3dRule;
  readonly pidIds?: readonly string[];
  readonly elementIds?: readonly string[];
  readonly item: string;
  readonly message: string;
  readonly values?: Readonly<Record<string, string | number | boolean>>;
}

export function makeFinding3d(init: Finding3dInit): Finding3d {
  const pidIds = [...(init.pidIds ?? [])].sort();
  const elementIds = [...(init.elementIds ?? [])].sort();
  return {
    code: init.code,
    status: 'fail',
    severity: 'error',
    ids: [...pidIds, ...elementIds],
    pidIds,
    elementIds,
    item: init.item,
    message: init.message,
    findingKey: `p3d:${init.code}:${[...pidIds, ...elementIds].join(',')}`,
    remediation: P3D_REMEDIATION[init.code],
    values: init.values ?? {},
  };
}

/** Rule order, then natural label, then key. */
export const compareFindings3d = (a: Finding3d, b: Finding3d): number =>
  P3D_RULES.indexOf(a.code) - P3D_RULES.indexOf(b.code) ||
  naturalCompare(a.item, b.item) ||
  (a.findingKey < b.findingKey ? -1 : a.findingKey > b.findingKey ? 1 : 0);
