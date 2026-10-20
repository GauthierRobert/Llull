/** Registration records (TECHNICAL_SPEC §4.1, FR-SCN-10): apply a computed record, mark pre-registered data, the human acceptance gate. */

import type { CloudReference, RegistrationRecord } from '@core/model/pointCloud';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import { canonicalJson } from '@lib/canonicalJson';
import { nextId } from '@lib/id';
import { sha256Hex } from '@lib/sha256';
import { refuseScan } from './codes';
import { isRigid, multiply } from './mat4';
import { findCloud, scanOf, withScan } from './model';
import { cloudIdParam } from './schemas';

const recordParam = z
  .object({
    fixed: z.string().describe('Fixed cloud id.'),
    moving: z.string().describe('Moving cloud id (gets the transform).'),
    method: z.enum(['targets', 'icp_point_to_point', 'icp_point_to_plane', 'targets+icp']).describe('How the record was computed.'),
    transform: z.array(z.number()).length(16).describe('Moving asset frame -> fixed asset frame, row-major, metres.'),
    quality: z
      .object({
        targetResiduals: z
          .array(
            z
              .object({ name: z.string().describe('Target name.'), residual: z.number().describe('Residual, metres.') })
              .describe('One target residual.'),
          )
          .optional()
          .describe('Per-target residuals.'),
        rms: z.number().describe('RMS, metres.'),
        overlap: z.number().optional().describe('ICP overlap fraction.'),
        iterations: z.number().optional().describe('ICP iterations.'),
        converged: z.boolean().describe('Whether ICP converged.'),
      })
      .nullable()
      .describe('Quality from compute_registration.'),
    status: z.enum(['computed', 'unverified']).describe('Record status as computed (accepted only through accept_registration).'),
    provenance: z
      .object({
        method: z.string().describe('Method.'),
        algorithmVersion: z.string().describe('Binary and algorithm version.'),
        device: z.enum(['cpu', 'gpu']).optional().describe('Device.'),
        deterministic: z.boolean().optional().describe('Whether the numbers are reproducible.'),
      })
      .describe('Provenance from compute_registration.'),
  })
  .describe('data.record of compute_registration, unchanged.');

function withCloud(scan: ReturnType<typeof scanOf>, cloud: CloudReference): ReturnType<typeof scanOf> {
  return { ...scan, clouds: { ...scan.clouds, [cloud.id]: cloud } };
}

/**
 * @affects stores 1 RegistrationRecord (affected: [registrationId, movingId]) and sets moving.transform = fixed.transform · record.transform
 * @invariant moving != fixed; the transform is rigid (orthonormal within 1e-9, det +1)
 * @failure unknown cloud -> SCN_CLOUD_NOT_FOUND; non-rigid -> SCN_REG_NOT_RIGID; same cloud -> SCN_REG_SAME_CLOUD; not converged ->
 *   SCN_REG_NOT_CONVERGED
 */
export const applyRegistration = defineCommand({
  name: 'apply_registration',
  description:
    'Apply a registration record from compute_registration: the moving cloud is placed onto the fixed one (moving.transform = fixed.transform x ' +
    'record.transform) and the record is stored with its quality (status computed, or unverified when a quality gate was exceeded). A human ' +
    'reviewer accepts it later with accept_registration. Pass data.record unchanged; a record that did not converge is refused.',
  params: z.object({ record: recordParam }),
  run: (doc, { record }): CommandResult => {
    const command = 'apply_registration';
    const fixed = findCloud(doc, record.fixed);
    const moving = findCloud(doc, record.moving);
    if (fixed === undefined || moving === undefined) {
      const missing = [record.fixed, record.moving].filter((id) => findCloud(doc, id) === undefined);
      return refuseScan(doc, command, 'SCN_CLOUD_NOT_FOUND', `no attached cloud ${missing.join(', ')}`, missing, ['record']);
    }
    if (fixed.id === moving.id)
      return refuseScan(doc, command, 'SCN_REG_SAME_CLOUD', 'fixed and moving are the same cloud', [fixed.id], ['record.moving']);
    if (!isRigid(record.transform))
      return refuseScan(doc, command, 'SCN_REG_NOT_RIGID', 'the record transform is not a rigid motion', [moving.id], ['record.transform']);
    if (record.quality !== null && !record.quality.converged)
      return refuseScan(
        doc,
        command,
        'SCN_REG_NOT_CONVERGED',
        'the record did not converge; it is never applied',
        [moving.id],
        ['record.quality'],
      );
    const id = nextId('reg');
    const stored: RegistrationRecord = {
      id,
      fixed: fixed.id,
      moving: moving.id,
      method: record.method,
      transform: record.transform,
      quality: record.quality,
      status: record.status,
      provenance: record.provenance,
    };
    const scan = scanOf(doc);
    const placed: CloudReference = { ...moving, transform: multiply(fixed.transform, record.transform), registrationId: id };
    return changed(
      withScan(doc, { ...withCloud(scan, placed), registrations: { ...scan.registrations, [id]: stored } }),
      `Applied registration ${id}: ${moving.id} placed onto ${fixed.id} (${record.method}, RMS ${((record.quality?.rms ?? 0) * 1000).toFixed(3)} mm, ${record.status}).`,
      [id, moving.id],
    );
  },
});

