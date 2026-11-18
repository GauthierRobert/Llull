/** The summary and data payload of a committed deformation. */

import type { CadDocument, Vec3 } from '../../model/types';
import type { DeformNode } from '../../geometry/deform/laws';
import type { GeometryKernel } from '../../geometry/kernel';
import type { DeformPlan, DeformRequest } from './request';
import { NEXT_STEP } from './schema';
import type { Built } from './runBuilt';
import { rangeOfPlan, type Prepared } from './runChecks';
import type { DeformTarget } from './target';

/** Wire-friendly form of a point for `data`. */
const list = (v: Vec3): number[] => [v[0], v[1], v[2]];

export interface DeformOutcome {
  readonly doc: CadDocument;
  readonly request: DeformRequest;
  readonly id: string;
  readonly target: DeformTarget;
  readonly plan: DeformPlan;
  readonly prepared: Prepared;
  readonly built: Built;
  readonly fallback: string | null;
  readonly volume: { value: number; method: 'exact' | 'mesh' };
}

const pathOf = (o: DeformOutcome): 'exact' | 'mesh' => (o.built.exact ? 'exact' : 'mesh');

/** Why a faceted result came out of a request that allowed an exact one (empty when it is exact or mesh was asked for). */
function whyFaceted(o: DeformOutcome, kernel: GeometryKernel | null): string {
  const { mode, useKernel } = o.prepared;
  return o.built.exact || mode === 'mesh'
    ? ''
    : o.target.faceted
      ? ' The source is a mesh without an exact construction, so the result is a faceted mesh.'
      : o.fallback !== null
        ? ` The exact warp refused (${o.fallback}), so the result is a faceted mesh (mode "exact" refuses instead).`
        : kernel === null
          ? ' No geometry kernel is installed, so the result is a faceted mesh.'
          : !useKernel
            ? ' The kernel does not build this law exactly, so the result is a faceted mesh (mode "exact" refuses instead).'
            : ' The kernel is a mesh kernel, so the result is a faceted mesh.';
}

export function deformSummary(o: DeformOutcome, newId: string, triangles: number): string {
  const { doc, request, id, target, plan, volume } = o;
  const why = whyFaceted(o, target.kernel);
  return (
    `${request.command}: ${request.verb} '${id}' (kind '${target.entity.kind}') → mesh '${newId}' (${triangles} triangles, ${pathOf(o)} path, volume ${volume.value.toPrecision(8)} ${doc.units}^3 ${volume.method}).${why} ` +
    `Frame origin [${list(plan.frame.origin).join(', ')}] axis [${list(plan.frame.axis).join(', ')}]${plan.defaulted.length > 0 ? ` (defaulted: ${plan.defaulted.join(', ')})` : ''}. ${NEXT_STEP}`
  );
}

export function deformData(o: DeformOutcome, newId: string): Record<string, unknown> {
  const { doc, request, target, plan, prepared, built, fallback, volume } = o;
  const { kernel } = target;
  const node: DeformNode = prepared.node;
  return {
    id: newId,
    path: pathOf(o),
    ...(fallback === null ? {} : { exactRefused: fallback }),
    kernel: kernel?.name ?? null,
    law: plan.law,
    frame: {
      origin: list(plan.frame.origin),
      axis: list(plan.frame.axis),
      reference: list(plan.frame.reference),
      defaulted: plan.defaulted,
    },
    ...(plan.region === undefined ? {} : { region: plan.region }),
    tolerance: { value: prepared.tolerance, unit: doc.units, defaulted: request.output?.tolerance === undefined },
    jacobian: { min: rangeOfPlan(node, plan).min, max: rangeOfPlan(node, plan).max },
    triangles: built.mesh.indices.length / 3,
    volume: { ...volume, unit: `${doc.units}^3` },
    edgeLength: built.edgeLength,
    chordError: built.chordError,
    ...(request.output?.preserveAnalytic === true && built.exact
      ? { analyticFaces: kernel?.deformReport?.(node)?.analyticFaces ?? null }
      : {}),
    ...plan.report,
    unit: doc.units,
  };
}
