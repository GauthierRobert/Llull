/** Screening mass-loss budget (PHY-14 FR-ENV-04, TR-ENV-04): TML x part mass and CVCM x part mass, mass from `mass_properties` through the registry. */

import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { isRecord } from '@lib/isRecord';
import { isMissing } from './materialValue';
import type { MaterialOutgassing } from './outgassing';
import type { Part } from './parts';

interface PartBudget {
  readonly entityId: string;
  readonly material: string;
  readonly massG: number | null;
  /** TML/100 x mass, grams; null when the mass or TML is unknown. */
  readonly maxMassLossG: number | null;
  /** CVCM/100 x mass, grams; null when the mass or CVCM is unknown. */
  readonly maxCondensableG: number | null;
  readonly unverified: boolean;
  /** Why a figure is null. */
  readonly note?: string;
}

export interface Budget {
  readonly label: string;
  readonly perPart: readonly PartBudget[];
  readonly totalMassLossG: number;
  readonly totalCondensableG: number;
  /** Parts counted in the totals / parts listed without a figure. */
  readonly counted: number;
  readonly uncounted: number;
}

const LABEL = 'screening quantity (TML x mass, CVCM x mass), not a contamination prediction';

const percentOf = (percent: number, massG: number): number => (percent / 100) * massG;

/** Budget of every part (instanced children once per instance); a part whose mass cannot be measured is listed with the reason. */
export function budgetOf(ctx: ExecutionContext | undefined, parts: readonly Part[], data: ReadonlyMap<string, MaterialOutgassing>): Budget {
  const perPart: PartBudget[] = [];
  for (const { entityId, material, measureIn } of parts) {
    const values = data.get(material);
    const measured = execute(measureIn, 'mass_properties', { entityId }, ctx);
    const result: unknown = measured.data;
    const massG = isRecord(result) && typeof result['massG'] === 'number' ? result['massG'] : null;
    const massUnverified = !isRecord(result) || result['unverified'] !== false;
    if (massG === null || values === undefined) {
      perPart.push({
        entityId,
        material,
        massG: null,
        maxMassLossG: null,
        maxCondensableG: null,
        unverified: true,
        note: massG === null ? measured.summary : 'no material data',
      });
      continue;
    }
    const { TML, CVCM } = values;
    perPart.push({
      entityId,
      material,
      massG,
      maxMassLossG: isMissing(TML) ? null : percentOf(TML.value, massG),
      maxCondensableG: isMissing(CVCM) ? null : percentOf(CVCM.value, massG),
      unverified: massUnverified || (!isMissing(TML) && TML.unverified) || (!isMissing(CVCM) && CVCM.unverified),
      ...(isMissing(TML) || isMissing(CVCM) ? { note: `${isMissing(TML) ? 'TML' : 'CVCM'} unknown: that figure is not counted` } : {}),
    });
  }
  const sum = (pick: (part: PartBudget) => number | null): number =>
    perPart.reduce((total, part) => {
      const figure = pick(part);
      return figure === null ? total : total + figure;
    }, 0);
  const counted = perPart.filter((part) => part.maxMassLossG !== null || part.maxCondensableG !== null).length;
  return {
    label: LABEL,
    perPart,
    totalMassLossG: sum((part) => part.maxMassLossG),
    totalCondensableG: sum((part) => part.maxCondensableG),
    counted,
    uncounted: perPart.length - counted,
  };
}
