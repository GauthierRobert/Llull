/**
 * commit_asbuilt_extraction / accept_asbuilt_extraction (TECHNICAL_SPEC §4.1, FR-SCN-13, 22): the numbers of a fit become an as-built pipe
 * run through add_pipe_run (L10: composed with execute); the commit holds every value, so replay never reads the cloud (TR-SCN-04).
 */

import type { ExtractionRecord } from '@aec/scan/types';
import type { Mat4 } from '@core/model/pointCloud';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import { fromMm } from '@core/model/units';
import { canonicalJson } from '@lib/canonicalJson';
import { nextId } from '@lib/id';
import { sha256Hex } from '@lib/sha256';
import { getBuilding, resolveLevel } from '../building/model';
import { levelIdParam } from '../building/levelParams';
import { refuseScan } from './codes';
import { extractionHash, unverifiedReasons, type PendingExtraction } from './extraction';
import { sameTransform } from './mat4';
import { findCloud, fromM, scanOf, withScan } from './model';
import { regionSpec } from './region';
import { regionParam } from './schemas';

const extractionParam = z
  .object({
    kind: z.literal('pipe').describe('Extraction kind.'),
    cloudId: z.string().describe('Cloud the fit was made on.'),
    assetKey: z.string().describe('Asset key of that cloud.'),
    region: regionParam,
    fit: z.record(z.string(), z.unknown()).describe('Native cylinder fit, metres, document frame.'),
    snapped: z
      .object({
        table: z.literal('en10220').describe('Size table.'),
        dn: z.number().nullable().describe('Snapped DN, or null (no standard size).'),
        odMm: z.number().describe('Table OD (or the measured OD when dn is null), mm.'),
        toleranceMm: z.number().describe('Snap tolerance, mm.'),
        defaulted: z.boolean().describe('Whether the tolerance is the named default.'),
      })
      .optional()
      .describe('DN snap of extract_pipes.'),
    cloudTransform: z.array(z.number()).length(16).describe('Cloud transform at fit time.'),
    unverified: z.boolean().describe('Unverified at fit time.'),
    unverifiedReasons: z.array(z.string()).describe('Why.'),
    provenance: z
      .object({
        method: z.string().describe('Method.'),
        algorithmVersion: z.string().describe('Binary and algorithm.'),
        seed: z.number().optional().describe('RANSAC seed.'),
        device: z.enum(['cpu', 'gpu']).optional().describe('Device.'),
        deterministic: z.boolean().optional().describe('Reproducible numbers.'),
      })
      .describe('Provenance.'),
    extractionHash: z.string().describe('sha256 of the canonical content.'),
  })
  .describe('data.extractions[i].extraction of extract_pipes (or data.extraction of fit_primitive kind cylinder), unchanged.');

const vec = (value: unknown): number[] | null =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number') ? (value as number[]) : null;

/**
 * @affects 1 extraction record + the pipe run add_pipe_run creates (affected: [extractionId, pipeId]), the run flagged asBuilt
 * @invariant the extraction hash matches its content, else refused; unverified = the record's reasons + the cloud's registration status now
 * @failure hash mismatch -> SCN_EXTRACTION_TAMPERED; unknown cloud -> SCN_CLOUD_NOT_FOUND; already committed -> SCN_EXTRACTION_DUPLICATE;
 *   a fit without start / end / radius -> SCN_PARAM_INVALID; add_pipe_run refusals are passed on
 */