/**
 * @affects stores 1 record of method "supplied", status "unverified" (affected: [registrationId, cloudId]); the cloud keeps its transform
 * @failure unknown cloud -> SCN_CLOUD_NOT_FOUND
 */
export const markRegistrationSupplied = defineCommand({
  name: 'mark_registration_supplied',
  description:
    'Record that a cloud arrived pre-registered (contractor data) without a llull registration: a record of method "supplied", status ' +
    '"unverified", so everything derived from the cloud carries unverified until a reviewer accepts it (accept_registration).',
  params: z.object({
    cloudId: cloudIdParam,
    reportRef: z.string().optional().describe('Reference of the contractor registration report.'),
  }),
  run: (doc, { cloudId, reportRef }): CommandResult => {
    const cloud = findCloud(doc, cloudId);
    if (cloud === undefined)
      return refuseScan(doc, 'mark_registration_supplied', 'SCN_CLOUD_NOT_FOUND', `no attached cloud '${cloudId}'`, [cloudId], ['cloudId']);
    const id = nextId('reg');
    const record: RegistrationRecord = {
      id,
      fixed: 'document',
      moving: cloudId,
      method: 'supplied',
      transform: cloud.transform,
      quality: null,
      status: 'unverified',
      provenance: { method: 'supplied', algorithmVersion: reportRef?.trim() || 'contractor report (not referenced)' },
    };
    const scan = scanOf(doc);
    return changed(
      withScan(doc, { ...withCloud(scan, { ...cloud, registrationId: id }), registrations: { ...scan.registrations, [id]: record } }),
      `Marked ${cloudId} as supplied pre-registered (${id}, unverified until accept_registration).`,
      [id, cloudId],
    );
  },
});

/** The payload a reviewer signs to accept a registration: its id, transform and quality. */
export const registrationPayload = (record: RegistrationRecord): string =>
  sha256Hex(canonicalJson({ act: 'accept_registration', registrationId: record.id, transform: record.transform, quality: record.quality }));

/**
 * @affects 1 record: status accepted with the verified signer (affected: [registrationId])
 * @invariant only a signature verified by the host's signing port over sha256(canonical { act, registrationId, transform, quality }) accepts
 * @failure no port / agent caller / bad signature -> SCN_HUMAN_GATE; unknown record -> SCN_REG_NOT_FOUND
 */
export const acceptRegistration = defineCommand({
  name: 'accept_registration',
  description:
    'HUMAN-ONLY. Accept a registration record for fabrication use (AF-34a): recorded only when the signature verifies against the signing port. ' +
    'An agent has no signature and always gets SCN_HUMAN_GATE with the document unchanged: hand the record to a reviewer.',
  params: z.object({
    registrationId: z.string().describe('Registration record id (affected[0] of apply_registration).'),
    signature: z.unknown().describe('Human signature object from the signing system over the record payload; agents cannot produce one.'),
  }),
  run: (doc, { registrationId, signature }, ctx): CommandResult => {
    const command = 'accept_registration';
    const scan = scanOf(doc);
    const record = Object.hasOwn(scan.registrations, registrationId) ? scan.registrations[registrationId] : undefined;
    if (record === undefined)
      return refuseScan(doc, command, 'SCN_REG_NOT_FOUND', `no registration '${registrationId}'`, [registrationId], ['registrationId']);
    const port = ctx?.humanSignature ?? null;
    if (port === null)
      return refuseScan(doc, command, 'SCN_HUMAN_GATE', 'no signing port: only a human reviewer can accept', [registrationId]);
    const signer = port.verify(signature, registrationPayload(record));
    if (signer === null)
      return refuseScan(
        doc,
        command,
        'SCN_HUMAN_GATE',
        'the signature did not verify for this registration',
        [registrationId],
        ['signature'],
      );
    const accepted: RegistrationRecord = {
      ...record,
      status: 'accepted',
      acceptedBy: { signer: signer.signer, signatureId: signer.signatureId },
    };
    return changed(
      withScan(doc, { ...scan, registrations: { ...scan.registrations, [registrationId]: accepted } }),
      `Registration ${registrationId} accepted by ${signer.signer} (signature ${signer.signatureId}).`,
      [registrationId],
    );
  },
});
