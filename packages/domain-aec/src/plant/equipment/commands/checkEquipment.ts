import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { MM_PER_UNIT } from '@core/model/units';
import type { EquipmentElement } from '@aec/building/types';
import { elementsOf, getBuilding } from '../../../building/model';
import { checkVessel, type EquipmentIssue } from '../codecheck/checkVessel';
import { remediationOf } from '../model';
import { equipmentRefParam, findEquipment } from './equipmentRef';
import { REVIEW_REASON } from './vesselThickness';

type Status = 'fail' | 'warn' | 'pass_with_review' | 'pass';

const SEVERITY_ORDER: Readonly<Record<string, number>> = { fail: 0, warning: 1 };
const byIssue = (a: EquipmentIssue, b: EquipmentIssue): number =>
  (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2) ||
  (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
  (a.ids.join() < b.ids.join() ? -1 : a.ids.join() > b.ids.join() ? 1 : 0) ||
  (a.paths.join() < b.paths.join() ? -1 : a.paths.join() > b.paths.join() ? 1 : 0);

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant findings, not refusals: status = fail if any fail, else warn if any warning, else pass_with_review if a code thickness was computed,
 *   else pass; issues sorted by severity then code; reviewRequired is true when a code thickness / MAWP was computed for any checked vessel; the
 *   thickness numbers are those of vessel_thickness (one source of truth)
 * @failure an explicitly listed legacy / non-vessel element -> warning EQP_NOT_PARAMETRIC (not checked); an equipment reference that matches nothing -> a fail issue EQP_NOT_FOUND (a check that could not run never reads as a pass)
 */
export const checkEquipment = defineCommand({
  name: 'check_equipment',
  description:
    'Query: design review of parametric equipment (all, or the listed tags / ids): ASME VIII-1 shell and head under-thickness (EQP_SHELL_UNDER_THICKNESS, ' +
    'EQP_HEAD_UNDER_THICKNESS, corroded) and MAWP below the design pressure (EQP_MAWP_BELOW_DESIGN) as fails; missing design data, a part outside the ' +
    'formulas (EQP_DESIGN_DATA_MISSING, EQP_ALLOWABLE_MISSING, EQP_FORMULA_OUT_OF_RANGE, EQP_HEAD_NOT_COVERED), nozzle layout (EQP_NOZZLE_OVERLAP, ' +
    'EQP_NOZZLE_IN_KNUCKLE, EQP_NOZZLE_IN_SUPPORT), unverified table rows (EQP_TABLE_UNVERIFIED), an allowable stress without source ' +
    '(EQP_VALUE_UNSOURCED) and placeholder flanges (EQP_FLANGE_PLACEHOLDER) as warnings. Returns status (fail > warn > pass_with_review > pass), ' +
    'issues[{code, severity, ids, paths, message, remediation}] sorted by severity then code, checked[{tag, id, status}], reviewRequired (true when a ' +
    'code thickness was computed: a computed check is not a stamped design) and reviewReason. Findings, not refusals: an unknown reference is a fail ' +
    'issue EQP_NOT_FOUND. Does not modify the document.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    equipment: z.array(equipmentRefParam).max(500).optional().describe('Tags or ids to check. Omit to check all parametric equipment.'),
  }),
  run: (doc, { equipment }): CommandResult => {
    const building = getBuilding(doc);
    const issues: EquipmentIssue[] = [];
    let scope: EquipmentElement[];
    if (equipment === undefined) scope = elementsOf(building, 'equipment');
    else {
      scope = [];
      equipment.forEach((reference, index) => {
        const found = findEquipment(building, reference);
        if (found === undefined)
          issues.push({
            code: 'EQP_NOT_FOUND',
            severity: 'fail',
            ids: [],
            paths: [`equipment.${index}`],
            message: `no equipment with tag or id '${reference}'`,
            remediation: remediationOf('EQP_NOT_FOUND'),
          });
        else if (!scope.includes(found)) scope.push(found);
      });
    }
    const mm = MM_PER_UNIT[doc.units];
    let reviewRequired = false;
    const checked: Array<{ tag: string; id: string; status: Status }> = [];
    for (const element of scope) {
      if (element.plant?.template.kind !== 'vessel') {
        if (equipment !== undefined)
          issues.push({
            code: 'EQP_NOT_PARAMETRIC',
            severity: 'warning',
            ids: [element.id],
            paths: ['equipment'],
            message: `${element.mark} (${element.id}) is not a parametric vessel: not checked`,
            remediation: remediationOf('EQP_NOT_PARAMETRIC'),
          });
        continue;
      }
      const check = checkVessel(element, mm);
      issues.push(...check.issues);
      reviewRequired ||= check.reviewRequired;
      const status: Status = check.issues.some((issue) => issue.severity === 'fail')
        ? 'fail'
        : check.issues.length > 0
          ? 'warn'
          : check.reviewRequired
            ? 'pass_with_review'
            : 'pass';
      checked.push({ tag: element.mark, id: element.id, status });
    }
    issues.sort(byIssue);
    const status: Status = issues.some((issue) => issue.severity === 'fail')
      ? 'fail'
      : issues.length > 0
        ? 'warn'
        : reviewRequired
          ? 'pass_with_review'
          : 'pass';
    const fails = issues.filter((issue) => issue.severity === 'fail').length;
    return report(
      doc,
      `check_equipment: ${status}, ${checked.length} vessel(s) checked, ${fails} fail(s), ${issues.length - fails} warning(s)${reviewRequired ? '; review required' : ''}.`,
      { status, issues, checked, reviewRequired, ...(reviewRequired ? { reviewReason: REVIEW_REASON } : {}) },
    );
  },
});
