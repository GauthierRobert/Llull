/** set_buckling_preload: a load case added to the buckling reference load (a `*STATIC` step before the `*BUCKLE` step; ccx 2.21 scales the sum). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf, withCase } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { loadCaseNameProblem } from '../shared/names';
import { analysisIdSchema } from '../shared/schemas';

/**
 * @affects doc.analysis.cases[analysisId].preloadLoadCase (part of the analysis input hash: a recorded mesh stays valid, results become stale)
 * @invariant buckling cases only; the name is a load case that has at least one load; omitted = no preload (one `*BUCKLE` step)
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not a buckling analysis -> FEA_PARAM_NOT_APPLICABLE; invalid or unused load case name -> FEA_LOAD_INVALID (unchanged doc)
 */
export const setBucklingPreload = defineCommand({
  name: 'set_buckling_preload',
  description:
    'Make one load case of a buckling analysis the PRELOAD, added to the reference load (the first OTHER load case). Without a preload the factors ' +
    'multiply the first load case alone. Omit preloadLoadCase to clear. Needs at least one more load case as the reference load. The CalculiX deck is a ' +
    '*STATIC step with the preload, then a *BUCKLE step that writes preload + reference loads SUMMED (a later *CLOAD / *DLOAD replaces the value at the same ' +
    'node and dof / element face / gravity instead of adding to it). CalculiX 2.21 scales the WHOLE *BUCKLE step load (measured: the stress of the static ' +
    'step is not held as a base state), so the factors multiply preload + reference: the critical load is factor x (preload + reference), NOT preload + ' +
    'factor x reference (analysis_report data.eigen.factorsMultiply). The Nastran BDF export does not support a preload.',
  params: z.object({
    analysisId: analysisIdSchema,
    preloadLoadCase: z
      .string()
      .optional()
      .describe(
        'Name of the load case (1-40 letters, digits or underscores) that is applied as the constant preload, e.g. "dead_weight". Omit to clear.',
      ),
  }),
  run: (doc, { analysisId, preloadLoadCase }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseCode(doc, 'set_buckling_preload', code, message, [analysisId], paths);
    const found = caseOf(doc, analysisId);
    if (found === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, ['analysisId']);
    if (found.type !== 'buckling')
      return fail('FEA_PARAM_NOT_APPLICABLE', `a preload applies to buckling analyses only, not '${found.type}'`, ['analysisId']);
    if (preloadLoadCase !== undefined) {
      const problem = loadCaseNameProblem(preloadLoadCase);
      if (problem !== null) return fail('FEA_LOAD_INVALID', problem, ['preloadLoadCase']);
      if (!found.loadOrder.some((id) => found.loads[id]?.loadCase === preloadLoadCase))
        return fail('FEA_LOAD_INVALID', `no load of load case '${preloadLoadCase}' in '${analysisId}': add the preload loads first`, [
          'preloadLoadCase',
        ]);
    }
    const { preloadLoadCase: _previous, ...rest } = found;
    void _previous;
    const next = preloadLoadCase === undefined ? rest : { ...rest, preloadLoadCase };
    return changed(
      withCase(doc, next),
      preloadLoadCase === undefined
        ? `set_buckling_preload: cleared the preload of '${analysisId}'.`
        : `set_buckling_preload: '${analysisId}' preload load case '${preloadLoadCase}' (added to the first other load case; CalculiX scales the sum: the factors multiply preload + reference). Results are stale until re-solved.`,
      [analysisId],
    );
  },
});
