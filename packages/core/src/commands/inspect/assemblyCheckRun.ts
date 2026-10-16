/**
 * The `check_assembly` pipeline (TECHNICAL_SPEC 5.2): collect parts, validity, pairs, connectivity, thickness, joint realisation.
 * @invariant deterministic: fixed iteration orders (document order, pairs i < j), no random, numbers rounded to 12 significant digits
 */

import type { CadDocument } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import { MM_PER_UNIT } from '../../model/units';
import { type CheckItem, type CheckResult, type CheckThreshold, worstStatus } from '../../model/checkResult';
import { PROCESS_RULES, type ProcessId } from '../../model/processRules';
import { GROUND } from '../../model/dynamics';
import { hashText } from '../../lib/hash';
import { roundDeep } from '../../lib/significant';
import { recipeKey } from '../../geometry/shapeRecipe';
import type { AssemblyPart, CheckTolerances } from '../../geometry/assemblyCheck/partTypes';
import { kernelUnsupportedItem, makeItem, validateParts } from '../../geometry/assemblyCheck/partValidity';
import { candidatePairs, classifyPair, pairItem } from '../../geometry/assemblyCheck/pairClassify';
import { connectivityItems } from '../../geometry/assemblyCheck/connectivity';
import { measureThickness } from '../../geometry/assemblyCheck/thickness';
import { realiseJoint } from '../../geometry/assemblyCheck/jointRealisation';
import { type PartScope, collectParts } from './assemblyParts';
import { assemblyLinks, intentOf } from './assemblyGraph';

export interface AssemblyCheckParams extends PartScope {
  readonly clearanceMm?: number | undefined;
  readonly touchToleranceMm?: number | undefined;
  readonly process?: ProcessId | undefined;
  readonly minWallMm?: number | undefined;
  readonly thickness?: 'off' | 'ray' | undefined;
  readonly raysPerPart?: number | undefined;
  readonly includeJoints?: boolean | undefined;
}

/** Budgets (TECHNICAL_SPEC 8). */
export const MAX_PARTS = 500;
export const MAX_PAIRS = 20_000;
export const MAX_RAYS_TOTAL = 200_000;
export const DEFAULT_RAYS = 2000;
const CONTAINMENT_RATIO = 0.99;
const VOLUME_RELATIVE = 1e-6;
const DEFAULT_TOUCH_UNITS = 1e-3;
const CORNER_EXCLUSION_FACTOR = 0.5;

export interface BudgetRefusal {
  readonly refused: true;
  readonly limit: string;
  readonly remediation: string;
}

export type AssemblyCheckOutcome =
  | { readonly refused: false; readonly result: CheckResult; readonly extras: Record<string, unknown> }
  | BudgetRefusal;

function thresholdOf(params: AssemblyCheckParams): CheckThreshold | null {
  if (params.minWallMm !== undefined)
    return { value: params.minWallMm, unit: 'mm', source: 'minWallMm parameter', grade: 'A', defaulted: false };
  if (params.process === undefined) return null;
  const rule = PROCESS_RULES[params.process];
  return { value: rule.minWallMm, unit: 'mm', source: `${params.process}: ${rule.source}`, grade: rule.grade, defaulted: true };
}

