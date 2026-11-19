/** Phases of implicit_properties: request validation, body mesh measure, result data and summary. */

import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { FieldEngine } from '@core/geometry/field/engineTypes';
import type { FieldProgram } from '@core/geometry/field/program';
import type { CadDocument } from '@core/model/types';
import type { MeshMeasures } from '@lib/isosurface/measures';
import { fullBodyMesh } from './bodyMesh';
import { refuseImplicit } from './codes';
import type { Compiled } from './compile';
import { type Box, type VolumeAnswer, resolveTarget, signComponentsOf } from './measure';
import { bodyMeshMeasuresOf } from './meshFacts';
import { fieldOf } from './model';

export type Target = NonNullable<ReturnType<typeof resolveTarget>>;

export const isRefusal = (value: object): value is CommandResult => 'document' in value;

/** The addressed body / field, or the refusal of an unknown id, a stale body, an unknown region or a bad voxel. */
export function resolveRequest(
  doc: CadDocument,
  p: { id: string; region?: string | undefined; voxel?: number | undefined },
): Target | CommandResult {
  const target = resolveTarget(doc, p.id);
  if (target === undefined)
    return refuseImplicit(doc, 'implicit_properties', 'IMP_FIELD_NOT_FOUND', `no implicit body or field '${p.id}'`, [p.id], ['params.id']);
  if (target.body !== undefined && !Object.hasOwn(doc.entities, target.body.id))
    return refuseImplicit(
      doc,
      'implicit_properties',
      'IMP_BODY_STALE',
      `body '${p.id}' is not realised on this machine (it reads a stored body whose mesh asset is missing)`,
      [p.id],
      ['params.id'],
    );
  if (p.region !== undefined && fieldOf(doc, p.region) === undefined)
    return refuseImplicit(
      doc,
      'implicit_properties',
      'IMP_FIELD_NOT_FOUND',
      `no region field '${p.region}'`,
      [p.region],
      ['params.region'],
    );
  if (p.voxel !== undefined && !(Number.isFinite(p.voxel) && p.voxel > 0))
    return refuseImplicit(doc, 'implicit_properties', 'IMP_PARAM_RANGE', `voxel must be > 0 (got ${p.voxel})`, [], ['params.voxel']);
  return target;
}

type MeshMeasure = MeshMeasures;

/** The measures of the full mesh of the body (null for a field), or the refusal when its mesh asset is missing. */
export function bodyMeshMeasures(
  doc: CadDocument,
  id: string,
  target: Target,
  ctx: ExecutionContext | undefined,
): MeshMeasure | null | CommandResult {
  const entity = target.body === undefined ? undefined : doc.entities[target.body.id];
  const full = entity?.kind === 'mesh' ? fullBodyMesh(entity, ctx?.meshAssets) : null;
  if (entity?.kind === 'mesh' && full === null)
    return refuseImplicit(
      doc,
      'implicit_properties',
      'IMP_ASSET_MISSING',
      `the full mesh of body '${id}' is not in this machine's mesh asset store`,
      [id],
    );
  return full === null ? null : bodyMeshMeasuresOf(full);
}

export interface Measured {
  readonly id: string;
  readonly region: string | undefined;
  readonly target: Target;
  readonly compiled: Compiled;
  readonly regionClipped: boolean;
  readonly box: Box;
  readonly engine: FieldEngine;
  readonly voxel: number;
  readonly quadrature: VolumeAnswer;
  readonly mesh: MeshMeasure | null;
}

/** The report of a measured body / field: data payload and one-line summary. */
export function propertiesReport(doc: CadDocument, measured: Measured): CommandResult {
  const { id, region, target, compiled, regionClipped: clipped, box, engine, voxel, quadrature, mesh } = measured;
  const program: FieldProgram = compiled.program;
  const meshEstimate =
    mesh !== null && Number.isFinite(compiled.minFeature)
      ? 0.6 * ((target.body?.voxel ?? 0) / compiled.minFeature) ** 2 * Math.abs(mesh.volume)
      : 0;
  const volume = mesh !== null && !clipped ? mesh.volume : quadrature.volume;
  const errorEstimate = quadrature.quadratureError + (mesh !== null && !clipped ? meshEstimate : 0);
  const referenceVolume = quadrature.regionVolume;
  const components = signComponentsOf(
    engine,
    program,
    box,
    Math.max(
      voxel,
      box === null ? voxel : Math.cbrt(((box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2])) / 2 ** 20),
    ),
  );
  const parts = 'code' in components ? null : components;
  const data = {
    id,
    field: target.fieldId,
    volume,
    volumeUnit: `${doc.units}^3`,
    volumeMesh: mesh?.volume ?? null,
    volumeQuadrature: quadrature.volume,
    meshQuadratureGap: mesh === null ? null : Math.abs(mesh.volume - quadrature.volume),
    errorEstimate: { value: errorEstimate, kind: 'estimated', basis: 'two quadratures + mesher second-order estimate' },
    area: mesh?.area ?? null,
    relativeDensity: referenceVolume > 0 ? quadrature.volume / referenceVolume : null,
    densityReference: region === undefined ? 'support box' : `region ${region}`,
    bounds: box,
    components: parts === null ? null : parts.solids.length,
    enclosedVoids: parts === null ? null : parts.voids.slice(0, 50).map((v) => ({ volume: v.volume, point: v.point })),
    componentsNote:
      parts === null
        ? 'components unavailable at this resolution'
        : `${parts.belowResolution} component(s) smaller than 8 voxels not reported`,
    unit: doc.units,
    distanceQuality: program.quality,
    unverified: compiled.unverified,
    provenance: {
      method: `${quadrature.sampling} quadrature at voxel ${quadrature.voxel}${mesh !== null ? ', mesh divergence integral' : ''}`,
      engine: quadrature.engine,
      deterministic: quadrature.deterministic,
      voxel: quadrature.voxel,
      quadrature: quadrature.sampling,
      samples: quadrature.samples,
      nonFiniteSamples: quadrature.nonFiniteSamples,
    },
  };
  return report(
    doc,
    `implicit_properties: ${id} volume ${volume.toPrecision(6)} ${doc.units}^3 (+-${errorEstimate.toPrecision(2)} estimated), relative density ${data.relativeDensity === null ? 'n/a' : data.relativeDensity.toPrecision(4)} of the ${data.densityReference}, ${data.components ?? '?'} solid component(s), ${data.enclosedVoids?.length ?? '?'} enclosed void(s)${compiled.unverified ? '; UNVERIFIED input' : ''}.`,
    data,
  );
}
