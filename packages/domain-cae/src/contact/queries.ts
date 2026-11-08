/** contact_report and check_contact: contact results and set-up checks of a nonlinear_static case (PHY-06 FR-CNT-04, FR-CNT-17). */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord, type Trust } from '../shared/trust';
import { isRefusal, nonlinearCase } from '../nonlinear/settings';
import { lengthUnitName, stressUnitName, toAnalysisLength } from '../decks/units';
import { NOT_APPROVED, refuseCnt } from './codes';
import { boltItems, overclosureItems, resultItems, sectionItems, setupItems, type ContactItem } from './check';
import { boltReport } from './boltReport';
import { defaultStickSlope } from './defaults';
import { findPair } from './pairRules';
import { forceUnitName } from './pretensionRules';
import { CLAMP_ZONE_RADIUS_DIAMETERS, type BoltRow } from './pretensionResults';
import { SLIDING_FRACTION, contactRows } from './reader';

/** Most rows one contact_report returns (AF-12); narrow with pair / step. */
const MAX_ROWS = 500;

const n = (value: number): string => significantNumber(value, 4);

/** Summary text of the bolt rows (first 4) and the number of separated joints. */
function boltText(rows: readonly BoltRow[], separated: number, force: string): string {
  if (rows.length === 0) return '';
  const lines = rows
    .slice(0, 4)
    .map((row) => `${row.pretensionId}/${row.stepId}: N ${n(row.axialForce)} ${force}, M_bend ${n(row.bendingMoment)}`);
  return `; bolts ${lines.join('; ')}${separated > 0 ? `; ${separated} joint(s) SEPARATED` : ''}`;
}

/** Refusal code of a case whose results cannot be read. */
function unreadable(trust: Trust): readonly [string, string] | null {
  if (trust.state === 'solved' && trust.resultsArtifact !== null && trust.meshArtifact !== null) return null;
  if (trust.state === 'stale') return ['FEA_RESULTS_STALE', 'the inputs changed after the solve: re-run fea_mesh and fea_solve'];
  if (trust.state === 'untrusted')
    return ['FEA_SUMMARY_MISMATCH', trust.problem?.message ?? 'a recorded summary differs from its artifact'];
  return ['FEA_RESULTS_MISSING', trust.problem?.message ?? 'no results yet: run fea_mesh and fea_solve'];
}

/** Pair descriptors with the named CalculiX defaults (FR-CNT-02, AF-31). */
function pairRecords(doc: CadDocument, analysis: AnalysisCase): Record<string, unknown>[] {
  const settings = analysis.contact;
  const stick = defaultStickSlope(doc, analysis);
  return (settings?.pairOrder ?? []).flatMap((pairId) => {
    const pair = settings?.pairs[pairId];
    if (pair === undefined) return [];
    const friction =
      pair.friction === undefined
        ? null
        : {
            mu: pair.friction.mu,
            stickSlope: pair.friction.stickSlope === undefined ? stick : { value: pair.friction.stickSlope, defaulted: false },
          };
    return [
      {
        pairId: pair.id,
        name: pair.name,
        slave: pair.slave.entityId,
        master: pair.master.entityId,
        behaviour: pair.behaviour,
        friction,
        adjust: pair.adjust ?? null,
        activeSteps: pair.activeSteps ?? null,
      },
    ];
  });
}

/**
 * @invariant read-only; numbers only from results re-verified against the artifact store (trustedRecord); every result reviewRequired and
 *   frd CONTACT layout pinned to a CalculiX 2.21 output (fixture ccx221_contact_excerpt.frd); at most 500 rows (truncated flag)
 * @failure unknown / non-nonlinear case -> FEA_ANALYSIS_NOT_FOUND / NLS_CASE_NOT_NONLINEAR; no pairs or unknown pair -> CNT_PAIR_NOT_FOUND;
 *   unknown step -> NLS_STEP_NOT_FOUND; stale -> FEA_RESULTS_STALE; no / unverifiable results -> FEA_RESULTS_MISSING / FEA_SUMMARY_MISMATCH;
 *   no CONTACT block -> CNT_CONTACT_RESULTS_MISSING (refusals, unchanged doc)
 */
