/** compute_margins (05 §5.8, AF-31..36): margins of safety from the TRUSTED results artifact of a static / thermo_static analysis. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, HumanSignaturePort, LoadCategory } from '@core/model/analysis';
import { documentIdentity } from '@core/model/documentUid';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { loadCasesOf } from '../decks/context';
import { elasticConstants, isElasticRefusal, propertyTemperatureK } from '../decks/elastic';
import { lengthUnitName, stressPerMpa, stressUnitName } from '../decks/units';
import { nodeCoordinates, stepOfLoadCase } from '../results/fields';
import { plyMarginRows } from './plyMargins';
import { compositeWarnings, exclusionWarnings, isCompositeEntity, orphanSingularKeys } from './screenWarnings';
import { caseOf } from '../shared/access';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import { checkThermomechItems } from '../thermomech/check';
import { solvedNodeTemperatures, temperatureWarnings, type NodeTemperatures } from './temperature';
import {
  explicitAllowable,
  isAllowableRefusal,
  materialAllowable,
  materialAllowableOver,
  type Allowable,
  type AllowableRefusal,
} from './allowable';
import { appliedFactor, factorReport, marginOfSafety, statusOf, type CheckKind, type MarginStatus } from './marginMath';
import { analysisInputHash } from '../hash/inputHash';
import { dispositionOf } from './disposition';
import { refuseMargins } from './refusal';
import { screenSingularities } from './singularity';
import { adequacyOf } from '../results/adequacy';
import { adequacyWarnings, gateRows, notAssessedText, overallOf, type GatedRows } from './adequacyGate';
import { appliedOver, CRITERIA, groupsOf, type Criterion } from './marginGroups';
import { queryRefusal, refusalFor, verifiedArtifacts } from './marginQueryChecks';
import { jointMarginSchema, jointMarginTable } from '../contact/jointMargins';
import { limitLoadMarginSchema, limitLoadMarginTable } from './limitLoadMargins';
import { appendAll } from '@lib/appendAll';

const allowableSchema = z.union([
  z.enum(['ftu', 'fty']),
  z.object({
    value: z.number().describe('Allowable stress value, > 0.'),
    unit: z.string().describe('Stress unit, e.g. "MPa", "psi", "ksi".'),
    against: z
      .enum(['ultimate', 'yield'])
      .optional()
      .describe('Which check the explicit allowable is used for: ultimate (default) or yield (limit load cases only).'),
  }),
]);

type AllowableInput = z.output<typeof allowableSchema>;

/** The checks to run for a load case category. */
function checksFor(category: LoadCategory, allowable: AllowableInput | undefined): CheckKind[] {
  if (allowable === undefined) return category === 'limit' ? ['ultimate', 'yield'] : ['ultimate'];
  const wanted: CheckKind = allowable === 'ftu' ? 'ultimate' : allowable === 'fty' ? 'yield' : (allowable.against ?? 'ultimate');
  return wanted === 'yield' && category === 'ultimate' ? [] : [wanted];
}

export interface MarginRow {
  readonly rowId: string;
  readonly ms: number | null;
  readonly status: MarginStatus | 'NOT_ASSESSED';
  readonly disposition: string;
  readonly [key: string]: unknown;
}

/** One warning per rejected stored disposition: a record made for another document, or one that records no uid (never counted). */
function dispositionWarnings(rows: readonly MarginRow[]): string[] {
  return rows.flatMap((row) =>
    typeof row['dispositionCode'] === 'string' ? [`${row['dispositionCode']}: ${row.rowId}: ${String(row['dispositionNote'])}`] : [],
  );
}

