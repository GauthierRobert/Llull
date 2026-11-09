/** Atomic-oxygen section of check_space_environment (PHY-14 FR-ENV-12): recession of each material in use at the mission fluence. */

import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { recessionCm } from './atomicOxygen';
import { materialProperty } from './materialValue';
import type { AoFluence } from './types';

export interface AoItem {
  readonly material: string;
  readonly entityIds: readonly string[];
  /** 'info' with a recession figure, 'unknown' (ENV_PROPERTY_MISSING) when the material has no aoErosionYield. No limit exists, so there is never a pass. */
  readonly status: 'info' | 'unknown';
  readonly code?: string;
  readonly recessionUm: number | null;
  readonly erosionYieldCm3PerAtom: number | null;
  readonly unverified: boolean;
  readonly valueSource: string;
  readonly reviewRequired: true;
}

const FLUENCE_TO_CM2: Readonly<Record<AoFluence['unit'], number>> = { 'atoms/cm^2': 1, 'atoms/m^2': 1e-4 };
const UM_PER_CM = 1e4;

export function aoItems(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  users: ReadonlyMap<string, readonly string[]>,
  fluence: AoFluence,
): AoItem[] {
  const perCm2 = fluence.value * FLUENCE_TO_CM2[fluence.unit];
  return [...users].map(([material, entityIds]): AoItem => {
    const found = materialProperty(doc, ctx, material, 'aoErosionYield', 'cm^3');
    if ('reason' in found)
      return {
        material,
        entityIds,
        status: 'unknown',
        code: 'ENV_PROPERTY_MISSING',
        recessionUm: null,
        erosionYieldCm3PerAtom: null,
        unverified: true,
        valueSource: `no aoErosionYield on the material (${found.code}: ${found.reason})`,
        reviewRequired: true,
      };
    return {
      material,
      entityIds,
      status: 'info',
      recessionUm: recessionCm(found.value, perCm2) * UM_PER_CM,
      erosionYieldCm3PerAtom: found.value,
      unverified: found.unverified,
      valueSource: found.source,
      reviewRequired: true,
    };
  });
}