function thicknessItems(
  parts: readonly AssemblyPart[],
  excluded: ReadonlySet<string>,
  threshold: CheckThreshold | null,
  rays: number,
  tolerances: CheckTolerances,
): CheckItem[] {
  const { mmPerUnit } = tolerances;
  const items: CheckItem[] = [];
  for (const part of parts) {
    if (excluded.has(part.id) || part.mesh === null) continue;
    const thresholdUnits = threshold === null ? 0 : threshold.value / mmPerUnit;
    const report = measureThickness(part.mesh, rays, CORNER_EXCLUSION_FACTOR * thresholdUnits, 2 * thresholdUnits);
    if (report === null) continue;
    const values = {
      thicknessMm: report.min * mmPerUnit,
      thicknessP1Mm: report.p1 * mmPerUnit,
      samples: report.samples,
      cornerSamplesExcluded: report.excluded,
    };
    const witness = {
      pointsMm: report.clusters.map((cluster) => cluster.center.map((c) => c * mmPerUnit) as unknown as [number, number, number]),
    };
    const note = 'method: ray (inward normal, first hit); overestimates on non-parallel walls; witness lists the thinnest clusters';
    if (threshold === null)
      items.push(
        makeItem('FPR_WALL_MEASURED', 'info', [part.id], 'Give process or minWallMm to judge these walls.', { values, witness, note }),
      );
    else {
      const thin = report.min * mmPerUnit < threshold.value;
      items.push(
        makeItem(
          'FPR_WALL_THIN',
          thin ? 'fail' : 'pass',
          [part.id],
          thin
            ? 'Thicken the thinnest region (witness points) or choose a process that allows thinner walls.'
            : 'Wall thickness meets the threshold.',
          { values, witness, threshold, note, unverified: false },
        ),
      );
    }
  }
  return items;
}

function jointItems(
  doc: CadDocument,
  kernel: GeometryKernel,
  partsById: ReadonlyMap<string, AssemblyPart>,
  mmPerUnit: number,
): CheckItem[] {
  const shapesOf = (bodyId: string): AssemblyPart['shape'][] =>
    (doc.dynamics?.bodies[bodyId]?.entityIds ?? []).flatMap((id) => {
      const part = partsById.get(id);
      return part === undefined ? [] : [part.shape];
    });
  return Object.values(doc.dynamics?.joints ?? {})
    .filter((joint) => joint.kind === 'revolute')
    .map((joint) =>
      realiseJoint(kernel, {
        id: joint.id,
        anchor: joint.anchor,
        axis: joint.axis,
        parentShapes: joint.parent === GROUND ? [] : shapesOf(joint.parent),
        childShapes: shapesOf(joint.child),
        mmPerUnit,
      }),
    );
}

