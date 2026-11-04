/**
 * User SIF / flexibility overrides at nodes (07 PST M5a part 2, `set_sif_override`): at a bend the whole bend (all its chord elements) takes the given
 * SIFs and flexibility factor; at a tee or any other node the SIFs act at the element ends of that node, replacing the code values there.
 * @failure flexibility at a node that is not on a bend -> PST_PARAM_INVALID
 */

import type { Vec3 } from '@core/model/vectors';
import type { ElementEndSif, FeElement, LayoutFailure } from './layoutTypes';

export interface NodeOverride {
  readonly id: string;
  readonly node: number;
  readonly ii: number;
  readonly io: number;
  readonly flexibility?: number | undefined;
  readonly source: string;
}

export interface OverrideWarning {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

const NO_PLANE: Vec3 = [0, 0, 1];

export function applySifOverrides(
  elements: readonly FeElement[],
  overrides: readonly NodeOverride[],
): { elements: FeElement[]; warnings: OverrideWarning[] } | LayoutFailure {
  let out = [...elements];
  const warnings: OverrideWarning[] = [];
  for (const override of overrides) {
    const incident = out.filter((element) => element.a === override.node || element.b === override.node);
    const bend = incident.find((element) => element.bend !== undefined)?.bend;
    const named = `node N${override.node + 1}`;
    if (bend !== undefined) {
      const replaced = { ...bend, ii: override.ii, io: override.io, k: override.flexibility ?? bend.k };
      out = out.map((element) => (element.bend === bend ? { ...element, bend: replaced } : element));
    } else {
      if (override.flexibility !== undefined)
        return {
          ok: false,
          code: 'PST_PARAM_INVALID',
          message: `SIF override ${override.id}: flexibility applies to a bend, ${named} is not on one`,
          ids: [override.id],
          paths: ['flexibility'],
        };
      const unequal = override.ii !== override.io;
      if (unequal && incident.every((element) => element.endSifs === undefined))
        warnings.push({
          code: 'PST_SIF_PLANE_UNKNOWN',
          message: `SIF override ${override.id} at ${named}: no bend or tee plane there, the larger of ii ${override.ii} and io ${override.io} acts in both planes`,
          ids: [override.id],
        });
      out = out.map((element) => {
        if (element.a !== override.node && element.b !== override.node) return element;
        const own = element.endSifs?.find((entry) => entry.node === override.node);
        const next: ElementEndSif = {
          ...(own ?? { node: override.node, normal: NO_PLANE, source: 'override' }),
          ii: own === undefined ? Math.max(override.ii, override.io) : override.ii,
          io: own === undefined ? Math.max(override.ii, override.io) : override.io,
          source: 'override',
        };
        return { ...element, endSifs: [...(element.endSifs ?? []).filter((entry) => entry.node !== override.node), next] };
      });
    }
    warnings.push({
      code: 'PST_SIF_OVERRIDE',
      message: `SIF override ${override.id} at ${named}: ii ${override.ii}, io ${override.io}${override.flexibility === undefined ? '' : `, k ${override.flexibility}`} (source: ${override.source})`,
      ids: [override.id],
    });
  }
  return { elements: out, warnings };
}
