/** implicit_properties: volume with an error statement, area, relative density, bounds, components and enclosed voids (05 IMP 4.4, 5.8). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { resolveFieldEngine } from '@core/geometry/field/engine';
import { meshMeasures } from '@lib/isosurface/measures';
import { fullBodyMesh } from './bodyMesh';
import { refuseImplicit } from './codes';
import { compileField } from './compile';
import { quadratureVolume, regionProgram, resolveTarget, signComponentsOf, measureVoxel } from './measure';
import { fieldOf } from './model';

/**
 * @affects none (read-only); data = volume, volumeMesh, volumeQuadrature, errorEstimate, area, relativeDensity, bounds, components, enclosedVoids, unit, provenance, unverified
 * @invariant volume is the mesh volume of a body (divergence theorem) or the field quadrature of a field; with a region it is the quadrature clipped to that region; errorEstimate = |quadrature(h) - quadrature(1.25 h)| + the mesher estimate, labelled estimated
 * @invariant field-engine-optional: reads ctx.fieldEngine when present, else the built-in TS engine (no kernel is needed)
 * @failure unknown id / region -> IMP_FIELD_NOT_FOUND; unbounded field -> IMP_FIELD_UNBOUNDED; over the sample limit -> IMP_GRID_BUDGET
 */
export const implicitProperties = defineCommand({
  name: 'implicit_properties',
  description:
    'Measure an implicit body (id from create_implicit_body) or field (id from add_field_primitive / add_tpms_lattice...): volume with an error estimate, mesh area, relative density ' +
    '(volume / region volume; the region defaults to the support box), bounds, number of solid components and enclosed voids (volume and a point inside each). ' +
    'region (a field id) restricts the volume and the density to that region, e.g. the box a lattice fills. Volumes are in document units cubed. Strut lattices use a low-discrepancy quadrature (an aligned grid would alias with the struts).',
  annotations: { readOnly: true },
  params: z.object({
    id: z.string().describe('Id of an implicit body or of a field node.'),
    region: z.string().optional().describe('Field id restricting the measure (volume, density). Default: no restriction.'),
    voxel: z.number().optional().describe('Measure grid spacing in document units. Default: about 2^19 cells over the support box.'),
  }),
  run: (doc, p, ctx): CommandResult => {
    const target = resolveTarget(doc, p.id);
    if (target === undefined)
      return refuseImplicit(
        doc,
        'implicit_properties',
        'IMP_FIELD_NOT_FOUND',
        `no implicit body or field '${p.id}'`,
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
    const compiled = compileField(doc, target.fieldId);
    if (!compiled.ok) return refuseImplicit(doc, 'implicit_properties', compiled.code, compiled.message, compiled.ids);
    const region = regionProgram(doc, p.region);
    if (region !== null && 'message' in region)
      return refuseImplicit(doc, 'implicit_properties', region.code, region.message, p.region === undefined ? [] : [p.region]);
    const box = target.body?.bounds ?? compiled.program.bounds ?? (region === null ? null : region.bounds);
    if (box === null)
      return refuseImplicit(
        doc,
        'implicit_properties',
        'IMP_FIELD_UNBOUNDED',
        `field '${target.fieldId}' has no finite support: give a region`,
        [target.fieldId],
      );
    const engine = resolveFieldEngine(ctx?.fieldEngine);
    const voxel = measureVoxel(box, p.voxel, target.body?.voxel !== undefined ? target.body.voxel / 4 : 0);
    const quadrature = quadratureVolume(engine, compiled.program, region, box, voxel);
    if ('code' in quadrature) return refuseImplicit(doc, 'implicit_properties', quadrature.code, quadrature.message, [p.id]);
    const entity = target.body === undefined ? undefined : doc.entities[target.body.id];
    const full = entity?.kind === 'mesh' ? fullBodyMesh(entity, ctx?.meshAssets) : null;
    if (entity?.kind === 'mesh' && full === null)
      return refuseImplicit(
        doc,
        'implicit_properties',
        'IMP_ASSET_MISSING',
        `the full mesh of body '${p.id}' is not in this machine's mesh asset store`,
        [p.id],
      );
    const mesh = full === null ? null : meshMeasures(full);
    const meshEstimate =
      mesh !== null && Number.isFinite(compiled.minFeature)
        ? 0.6 * ((target.body?.voxel ?? 0) / compiled.minFeature) ** 2 * Math.abs(mesh.volume)
        : 0;
    const clipped = region !== null;
    const volume = mesh !== null && !clipped ? mesh.volume : quadrature.volume;
    const errorEstimate = quadrature.quadratureError + (mesh !== null && !clipped ? meshEstimate : 0);
    const referenceVolume = quadrature.regionVolume;
    const components = signComponentsOf(
      engine,
      compiled.program,
      box,
      Math.max(
        voxel,
        box === null ? voxel : Math.cbrt(((box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2])) / 2 ** 20),
      ),
    );
    const parts = 'code' in components ? null : components;
    const data = {
      id: p.id,
      field: target.fieldId,
      volume,
      volumeUnit: `${doc.units}^3`,
      volumeMesh: mesh?.volume ?? null,
      volumeQuadrature: quadrature.volume,
      meshQuadratureGap: mesh === null ? null : Math.abs(mesh.volume - quadrature.volume),
      errorEstimate: { value: errorEstimate, kind: 'estimated', basis: 'two quadratures + mesher second-order estimate' },
      area: mesh?.area ?? null,
      relativeDensity: referenceVolume > 0 ? quadrature.volume / referenceVolume : null,
      densityReference: p.region === undefined ? 'support box' : `region ${p.region}`,
      bounds: box,
      components: parts === null ? null : parts.solids.length,
      enclosedVoids: parts === null ? null : parts.voids.slice(0, 50).map((v) => ({ volume: v.volume, point: v.point })),
      componentsNote:
        parts === null
          ? 'components unavailable at this resolution'
          : `${parts.belowResolution} component(s) smaller than 8 voxels not reported`,
      unit: doc.units,
      distanceQuality: compiled.program.quality,
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
      `implicit_properties: ${p.id} volume ${volume.toPrecision(6)} ${doc.units}^3 (+-${errorEstimate.toPrecision(2)} estimated), relative density ${data.relativeDensity === null ? 'n/a' : data.relativeDensity.toPrecision(4)} of the ${data.densityReference}, ${data.components ?? '?'} solid component(s), ${data.enclosedVoids?.length ?? '?'} enclosed void(s)${compiled.unverified ? '; UNVERIFIED input' : ''}.`,
      data,
    );
  },
});
