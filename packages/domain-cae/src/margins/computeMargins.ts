/** compute_margins (05 §5.8, AF-31..36): margins of safety from the TRUSTED results artifact of a static / thermo_static analysis. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, LoadCategory } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { loadCasesOf } from '../decks/context';
import { elasticConstants, isElasticRefusal, propertyTemperatureK } from '../decks/elastic';
import { lengthUnitName, stressPerMpa, stressUnitName } from '../decks/units';
import { maxOverNodes, nodeCoordinates, nodeEntities, stepOfLoadCase, vonMises } from '../results/fields';
import { caseOf } from '../shared/access';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import { checkThermomechItems } from '../thermomech/check';
import { explicitAllowable, isAllowableRefusal, materialAllowable, type Allowable, type AllowableRefusal } from './allowable';
import { appliedFactor, factorReport, marginOfSafety, statusOf, type CheckKind, type MarginStatus } from './marginMath';
import { refuseMargins } from './refusal';

const CRITERIA = ['von_mises', 's_xx', 's_yy', 's_zz'] as const;
type Criterion = (typeof CRITERIA)[number];
const COMPONENT: Readonly<Record<Exclude<Criterion, 'von_mises'>, number>> = { s_xx: 0, s_yy: 1, s_zz: 2 };

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

interface Group {
  readonly entityId: string;
  readonly region: string;
  readonly nodes: readonly number[];
}

/** Part groups (every node of the part's elements) or target groups (the nodes of each constraint / load target, split by owning part). */
function groupsOf(analysis: AnalysisCase, mesh: FeMeshArtifact, groupBy: 'part' | 'target'): Group[] {
  if (groupBy === 'part') {
    const byPart = new Map<string, Set<number>>();
    for (const block of mesh.blocks) {
      const nodes = byPart.get(block.entityId) ?? new Set<number>();
      for (const element of block.elements) for (const node of element.slice(1)) nodes.add(node);
      byPart.set(block.entityId, nodes);
    }
    return Object.keys(analysis.parts).flatMap((entityId) => {
      const nodes = byPart.get(entityId);
      return nodes === undefined ? [] : [{ entityId, region: 'part', nodes: [...nodes] }];
    });
  }
  const owner = nodeEntities(mesh);
  const groups: Group[] = [];
  for (const key of Object.keys(mesh.nodeSets).sort()) {
    if (!key.startsWith('C_') && !key.startsWith('L_')) continue;
    const split = new Map<string, number[]>();
    for (const node of mesh.nodeSets[key] ?? []) {
      const entityId = owner.get(node) ?? '';
      split.set(entityId, [...(split.get(entityId) ?? []), node]);
    }
    for (const [entityId, nodes] of split) groups.push({ entityId, region: key, nodes });
  }
  return groups;
}

/** Largest criterion value over `nodes` of a STRESS field (component criteria: largest magnitude). */
function appliedOver(
  stress: NonNullable<ReturnType<typeof stepOfLoadCase>>['fields'][string] | undefined,
  nodes: readonly number[],
  criterion: Criterion,
): { readonly node: number; readonly value: number } | null {
  const wanted = new Set(nodes);
  const scalar = (values: readonly number[]): number =>
    criterion === 'von_mises' ? vonMises(values) : Math.abs(values[COMPONENT[criterion]] ?? Number.NaN);
  const subset = Object.fromEntries(Object.entries(stress?.values ?? {}).filter(([id]) => wanted.has(Number(id))));
  return maxOverNodes({ values: subset }, scalar);
}

