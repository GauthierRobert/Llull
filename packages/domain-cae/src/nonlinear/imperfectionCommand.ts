/** add_imperfection / delete_imperfection: buckling-mode geometric imperfections of a nonlinear_static case (PHY-05 FR-NLS-09, TR-NLS-30). */

import type { AnalysisCase } from '@core/model/analysis';
import type { Imperfection } from '@core/model/nonlinear';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { nextId } from '@lib/id';
import { caseOf } from '../shared/access';
import { analysisIdSchema } from '../shared/schemas';
import { stateOf } from '../shared/state';
import { refuseNls } from './codes';
import { MAX_IMPERFECTIONS, MAX_IMPERFECTION_MODES, MAX_SOURCE_TEXT, imperfectionsOf } from './imperfectionShape';
import { isRefusal, nonlinearCase, nonlinearOf, withNonlinear } from './settings';

/** Parts and idealizations of two cases agree (the same mesh can only come from the same parts). */
const sameParts = (a: AnalysisCase, b: AnalysisCase): boolean => {
  const keys = Object.keys(a.parts).sort();
  return (
    keys.join('\n') === Object.keys(b.parts).sort().join('\n') &&
    keys.every((key) => JSON.stringify(a.parts[key]) === JSON.stringify(b.parts[key]))
  );
};

/** Why `source` cannot provide modes `modes` to `target`, else null. */
function sourceProblem(doc: CadDocument, target: AnalysisCase, sourceId: string, modes: readonly number[]): string | null {
  const source = caseOf(doc, sourceId);
  if (source === undefined) return `no analysis '${sourceId}'`;
  if (source.type !== 'buckling') return `'${sourceId}' is a ${source.type} case, not buckling`;
  if (!sameParts(source, target)) return `'${sourceId}' does not analyse the same parts with the same idealizations as '${target.id}'`;
  const state = stateOf(doc, source);
  if (state !== 'solved') return `'${sourceId}' is ${state}, not solved: fea_mesh + fea_solve it first`;
  const available = (source.results?.bucklingFactors ?? []).length;
  const beyond = modes.filter((mode) => mode > available);
  return beyond.length === 0 ? null : `'${sourceId}' has ${available} buckling mode(s); mode ${beyond.join(', ')} does not exist`;
}

/**
 * @affects doc.analysis.cases[analysisId].nonlinear.imperfections (adds 1 imperfection, id `imp-<step>.<k>`, appended to imperfectionOrder;
 *   affected: [imperfectionId]); the full input hash changes, so recorded nonlinear results turn stale
 * @invariant amplitude and amplitudeSource are explicit (AF-31, no default); the buckling results are pinned by hash (sourceResultsHash): the
 *   deck always reads that artifact; amplitudes in document length units
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not nonlinear_static -> NLS_CASE_NOT_NONLINEAR; a mode without amplitude, a zero or
 *   non-finite amplitude, or no amplitudeSource -> NLS_IMPERFECTION_AMPLITUDE_UNSET; a mode listed twice or too many imperfections ->
 *   NLS_CONTROL_INVALID; source missing / not buckling / other parts / not solved / too few modes -> NLS_IMPERFECTION_SOURCE_INVALID
 *   (refusals, unchanged doc)
 */
