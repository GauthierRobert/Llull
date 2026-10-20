/**
 * Re-resolution of PMI features against the CURRENT B-rep (TR-GDT-06): after a parametric edit `facesNear` finds the faces again and the
 * derived data (`faceIndices`, measured size / location, pattern count) are recomputed. Failures are findings, never throws.
 * @invariant a stored surface type that differs from the resolved one is an error (GDT_SURFACE_TYPE_CHANGED), never a silent re-attachment
 */

import type { GeometryKernel } from '../../geometry/kernel';
import type { AnnotationPlacement, PmiFeature, PmiItem } from '../../model/pmi';
import { autoPlacement } from '../../geometry/pmiPlacement';
import { type CadDocument, is3D } from '../../model/types';
import { type FeatureProblem, type SolidFaces, openSolid, resolveIn } from '../../geometry/pmiFeatures';
import { featureElement, locate, measureSize } from '../../geometry/pmiMeasure';
import { operandRecipe } from '../brep/kernelShape';
import { type Finding, finding } from './rules';

const NO_KERNEL: FeatureProblem = { code: 'GDT_KERNEL_NO_TOPOLOGY', message: 'requires the OCC kernel', pointIndices: [] };

export type SolidLookup = (entityId: string) => SolidFaces | FeatureProblem | null;

/** Memoised solid openers: one `faceDetails` per solid per pass. `null` = the entity is missing or not a solid. */
export function createSolidLookup(doc: CadDocument, kernel: GeometryKernel | null): SolidLookup {
  const cache = new Map<string, SolidFaces | FeatureProblem | null>();
  return (entityId) => {
    if (cache.has(entityId)) return cache.get(entityId) ?? null;
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    const opened =
      entity === undefined || !is3D(entity) ? null : kernel === null ? NO_KERNEL : openSolid(kernel, operandRecipe(kernel, entity));
    cache.set(entityId, opened);
    return opened;
  };
}

export interface Refresh {
  readonly item: PmiItem;
  readonly findings: readonly Finding[];
  /** The kernel could not answer (no exact topology): nothing was checked. */
  readonly notRun: boolean;
}

interface FeatureRefresh {
  readonly feature: PmiFeature;
  readonly found: SolidFaces | null;
  readonly resolved: ReturnType<typeof resolveIn> | null;
}

function refreshFeature(
  id: string,
  path: string,
  feature: PmiFeature,
  lookup: SolidLookup,
  adopt: boolean,
  out: Finding[],
): FeatureRefresh & { readonly notRun: boolean } {
  const solid = lookup(feature.entityId);
  const keep = { feature, found: null, resolved: null };
  if (solid === null) {
    out.push(finding('error', 'GDT_FEATURE_UNRESOLVED', [id], `${path}: entity '${feature.entityId}' is missing or not a solid`, [path]));
    return { ...keep, notRun: false };
  }
  if ('code' in solid) return { ...keep, notRun: solid.code === 'GDT_KERNEL_NO_TOPOLOGY' };
  const resolved = resolveIn(solid, feature.facesNear);
  if ('code' in resolved) {
    out.push(finding('error', 'GDT_FEATURE_UNRESOLVED', [id], `${path}: ${resolved.message}`, [path]));
    return { ...keep, found: solid, notRun: false };
  }
  if (resolved.surface !== feature.surface)
    out.push(
      finding('error', 'GDT_SURFACE_TYPE_CHANGED', [id], `${path}: resolved ${resolved.surface}, stored ${feature.surface}`, [path]),
    );
  const next: PmiFeature = {
    ...feature,
    faceIndices: resolved.faces.map((face) => face.index),
    ...(adopt ? { surface: resolved.surface } : {}),
  };
  return { feature: next, found: solid, resolved, notRun: false };
}

/**
 * The item with every feature re-resolved and its derived data refreshed, plus the findings. With `adopt` the resolved surface type replaces
 * the stored one (an explicit re-attach); without it a differing type is reported.
 */
