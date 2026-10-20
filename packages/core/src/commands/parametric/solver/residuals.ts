import type { CadDocument, Constraint } from '../../../model/types';
import { resolveNumeric } from '../expression';
import type { Layout } from './layout';
import { fail, type CompileContext, type CompileOutcome } from './compileContext';
import {
  compileAxisAligned,
  compileCoincident,
  compileCollinear,
  compileConcentric,
  compileDirectionRelation,
  compileEqual,
  compileFix,
  compileMidpoint,
  compilePointOnCurve,
  compileSymmetric,
} from './residualsGeometric';
import { compileCurvature, compileTangent } from './residualsCurves';
import { compileDimension } from './residualsDimensional';

function compileGeometric(ctx: CompileContext): CompileOutcome {
  switch (ctx.constraint.kind) {
    case 'coincident':
      return compileCoincident(ctx);
    case 'parallel':
      return compileDirectionRelation(ctx, false);
    case 'perpendicular':
      return compileDirectionRelation(ctx, true);
    case 'tangent':
      return compileTangent(ctx);
    case 'horizontal':
      return compileAxisAligned(ctx, 1);
    case 'vertical':
      return compileAxisAligned(ctx, 0);
    case 'equal':
      return compileEqual(ctx);
    case 'concentric':
      return compileConcentric(ctx);
    case 'collinear':
      return compileCollinear(ctx);
    case 'midpoint':
      return compileMidpoint(ctx);
    case 'symmetric':
      return compileSymmetric(ctx);
    case 'fix':
      return compileFix(ctx);
    case 'point_on_curve':
      return compilePointOnCurve(ctx);
    case 'curvature':
      return compileCurvature(ctx);
    default:
      return fail(`'${ctx.constraint.kind}' is a dimension and needs a value`);
  }
}

/** Turn one constraint into residual rows over `layout`; branches and fix anchors come from the layout's initial sketch. */
export function compileConstraint(doc: CadDocument, layout: Layout, constraint: Constraint): CompileOutcome {
  const ctx: CompileContext = { doc, layout, constraint };
  if (!('value' in constraint)) return compileGeometric(ctx);
  const value = resolveNumeric(constraint.value, doc.parameters);
  if (value === null) return fail(`value '${String(constraint.value)}' cannot be evaluated yet`, true);
  return compileDimension(ctx, constraint.kind, value);
}
