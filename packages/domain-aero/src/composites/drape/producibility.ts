/** Producibility of a ply on its tool face (06 CMP FR-CMP-41 / 42): fishnet shear against the material locking angle, with dart / splice hints. */

import type { CompositePart, LaminaMaterial, Ply } from '@core/model/composites';
import type { Vec3 } from '@core/model/types';
import { sig } from '../../shared/results';
import { isDoublyCurved } from '../surface';
import { type PlyDrapeResult, drapePly } from './plyDrape';
import type { OverLockRegion } from './shear';

export interface ProducibilityFinding {
  readonly code: 'CMP_DRAPE_LIMIT_MISSING' | 'CMP_PRODUCIBILITY_OVER_LOCK' | 'CMP_PRODUCIBILITY_NEAR_LOCK' | 'CMP_DRAPE_INCOMPLETE';
  readonly severity: 'fail' | 'warn';
  readonly message: string;
  readonly remediation: string;
}

export interface ProducibilitySuggestion {
  readonly kind: 'dart' | 'splice';
  readonly regionId: string;
  readonly near: Vec3;
  readonly message: string;
}

export interface PlyProducibility {
  readonly ply: string;
  readonly name: string;
  readonly method: 'fishnet' | 'developable';
  readonly maxShearDeg: number;
  /** Lowest piece coverage of the net (1 = every interior sample mapped); null for exact developable plies. */
  readonly coverage: number | null;
  readonly nodesOverWarning: number | null;
  readonly nodesOverLock: number | null;
  readonly areaOverLock: number | null;
  readonly findings: readonly ProducibilityFinding[];
  readonly suggestions: readonly ProducibilitySuggestion[];
}

const MIN_COVERAGE = 0.99;

export interface ShearOverrides {
  readonly lockingAngle?: number | undefined;
  readonly warningShear?: number | undefined;
  readonly stepLength?: number | undefined;
  readonly allowOverLock?: boolean | undefined;
  readonly maxNodes?: number | undefined;
}

/** Locking and warning shear limits (degrees): the explicit override, else the material record. */
export const limitsOf = (material: LaminaMaterial, over: ShearOverrides): { lock?: number; warning?: number } => {
  const lock = over.lockingAngle ?? material.lockingAngle;
  const warning = over.warningShear ?? material.warningShear;
  return { ...(lock === undefined ? {} : { lock }), ...(warning === undefined ? {} : { warning }) };
};

const DEVELOPABLE = (ply: Ply, part: CompositePart): boolean => !isDoublyCurved(part.surface) && ply.drape?.method !== 'kinematic';

/**
 * Assessment of one ply; developable faces without an explicit kinematic drape are exact (shear 0, nothing to drape).
 * @invariant a draped ply reports the worst shear over its pieces, counts nodes above the locking / warning angles and suggests a dart or
 *   splice at each over-lock region; a missing locking angle is a failing finding (no default exists)
 */
export function assessPly(
  part: CompositePart,
  ply: Ply,
  material: LaminaMaterial,
  over: ShearOverrides,
  drape: (part: CompositePart, ply: Ply, limits: { lock?: number; warning?: number }) => PlyDrapeResult = (p, q, limits) =>
    drapePly(p, q, { stepLength: over.stepLength, limits, allowOverLock: true, maxNodes: over.maxNodes }),
): PlyProducibility | { readonly error: string } {
  const base = { ply: ply.id, name: ply.name };
  if (DEVELOPABLE(ply, part))
    return {
      ...base,
      method: 'developable',
      maxShearDeg: 0,
      coverage: null,
      nodesOverWarning: null,
      nodesOverLock: null,
      areaOverLock: null,
      findings: [],
      suggestions: [],
    };
  const limits = limitsOf(material, over);
  const result = drape(part, ply, limits);
  if (!result.ok) return { error: result.message };
  const pieces = result.pieces.map((piece) => piece.summary);
  const maxShearDeg = Math.max(0, ...pieces.map((summary) => summary.maxShearDeg));
  const sum = (pick: (s: (typeof pieces)[number]) => number | null): number => pieces.reduce((total, s) => total + (pick(s) ?? 0), 0);
  const nodesOverLock = limits.lock === undefined ? null : sum((s) => s.nodesOverLock);
  const nodesOverWarning = limits.warning === undefined ? null : sum((s) => s.nodesOverWarning);
  const areaOverLock = limits.lock === undefined ? null : sum((s) => s.areaOverLock);
  const findings: ProducibilityFinding[] = [];
  const coverage = Math.min(...result.pieces.map((piece) => piece.coverage));
  const truncated = result.pieces.some((piece) => piece.net.stats.truncated);
  if (truncated || coverage < MIN_COVERAGE)
    findings.push({
      code: 'CMP_DRAPE_INCOMPLETE',
      severity: 'fail',
      message: `ply "${ply.name}": the drape net covers only ${sig(100 * coverage)} % of the piece${truncated ? ' (node budget reached)' : ''}: a node failed (off the face, folded or not converged), so shear statistics are missing for the rest`,
      remediation: 'change the seed or the step length (stepLength), or split the ply with darts so each piece drapes completely',
    });
  if (limits.lock === undefined)
    findings.push({
      code: 'CMP_DRAPE_LIMIT_MISSING',
      severity: 'fail',
      message: `material "${material.name}" has no lockingAngle`,
      remediation: 'add lockingAngle (degrees, from a cited drape test) to the lamina record or pass lockingAngle explicitly',
    });
  else if ((nodesOverLock ?? 0) > 0)
    findings.push({
      code: 'CMP_PRODUCIBILITY_OVER_LOCK',
      severity: 'fail',
      message: `ply "${ply.name}": ${nodesOverLock} node(s) over the ${limits.lock} deg locking angle (max shear ${sig(maxShearDeg)} deg, area ${sig(areaOverLock ?? 0)})`,
      remediation:
        'split the ply with a dart or splice (split_ply), change its orientation or seed, or accept over-lock flats (allowOverLock) with a reviewer',
    });
  else if (limits.warning !== undefined && (nodesOverWarning ?? 0) > 0)
    findings.push({
      code: 'CMP_PRODUCIBILITY_NEAR_LOCK',
      severity: 'warn',
      message: `ply "${ply.name}": ${nodesOverWarning} node(s) over the ${limits.warning} deg warning shear (max ${sig(maxShearDeg)} deg)`,
      remediation: 'review the shear map; consider a dart or splice near the highest-shear region',
    });
  const regions: readonly OverLockRegion[] = result.pieces.flatMap((piece) => piece.summary.overLockRegions);
  const suggestions = regions
    .slice(0, 10)
    .map(
      (region): ProducibilitySuggestion => ({
        kind: region.nodeCount > 50 ? 'splice' : 'dart',
        regionId: region.id,
        near: region.centroid,
        message: `${region.nodeCount} node(s) up to ${sig(region.maxShearDeg)} deg near [${region.centroid.map(sig).join(', ')}]: cut a ${region.nodeCount > 50 ? 'splice across' : 'dart into'} this region`,
      }),
    );
  return {
    ...base,
    method: 'fishnet',
    maxShearDeg: sig(maxShearDeg),
    coverage: sig(coverage),
    nodesOverWarning,
    nodesOverLock,
    areaOverLock,
    findings,
    suggestions,
  };
}