export const addImperfection = defineCommand({
  name: 'add_imperfection',
  description:
    'Give a nonlinear_static analysis a geometric imperfection taken from the mode shapes of a SOLVED buckling analysis (fromAnalysisId: same ' +
    'parts and mesh controls, meshed and solved with fea_mesh + fea_solve first). Each mode shape is scaled so its largest nodal displacement ' +
    'equals the signed amplitude (DOCUMENT length units) and the modes are summed; the deck moves every node by that offset before the run ' +
    '(NLGEOM run of an imperfect column / panel: load-displacement curve, collapse load). amplitude and amplitudeSource are REQUIRED and have ' +
    'no default (refused with NLS_IMPERFECTION_AMPLITUDE_UNSET): ask the owner or cite the company rule (e.g. L/1000). The buckling results are ' +
    'pinned by hash: re-solving the buckling case later does not change this imperfection (delete_imperfection + add_imperfection to take the ' +
    'new modes). fea_solve refuses with NLS_IMPERFECTION_SOURCE_INVALID when this case is not meshed node-for-node like the buckling case. ' +
    'Returns the imperfection id in affected[0].',
  params: z.object({
    analysisId: analysisIdSchema.describe('Id of the nonlinear_static analysis that gets the imperfection.'),
    fromAnalysisId: z
      .string()
      .describe('Id of the solved buckling analysis whose mode shapes are used (affected[0] of its create_analysis).'),
    modes: z
      .array(
        z.object({
          mode: z.number().int().min(1).describe('Buckling mode number, 1-based (1 = lowest buckling factor).'),
          amplitude: z
            .number()
            .optional()
            .describe(
              'REQUIRED, no default: signed largest nodal offset of this mode shape, in DOCUMENT length units (e.g. 0.5 for 0.5 mm in a mm document).',
            ),
        }),
      )
      .min(1)
      .max(MAX_IMPERFECTION_MODES)
      .describe('Modes to combine, each with its amplitude; the offsets of all listed modes are summed.'),
    amplitudeSource: z
      .string()
      .max(MAX_SOURCE_TEXT)
      .optional()
      .describe(
        'REQUIRED, no default: who or which rule set the amplitudes, e.g. "owner instruction 2026-11-07" or "company rule SR-12: L/1000".',
      ),
  }),
  run: (doc, { analysisId, fromAnalysisId, modes, amplitudeSource }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[], ids: readonly string[] = [analysisId]): CommandResult =>
      refuseNls(doc, 'add_imperfection', code, message, ids, paths);
    const found = nonlinearCase(doc, 'add_imperfection', analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const unset = modes.findIndex((entry) => entry.amplitude === undefined || !Number.isFinite(entry.amplitude) || entry.amplitude === 0);
    if (unset >= 0)
      return fail(
        'NLS_IMPERFECTION_AMPLITUDE_UNSET',
        `mode ${modes[unset]?.mode ?? '?'} has no usable amplitude: give a finite, non-zero signed length (document units) — there is no default`,
        [`modes[${unset}].amplitude`],
      );
    const source = amplitudeSource?.trim() ?? '';
    if (source === '')
      return fail('NLS_IMPERFECTION_AMPLITUDE_UNSET', 'amplitudeSource is required: name who or which rule set the amplitude', [
        'amplitudeSource',
      ]);
    const numbers = modes.map((entry) => entry.mode);
    const twice = numbers.find((mode, index) => numbers.indexOf(mode) !== index);
    if (twice !== undefined) return fail('NLS_CONTROL_INVALID', `mode ${twice} is listed twice`, ['modes']);
    const nonlinear = nonlinearOf(analysis);
    if (imperfectionsOf(nonlinear).length >= MAX_IMPERFECTIONS)
      return fail('NLS_CONTROL_INVALID', `'${analysisId}' already has ${MAX_IMPERFECTIONS} imperfections (the most a case keeps)`, [
        'analysisId',
      ]);
    const problem = sourceProblem(doc, analysis, fromAnalysisId, numbers);
    const solved = caseOf(doc, fromAnalysisId)?.results;
    if (problem !== null || solved === undefined)
      return fail(
        'NLS_IMPERFECTION_SOURCE_INVALID',
        problem ?? `'${fromAnalysisId}' has no results`,
        ['fromAnalysisId'],
        [analysisId, fromAnalysisId],
      );
    const id = nextId('imp');
    const imperfection: Imperfection = {
      id,
      fromAnalysisId,
      sourceResultsHash: solved.resultsHash,
      // every amplitude was checked finite and non-zero above; factors exist for every mode (sourceProblem)
      modes: modes.map(({ mode, amplitude }) => ({
        mode,
        amplitude: Number(amplitude),
        factor: Number(solved.bucklingFactors?.[mode - 1]),
      })),
      amplitudeSource: source,
    };
    const next = {
      ...nonlinear,
      imperfections: { ...nonlinear.imperfections, [id]: imperfection },
      imperfectionOrder: [...(nonlinear.imperfectionOrder ?? []), id],
    };
    const text = imperfection.modes
      .map(({ mode, amplitude, factor }) => `mode ${mode} (buckling factor ${significantNumber(factor, 6)}) x ${amplitude} ${doc.units}`)
      .join(' + ');
    return changed(
      withNonlinear(doc, analysis, next),
      `add_imperfection: '${id}' on '${analysisId}': ${text} from '${fromAnalysisId}' (results ${solved.resultsHash.slice(0, 12)}, pinned); amplitude source "${source}"; ${next.imperfectionOrder.length} imperfection(s). The deck moves the nodes by these offsets; mesh this case like the buckling case and fea_solve.`,
      [id],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].nonlinear.imperfections (removes 1; affected: [imperfectionId]); the full input hash changes
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not nonlinear_static -> NLS_CASE_NOT_NONLINEAR; unknown id -> NLS_IMPERFECTION_NOT_FOUND
 */
export const deleteImperfection = defineCommand({
  name: 'delete_imperfection',
  description:
    'Remove one geometric imperfection (add_imperfection) from a nonlinear_static analysis; the nodes of the next deck are no longer moved by it ' +
    'and the recorded nonlinear results turn stale.',
  annotations: { destructive: true },
  params: z.object({
    analysisId: analysisIdSchema,
    imperfectionId: z.string().describe('Id of the imperfection (affected[0] of add_imperfection, e.g. imp-12.1).'),
  }),
  run: (doc, { analysisId, imperfectionId }): CommandResult => {
    const found = nonlinearCase(doc, 'delete_imperfection', analysisId);
    if (isRefusal(found)) return found;
    const nonlinear = nonlinearOf(found.analysis);
    const order = nonlinear.imperfectionOrder ?? [];
    if (!order.includes(imperfectionId))
      return refuseNls(
        doc,
        'delete_imperfection',
        'NLS_IMPERFECTION_NOT_FOUND',
        `'${analysisId}' has no imperfection '${imperfectionId}' (imperfections: ${order.join(', ') || 'none'})`,
        [analysisId, imperfectionId],
        ['imperfectionId'],
      );
    const imperfections = Object.fromEntries(Object.entries(nonlinear.imperfections ?? {}).filter(([id]) => id !== imperfectionId));
    const imperfectionOrder = order.filter((id) => id !== imperfectionId);
    const { imperfections: dropped, imperfectionOrder: droppedOrder, ...rest } = nonlinear;
    void dropped;
    void droppedOrder;
    // the last one removed: the bag disappears, so the input hash equals that of a case that never had one
    const next = imperfectionOrder.length === 0 ? rest : { ...rest, imperfections, imperfectionOrder };
    return changed(
      withNonlinear(doc, found.analysis, next),
      `delete_imperfection: removed '${imperfectionId}' from '${analysisId}' (${imperfectionOrder.length} imperfection(s) left).`,
      [imperfectionId],
    );
  },
});
