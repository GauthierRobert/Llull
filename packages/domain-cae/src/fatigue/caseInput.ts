/** Shared validation and zod schemas of fatigue cases and their factors. */

import type { FatigueCase, FatigueFactors } from '@core/model/durability';
import type { CadDocument } from '@core/model/types';
import { z } from '@core/commands/schema';
import { caseOf } from '../shared/access';
import { findCurve, isCurveRefusal } from './curves';
import { modifierProblem, modifierSchema } from './schemas';
import { historyOf } from './store';

export const DEFAULT_FACTORS: FatigueFactors = { damageLimit: 1, modifiers: [], compressiveMean: 'no_benefit' };

export const factorsShape = {
  scatter: z
    .object({
      value: z.number().describe('Scatter (safety) factor on life, >= 1.'),
      source: z.string().describe('Mandatory source of the factor (regulation, company rule, case input).'),
    })
    .optional()
    .describe('Scatter factor SF on life. There is NO default: without it compute_fatigue refuses with FAT_SCATTER_FACTOR_UNSET.'),
  damageLimit: z.number().optional().describe('Miner damage limit D (> 0). Default 1 (Palmgren-Miner rule), reported as defaulted.'),
  marginalBand: z.number().optional().describe('Margin band (>= 0): 0 <= margin < band is MARGINAL. No default.'),
  modifiers: z
    .array(modifierSchema)
    .optional()
    .describe('REPLACES the Marin modifier list (surface, size, reliability, ...). Each needs value > 0 and a justification.'),
  compressiveMean: z
    .enum(['no_benefit', 'formula'])
    .optional()
    .describe('Compressive mean-stress rule: no_benefit (default, conservative) or formula.'),
};

export const factorsSchema = z.object(factorsShape);
type FactorsInput = z.output<typeof factorsSchema>;

/** `current` with the given factor fields, or a problem text. */
export function applyFactors(current: FatigueFactors, input: FactorsInput): FatigueFactors | string {
  if (input.scatter !== undefined && (!(input.scatter.value >= 1) || input.scatter.source.trim() === ''))
    return 'scatter needs value >= 1 and a non-empty source';
  if (input.damageLimit !== undefined && !(input.damageLimit > 0)) return 'damageLimit must be > 0';
  if (input.marginalBand !== undefined && !(input.marginalBand >= 0)) return 'marginalBand must be >= 0';
  const modifierIssue = input.modifiers === undefined ? null : modifierProblem(input.modifiers);
  if (modifierIssue !== null) return modifierIssue;
  return {
    ...current,
    ...(input.scatter !== undefined ? { scatter: input.scatter } : {}),
    ...(input.damageLimit !== undefined ? { damageLimit: input.damageLimit } : {}),
    ...(input.marginalBand !== undefined ? { marginalBand: input.marginalBand } : {}),
    ...(input.modifiers !== undefined ? { modifiers: input.modifiers } : {}),
    ...(input.compressiveMean !== undefined ? { compressiveMean: input.compressiveMean } : {}),
  };
}

/** Problem with a fatigue case (references, ranges, curve), as { code, message, path }, or null. */
export function caseProblem(doc: CadDocument, fatigueCase: FatigueCase): { code: string; message: string; path: string } | null {
  const invalid = (message: string, path: string): { code: string; message: string; path: string } => ({
    code: 'FAT_CASE_INVALID',
    message,
    path,
  });
  if (fatigueCase.mapping.length === 0) return invalid('mapping needs >= 1 entry', 'mapping');
  for (const [index, entry] of fatigueCase.mapping.entries()) {
    if (historyOf(doc, entry.historyId) === undefined)
      return { code: 'FAT_HISTORY_NOT_FOUND', message: `no history '${entry.historyId}'`, path: `mapping.${index}.historyId` };
    if (!Number.isFinite(entry.scale)) return invalid('scale must be finite', `mapping.${index}.scale`);
  }
  if (fatigueCase.analysisId !== undefined && caseOf(doc, fatigueCase.analysisId) === undefined)
    return invalid(`no analysis '${fatigueCase.analysisId}'`, 'analysisId');
  const life = fatigueCase.requiredLife;
  if (!(life.value > 0)) return invalid('requiredLife.value must be > 0', 'requiredLife.value');
  if ((life.unit === 'flights' || life.unit === 'hours') && !(life.blocksPerUnit !== undefined && life.blocksPerUnit > 0))
    return invalid(`requiredLife in ${life.unit} needs blocksPerUnit > 0`, 'requiredLife.blocksPerUnit');
  if (fatigueCase.notch !== undefined && !(fatigueCase.notch.kt >= 1 && fatigueCase.notch.q >= 0 && fatigueCase.notch.q <= 1))
    return invalid('notch needs kt >= 1 and q in [0, 1]', 'notch');
  const kinds =
    fatigueCase.method === 'stress_life' ? (['sn_basquin', 'sn_power_law', 'sn_table'] as const) : (['en_coffin_manson'] as const);
  const curve = findCurve(doc, fatigueCase.material.recordId, fatigueCase.material.modelId, kinds);
  if (isCurveRefusal(curve)) return { code: curve.code, message: curve.message, path: 'material.modelId' };
  if (fatigueCase.method === 'strain_life') {
    if (fatigueCase.material.cyclicModelId === undefined)
      return invalid('strain_life needs material.cyclicModelId', 'material.cyclicModelId');
    const cyclic = findCurve(doc, fatigueCase.material.recordId, fatigueCase.material.cyclicModelId, ['cyclic_ramberg_osgood']);
    if (isCurveRefusal(cyclic)) return { code: cyclic.code, message: cyclic.message, path: 'material.cyclicModelId' };
  }
  return null;
}