export const commitAsbuiltExtraction = defineCommand({
  name: 'commit_asbuilt_extraction',
  description:
    'Turn a pipe extraction (from extract_pipes, or fit_primitive kind cylinder) into an as-built pipe run: add_pipe_run from the fitted ends ' +
    '(z relative to the level), DN from the snap (else the measured OD), flagged asBuilt with the extraction id and unverified when the ' +
    'cloud registration is unverified or the fit quality is low. The extraction record is stored with its provenance. Pass the extraction ' +
    'unchanged: its hash is checked (SCN_EXTRACTION_TAMPERED). Fabrication use needs a reviewer: accept_asbuilt_extraction.',
  params: z.object({
    extraction: extractionParam,
    line: z.string().optional().describe('Line number of the as-built run, e.g. "L-101".'),
    service: z.string().optional().describe('Fluid / service. Default "process".'),
    levelId: levelIdParam,
  }),
  run: (doc, { extraction, line, service, levelId }, ctx): CommandResult => {
    const command = 'commit_asbuilt_extraction';
    const pending: PendingExtraction = { ...extraction, region: regionSpec(extraction.region) } as PendingExtraction;
    if (extractionHash(pending) !== extraction.extractionHash)
      return refuseScan(
        doc,
        command,
        'SCN_EXTRACTION_TAMPERED',
        'the extraction does not match its hash',
        [extraction.cloudId],
        ['extraction.extractionHash'],
      );
    const cloud = findCloud(doc, extraction.cloudId);
    if (cloud === undefined)
      return refuseScan(
        doc,
        command,
        'SCN_CLOUD_NOT_FOUND',
        `no attached cloud '${extraction.cloudId}'`,
        [extraction.cloudId],
        ['extraction.cloudId'],
      );
    if (!sameTransform(cloud.transform, extraction.cloudTransform as Mat4))
      return refuseScan(
        doc,
        command,
        'SCN_EXTRACTION_STALE',
        `cloud ${cloud.id} moved since the fit: the extraction is in its old frame`,
        [cloud.id],
        ['extraction.cloudTransform'],
      );
    const scan = scanOf(doc);
    const twin = Object.values(scan.extractions).find((e) => e.extractionHash === extraction.extractionHash);
    if (twin !== undefined)
      return refuseScan(doc, command, 'SCN_EXTRACTION_DUPLICATE', `already committed as ${twin.id}`, [twin.id], ['extraction']);
    const [start, end, radius] = [vec(extraction.fit['start']), vec(extraction.fit['end']), extraction.fit['radius']];
    if (start === null || end === null || typeof radius !== 'number')
      return refuseScan(
        doc,
        command,
        'SCN_PARAM_INVALID',
        'the fit has no start / end / radius (commit a cylinder extraction)',
        [cloud.id],
        ['extraction.fit'],
      );
    const reasons = [...new Set([...extraction.unverifiedReasons, ...unverifiedReasons(scan, cloud, [])])];
    const level = resolveLevel(doc, getBuilding(doc), levelId);
    const elevation = level.ok ? level.level.elevation : 0;
    const insulation = typeof extraction.fit['insulationThicknessM'] === 'number' ? extraction.fit['insulationThicknessM'] : 0;
    const diameter = extraction.snapped !== undefined ? fromMm(doc, extraction.snapped.odMm) : fromM(doc, 2 * (radius - insulation));
    const id = nextId('ext');
    const at = (p: number[]): number[] => [fromM(doc, p[0] ?? 0), fromM(doc, p[1] ?? 0), fromM(doc, p[2] ?? 0) - elevation];
    const added = execute(
      doc,
      'add_pipe_run',
      {
        points: [at(start), at(end)],
        diameter,
        ...(extraction.snapped?.dn != null ? { dn: extraction.snapped.dn } : {}),
        ...(line !== undefined ? { line } : {}),
        service: service ?? 'process',
        ...(levelId !== undefined ? { levelId } : {}),
        asBuilt: { extractionId: id, unverified: reasons.length > 0 },
      },
      ctx,
    );
    if (added.affected.length === 0) return { ...added, document: doc, summary: `${command}: ${added.summary}` };
    const elements = added.document.building?.elements ?? {};
    const record: ExtractionRecord = {
      ...pending,
      unverified: reasons.length > 0,
      unverifiedReasons: reasons,
      id,
      createdElementIds: added.affected.filter((created) => Object.hasOwn(elements, created)),
      status: 'computed',
    };
    const after = scanOf(added.document);
    return changed(
      withScan(added.document, { ...after, extractions: { ...after.extractions, [id]: record } }),
      `Committed extraction ${id}: as-built pipe ${added.affected.join(', ')}${reasons.length > 0 ? ` (unverified: ${reasons.join('; ')})` : ''}. Review before fabrication (accept_asbuilt_extraction).`,
      [id, ...added.affected],
    );
  },
});

/** The payload a reviewer signs to accept an extraction. */
export const extractionPayload = (record: ExtractionRecord): string =>
  sha256Hex(canonicalJson({ act: 'accept_asbuilt_extraction', extractionId: record.id, extractionHash: record.extractionHash }));

/**
 * @affects 1 extraction record: status accepted with the verified signer (affected: [extractionId])
 * @failure no port / agent caller / bad signature -> SCN_HUMAN_GATE; unknown id -> SCN_EXTRACTION_NOT_FOUND
 */
export const acceptAsbuiltExtraction = defineCommand({
  name: 'accept_asbuilt_extraction',
  description:
    'Accept a committed as-built extraction for fabrication use (field-verified tie-in): recorded only when the signature verifies ' +
    'against the signing port. HUMAN-ONLY. An agent always gets SCN_HUMAN_GATE with the document unchanged: hand it to the reviewer.',
  params: z.object({
    extractionId: z.string().describe('Extraction id (affected[0] of commit_asbuilt_extraction).'),
    signature: z.unknown().describe('Human signature object over the extraction payload; agents cannot produce one.'),
  }),
  run: (doc, { extractionId, signature }, ctx): CommandResult => {
    const command = 'accept_asbuilt_extraction';
    const scan = scanOf(doc);
    const record = Object.hasOwn(scan.extractions, extractionId) ? scan.extractions[extractionId] : undefined;
    if (record === undefined)
      return refuseScan(doc, command, 'SCN_EXTRACTION_NOT_FOUND', `no extraction '${extractionId}'`, [extractionId], ['extractionId']);
    const port = ctx?.humanSignature ?? null;
    if (port === null)
      return refuseScan(doc, command, 'SCN_HUMAN_GATE', 'no signing port: only a human reviewer can accept', [extractionId]);
    const signer = port.verify(signature, extractionPayload(record));
    if (signer === null)
      return refuseScan(doc, command, 'SCN_HUMAN_GATE', 'the signature did not verify for this extraction', [extractionId], ['signature']);
    const accepted: ExtractionRecord = {
      ...record,
      status: 'accepted',
      acceptedBy: { signer: signer.signer, signatureId: signer.signatureId },
    };
    return changed(
      withScan(doc, { ...scan, extractions: { ...scan.extractions, [extractionId]: accepted } }),
      `Extraction ${extractionId} accepted by ${signer.signer}.`,
      [extractionId],
    );
  },
});