export function refreshItem(item: PmiItem, lookup: SolidLookup, adopt = false): Refresh {
  const findings: Finding[] = [];
  let notRun = false;
  const run = (path: string, feature: PmiFeature): FeatureRefresh => {
    const result = refreshFeature(item.id, path, feature, lookup, adopt, findings);
    notRun = notRun || result.notRun;
    return result;
  };
  switch (item.kind) {
    case 'datum_feature':
    case 'datum_target':
    case 'surface_texture':
      return { item: { ...item, feature: run('feature', item.feature).feature }, findings, notRun };
    case 'note': {
      if (item.feature === undefined) return { item, findings, notRun };
      return { item: { ...item, feature: run('feature', item.feature).feature }, findings, notRun };
    }
    case 'geometric_tolerance': {
      if (!('feature' in item.target)) return { item, findings, notRun };
      return { item: { ...item, target: { feature: run('target.feature', item.target.feature).feature } }, findings, notRun };
    }
    case 'size_dimension': {
      const refreshed = run('feature', item.feature);
      if (refreshed.resolved === null || 'code' in refreshed.resolved)
        return { item: { ...item, feature: refreshed.feature }, findings, notRun };
      const size = measureSize(refreshed.resolved.faces, item.sizeKind, refreshed.resolved.topology, refreshed.resolved.tolerance);
      if ('code' in size) {
        findings.push(finding('error', 'GDT_FEATURE_UNRESOLVED', [item.id], `feature: ${size.message}`, ['feature']));
        return { item: { ...item, feature: refreshed.feature }, findings, notRun };
      }
      return { item: { ...item, count: size.count, feature: { ...refreshed.feature, ofSize: size.ofSize } }, findings, notRun };
    }
    case 'location_dimension': {
      const [from, to] = [run('from', item.from), run('to', item.to)];
      if (from.resolved === null || to.resolved === null || 'code' in from.resolved || 'code' in to.resolved)
        return { item: { ...item, from: from.feature, to: to.feature }, findings, notRun };
      const [a, b] = [
        featureElement(from.resolved.faces, from.resolved.tolerance),
        featureElement(to.resolved.faces, to.resolved.tolerance),
      ];
      const located = 'code' in a || 'code' in b ? null : locate(a, b, item.measure);
      if (located === null || 'code' in located) {
        findings.push(finding('error', 'GDT_FEATURE_UNRESOLVED', [item.id], 'the located features no longer measure', ['from']));
        return { item: { ...item, from: from.feature, to: to.feature }, findings, notRun };
      }
      return { item: { ...item, measured: located.measured, from: from.feature, to: to.feature }, findings, notRun };
    }
  }
}

/** The feature an item is placed on: its own, a location's `to`, or the targeted size dimension's. */
export function primaryFeature(item: PmiItem, items: Readonly<Record<string, PmiItem>>): PmiFeature | undefined {
  switch (item.kind) {
    case 'location_dimension':
      return item.to;
    case 'note':
      return item.feature;
    case 'geometric_tolerance': {
      if ('feature' in item.target) return item.target.feature;
      const target = items[item.target.pmiId];
      return target !== undefined && 'feature' in target ? target.feature : undefined;
    }
    default:
      return item.feature;
  }
}

/** Automatic annotation placement of `item` on its current faces (its own frame is ignored when avoiding collisions). */
export function autoPlacementOf(doc: CadDocument, item: PmiItem, lookup: SolidLookup): AnnotationPlacement {
  const feature = primaryFeature(item, doc.pmi?.items ?? {});
  const solid = feature === undefined ? null : lookup(feature.entityId);
  if (feature === undefined || solid === null || 'code' in solid) return item.placement;
  const resolved = resolveIn(solid, feature.facesNear);
  const face = 'code' in resolved ? undefined : resolved.faces[0];
  if ('code' in resolved || face === undefined) return item.placement;
  const taken = Object.values(doc.pmi?.items ?? {}).flatMap((other) => (other.id === item.id ? [] : [other.placement]));
  return autoPlacement(face, resolved.diagonal, taken);
}