export const contactReport = defineCommand({
  name: 'contact_report',
  description:
    'Contact results of a solved nonlinear_static analysis with contact pairs, as data: per pair and step (last increment, or every stored ' +
    'increment with increments "all") the slave area and its closed / sliding fractions, max contact pressure with node and position, mean ' +
    'pressure over the closed area, normal force (pressure x area), max penetration, max slip and the bounding box of the closed nodes ' +
    '(contact half-width of a roller = closedBox width / 2). Lengths / stresses in the analysis unit system. Also returns each pair with its ' +
    'friction and the named CalculiX stick-slope default. Forces integrate the nodal (extrapolated) pressures: exact for a uniform pressure, ' +
    'a few % high where the pressure peaks at edges (measured +4 % on a sliding block); every result is reviewRequired. Compare with ' +
    'hertz_contact; finish with check_contact. With bolt pretensions (add_bolt_pretension) it also returns bolts [{ pretensionId, stepId, preload, ' +
    'axialForce (tension +), shearForce, bendingMoment, torsion, shortening }] from the stress on the section faces, clamp [{ pretensionId, pairId, ' +
    'stepId, closedFraction }] (contact pairs within 1.5 bolt diameters of the axis) and separated [{ pretensionId, pairId, stepId, time }] (a pair fully ' +
    'open around a bolt). A case with pretensions and no pair is accepted.',
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    pair: z.string().optional().describe('Only this pair (id or unique name); absent = all pairs.'),
    step: z.string().optional().describe('Only this step (id or unique name); absent = all steps.'),
    increments: z
      .enum(['summary', 'all'])
      .optional()
      .describe('"summary" (default): last stored increment per step; "all": every stored increment.'),
  }),
  run: (doc, params, ctx?: ExecutionContext): CommandResult => {
    const command = 'contact_report';
    const found = nonlinearCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseCnt(doc, command, code, message, [analysis.id], [path]);
    if (analysis.contact === undefined && analysis.pretension === undefined)
      return fail(
        'CNT_PAIR_NOT_FOUND',
        `analysis '${analysis.id}' has no contact pairs or bolt pretensions (add_contact_pair, add_bolt_pretension)`,
        'analysisId',
      );
    const pair = params.pair === undefined ? undefined : findPair(analysis.contact, params.pair);
    if (params.pair !== undefined && pair === undefined) return fail('CNT_PAIR_NOT_FOUND', `no contact pair '${params.pair}'`, 'pair');
    const steps = analysis.nonlinear?.steps ?? {};
    const stepId =
      params.step === undefined
        ? undefined
        : Object.hasOwn(steps, params.step)
          ? params.step
          : Object.values(steps).find((step) => step.name === params.step)?.id;
    if (params.step !== undefined && stepId === undefined) return fail('NLS_STEP_NOT_FOUND', `no step '${params.step}'`, 'step');
    const trust = trustedRecord(doc, analysis, ctx?.feaArtifacts);
    const blocked = unreadable(trust);
    if (blocked !== null || trust.meshArtifact === null || trust.resultsArtifact === null)
      return fail(blocked?.[0] ?? 'FEA_RESULTS_MISSING', blocked?.[1] ?? 'no results', 'analysisId');
    const rows =
      analysis.contact === undefined
        ? []
        : contactRows(analysis, trust.meshArtifact, trust.resultsArtifact, params.increments ?? 'summary');
    if (!Array.isArray(rows)) return fail(rows.code, rows.message, 'analysisId');
    const bolts = boltReport(doc, analysis, trust.meshArtifact, trust.resultsArtifact, params.increments ?? 'summary');
    if ('code' in bolts) return refuseCnt(doc, command, bolts.code, bolts.message, bolts.ids, ['analysisId']);
    const boltRowsShown = bolts.bolts.filter((row) => stepId === undefined || row.stepId === stepId);
    const wanted = rows.filter((row) => (pair === undefined || row.pairId === pair.id) && (stepId === undefined || row.stepId === stepId));
    const shown = wanted.slice(0, MAX_ROWS);
    const length = lengthUnitName(analysis.unitSystem);
    const stress = stressUnitName(analysis.unitSystem);
    const forceName = forceUnitName(analysis.unitSystem);
    const lines = shown
      .slice(0, 6)
      .map(
        (row) =>
          `${row.pairId}/${row.stepId}: closed ${n(100 * row.closedAreaFraction)} %, p_max ${row.maxPressure === null ? 0 : n(row.maxPressure.value)} ${stress}, penetration ${n(row.maxPenetration)} ${length}, slip ${n(row.maxSlip)} ${length}`,
      );
    return report(
      doc,
      `${command}: '${analysis.id}' ${analysis.contact?.formulation ?? 'no contact pairs'}, ${wanted.length} row(s)${wanted.length > shown.length ? ` (first ${MAX_ROWS})` : ''}${lines.length > 0 ? `; ${lines.join('; ')}` : ''}${boltText(boltRowsShown, bolts.separated.length, forceName)}. ${NOT_APPROVED}`,
      {
        analysisId: analysis.id,
        formulation: analysis.contact?.formulation ?? null,
        units: { length, stress, area: `${length}^2`, force: forceName, moment: `${forceName}*${length}` },
        pairs: pairRecords(doc, analysis),
        rows: shown,
        bolts: boltRowsShown,
        clamp: bolts.clamp,
        separated: bolts.separated,
        truncated: wanted.length > shown.length,
        provenance: {
          resultsHash: analysis.results?.resultsHash ?? null,
          inputHash: analysis.results?.inputHash ?? null,
          reader: 'frd CONTACT block (COPEN, CSLIP1, CSLIP2, CPRESS, CSHEAR1, CSHEAR2) at the slave nodes',
          area: 'tributary corner areas of the slave faces (face area / 3 per corner); forces integrate the nodal pressures (high where pressure peaks at edges)',
          sliding: `closed node with |shear| >= ${SLIDING_FRACTION} x mu x pressure`,
          bolts:
            'force = (nodal stress . area) . n summed over the cut faces of the section (tension positive along its normal); moments about the section centroid; shortening = reference node U1',
          separation: `a pair is separated when no slave node within ${CLAMP_ZONE_RADIUS_DIAMETERS} bolt diameters of the axis carries contact pressure; increments of the preload step before its last are not judged`,
        },
        reviewRequired: true,
      },
    );
  },
});

