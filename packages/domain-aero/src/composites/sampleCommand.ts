/** core_sample: the ply stack at a point or along a polyline of a composite part (FR-CMP-11). */

import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import type { CompositePart, CompositesModel } from '@core/model/composites';
import type { Vec3 } from '@core/model/types';
import { lerp3 } from '@lib/vec3';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { printNotation } from './notation';
import { isUnverified } from './provenance';
import { type StackEntry, locate, stackAt } from './sample';
import { compositesOf, findPart } from './state';
import { fibreDirection3d } from './surface';

/** One sampled stack as agent-readable data (lengths in document units). */
export function sampleData(
  model: CompositesModel,
  part: CompositePart,
  point: Vec3,
  entries: readonly StackEntry[],
  lengthUnit: string,
): Record<string, unknown> {
  const uv = locate(part, point);
  const thickness = entries.length === 0 ? 0 : (entries[entries.length - 1] as StackEntry).z1;
  return {
    point: [...point],
    flatPoint: uv === null ? null : uv.map(sig),
    lengthUnit,
    plyCount: entries.length,
    thickness: sig(thickness),
    laminate: printNotation(entries.map((entry) => entry.ply.orientation)),
    plies: entries.map((entry) => {
      const direction = uv === null ? null : fibreDirection3d(part.surface, uv, entry.ply.orientation);
      return {
        id: entry.ply.id,
        name: entry.ply.name,
        material: entry.ply.materialName,
        sequence: entry.ply.sequence,
        angleRosetteDeg: entry.ply.orientation,
        angleGlobalDeg: direction === null ? null : sig((Math.atan2(direction[1], direction[0]) * 180) / Math.PI),
        directionGlobal: direction === null ? null : direction.map(sig),
        z0: sig(entry.z0),
        z1: sig(entry.z1),
      };
    }),
    unverified: entries.some((entry) => isUnverified(model.materials[entry.ply.materialName] ?? entry.material)),
  };
}

const MAX_SAMPLES = 200;

/**
 * @affects nothing (read-only)
 * @invariant plies are listed tool side first; z0 / z1 are heights above the tool face in document units; a point is projected on the tool face along its normal
 * @failure unknown part -> CMP_REF_MISSING; neither / both of point and polyline, or a point off the part outline -> CMP_POINT_OFF_PART / CMP_PARAM_INVALID
 */
export const coreSample = defineCommand({
  name: 'core_sample',
  annotations: { readOnly: true },
  description:
    'Core sample of a composite part: the ordered plies (tool side first) that cover a point, with material, sequence, fibre angle in the ' +
    'rosette frame and in global axes, the 3D fibre direction, cumulative heights z0 / z1 above the tool face and the total thickness, ' +
    'all in document units, plus the compact stacking string. Give `point` [x, y, z] (projected onto the tool face) or `polyline` ' +
    '(vertices [x, y, z] of a section path, sampled at `samples` equally spaced stations along it, default 5, at most 200). Plies from ' +
    'ramps count where their extended region covers the point. Read-only.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    point: vec3('World point [x, y, z] in document units (projected on the tool face).').optional(),
    polyline: z.array(vec3('Path vertex [x, y, z], document units.')).describe('Section path of at least 2 vertices.').optional(),
    samples: z.number().describe('Number of stations along `polyline`, integer 2..200; default 5.').optional(),
  }),
  run: (doc, { part: partRef, point, polyline, samples = 5 }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'core_sample', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    if ((point === undefined) === (polyline === undefined) || (polyline !== undefined && polyline.length < 2))
      return refuseCmp(
        doc,
        'core_sample',
        'CMP_PARAM_INVALID',
        'give either a point or a polyline of at least 2 vertices',
        [part.id],
        ['params.point'],
      );
    const count = Math.min(MAX_SAMPLES, Math.max(2, Math.floor(samples)));
    const stations: Vec3[] =
      polyline === undefined
        ? [point as Vec3]
        : Array.from({ length: count }, (_, i) => {
            const t = (i / (count - 1)) * (polyline.length - 1);
            const k = Math.min(Math.floor(t), polyline.length - 2);
            return lerp3(polyline[k] as Vec3, polyline[k + 1] as Vec3, t - k);
          });
    const results: Record<string, unknown>[] = [];
    for (const station of stations) {
      const uv = locate(part, station);
      if (uv === null)
        return refuseCmp(
          doc,
          'core_sample',
          'CMP_POINT_OFF_PART',
          `[${station.join(', ')}] projects outside the outline of part "${part.name}"`,
          [part.id],
          ['params.point'],
        );
      results.push(sampleData(model, part, station, stackAt(model, part, uv), doc.units));
    }
    const first = results[0] as { plyCount: number; thickness: number; laminate: string };
    return report(
      doc,
      `core_sample: part "${part.name}": ${results.length === 1 ? `${first.plyCount} plies, thickness ${first.thickness} ${doc.units}, ${first.laminate}` : `${results.length} stations, ${Math.min(...results.map((r) => r['plyCount'] as number))}..${Math.max(...results.map((r) => r['plyCount'] as number))} plies`}.`,
      polyline === undefined ? { part: part.id, ...results[0] } : { part: part.id, stations: results },
    );
  },
});