interface MarginRow {
  readonly rowId: string;
  readonly ms: number | null;
  readonly status: MarginStatus;
  readonly disposition: string;
  readonly [key: string]: unknown;
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
function allowableFor(context: Context, entityId: string, check: CheckKind): Allowable | AllowableRefusal {
  const { doc, analysis, allowable } = context;
  if (typeof allowable === 'object') return explicitAllowable(allowable.value, allowable.unit);
  const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
  const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  if (materialId === undefined || material === undefined)
    return {
      code: 'FEA_MATERIAL_NO_ALLOWABLE',
      message: `part '${entityId}' has no material, so no allowable (pass allowable { value, unit })`,
    };
  return materialAllowable(material, materialId, check === 'ultimate' ? 'Ftu' : 'Fty', propertyTemperatureK(analysis));
}

function buildRows(
  context: Context,
): { readonly rows: MarginRow[] } | AllowableRefusal | { readonly code: string; readonly message: string } {
  const { analysis, mesh, results, criterion, marginalBand } = context;
  const factors = factorReport(analysis);
  const stress = stressUnitName(analysis.unitSystem);
  const length = suffix(lengthUnitName(analysis.unitSystem));
  const perMpa = stressPerMpa(analysis.unitSystem);
  const coordinates = nodeCoordinates(mesh);
  const rows: MarginRow[] = [];
  const groups = groupsOf(analysis, mesh, context.groupBy);
  const cases = loadCasesOf(analysis);
  for (const [index, { name, category }] of cases.entries()) {
    if (context.loadCaseFilter !== undefined && !context.loadCaseFilter.has(name)) continue;
    const field = stepOfLoadCase(results, index)?.fields['STRESS'];
    if (field === undefined)
      return {
        code: 'FEA_RESULTS_MISSING',
        message: `the results have no STRESS field for load case '${name}' (solver step ${index + 1})`,
      };
    for (const group of groups) {
      const applied = appliedOver(field, group.nodes, criterion);
      if (applied === null) continue;
      const materialId = Object.hasOwn(context.doc.entities, group.entityId) ? context.doc.entities[group.entityId]?.materialId : undefined;
      for (const check of checksFor(category, context.allowable)) {
        const found = allowableFor(context, group.entityId, check);
        if (isAllowableRefusal(found)) return found;
        const factor = appliedFactor(factors, check, category);
        const ms = marginOfSafety(found.valueMpa * perMpa, applied.value, factor);
        const status = statusOf(ms, marginalBand);
        const reasons = [...new Set([...found.unverifiedReasons, ...unverifiedReasonsOf(context, group.entityId, materialId)])];
        const at: Vec3 = coordinates.get(applied.node) ?? [0, 0, 0];
        rows.push({
          rowId: `r${rows.length + 1}`,
          part: group.entityId,
          region: group.region,
          loadCase: name,
          category,
          check,
          criterion,
          [`applied${stress === 'psi' ? 'Psi' : stress}`]: applied.value,
          [`allowable${stress === 'psi' ? 'Psi' : stress}`]: found.valueMpa * perMpa,
          allowable: { property: found.property, basis: found.basis, provenance: found.provenance },
          factorApplied: factor,
          ms,
          status,
          ...(status === 'FAIL' ? { code: 'FEA_MS_NEGATIVE' } : status === 'MARGINAL' ? { code: 'FEA_MS_MARGINAL' } : {}),
          node: applied.node,
          [`at${length}`]: at,
          singular: false,
          provenance: {
            formula: 'MS = allowable / (applied x FoS x prod(extra)) - 1',
            standard: ['NASA-STD-5001B', '14 CFR 25.303', '14 CFR 25.305(a)'],
            ...(ms === null ? { note: 'applied stress is zero: no finite margin' } : {}),
          },
          unverified: reasons.length > 0,
          unverifiedReasons: reasons,
          reviewRequired: true,
          reviewReason: 'margin of safety supports a structural substantiation decision',
          disposition: status === 'PASS' ? 'none' : 'pending_human',
        });
      }
    }
  }
  return { rows };
}

/**
 * @invariant read-only; every number comes from the results artifact re-verified by `trustedRecord` (05 §4.1); every factor is named with
 *   source + defaulted (AF-31); every row has reviewRequired: true (AF-33), unverified = OR of the allowable, E/nu (and CTE) flags (AF-32);
 *   FAIL / MARGINAL rows are disposition pending_human (no dispose_margin is built); singular zones are NOT screened (every row singular: false)
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not static / thermo_static -> FEA_ANALYSIS_TYPE_UNSUPPORTED; stale results ->
 *   FEA_RESULTS_STALE; no verified results -> FEA_RESULTS_MISSING; recorded summary differs from its artifact -> FEA_SUMMARY_MISMATCH;
 *   no allowable -> FEA_MATERIAL_NO_ALLOWABLE; bad load case / band / yield on ultimate-only cases -> FEA_MARGIN_PARAM_INVALID (refusals)
 */
export const computeMargins = defineCommand({
  name: 'compute_margins',
  description:
    'Compute margins of safety of a SOLVED static or thermo_static analysis from its results artifact (never from the document ' +
    'summary): per load case and part (groupBy part) or per constraint / load target (groupBy target), the maximum von Mises stress (or ' +
    'the largest magnitude of s_xx / s_yy / s_zz) over the nodes, against allowables. allowable omitted = both checks from the part ' +
    'material PHY-01 property models Ftu and Fty, read at the case reference temperature (thermo_static) or 20 degC: on a LIMIT load ' +
    'case MS_ult = Ftu / (applied x ultimate factor x extras) - 1 and MS_yield = Fty / (applied x yield factor x extras) - 1; on an ' +
    'ULTIMATE load case only MS_ult = Ftu / (applied x extras) - 1. allowable "ftu" / "fty" runs one check; { value, unit, against? } is ' +
    'an explicit allowable for all parts (against ultimate by default; always flagged unverified). The factors come from the case ' +
    '(create_analysis factors; defaults 1.5 per 14 CFR 25.303 and 1.0) and are listed with source and defaulted. Status: FAIL if MS < 0, ' +
    'MARGINAL only when marginalBand is given and MS < band (no default band), else PASS; FAIL / MARGINAL rows are disposition ' +
    'pending_human. Every row has reviewRequired: true and unverified = OR of the input flags. Peak stresses at point loads, supports and ' +
    're-entrant corners are NOT screened for singularities (singular is always false): judge them yourself. Refused with ' +
    'FEA_RESULTS_STALE when inputs changed since the solve (run fea_mesh and fea_solve), FEA_RESULTS_MISSING without a verified results ' +
    'artifact, FEA_MATERIAL_NO_ALLOWABLE when a part has no Ftu / Fty for the check and no explicit allowable. Values are in the analysis ' +
    'unit system (N-mm-t-s: MPa, mm) and field names carry the unit.',
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    criterion: z
      .enum(CRITERIA)
      .optional()
      .describe('Applied stress: von_mises (default) or the largest magnitude of the normal component s_xx, s_yy or s_zz.'),
    allowable: allowableSchema
      .optional()
      .describe(
        '"ftu" (ultimate check), "fty" (yield check), or { value, unit, against? }. Omit for both checks from the material models.',
      ),
    groupBy: z
      .enum(['part', 'target'])
      .optional()
      .describe('part (default): one row per part; target: per constraint / load node set and part.'),
    loadCases: z.array(z.string()).optional().describe('Load case names to include (default: all load cases of the analysis).'),
    marginalBand: z
      .number()
      .optional()
      .describe('MS value below which a passing row is MARGINAL (>= 0, in MS units). No default: without it no row is marginal.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { analysisId, groupBy = 'part', marginalBand } = params;
    const criterion = params.criterion ?? 'von_mises';
    const analysis = caseOf(doc, analysisId);
    if (analysis === undefined) return refuseMargins(doc, 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    if (analysis.type !== 'static' && analysis.type !== 'thermo_static')
      return refuseMargins(doc, 'FEA_ANALYSIS_TYPE_UNSUPPORTED', `margins need structural results; '${analysisId}' is ${analysis.type}`, [
        analysisId,
      ]);
    if (marginalBand !== undefined && !(Number.isFinite(marginalBand) && marginalBand >= 0))
      return refuseMargins(doc, 'FEA_MARGIN_PARAM_INVALID', `marginalBand ${marginalBand} must be a finite number >= 0`, [analysisId]);
    const known = loadCasesOf(analysis).map((entry) => entry.name);
    const unknown = (params.loadCases ?? []).filter((name) => !known.includes(name));
    if (unknown.length > 0)
      return refuseMargins(
        doc,
        'FEA_MARGIN_PARAM_INVALID',
        `unknown load case(s) ${unknown.join(', ')}; the analysis has ${known.join(', ')}`,
        [analysisId],
      );
    const trust = trustedRecord(doc, analysis, ctx?.feaArtifacts);
    if (trust.state === 'stale' && analysis.results !== undefined)
      return refuseMargins(doc, 'FEA_RESULTS_STALE', `the results of '${analysisId}' predate a change of its inputs`, [analysisId]);
    if (trust.state === 'untrusted')
      return refuseMargins(
        doc,
        trust.problem?.code ?? 'FEA_SUMMARY_MISMATCH',
        trust.problem?.message ?? 'the recorded summary differs from its artifact',
        [analysisId],
      );
    if (trust.resultsArtifact === null || trust.meshArtifact === null)
      return refuseMargins(
        doc,
        'FEA_RESULTS_MISSING',
        `analysis '${analysisId}' has no verified results (${trust.problem?.message ?? `state ${trust.state}`})`,
        [analysisId],
      );
    const context: Context = {
      doc,
      analysis,
      mesh: trust.meshArtifact,
      results: trust.resultsArtifact,
      criterion,
      allowable: params.allowable,
      marginalBand,
      groupBy,
      loadCaseFilter: params.loadCases === undefined ? undefined : new Set(params.loadCases),
    };
    const built = buildRows(context);
    if ('code' in built) return refuseMargins(doc, built.code, built.message, [analysisId]);
    const { rows } = built;
    if (rows.length === 0)
      return refuseMargins(
        doc,
        'FEA_MARGIN_PARAM_INVALID',
        'no margin row to compute (yield checks need a limit load case, and the groups need stress values)',
        [analysisId],
      );
    const finite = rows.filter((row) => row.ms !== null);
    const lowest = finite.reduce<MarginRow | null>((best, row) => (best === null || (row.ms ?? 0) < (best.ms ?? 0) ? row : best), null);
    const pending = rows.filter((row) => row.disposition === 'pending_human').length;
    const unverified = rows.filter((row) => row['unverified'] === true).length;
    const factors = factorReport(analysis);
    const data = {
      analysisId,
      unitSystem: analysis.unitSystem,
      resultsHash: analysis.results?.resultsHash ?? '',
      criterion,
      groupBy,
      marginalBand: marginalBand ?? null,
      minMs: lowest?.ms ?? null,
      minMsRow: lowest?.rowId ?? null,
      factors,
      rows,
      singularScreening:
        'not performed: peak stresses at point loads, supports and re-entrant corners are not screened (singular is false on every row)',
      warnings: marginalBand === undefined ? ['FEA_MARGINAL_BAND_UNSET: no marginalBand given, so no row is MARGINAL'] : [],
      reviewRequired: true,
    };
    const worst =
      lowest === null
        ? 'no finite margin'
        : `min MS ${significantNumber(lowest.ms ?? 0, 4)} (${lowest.status}, ${lowest.rowId} ${String(lowest['loadCase'])}, part ${String(lowest['part'])})`;
    return report(
      doc,
      `compute_margins: '${analysisId}' ${rows.length} row(s), ${worst}; ${pending} pending a human disposition, ${unverified} unverified; factors ultimate ${factors.ultimate.value}${factors.ultimate.defaulted ? ' (default)' : ''}, yield ${factors.yield.value}${factors.yield.defaulted ? ' (default)' : ''}. Computed by llull, not approved: needs a qualified engineer.`,
      data,
    );
  },
});
