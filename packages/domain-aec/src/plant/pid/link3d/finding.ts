/** A `check_pid_3d` finding, its stable key and the rule table (plant 04 PID §5.6, MVP subset). */

import { naturalCompare } from '../lists/sort';

/** The codes the MVP can decide: SPEC / CLASS / INLINE_ORDER need 3D data (02 RTE, 01 PSC, 03 EQP) that does not exist yet. */
export const P3D_RULES = ['P3D_TAG_AMBIGUOUS', 'P3D_UNPLACED', 'P3D_NOT_IN_PID', 'P3D_SIZE_MISMATCH', 'P3D_CONNECTIVITY_MISMATCH'] as const;
export type P3dRule = (typeof P3D_RULES)[number];

export const P3D_REMEDIATION: Readonly<Record<P3dRule, string>> = {
  P3D_TAG_AMBIGUOUS:
    'Two or more objects carry the same normalised tag: rename one (update_pid_item set.tag, rename_equipment_tag) or pair the right ones with link_pid_item.',
  P3D_UNPLACED:
    'Place the 3D item (add_equipment with mark = the tag, add_pipe_run with line = the line number), or pair an existing one with link_pid_item. Inline components have no 3D object in this subset.',
  P3D_NOT_IN_PID:
    'Draw the item on the P&ID (add_pid_equipment / add_pid_line with the same tag or line number), pair it with link_pid_item, or remove it from the 3D model.',
  P3D_SIZE_MISMATCH: 'Make the DN agree: update_pid_item set.dn on the P&ID, or re-route the 3D run with the P&ID size (add_pipe_run dn).',
  P3D_CONNECTIVITY_MISMATCH:
    'Make the ends agree: the 3D run goes from / to the equipment (and nozzle) the P&ID line connects; correct the 3D from / to or the P&ID line.',
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
