/** The report engine (plant 08 DAT §5.9, TR-DAT-11): `(doc, kind, filter) -> { columns, rows }`, a pure function of the document. */

import type { CadDocument } from '@core/model/types';
import { equipmentList } from './equipmentList';
import { lineList } from './lineList';
import { DEFAULT_MTO_GROUPING, mto, type MtoDimension } from './mto';
import { nozzleSchedule } from './nozzleSchedule';
import { objectsInScope } from './scope';
import { tagRegister } from './tagRegister';
import type { ReportKind, ReportOutcome } from './types';

export interface ReportQuery {
  readonly kind: ReportKind;
  readonly hierarchy?: string | undefined;
  readonly groupBy?: readonly MtoDimension[] | undefined;
}

const UNAVAILABLE: Readonly<Record<string, string>> = {
  valve_list: 'valve_list reads valve objects from the component providers of 01 PSC / 02 RTE, which are not installed yet (DAT-M5)',
  instrument_index: 'instrument_index reads instrument objects from the 04 PID provider, which is not installed yet (DAT-M5)',
  custom: 'custom reports need saved report definitions (save_report_definition, DAT-M4)',
};

export function buildReport(doc: CadDocument, query: ReportQuery): ReportOutcome {
  const unavailable = UNAVAILABLE[query.kind];
  if (unavailable !== undefined) return { ok: false, code: 'DAT_REPORT_KIND_UNAVAILABLE', message: unavailable, path: 'kind' };
  if (query.groupBy !== undefined && query.kind !== 'mto')
    return {
      ok: false,
      code: 'DAT_PARAM_INVALID',
      message: `groupBy applies to the mto report only, not to ${query.kind}`,
      path: 'groupBy',
    };
  const scope = objectsInScope(doc, query.hierarchy);
  if (!scope.ok) return scope;
  const table = {
    line_list: () => lineList(doc, scope.objects),
    equipment_list: () => equipmentList(doc, scope.objects),
    nozzle_schedule: () => nozzleSchedule(doc, scope.objects),
    tag_register: () => tagRegister(doc, scope.objects),
    mto: () => mto(doc, scope.objects, query.groupBy ?? DEFAULT_MTO_GROUPING),
  }[query.kind as 'line_list' | 'equipment_list' | 'nozzle_schedule' | 'tag_register' | 'mto']();
  return { ok: true, table };
}
