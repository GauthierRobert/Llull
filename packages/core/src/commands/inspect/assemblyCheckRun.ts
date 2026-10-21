/**
 * The `check_assembly` pipeline (TECHNICAL_SPEC 5.2): collect parts, validity, pairs, connectivity, thickness, joint realisation.
 * @invariant deterministic: fixed iteration orders (document order, pairs i < j), no random, numbers rounded to 12 significant digits
 * @invariant a scoped run builds the connectivity graph over ALL parts and reports only items that touch the scope
 */

import type { CadDocument, MeshData, Vec3 } from '../../model/types';
import type { GeometryKernel, ShapeAnalysis } from '../../geometry/kernel';
import { MM_PER_UNIT } from '../../model/units';
import { type CheckItem, type CheckResult, type CheckThreshold, worstStatus } from '../../model/checkResult';
import { PROCESS_RULES, type ProcessId } from '../../model/processRules';
import { GROUND } from '../../model/dynamics';
import { checkedPrototype } from '../../model/prototype';
import { hashText } from '../../lib/hash';
import { canonicalJson } from '../../lib/canonicalJson';
import { roundDeep } from '../../lib/significant';
import { recipeKey } from '../../geometry/shapeRecipe';
import type { AssemblyPart, CheckTolerances } from '../../geometry/assemblyCheck/partTypes';
import { kernelUnsupportedItem, makeItem, validateParts } from '../../geometry/assemblyCheck/partValidity';
import { candidatePairs, classifyPair, pairItem } from '../../geometry/assemblyCheck/pairClassify';
import { connectivityItems } from '../../geometry/assemblyCheck/connectivity';
import { type GeometryQueryEngine, meshBvhEngine, resolveGeometryQueries } from '../../geometry/geometryQueries';
import { measureThickness } from '../../geometry/assemblyCheck/thickness';
import { realiseJoint } from '../../geometry/assemblyCheck/jointRealisation';
import { type PartScope, candidateIds, collectParts, scopedIds } from '../../geometry/assemblyParts';
import { assemblyLinks, intentOf } from '../../geometry/assemblyGraph';

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
export const MAX_RAYS_TOTAL = meshBvhEngine.limits.maxThicknessRays;
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
  skip: (part: AssemblyPart) => boolean,
  threshold: CheckThreshold | null,
  rays: number,
  tolerances: CheckTolerances,
  engine: GeometryQueryEngine,
): CheckItem[] {
  const { mmPerUnit } = tolerances;
  const items: CheckItem[] = [];
  const code = threshold === null ? 'FPR_WALL_MEASURED' : 'FPR_WALL_THIN';
  for (const part of parts) {
    if (skip(part)) continue;
    const thresholdUnits = threshold === null ? 0 : threshold.value / mmPerUnit;
    const report =
      part.mesh === null ? null : measureThickness(part.mesh, rays, CORNER_EXCLUSION_FACTOR * thresholdUnits, 2 * thresholdUnits, engine);
    if (report === null) {
      items.push(
        makeItem(code, 'not_run', [part.id], 'Check that the part is a closed solid (check_assembly part validity) and retry.', {
          unverified: true,
          note: 'thickness could not be measured: no mesh, or no sample ray hit the opposite wall',
        }),
      );
      continue;
    }
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
      items.push(makeItem(code, 'info', [part.id], 'Give process or minWallMm to judge these walls.', { values, witness, note }));
    else {
      const thin = report.min * mmPerUnit < threshold.value;
      items.push(
        makeItem(
          code,
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
  inScope: (bodyId: string) => boolean,
  mmPerUnit: number,
): CheckItem[] {
  const shapesOf = (bodyId: string): AssemblyPart['shape'][] =>
    (doc.dynamics?.bodies[bodyId]?.entityIds ?? []).flatMap((id) => {
      const part = partsById.get(id);
      return part === undefined ? [] : [part.shape];
    });
  const meshesOf = (bodyId: string): MeshData[] =>
    (doc.dynamics?.bodies[bodyId]?.entityIds ?? []).flatMap((id) => partsById.get(id)?.mesh ?? []);
  return Object.values(doc.dynamics?.joints ?? {})
    .filter((joint) => joint.kind === 'revolute' && (inScope(joint.child) || inScope(joint.parent)))
    .map((joint) =>
      realiseJoint(kernel, {
        id: joint.id,
        anchor: joint.anchor,
        axis: joint.axis,
        parentShapes: joint.parent === GROUND ? [] : shapesOf(joint.parent),
        childShapes: shapesOf(joint.child),
        parentMeshes: joint.parent === GROUND ? [] : meshesOf(joint.parent),
        childMeshes: meshesOf(joint.child),
        mmPerUnit,
      }),
    );
}

/** Part bounds from the kernel's exact lumps when known (the tessellation is short by its chord error on curved parts). */
function withExactBounds(parts: readonly AssemblyPart[], analyses: ReadonlyMap<string, ShapeAnalysis>): AssemblyPart[] {
  return parts.map((part) => {
    const lumps = analyses.get(part.id)?.lumps ?? [];
    if (lumps.length === 0) return part;
    const min = [0, 1, 2].map((k) => Math.min(...lumps.map((lump) => lump.bounds.min[k] ?? Infinity), part.min[k] ?? Infinity));
    const max = [0, 1, 2].map((k) => Math.max(...lumps.map((lump) => lump.bounds.max[k] ?? -Infinity), part.max[k] ?? -Infinity));
    return { ...part, min: min as unknown as Vec3, max: max as unknown as Vec3 };
  });
}

function staleReferenceItem(doc: CadDocument): CheckItem[] {
  const prototype = doc.prototype;
  if (prototype === undefined) return [];
  const referenced = [...prototype.grounded, ...Object.values(prototype.intents).flatMap((intent) => [intent.a, intent.b])];
  const stale = [...new Set(referenced.filter((id) => doc.entities[id] === undefined))];
  return stale.length === 0
    ? []
    : [
        makeItem(
          'FPR_STALE_REFERENCE',
          'info',
          stale,
          'These ids no longer exist: remove their intents with delete_interference_intent or release them with set_part_grounded.',
          { note: 'prototype intents / grounded parts refer to deleted entities; they were ignored' },
        ),
      ];
}

const refusal = (limit: string, remediation: string): BudgetRefusal => ({ refused: true, limit, remediation });

export function runAssemblyCheck(
  doc: CadDocument,
  kernel: GeometryKernel,
  params: AssemblyCheckParams,
  geometryQueries?: GeometryQueryEngine | null,
): AssemblyCheckOutcome {
  const engine = resolveGeometryQueries(geometryQueries);
  const mmPerUnit = MM_PER_UNIT[doc.units];
  const tolerances: CheckTolerances = {
    epsTouch: params.touchToleranceMm === undefined ? DEFAULT_TOUCH_UNITS : params.touchToleranceMm / mmPerUnit,
    clearance: (params.clearanceMm ?? 0) / mmPerUnit,
    containmentRatio: CONTAINMENT_RATIO,
    volumeRelative: VOLUME_RELATIVE,
    mmPerUnit,
  };
  const { ids: allIds, skipped2D } = candidateIds(doc);
  const selected = scopedIds(doc, params);
  const subjectIds = selected === null ? allIds : allIds.filter((id) => selected.has(id));
  const narrow = 'Narrow the request with ids, body or component.';
  if (subjectIds.length > MAX_PARTS) return refusal(`${subjectIds.length} parts, limit ${MAX_PARTS}`, narrow);
  const threshold = thresholdOf(params);
  const rays = params.raysPerPart ?? DEFAULT_RAYS;
  const thicknessOn = (params.thickness ?? (threshold === null ? 'off' : 'ray')) === 'ray';
  if (thicknessOn && subjectIds.length * rays > engine.limits.maxThicknessRays)
    return refusal(
      `${subjectIds.length * rays} thickness rays, limit ${engine.limits.maxThicknessRays}`,
      'Lower raysPerPart, narrow the scope, or set thickness to "off".',
    );

  const subjects = new Set(subjectIds);
  // Context parts (outside the scope) are built so that contact with them counts as a connection; skipped when the document is too big.
  const buildIds = allIds.length <= MAX_PARTS ? new Set(allIds) : subjects;
  const collected = collectParts(doc, kernel, buildIds);
  const items: CheckItem[] = collected.refused.map(({ id, reason }) =>
    reason === 'kernel'
      ? makeItem(
          'FPR_PART_INVALID',
          'fail',
          [id],
          'The kernel refused to build this part (degenerate size, open mesh, unsupported feature); rebuild it.',
          { note: 'kernel evaluation returned null' },
        )
      : makeItem(
          'FPR_PART_EMPTY',
          'fail',
          [id],
          'The instance has no buildable solid: fix its component (missing, empty or nested too deep).',
          { note: 'instance expansion produced no solid' },
        ),
  );
  if (subjectIds.length === 0)
    items.push(
      makeItem(
        'FPR_NO_PARTS',
        'not_run',
        [],
        'Add 3D solids or component instances (2D entities are ignored), or pick a scope that has some.',
        { unverified: true, note: 'nothing to check: the document or scope has no 3D parts' },
      ),
    );
  const validity = validateParts(kernel, collected.parts, tolerances);
  items.push(...validity.items);
  const parts = withExactBounds(collected.parts, validity.analyses);

  const links = assemblyLinks(doc, new Set(allIds));
  const strongLinks = [...links.strongLinks];
  const touchLinks: Array<readonly [string, string]> = [];
  const candidates = candidatePairs(parts, tolerances.clearance + tolerances.epsTouch).filter(([i, j]) => {
    const [a, b] = [parts[i], parts[j]];
    if (a === undefined || b === undefined || (!subjects.has(a.id) && !subjects.has(b.id))) return false;
    if (validity.excluded.has(a.id) || validity.excluded.has(b.id)) return false;
    return params.body !== undefined || links.bodyOf.get(a.id) === undefined || links.bodyOf.get(a.id) !== links.bodyOf.get(b.id);
  });
  if (candidates.length > MAX_PAIRS) return refusal(`${candidates.length} candidate pairs, limit ${MAX_PAIRS}`, narrow);
  let pairsNotRun = false;
  for (const [i, j] of candidates) {
    const [a, b] = [parts[i] as AssemblyPart, parts[j] as AssemblyPart];
    const [analysisA, analysisB] = [validity.analyses.get(a.id), validity.analyses.get(b.id)];
    const pair =
      analysisA === undefined || analysisB === undefined
        ? null
        : classifyPair(kernel, a, b, analysisA.volume, analysisB.volume, tolerances);
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
  if (pairsNotRun) items.push(kernelUnsupportedItem(subjectIds, 'pair classification (distance / analyze)'));

  items.push(...connectivityItems({ parts: allIds, strongLinks, touchLinks, grounded: links.grounded }));
  const reported = items.filter((entry) => entry.ids.length === 0 || entry.ids.some((id) => subjects.has(id)));
  if (thicknessOn)
    reported.push(
      ...thicknessItems(parts, (part) => !subjects.has(part.id) || validity.excluded.has(part.id), threshold, rays, tolerances, engine),
    );
  if (params.includeJoints !== false) {
    const bodyInScope = (bodyId: string): boolean =>
      selected === null || (doc.dynamics?.bodies[bodyId]?.entityIds ?? []).some((id) => subjects.has(id));
    reported.push(...jointItems(doc, kernel, new Map(parts.map((part) => [part.id, part])), bodyInScope, mmPerUnit));
  }
  reported.push(...staleReferenceItem(doc));

  const provenanceParams = { ...params };
  const inputsHash = hashText(
    canonicalJson({
      parts: parts.map((part) => [part.id, recipeKey(part.recipe)]),
      refused: collected.refused,
      subjects: subjectIds,
      dynamics: doc.dynamics ?? null,
      joints: doc.joints,
      prototype: checkedPrototype(doc.prototype) ?? null,
      params: provenanceParams,
      units: doc.units,
      kernel: kernel.name ?? null,
    }),
  );
  const result: CheckResult = {
    check: 'assembly',
    status: reported.length === 0 ? 'pass' : worstStatus(reported.map((entry) => entry.status)),
    items: reported,
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
    unverified: reported.some((entry) => entry.status === 'not_run'),
    reviewRequired: true,
  };
  const extras = {
    parts: parts
      .filter((part) => subjects.has(part.id))
      .map((part) => ({ id: part.id, volumeMm3: (validity.analyses.get(part.id)?.volume ?? 0) * mmPerUnit ** 3 })),
    skipped2D,
    pairsChecked: candidates.length,
    ...(thicknessOn ? { geometryQueries: engine.provenance } : {}),
  };
  return { refused: false, result: roundDeep(result), extras: roundDeep(extras) };
}
