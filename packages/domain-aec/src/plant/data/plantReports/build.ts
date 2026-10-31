/** The report engine (plant 08 DAT §5.9, TR-DAT-11): `(doc, kind, filter) -> { columns, rows }`, a pure function of the document. */

import type { CadDocument } from '@core/model/types';
import { equipmentList } from './equipmentList';
import { instrumentIndex } from './instrumentIndex';
import { lineList } from './lineList';
import { DEFAULT_MTO_GROUPING, mto, type MtoDimension } from './mto';
import { nozzleSchedule } from './nozzleSchedule';
import { objectsInScope } from './scope';
import { tagRegister } from './tagRegister';
import { valveList } from './valveList';
import type { ReportKind, ReportOutcome } from './types';

export interface ReportQuery {
  readonly kind: ReportKind;
  readonly hierarchy?: string | undefined;
  readonly groupBy?: readonly MtoDimension[] | undefined;
}

const UNAVAILABLE: Readonly<Record<string, string>> = {
  custom: 'kind custom needs definition: the id of a report saved with save_report_definition',
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
  const whole = query.hierarchy === undefined;
  const table = {
    line_list: () => lineList(doc, scope.objects),
    equipment_list: () => equipmentList(doc, scope.objects),
    nozzle_schedule: () => nozzleSchedule(doc, scope.objects, whole),
    valve_list: () => valveList(doc, scope.objects, whole),
    instrument_index: () => instrumentIndex(doc, scope.objects, whole),
    tag_register: () => tagRegister(doc, scope.objects, whole),
    mto: () => mto(doc, scope.objects, query.groupBy ?? DEFAULT_MTO_GROUPING),
  }[query.kind as Exclude<ReportKind, 'custom'>]();
  return { ok: true, table };
}
