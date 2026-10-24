/** Catalogue rows of every spec component at every standard size it covers (shared by the coverage, reference, trust and dimension passes). */

import type { NominalSize } from '../../catalog/types';
import { resolveChosen, type ResolvedComponent } from '../resolve';
import { inRange, sizeOrdinal, sizesInRange } from '../size';
import type { SpecComponent } from '../types';
import type { CheckContext } from './finding';

export interface ComponentRows {
  readonly component: SpecComponent;
  readonly index: number;
  readonly resolved: readonly ResolvedComponent[];
  /** Sizes with no row, and the coded reason of the first. */
  readonly missing: readonly NominalSize[];
  readonly missingReason?: string;
  /** First reason a component has no catalogue family at all (import-only standard). */
  readonly unresolved?: string;
}

/** Codes that mean "cannot judge here" rather than "row missing": several rows match without a small size. */
const NOT_A_GAP = new Set(['PSC_AMBIGUOUS_COMPONENT']);

export function componentRows(context: CheckContext): readonly ComponentRows[] {
  const { spec, catalogs, sizes } = context;
  return spec.components.map((component, index) => {
    const covered = sizes.filter((size) => inRange(size, component.from, component.to));
    const resolved: ResolvedComponent[] = [];
    const missing: NominalSize[] = [];
    let missingReason: string | undefined;
    const branches = component.branchFrom && component.branchTo ? sizesInRange(component.branchFrom, component.branchTo) : [undefined];
    for (const size of covered) {
      const usable = branches.filter((branch) => branch === undefined || sizeOrdinal(branch) <= sizeOrdinal(size));
      let gap = false;
      for (const branch of usable) {
        const outcome = resolveChosen(spec, catalogs, component, size, branch, { type: component.type });
        if (outcome.ok) resolved.push(outcome.resolved);
        else if (!NOT_A_GAP.has(outcome.code)) {
          gap = true;
          missingReason ??= `${outcome.code}: ${outcome.message}`;
        }
      }
      if (gap) missing.push(size);
    }
    const unresolved = resolved.find((entry) => entry.unresolved !== undefined)?.unresolved;
    return {
      component,
      index,
      resolved,
      missing,
      ...(missingReason === undefined ? {} : { missingReason }),
      ...(unresolved === undefined ? {} : { unresolved }),
    };
  });
}
