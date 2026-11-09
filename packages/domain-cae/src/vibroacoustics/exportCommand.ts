/** export_acoustic_load (PHY-20 FR-VAC-08, 09, 11): the acoustic hand-off package of an exposure, with exact face areas from the kernel. */

import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import { exportRefusal, report } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { exportDocumentHash } from '@core/model/exportGate';
import { MM_PER_UNIT, toMm } from '@core/model/units';
import { is3D, type Vec3 } from '@core/model/types';
import { refuseVac } from './codes';
import { facesNearPoints } from './faceResolve';
import { acousticLoadPackage, type ExposedFace } from './exportPackage';
import { exposureOf, spectrumOf } from './model';

interface FaceRecord {
  readonly index: number;
  readonly surface: string;
  readonly area: number;
  readonly centroid: Vec3;
}

const isFiniteVec3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));

/** Every record has an integer index, a string surface, a finite area and a finite 3-element centroid (a malformed kernel answer is never exported). */
const isFaceRecords = (value: unknown, count: number): value is readonly FaceRecord[] =>
  Array.isArray(value) &&
  value.length === count &&
  value.every((face: Partial<FaceRecord> | null) => {
    if (face === null || typeof face !== 'object') return false;
    return Number.isInteger(face.index) && typeof face.surface === 'string' && Number.isFinite(face.area) && isFiniteVec3(face.centroid);
  });

/**
 * @affects nothing; read-only, data = the llull.acousticLoad/1 package { schema, exposure, field, spectrum, faces[{ entityId, faceIndex, areaMm2, centroidMm, rmsForceN }], totalAreaMm2,
 *   provenance, unverified, reviewRequired: true, reviewReason, items }
 * @invariant areas and centroids come from inspect_faces (exact kernel) in document units and are converted to mm / mm^2 and rounded to 1e-6 (stable across kernel builds), never estimated; deterministic for one document
 * @failure kind given -> VAC_OUT_OF_SCOPE; unknown exposure / spectrum -> VAC_EXPOSURE_UNKNOWN / VAC_SPECTRUM_UNKNOWN; no exact kernel -> KRN_NO_EXACT_KERNEL; inspect_faces refusals are forwarded with their code (ENTITY_NOT_FOUND, ENTITY_NOT_SOLID, KRN_NO_EXACT_KERNEL, KRN_SHAPE_UNAVAILABLE,
 *   KRN_FACE_INDEX, KRN_FACE_QUERY_FAILED); malformed face records -> KRN_FACE_QUERY_FAILED; target solid
 *   gone, a point off the solid or on an edge -> VAC_EXPOSURE_UNRESOLVED (rejected, no data)
 */
export const exportAcousticLoad = defineCommand({
  name: 'export_acoustic_load',
  annotations: { readOnly: true, requiresKernel: true },
  description:
    'Export an acoustic exposure (define_acoustic_exposure) as the hand-off package "llull.acousticLoad/1" in data: the field type, the spectrum (per band nominal and exact mid frequency, level dB re 20 micropascal, ' +
    'band-averaged one-sided pressure PSD in Pa^2/Hz, overall level and rms pressure) and the exposed faces with their EXACT area (mm^2) and centroid (mm) from the exact kernel (inspect_faces; ' +
    'there is no mesh estimate: without the exact kernel the command is refused with KRN_NO_EXACT_KERNEL), plus for a diffuse field the rms force of the overall pressure on each face (N; uniform ' +
    'pressure, correlation not modelled) and the total area. Provenance carries the source and the document hash. reviewRequired is always true (the package feeds a qualification analysis) ' +
    'and an unverified spectrum adds VAC_SPECTRUM_UNVERIFIED. It is a hand-off: llull does not compute a response (no SEA, no acoustic FE); pass no `kind`. Does not modify the document; ' +
    'save data to a file with the CLI --save.',
  params: z.object({
    confirmExportControlled,
    exposure: z.string().describe('Name of the exposure to export (define_acoustic_exposure).'),
    kind: z
      .string()
      .optional()
      .describe(
        'Do not set. Any value (e.g. "sea", "acoustic_fe") asks for a response analysis, which llull does not do: refused with VAC_OUT_OF_SCOPE.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: string[], paths: string[] = []): CommandResult =>
      refuseVac(doc, 'export_acoustic_load', code, message, ids, paths);
    const refused = exportRefusal(doc, 'export_acoustic_load', 'data', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    if (params.kind !== undefined)
      return fail(
        'VAC_OUT_OF_SCOPE',
        `kind '${params.kind}' asks for a response analysis; llull exports the environment only`,
        [params.exposure],
        ['kind'],
      );
    const exposure = exposureOf(doc, params.exposure);
    if (exposure === undefined) return fail('VAC_EXPOSURE_UNKNOWN', `no exposure '${params.exposure}'`, [params.exposure], ['exposure']);
    const spectrum = spectrumOf(doc, exposure.spectrum);
    if (spectrum === undefined)
      return fail('VAC_SPECTRUM_UNKNOWN', `exposure '${exposure.name}' names no spectrum '${exposure.spectrum}'`, [exposure.name]);
    const kernel = ctx?.kernel ?? null;
    if (kernel === null || kernel.faceQuery === undefined)
      return fail('KRN_NO_EXACT_KERNEL', 'no exact kernel with face queries is available: face areas are never estimated', [exposure.name]);
    const entityId = exposure.target.entityId;
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    if (entity === undefined || !is3D(entity))
      return fail('VAC_EXPOSURE_UNRESOLVED', `target '${entityId}' is not a 3D solid of the document`, [exposure.name, entityId]);
    const resolved = facesNearPoints(doc, kernel, entity, exposure.target.facesNear);
    if ('problem' in resolved) return fail('VAC_EXPOSURE_UNRESOLVED', resolved.problem, [exposure.name, entityId]);
    const inspected = execute(doc, 'inspect_faces', { entityId, faces: [...resolved.faces] }, ctx);
    const records: unknown = (inspected.data as { faces?: unknown } | undefined)?.faces;
    if (inspected.rejected === true || inspected.error !== undefined)
      return { ...inspected, summary: `export_acoustic_load: ${inspected.summary}` };
    if (!isFaceRecords(records, resolved.faces.length))
      return fail('KRN_FACE_QUERY_FAILED', 'the kernel returned malformed face records (non-finite area or centroid, wrong count)', [
        exposure.name,
        entityId,
      ]);
    const areaFactor = MM_PER_UNIT[doc.units] ** 2;
    const faces: ExposedFace[] = records.map((face) => ({
      entityId,
      faceIndex: face.index,
      surface: face.surface,
      areaMm2: face.area * areaFactor,
      centroidMm: [toMm(doc, face.centroid[0]), toMm(doc, face.centroid[1]), toMm(doc, face.centroid[2])],
    }));
    const data = acousticLoadPackage(exposure, spectrum, faces, exportDocumentHash(doc));
    return report(
      doc,
      `export_acoustic_load '${exposure.name}': ${exposure.field} field, spectrum '${spectrum.name}' (${spectrum.bands.length} ${spectrum.bandwidth} bands, OASPL ${data.spectrum.oasplDb.toPrecision(12)} dB re 20 uPa) on ${faces.length} face(s) of '${entityId}' [${faces.map((face) => face.faceIndex).join(', ')}], total ${data.totalAreaMm2.toPrecision(10)} mm^2 (exact kernel); reviewRequired${spectrum.unverified ? '; VAC_SPECTRUM_UNVERIFIED: not grade A' : ''}.`,
      data,
    );
  },
});
