/**
 * P&ID nozzles against the 03 EQP `NozzleRecord`s of the paired equipment, and the DN of a paired inline item (plant 04 PID-FU-5). A P&ID nozzle pairs with
 * the nozzle record whose mark equals its sub-tag (normalised like tags); a record is reported as not on the P&ID only when a 3D line ends on it (a spare
 * or manway nozzle the drawing leaves out is not an inconsistency).
 */

import type { EquipmentElement } from '@aec/building/types';
import type { PidInline, PidNozzle } from '../model';
import type { Inline3d, Norm } from './common';
import { makeFinding3d, type Finding3d, type Skip3d } from './finding';

export interface NozzleComparison {
  readonly findings: Finding3d[];
  readonly skips: Skip3d[];
  /** `TAG/SUB` of every P&ID nozzle paired with a record. */
  readonly matched: string[];
  /** P&ID nozzles with no record, and records a 3D line ends on that the P&ID does not draw. */
  readonly unplaced: Array<{ readonly nozzle: PidNozzle; readonly label: string }>;
  readonly notInPid: Array<{ readonly ids: readonly string[]; readonly label: string }>;
}

const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/**
 * @param connected normalised `TAG:MARK` of every nozzle a 3D line starts or ends on
 * @invariant an equipment without nozzle records (a legacy block) gives one coded skip, never a finding per nozzle
 */
export function compareNozzles(
  tag: string,
  element: EquipmentElement,
  nozzles: readonly PidNozzle[],
  connected: ReadonlySet<string>,
  norm: Norm,
): NozzleComparison {
  const out: NozzleComparison = { findings: [], skips: [], matched: [], unplaced: [], notInPid: [] };
  const records = element.plant?.nozzles ?? [];
  if (records.length === 0) {
    if (nozzles.length > 0)
      out.skips.push({
        code: 'P3D_UNPLACED',
        reason: 'no_3d_nozzles',
        item: tag,
        pidIds: nozzles.map((n) => n.id),
        elementIds: [element.id],
        detail: `equipment ${tag}: the 3D element has no nozzle records (add_nozzle), so the ${nozzles.length} P&ID nozzle(s) cannot be compared`,
      });
    return out;
  }
  const byMark = new Map(records.map((record) => [norm(record.mark), record]));
  const drawn = new Set<string>();
  for (const nozzle of nozzles) {
    const label = `${tag}/${nozzle.subTag}`;
    const record = byMark.get(norm(nozzle.subTag));
    if (record === undefined) {
      out.unplaced.push({ nozzle, label });
      out.findings.push(
        makeFinding3d({
          code: 'P3D_UNPLACED',
          pidIds: [nozzle.id],
          elementIds: [element.id],
          item: label,
          message: `nozzle ${label} is on the P&ID but the 3D equipment has no nozzle ${nozzle.subTag}`,
          values: { nozzle: nozzle.subTag },
        }),
      );
      continue;
    }
    drawn.add(norm(record.mark));
    out.matched.push(label);
    if (nozzle.dn === undefined)
      out.skips.push({
        code: 'P3D_SIZE_MISMATCH',
        reason: 'no_pid_dn',
        item: label,
        pidIds: [nozzle.id],
        elementIds: [element.id],
        detail: `nozzle ${label}: the P&ID nozzle has no DN`,
      });
    else if (!same(nozzle.dn, record.dn))
      out.findings.push(
        makeFinding3d({
          code: 'P3D_SIZE_MISMATCH',
          pidIds: [nozzle.id],
          elementIds: [element.id],
          item: label,
          message: `nozzle ${label}: P&ID DN ${nozzle.dn} but the 3D nozzle ${record.mark} is DN ${record.dn}`,
          values: { pidDn: nozzle.dn, modelDn: record.dn },
        }),
      );
  }
  for (const record of records) {
    if (drawn.has(norm(record.mark)) || !connected.has(`${norm(tag)}:${norm(record.mark)}`)) continue;
    const label = `${tag}/${record.mark}`;
    out.notInPid.push({ ids: [element.id], label });
    out.findings.push(
      makeFinding3d({
        code: 'P3D_NOT_IN_PID',
        elementIds: [element.id],
        item: label,
        message: `3D nozzle ${label} has a line on it but is not on the P&ID`,
        values: { nozzle: record.mark },
      }),
    );
  }
  return out;
}

/** P3D_SIZE_MISMATCH of one paired inline item: its DN against the DN of the 3D line at the component (a reducer has two sizes: coded skip). */
export function compareInlineSize(item: PidInline, component: Inline3d): Finding3d | Skip3d | undefined {
  const label = item.tag ?? item.id;
  const where = { item: label, pidIds: [item.id], elementIds: component.ids };
  if (component.type.startsWith('reducer'))
    return {
      code: 'P3D_SIZE_MISMATCH',
      reason: 'reducer',
      ...where,
      detail: `inline ${label}: a reducer has two sizes, so one P&ID DN cannot be compared`,
    };
  if (item.dn === undefined)
    return { code: 'P3D_SIZE_MISMATCH', reason: 'no_pid_dn', ...where, detail: `inline ${label}: the P&ID item has no DN` };
  if (component.dn === undefined)
    return { code: 'P3D_SIZE_MISMATCH', reason: 'no_3d_dn', ...where, detail: `inline ${label}: the 3D line has no DN at the component` };
  if (same(item.dn, component.dn)) return undefined;
  return makeFinding3d({
    code: 'P3D_SIZE_MISMATCH',
    ...where,
    message: `inline ${label}: P&ID DN ${item.dn} but the 3D line is DN ${component.dn} at the component`,
    values: { pidDn: item.dn, modelDn: component.dn },
  });
}