const suffix = (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

interface Context {
  readonly doc: CadDocument;
  readonly analysis: AnalysisCase;
  readonly mesh: FeMeshArtifact;
  readonly results: FeResultsArtifact;
  readonly criterion: Criterion;
  readonly allowable: AllowableInput | undefined;
  readonly marginalBand: number | undefined;
  readonly groupBy: 'part' | 'target';
  readonly loadCaseFilter: ReadonlySet<string> | undefined;
  /** Signing port that re-verifies stored dispositions (null: none counts). */
  readonly port: HumanSignaturePort | null;
  /** thermo_static only: solved temperature of each mesh node; null = the allowable is read at the reference temperature. */
  readonly temperatures: NodeTemperatures | null;
  /** Nodes excluded from the applied stress (singular zones): their stress is reported in separate `singular` rows. */
  readonly singular: ReadonlySet<number>;
}

function unverifiedReasonsOf(context: Context, entityId: string, materialId: string | undefined): string[] {
  const { doc, analysis } = context;
  if (materialId === undefined || !Object.hasOwn(doc.materials, materialId)) return [];
  const material = doc.materials[materialId];
  const elastic = material === undefined ? null : elasticConstants(material, materialId, propertyTemperatureK(analysis));
  const reasons = elastic === null || isElasticRefusal(elastic) ? [] : elastic.unverifiedReasons.map((reason) => `E/nu: ${reason}`);
  if (analysis.type === 'thermo_static')
    for (const item of checkThermomechItems(doc, analysis.id))
      if (item.code === 'TMC_MATERIAL_UNVERIFIED' && item.ids.includes(entityId)) reasons.push(item.message);
  return reasons;
}

/** Allowable for a part and a check, or a refusal. */
function allowableFor(context: Context, entityId: string, check: CheckKind, nodes: readonly number[]): Allowable | AllowableRefusal {
  const { doc, analysis, allowable } = context;
  if (typeof allowable === 'object') return explicitAllowable(allowable.value, allowable.unit);
  const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
  const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  if (materialId === undefined || material === undefined)
    return {
      code: 'FEA_MATERIAL_NO_ALLOWABLE',
      message: `part '${entityId}' has no material, so no allowable (pass allowable { value, unit })`,
    };
  const property = check === 'ultimate' ? 'Ftu' : 'Fty';
  const region = context.temperatures?.rangeOf(nodes);
  return region === undefined || region === null
    ? materialAllowable(material, materialId, property, propertyTemperatureK(analysis))
    : materialAllowableOver(material, materialId, property, region);
}

/** Which temperature the allowable of a thermo_static row was read at, and where that temperature comes from. */
function temperatureColumns(context: Context, found: Allowable, nodes: readonly number[]): Record<string, unknown> {
  const region = context.temperatures?.rangeOf(nodes) ?? null;
  const referenceK = propertyTemperatureK(context.analysis);
  if (region === null)
    return {
      temperatureDependent: found.temperatureDependent,
      allowableTemperatureK: found.temperatureK ?? referenceK,
      allowableTemperatureBasis: 'reference temperature (no solved temperature available for this region)',
    };
  return {
    temperatureDependent: found.temperatureDependent,
    allowableTemperatureK: found.temperatureK ?? region[1],
    allowableTemperatureRangeK: region,
    allowableTemperatureBasis: `solved temperature field of the case (${context.temperatures?.description ?? ''}); the lower allowable of the region's coldest and hottest node`,
  };
}

function buildRows(
  context: Context,
):
  | { readonly rows: MarginRow[]; readonly skipped: ReadonlyMap<string, string> }
  | AllowableRefusal
  | { readonly code: string; readonly message: string } {
  const { analysis, mesh, results, criterion, marginalBand } = context;
  const factors = factorReport(analysis);
  const stress = stressUnitName(analysis.unitSystem);
  const length = suffix(lengthUnitName(analysis.unitSystem));
  const perMpa = stressPerMpa(analysis.unitSystem);
  const coordinates = nodeCoordinates(mesh);
  const rows: MarginRow[] = [];
  const singularRows: MarginRow[] = [];
  const skipped = new Map<string, string>();
  const groups = groupsOf(analysis, mesh, context.groupBy);
  const cases = loadCasesOf(analysis);
  for (const [index, { name, category }] of cases.entries()) {
    if (context.loadCaseFilter !== undefined && !context.loadCaseFilter.has(name)) continue;
    const fields = stepOfLoadCase(results, index, analysis)?.fields;
    if (fields?.['STRESS'] === undefined)
      return {
        code: 'FEA_RESULTS_MISSING',
        message: `the results have no STRESS field for load case '${name}' (solver step ${index + 1})`,
      };
    for (const group of groups) {
      const parts = [
        { nodes: group.nodes.filter((node) => !context.singular.has(node)), singular: false },
        { nodes: group.nodes.filter((node) => context.singular.has(node)), singular: true },
      ];
      if (isCompositeEntity(analysis, group.entityId)) {
        for (const { nodes, singular } of parts) {
          if (nodes.length === 0) continue;
          const plyRows = plyMarginRows({
            doc: context.doc,
            analysis,
            mesh,
            fields,
            entityId: group.entityId,
            region: group.region,
            nodes,
            singular,
            loadCase: { name, category },
            factors,
            marginalBand,
            port: context.port,
          });
          if ('skipped' in plyRows) skipped.set(group.entityId, plyRows.skipped);
          else
            appendAll(
              singular ? singularRows : rows,
              plyRows.rows.map((row) => ({ rowId: '', ...row })),
            );
        }
        continue;
      }
      for (const { nodes, singular } of parts) {
        const applied = appliedOver(fields, nodes, criterion);
        if (applied === null) continue;
        const materialId = Object.hasOwn(context.doc.entities, group.entityId)
          ? context.doc.entities[group.entityId]?.materialId
          : undefined;
        for (const check of checksFor(category, context.allowable)) {
          const found = allowableFor(context, group.entityId, check, nodes);
          if (isAllowableRefusal(found)) return found;
          const factor = appliedFactor(factors, check, category);
          const ms = marginOfSafety(found.valueMpa * perMpa, applied.value, factor);
          const status = statusOf(ms, marginalBand);
          const reasons = [...new Set([...found.unverifiedReasons, ...unverifiedReasonsOf(context, group.entityId, materialId)])];
          const at: Vec3 = coordinates.get(applied.node) ?? [0, 0, 0];
          const rowKey = [name, group.entityId, group.region, check, criterion].join('|') + (singular ? '|singular' : '');
          const decided = dispositionOf(
            analysis,
            { rowKey, status, ms, inputHash: analysisInputHash(context.doc, analysis.id, 'full') },
            context.port,
            analysis.results?.resultsHash ?? '',
            documentIdentity(context.doc),
          );
          (singular ? singularRows : rows).push({
            rowId: '',
            rowKey,
            part: group.entityId,
            region: singular ? 'singular' : group.region,
            ...(singular ? { groupRegion: group.region } : {}),
            loadCase: name,
            category,
            check,
            criterion,
            [`applied${stress === 'psi' ? 'Psi' : stress}`]: applied.value,
            [`allowable${stress === 'psi' ? 'Psi' : stress}`]: found.valueMpa * perMpa,
            allowable: { property: found.property, basis: found.basis, provenance: found.provenance },
            ...(analysis.type === 'thermo_static' ? temperatureColumns(context, found, nodes) : {}),
            factorApplied: factor,
            ms,
            status,
            ...(status === 'FAIL' ? { code: 'FEA_MS_NEGATIVE' } : status === 'MARGINAL' ? { code: 'FEA_MS_MARGINAL' } : {}),
            node: applied.node,
            ...(applied.fibre !== undefined ? { fibre: applied.fibre } : {}),
            [`at${length}`]: at,
            singular,
            ...(singular
              ? {
                  singularNote:
                    'peak stress within the singularity radius of a point / edge load or support: mesh-dependent, excluded from minMs; judge it yourself',
                }
              : {}),
            provenance: {
              formula: 'MS = allowable / (applied x FoS x prod(extra)) - 1',
              standard: ['NASA-STD-5001B', '14 CFR 25.303', '14 CFR 25.305(a)'],
              ...(ms === null ? { note: 'applied stress is zero: no finite margin' } : {}),
            },
            unverified: reasons.length > 0,
            unverifiedReasons: reasons,
            reviewRequired: true,
            reviewReason: 'margin of safety supports a structural substantiation decision',
            disposition: decided.disposition,
            statusLabel: decided.statusLabel,
            ...(decided.record !== undefined ? { dispositionRecord: decided.record } : {}),
            ...(decided.note !== undefined ? { dispositionNote: decided.note } : {}),
            ...(decided.code !== undefined ? { dispositionCode: decided.code } : {}),
          });
        }
      }
    }
  }
  return { rows: [...rows, ...singularRows].map((row, index) => ({ ...row, rowId: `r${index + 1}` })), skipped };
}

/** Parameters that choose which margin table is computed (shared by compute_margins and dispose_margin, so a row id means the same row in both). */
export const marginQueryShape = {
  criterion: z
    .enum([...CRITERIA, 'limit_load', 'joint'])
    .optional()
    .describe('von_mises (default) / |s_xx| / |s_yy| / |s_zz|; limit_load (limitLoad) and joint (joint): nonlinear_static case.'),
  limitLoad: limitLoadMarginSchema.optional(),
  joint: jointMarginSchema.optional(),
  allowable: allowableSchema
    .optional()
    .describe('"ftu" (ultimate check), "fty" (yield check), or { value, unit, against? }. Omit for both checks from the material models.'),
  groupBy: z
    .enum(['part', 'target'])
    .optional()
    .describe('part (default): one row per part; target: per constraint / load node set and part.'),
  loadCases: z.array(z.string()).optional().describe('Load case names to include (default: all load cases of the analysis).'),
  marginalBand: z
    .number()
    .optional()
    .describe('MS value below which a passing row is MARGINAL (>= 0, in MS units). No default: without it no row is marginal.'),
  singularityRadius: z
    .number()
    .optional()
    .describe(
      'Override of the singularity exclusion radius, in DOCUMENT length units (>= 0; 0 = exclude nothing). Default: 2 x the mesh globalSize (llull default, reported as defaulted). REQUIRES singularityNote.',
    ),
  singularityNote: z
    .string()
    .optional()
    .describe('Mandatory (non-empty) engineering justification when singularityRadius is given; echoed in the result data.'),
  acceptInadequateMesh: z
    .boolean()
    .optional()
    .describe(
      "Default false: when the mesh of the results is inadequate (too few element layers through a wall, data.meshAdequacy) every row is not_assessed with FEA_MESH_INADEQUATE and the overall verdict is never pass. true: numeric margins are computed anyway and data.overrides records acceptInadequateMesh. Set it only on the engineer's explicit decision; the better fix is a finer mesh.",
    ),
};

export type MarginQuery = z.output<z.ZodObject<typeof marginQueryShape>>;

export interface MarginTable {
  readonly analysis: AnalysisCase;
  readonly rows: readonly MarginRow[];
  readonly summary: string;
  readonly data: Record<string, unknown>;
}

export interface MarginRefusal {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

type Adequacy = ReturnType<typeof adequacyOf>;
type Gate = GatedRows<MarginRow>;

/** The mesh-adequacy gate over the built rows and the composite warnings; no row left to report is a refusal. */
function gatedRows(
  analysis: AnalysisCase,
  built: { readonly rows: MarginRow[]; readonly skipped: ReadonlyMap<string, string> },
  artifacts: { readonly mesh: FeMeshArtifact; readonly results: FeResultsArtifact },
  acceptInadequateMesh: boolean,
): { readonly gate: Gate; readonly composite: string[]; readonly adequacy: Adequacy } | MarginRefusal {
  const adequacy = adequacyOf(artifacts.results, artifacts.mesh);
  const gate = gateRows(built.rows, adequacy, acceptInadequateMesh);
  const rows = gate.rows;
  const withRows = new Set(rows.map((row) => String(row['part'])));
  const composite = compositeWarnings(analysis, new Map([...built.skipped].filter(([entityId]) => !withRows.has(entityId))));
  if (rows.length === 0 && composite.length > 0)
    return refusalFor(
      analysis.id,
      'FEA_COMPOSITE_MARGINS_UNSUPPORTED',
      composite.map((text) => text.replace(/^FEA_COMPOSITE_MARGINS_UNSUPPORTED: /, '')).join('; '),
    );
  if (rows.length === 0)
    return refusalFor(
      analysis.id,
      'FEA_MARGIN_PARAM_INVALID',
      'no margin row to compute (yield checks need a limit load case, and the groups need stress values)',
    );
  return { gate, composite, adequacy };
}

/** What the table's data and summary are written from. */
interface Tabulated {
  readonly analysis: AnalysisCase;
  readonly mesh: FeMeshArtifact;
  readonly context: Context;
  readonly screen: ReturnType<typeof screenSingularities>;
  readonly gate: Gate;
  readonly adequacy: Adequacy;
  readonly composite: readonly string[];
  readonly lowest: MarginRow | null;
}

function marginData(t: Tabulated): Record<string, unknown> {
  const { analysis, mesh, context, screen, gate, adequacy, composite, lowest } = t;
  const { criterion, groupBy, marginalBand } = context;
  const rows = gate.rows;
  return {
    analysisId: analysis.id,
    unitSystem: analysis.unitSystem,
    resultsHash: analysis.results?.resultsHash ?? '',
    criterion,
    groupBy,
    marginalBand: marginalBand ?? null,
    minMs: lowest?.ms ?? null,
    minMsRow: lowest?.rowId ?? null,
    factors: factorReport(analysis),
    rows,
    singularScreening: screen.data,
    overall: overallOf(rows),
    meshAdequacy: adequacy,
    ...(gate.overrides.length > 0 ? { overrides: gate.overrides } : {}),
    warnings: [
      ...adequacyWarnings(gate, adequacy),
      ...(marginalBand === undefined ? ['FEA_MARGINAL_BAND_UNSET: no marginalBand given, so no row is MARGINAL'] : []),
      ...composite,
      ...dispositionWarnings(rows),
      ...exclusionWarnings(mesh, screen.excluded),
      ...orphanSingularKeys(rows).map(
        (key) => `FEA_MS_ALL_SINGULAR: group ${key} lies entirely in a singular zone: it has only a singular row and no margin`,
      ),
      ...(analysis.type === 'thermo_static' ? temperatureWarnings(context.temperatures, propertyTemperatureK(analysis), rows) : []),
    ],
    reviewRequired: true,
  };
}

function marginSummary(t: Tabulated): string {
  const { analysis, gate, adequacy, lowest } = t;
  const rows = gate.rows;
  const pending = rows.filter((row) => row.disposition === 'pending_human').length;
  const decided = rows.filter(
    (row) => row.status !== 'PASS' && row.status !== 'NOT_ASSESSED' && row.disposition !== 'pending_human',
  ).length;
  const unverified = rows.filter((row) => row['unverified'] === true).length;
  const singularCount = rows.filter((row) => row['singular'] === true).length;
  const factors = factorReport(analysis);
  const worst = gate.gated
    ? notAssessedText(gate.reasons)
    : lowest === null
      ? 'no finite margin'
      : `min MS ${significantNumber(lowest.ms ?? 0, 4)} (${String(lowest['statusLabel'])}, ${lowest.rowId} ${String(lowest['loadCase'])}, part ${String(lowest['part'])})`;
  return `compute_margins: '${analysis.id}' ${rows.length} row(s), ${worst}${adequacy.verdict === 'marginal' ? '; FEA_MESH_MARGINAL: a thin region of the mesh is under-resolved (not gated, see data.warnings)' : ''}; ${pending} pending a human disposition${decided > 0 ? `, ${decided} dispositioned by a human (status unchanged)` : ''}, ${unverified} unverified${singularCount > 0 ? `, ${singularCount} singular row(s) excluded from min MS` : ''}; factors ultimate ${factors.ultimate.value} (${factors.ultimate.defaulted ? 'DEFAULT 14 CFR 25.303, not set by the user' : 'set via create_analysis'}), yield ${factors.yield.value} (${factors.yield.defaulted ? 'DEFAULT, not set by the user' : 'set via create_analysis'}). Computed by llull, not approved: needs a qualified engineer.`;
}

/**
 * The margin table of `analysisId` for `query` (what `compute_margins` returns), or the refusal; shared with `dispose_margin` and `check_analysis`.
 * @failure see `computeMargins`
 */
export function marginTable(
  doc: CadDocument,
  analysisId: string,
  query: MarginQuery,
  ctx: ExecutionContext | undefined,
): MarginTable | MarginRefusal {
  const { groupBy = 'part', marginalBand } = query;
  const refuse = (code: string, message: string): MarginRefusal => refusalFor(analysisId, code, message);
  const analysis = caseOf(doc, analysisId);
  if (analysis === undefined) return refuse('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`);
  if (marginalBand !== undefined && !(Number.isFinite(marginalBand) && marginalBand >= 0))
    return refuse('FEA_MARGIN_PARAM_INVALID', `marginalBand ${marginalBand} must be a finite number >= 0`);
  if (query.criterion === 'limit_load') return limitLoadMarginTable(doc, analysis, query, ctx);
  if (query.criterion === 'joint') return jointMarginTable(doc, analysis, query, ctx);
  const queryProblem = queryRefusal(analysis, analysisId, query);
  if (queryProblem !== null) return queryProblem;
  const criterion = query.criterion ?? 'von_mises';
  const { singularityRadius, singularityNote } = query;
  const artifacts = verifiedArtifacts(analysis, trustedRecord(doc, analysis, ctx?.feaArtifacts));
  if ('code' in artifacts) return artifacts;
  const { mesh, results } = artifacts;
  const screen = screenSingularities(
    doc,
    analysis,
    mesh,
    singularityRadius === undefined ? undefined : { radius: singularityRadius, note: (singularityNote ?? '').trim() },
  );
  const context: Context = {
    singular: screen.excluded,
    doc,
    analysis,
    mesh,
    results,
    criterion,
    allowable: query.allowable,
    marginalBand,
    groupBy,
    loadCaseFilter: query.loadCases === undefined ? undefined : new Set(query.loadCases),
    port: ctx?.humanSignature ?? null,
    temperatures: analysis.type === 'thermo_static' ? solvedNodeTemperatures(doc, analysis, mesh, ctx?.feaArtifacts ?? null) : null,
  };
  const built = buildRows(context);
  if ('code' in built) return refuse(built.code, built.message);
  const gated = gatedRows(analysis, built, { mesh, results }, query.acceptInadequateMesh === true);
  if ('code' in gated) return gated;
  const { gate, composite, adequacy } = gated;
  const rows = gate.rows;
  const finite = rows.filter((row) => row.ms !== null && row['singular'] !== true);
  const lowest = finite.reduce<MarginRow | null>((best, row) => (best === null || (row.ms ?? 0) < (best.ms ?? 0) ? row : best), null);
  const tabulated: Tabulated = { analysis, mesh, context, screen, gate, adequacy, composite, lowest };
  return { analysis, rows, summary: marginSummary(tabulated), data: marginData(tabulated) };
}

/**
 * @invariant read-only; every number comes from the results artifact re-verified by `trustedRecord` (05 §4.1); every factor is named with
 *   source + defaulted (AF-31); every row has reviewRequired: true (AF-33), unverified = OR of the allowable, E/nu (and CTE) flags (AF-32);
 *   FAIL / MARGINAL rows are disposition pending_human until dispose_margin records a human decision whose signature still verifies (the status
 *   never changes: statusLabel reads `FAIL (accepted)`); every row has a stable rowKey; nodes within the singularity radius of a point / edge load or support are excluded from the
 *   part / target rows and reported in separate singular rows (singular: true, rowKey suffix |singular, after the regular rows) that never count
 *   towards minMs; re-entrant edges are NOT screened; the mesh adequacy (always measured on the mesh artifact; the verdict recorded on the results is display only; unmeasured gates like inadequate; marginal is a warning) gates every
 *   row: an inadequate result gives rows status NOT_ASSESSED / state not_assessed / code FEA_MESH_INADEQUATE, ms null, data.overall never pass, unless
 *   acceptInadequateMesh: true, which restores the numeric rows and records data.overrides
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not static / thermo_static -> FEA_ANALYSIS_TYPE_UNSUPPORTED; stale results ->
 *   FEA_RESULTS_STALE; no verified results -> FEA_RESULTS_MISSING; recorded summary differs from its artifact -> FEA_SUMMARY_MISMATCH;
 *   no allowable -> FEA_MATERIAL_NO_ALLOWABLE; bad load case / band / yield on ultimate-only cases / singularityRadius < 0 or without a
 *   singularityNote -> FEA_MARGIN_PARAM_INVALID (refusals)
 */
export const computeMargins = defineCommand({
  name: 'compute_margins',
  description:
    'Compute margins of safety of a SOLVED static or thermo_static analysis (or, criterion limit_load, of a solved nonlinear_static one: see limitLoad) from its results artifact (never from the document ' +
    'summary): per load case and part (groupBy part) or per constraint / load target (groupBy target), the maximum von Mises stress (or ' +
    'the largest magnitude of s_xx / s_yy / s_zz) over the nodes, against allowables. allowable omitted = both checks from the part ' +
    'material PHY-01 property models Ftu and Fty: for a thermo_static case read at the SOLVED temperature (the lower value at the coldest and hottest node of the part / target, ' +
    'the temperature used is reported per row as allowableTemperatureK; a constant model or explicit value is flagged FEA_ALLOWABLE_NOT_TEMPERATURE_DEPENDENT, no field FEA_ALLOWABLE_TEMPERATURE_UNKNOWN and then the case reference temperature is used), for a static case at 20 degC: on a LIMIT load ' +
    'case MS_ult = Ftu / (applied x ultimate factor x extras) - 1 and MS_yield = Fty / (applied x yield factor x extras) - 1; on an ' +
    'ULTIMATE load case only MS_ult = Ftu / (applied x extras) - 1. allowable "ftu" / "fty" runs one check; { value, unit, against? } is ' +
    'an explicit allowable for all parts (against ultimate by default; always flagged unverified). The factors come from the case ' +
    '(create_analysis factors, or factor = one number for both; defaults 1.5 per 14 CFR 25.303 and 1.0 apply silently unless the user states a safety factor, so map "SF 2" to factor 2 there) and are listed with source and defaulted. Status: FAIL if MS < 0, ' +
    'MARGINAL only when marginalBand is given and MS < band (no default band), else PASS; FAIL / MARGINAL rows are disposition ' +
    'pending_human until a qualified human records dispose_margin (an agent cannot: FEA_HUMAN_GATE); a disposition never changes the status ' +
    '(statusLabel "FAIL (accepted)") and every row has a stable rowKey. Shell / plane-stress nodes use the largest of the membrane and the top / bottom fibre stress (row fibre). Composite shells (a laminate in the part idealization) get one row PER PLY (criterion ply_failure, rowKey ending in the ply id): the ply stresses are recovered through the 06 CMP laminate from the STRESS_TOP / STRESS_BOT fibre stresses (CLT, linear through the thickness, in-plane first-ply failure, no hygrothermal state, ultimate check only, allowable and criterion params do not apply) and MS = R / (factor) - 1 with R the lower of the max-stress and Tsai-Wu strength ratios (both reported, plus the governing one); a laminate whose lamina lacks Xt, Xc, Yt, Yc or S, a non-planar shell or results without both fibre stresses get no rows (warning FEA_COMPOSITE_MARGINS_UNSUPPORTED with the reason; a refusal when nothing else is left). Every row has reviewRequired: true and unverified = OR of the input flags. Singularity policy: nodes within a radius of a point / edge ' +
    'force or moment load and of a point / edge support of a SOLID part (targets with no mesh face; shell / plane-stress edge supports are not sources) are excluded from the part / target rows (FEA_MS_ALL_SINGULAR / FEA_SINGULAR_EXCLUSION_LARGE warnings when that swallows a group or > 25 % of a part) and reported in ' +
    'separate rows (region "singular", singular true, a note) that never count towards minMs / minMsRow (status still computed and shown). ' +
    'Radius default = 2 x mesh globalSize (named llull default, defaulted true in data.singularScreening.radius); singularityRadius ' +
    '(document length units, 0 = exclude nothing) overrides it and REQUIRES singularityNote (engineer justification, echoed in data), else ' +
    'FEA_MARGIN_PARAM_INVALID. Re-entrant corners / sharp edges are NOT screened (needs geometry, deferred): judge them yourself. Refused with ' +
    'FEA_RESULTS_STALE when inputs changed since the solve (run fea_mesh and fea_solve), FEA_RESULTS_MISSING without a verified results ' +
    'artifact, FEA_MATERIAL_NO_ALLOWABLE when a part has no Ftu / Fty for the check and no explicit allowable. MESH ADEQUACY: the through-thickness verdict is ALWAYS measured on the mesh artifact (data.meshAdequacy: adequate | marginal | inadequate, element layers through the wall per part and order; a verdict recorded on the results is display only; an unavailable mesh is unmeasured and gates like inadequate; a thin spot under half the budget is inadequate, under 75 % marginal = warning FEA_MESH_MARGINAL, not gated); on an inadequate mesh every row is not_assessed (status NOT_ASSESSED, code FEA_MESH_INADEQUATE, ms null) and data.overall is never pass: refine the mesh (fea_mesh) or pass acceptInadequateMesh: true on the explicit decision of the engineer (recorded in data.overrides). data.overall is pass | marginal | fail | not_assessed. Values are in the analysis ' +
    'unit system (N-mm-t-s: MPa, mm) and field names carry the unit.',
  annotations: { readOnly: true },
  params: z.object({ analysisId: analysisIdSchema, ...marginQueryShape }),
  run: (doc, params, ctx): CommandResult => {
    const { analysisId, ...query } = params;
    const table = marginTable(doc, analysisId, query, ctx);
    return 'code' in table ? refuseMargins(doc, table.code, table.message, table.ids) : report(doc, table.summary, table.data);
  },
});
