/**
 * fea_import_field: CSV `x,y,z,T` with declared units -> `fe_table` artifact (parsed by the pure @cae `parseFieldTable`) -> store ->
 * `set_temperature_field { source: { kind: 'table', csvSha256, rows, coordinatesUnit, temperatureUnit } }` through the command bus.
 */

import type { FeaHost, FeaToolResult, FieldTableInput } from '@protocol/index';
import type { FeArtifactStore } from './artifactStore';
import type { CaeHooks } from './caeHooks';
import { feaFailure } from './feaCommon';

/** Named guard: the longest CSV text accepted (characters); larger tables are a mistake or an attack ("llull guard"). */
const MAX_FIELD_CSV_CHARS = 256 * 1024 * 1024;

/**
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not thermo_static -> THM_CASE_TYPE; CSV / unit problems -> TMC_FIELD_INVALID /
 *   TMC_FIELD_SOURCE_INVALID; set_temperature_field refusal -> its code; the document is unchanged on every failure
 */
export function runFeaImportField(
  analysisId: string,
  table: FieldTableInput,
  host: FeaHost,
  deps: { store: FeArtifactStore; hooks: CaeHooks },
): FeaToolResult {
  const tool = 'fea_import_field';
  const analysisCase = host.getDoc().analysis?.cases[analysisId];
  if (analysisCase === undefined) return feaFailure(tool, 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
  if (analysisCase.type !== 'thermo_static')
    return feaFailure(tool, 'THM_CASE_TYPE', `analysis '${analysisId}' is ${analysisCase.type}, not thermo_static`, [analysisId]);
  if (table.csv.length > MAX_FIELD_CSV_CHARS)
    return feaFailure(tool, 'TMC_FIELD_SOURCE_INVALID', `the CSV has more than ${MAX_FIELD_CSV_CHARS} characters (llull guard)`, [
      analysisId,
    ]);
  const parsed = deps.hooks.parseFieldTable(table.csv, table.coordinatesUnit, table.temperatureUnit);
  if (!parsed.ok) return feaFailure(tool, parsed.code, parsed.message, [analysisId]);
  const csvSha256 = deps.store.put(parsed.artifact);
  const source = {
    kind: 'table',
    csvSha256,
    rows: parsed.rows,
    coordinatesUnit: table.coordinatesUnit,
    temperatureUnit: table.temperatureUnit,
  };
  const applied = host.applyCommand('set_temperature_field', { analysisId, source });
  if (applied.isError) return { ...applied, summary: `${tool} ${applied.summary}`, isError: true };
  return {
    summary: `fea_import_field: '${analysisId}' table ${csvSha256.slice(0, 12)}… (${parsed.rows} rows, T ${parsed.minT}..${parsed.maxT} ${table.temperatureUnit}, coordinates in ${table.coordinatesUnit}); ${applied.summary}`,
    affected: applied.affected,
    isError: false,
    data: {
      csvSha256,
      rows: parsed.rows,
      minT: parsed.minT,
      maxT: parsed.maxT,
      coordinatesUnit: table.coordinatesUnit,
      temperatureUnit: table.temperatureUnit,
    },
  };
}