export function runAssemblyCheck(doc: CadDocument, kernel: GeometryKernel, params: AssemblyCheckParams): AssemblyCheckOutcome {
  const mmPerUnit = MM_PER_UNIT[doc.units];
  const tolerances: CheckTolerances = {
    epsTouch: params.touchToleranceMm === undefined ? DEFAULT_TOUCH_UNITS : params.touchToleranceMm / mmPerUnit,
    clearance: (params.clearanceMm ?? 0) / mmPerUnit,
    containmentRatio: CONTAINMENT_RATIO,
    volumeRelative: VOLUME_RELATIVE,
    mmPerUnit,
  };
  const collected = collectParts(doc, kernel, params);
  const { parts } = collected;
  if (parts.length + collected.refused.length > MAX_PARTS)
    return {
      refused: true,
      limit: `${parts.length + collected.refused.length} parts, limit ${MAX_PARTS}`,
      remediation: 'Narrow the request with ids, body or component.',
    };
  const threshold = thresholdOf(params);
  const rays = params.raysPerPart ?? DEFAULT_RAYS;
  const thicknessOn = (params.thickness ?? (threshold === null ? 'off' : 'ray')) === 'ray';
  if (thicknessOn && parts.length * rays > MAX_RAYS_TOTAL)
    return {
      refused: true,
      limit: `${parts.length * rays} thickness rays, limit ${MAX_RAYS_TOTAL}`,
      remediation: 'Lower raysPerPart, narrow the scope, or set thickness to "off".',
    };

  const items: CheckItem[] = collected.refused.map((id) =>
    makeItem(
      'FPR_PART_INVALID',
      'fail',
      [id],
      'The kernel refused to build this part (degenerate size, open mesh, unsupported feature); rebuild it.',
      { note: 'kernel evaluation returned null' },
    ),
  );
  const validity = validateParts(kernel, parts, tolerances);
  items.push(...validity.items);

  const partIds = new Set(parts.map((part) => part.id));
  const links = assemblyLinks(doc, partIds);
  const strongLinks = [...links.strongLinks];
  const touchLinks: Array<readonly [string, string]> = [];
  const candidates = candidatePairs(parts, tolerances.clearance + tolerances.epsTouch).filter(([i, j]) => {
    const [a, b] = [parts[i], parts[j]];
    if (a === undefined || b === undefined || validity.excluded.has(a.id) || validity.excluded.has(b.id)) return false;
    return params.body !== undefined || links.bodyOf.get(a.id) === undefined || links.bodyOf.get(a.id) !== links.bodyOf.get(b.id);
  });
  if (candidates.length > MAX_PAIRS)
    return {
      refused: true,
      limit: `${candidates.length} candidate pairs, limit ${MAX_PAIRS}`,
      remediation: 'Narrow the request with ids, body or component.',
    };
  let pairsNotRun = false;
  for (const [i, j] of candidates) {
    const [a, b] = [parts[i] as AssemblyPart, parts[j] as AssemblyPart];
    const volumeOf = (part: AssemblyPart): number => validity.analyses.get(part.id)?.volume ?? 0;
    const pair = classifyPair(kernel, a, b, volumeOf(a), volumeOf(b), tolerances);
    if (pair === null) {
      pairsNotRun = true;
      continue;
    }
    if (pair === undefined) continue;
    const intent = intentOf(doc, a.id, b.id);
    items.push(
      pairItem(
        pair,
        [a.id, b.id],
        tolerances,
        intent === undefined ? undefined : { id: intent.id, kind: intent.kind, reason: intent.reason, declaredBy: intent.declaredBy },
      ),
    );
    if (pair.kind === 'touch') touchLinks.push([a.id, b.id]);
    else if (pair.kind !== 'clearance') strongLinks.push([a.id, b.id]);
  }
  if (pairsNotRun)
    items.push(
      kernelUnsupportedItem(
        parts.map((part) => part.id),
        'pair classification (distance / analyze)',
      ),
    );

  items.push(...connectivityItems({ parts: parts.map((part) => part.id), strongLinks, touchLinks, grounded: links.grounded }));
  if (thicknessOn) items.push(...thicknessItems(parts, validity.excluded, threshold, rays, tolerances));
  if (params.includeJoints !== false) items.push(...jointItems(doc, kernel, new Map(parts.map((part) => [part.id, part])), mmPerUnit));

  const unverified = items.some((entry) => entry.status === 'not_run');
  const provenanceParams = { ...params };
  const inputsHash = hashText(
    JSON.stringify({
      parts: parts.map((part) => [part.id, recipeKey(part.recipe)]),
      refused: collected.refused,
      dynamics: doc.dynamics ?? null,
      joints: doc.joints,
      prototype: doc.prototype ?? null,
      params: provenanceParams,
      units: doc.units,
      kernel: kernel.name ?? null,
    }),
  );
  const result: CheckResult = {
    check: 'assembly',
    status: worstStatus(items.map((entry) => entry.status)),
    items,
    provenance: {
      method: 'kernel distance + recipe intersect; ray thickness; union-find connectivity',
      ...(kernel.name === undefined ? {} : { kernel: kernel.name }),
      tolerances: {
        epsTouchMm: tolerances.epsTouch * mmPerUnit,
        clearanceMm: tolerances.clearance * mmPerUnit,
        containmentRatio: CONTAINMENT_RATIO,
        volumeRelative: VOLUME_RELATIVE,
        rayStartOffsetRelative: 1e-6,
        cornerExclusionFactor: CORNER_EXCLUSION_FACTOR,
      },
      params: provenanceParams,
    },
    inputsHash,
    unverified,
    reviewRequired: true,
  };
  const extras = {
    parts: parts.map((part) => ({ id: part.id, volumeMm3: (validity.analyses.get(part.id)?.volume ?? 0) * mmPerUnit ** 3 })),
    skipped2D: collected.skipped2D,
    pairsChecked: candidates.length,
  };
  return { refused: false, result: roundDeep(result), extras: roundDeep(extras) };
}