const statusOf = (items: readonly ContactItem[]): 'pass' | 'warn' | 'fail' =>
  items.some((entry) => entry.severity !== 'warning') ? 'fail' : items.length > 0 ? 'warn' : 'pass';

/**
 * @invariant read-only; set-up items always; initial overclosure only on a current, re-verified mesh; result items only on re-verified results
 *   (stale results give FEA_RESULTS_STALE); status fail on any error / fail item, warn on warnings only; reviewRequired always
 * @failure unknown / non-nonlinear case -> FEA_ANALYSIS_NOT_FOUND / NLS_CASE_NOT_NONLINEAR; penetrationTolerance <= 0 -> CNT_INPUT_INVALID
 */
export const checkContact = defineCommand({
  name: 'check_contact',
  description:
    'Check the contact set-up and results of a nonlinear_static analysis; run it before fea_solve and again after. Set-up: the PHY-05 ' +
    'nonlinear items, every pair against the case (targets, one formulation, tied / smallSliding rules, values, steps), parts held only by ' +
    'contact (CNT_RIGID_BODY_BY_CONTACT_ONLY). On a current mesh: initial overclosure of the slave nodes beyond adjust ' +
    '(CNT_INITIAL_OVERCLOSURE). On current results: non-convergence (CNT_CONTACT_NOT_CONVERGED), penetration above penetrationTolerance ' +
    '(CNT_PENETRATION_EXCESSIVE; CNT_PENETRATION_TOLERANCE_UNSET when not given), slip on pairs marked noSlipRequired (CNT_SLIP). Bolt pretensions: ' +
    'each bolt against the case (CNT_PRETENSION_*, CNT_STEP_UNKNOWN), the cut on the mesh (CNT_PRETENSION_SECTION_INVALID), a section force that misses ' +
    'the preload by > 5 % (CNT_PRELOAD_MISMATCH), a joint that separates (CNT_SEPARATED, fail). Returns ' +
    'data { analysisId, state, status pass | warn | fail, items [{ code, severity, ids, message, remediation }], notes, reviewRequired }.',
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    penetrationTolerance: z
      .object({
        value: z.number().describe('Largest acceptable penetration, document length units (> 0).'),
        source: z.string().min(1).describe('Who / what sets it (programme rule, reviewer).'),
      })
      .optional()
      .describe('Penetration tolerance for the result check (no default).'),
  }),
  run: (doc, params, ctx?: ExecutionContext): CommandResult => {
    const command = 'check_contact';
    const found = nonlinearCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const tolerance = params.penetrationTolerance;
    if (tolerance !== undefined && !(Number.isFinite(tolerance.value) && tolerance.value > 0))
      return refuseCnt(
        doc,
        command,
        'CNT_INPUT_INVALID',
        'penetrationTolerance.value must be > 0',
        [analysis.id],
        ['penetrationTolerance.value'],
      );
    const items = setupItems(doc, analysis);
    const notes: string[] = [];
    if (analysis.contact === undefined && analysis.pretension === undefined)
      notes.push('the case has no contact pairs or bolt pretensions');
    const trust = trustedRecord(doc, analysis, ctx?.feaArtifacts);
    const scale = toAnalysisLength(doc, analysis.unitSystem, 1);
    if (analysis.pretension !== undefined && trust.meshArtifact !== null && (trust.state === 'meshed' || trust.state === 'solved'))
      items.push(...sectionItems(doc, analysis, trust.meshArtifact));
    if (analysis.contact !== undefined && trust.meshArtifact !== null && (trust.state === 'meshed' || trust.state === 'solved')) {
      const overclosure = overclosureItems(analysis, trust.meshArtifact, scale);
      items.push(...overclosure.items);
      if (overclosure.unmeasured.length > 0)
        notes.push(`initial overclosure not measured for ${overclosure.unmeasured.join(', ')} (no faces or too large)`);
    } else if (analysis.contact !== undefined)
      notes.push(`initial overclosure not measured: no current verified mesh (state ${trust.state}; run fea_mesh)`);
    if (trust.state === 'stale')
      items.push({
        code: 'FEA_RESULTS_STALE',
        severity: 'warning',
        ids: [analysis.id],
        message: 'results are stale: re-run fea_mesh and fea_solve',
        remediation: 'run fea_mesh and fea_solve again',
      });
    if (
      (analysis.contact !== undefined || analysis.pretension !== undefined) &&
      trust.state === 'solved' &&
      trust.meshArtifact !== null &&
      trust.resultsArtifact !== null
    ) {
      const rows = analysis.contact === undefined ? [] : contactRows(analysis, trust.meshArtifact, trust.resultsArtifact);
      if (Array.isArray(rows)) items.push(...resultItems(analysis, trust.results, rows, tolerance, scale));
      else items.push({ code: rows.code, severity: 'error', ids: [analysis.id], message: rows.message, remediation: 'see contact_report' });
      const bolts = boltReport(doc, analysis, trust.meshArtifact, trust.resultsArtifact, 'summary');
      if ('code' in bolts)
        items.push({ code: bolts.code, severity: 'error', ids: bolts.ids, message: bolts.message, remediation: 'see contact_report' });
      else items.push(...boltItems(analysis, bolts));
    } else notes.push('no current results: result checks skipped');
    const status = statusOf(items);
    return report(
      doc,
      `${command}: '${analysis.id}' ${status} (${items.length} item(s)${items.length > 0 ? `: ${[...new Set(items.map((entry) => entry.code))].join(', ')}` : ''}). ${NOT_APPROVED}`,
      { analysisId: analysis.id, state: trust.state, status, items, notes, reviewRequired: true },
    );
  },
});
