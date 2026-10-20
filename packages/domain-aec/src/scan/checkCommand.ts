/** check_point_clouds (FR-SCN-20, AF-20): the read-only health list an agent ends every scan job with. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { refuseScan, SCAN_REMEDIATION } from './codes';
import { sameTransform } from './mat4';
import { cloudsOf, findCloud, scanOf } from './model';
import { portOf } from './region';

type Severity = 'fail' | 'warn' | 'info';

interface Item {
  readonly severity: Severity;
  readonly code: string;
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

const item = (severity: Severity, code: string, ids: readonly string[], message: string): Item => ({
  severity,
  code,
  ids,
  message,
  remediation: SCAN_REMEDIATION[code] ?? '',
});

/** Pipe runs flagged as-built from the extractions of `cloudId`. */
function derivedOf(doc: CadDocument, cloudId: string): string[] {
  return Object.values(scanOf(doc).extractions)
    .filter((e) => e.cloudId === cloudId)
    .flatMap((e) => [e.id, ...e.createdElementIds]);
}

/**
 * @failure an unknown id in cloudIds -> SCN_CLOUD_NOT_FOUND
 */
export const checkPointClouds = defineCommand({
  name: 'check_point_clouds',
  description:
    'Read-only check of the scan workspace (end every scan job with it): missing assets (SCN_ASSET_MISSING), unregistered stations, ' +
    'unverified or unaccepted registrations (SCN_REGISTRATION_UNVERIFIED, listing the as-built runs derived from the cloud), extractions made ' +
    'before the cloud moved (SCN_EXTRACTION_STALE), unverified extractions and those awaiting a reviewer (SCN_REVIEW_REQUIRED). data: ' +
    '{ status pass | warn | fail, items [{ severity, code, ids, message, remediation }] }.',
  annotations: { readOnly: true },
  params: z.object({ cloudIds: z.array(z.string()).optional().describe('Clouds to check (default all attached clouds).') }),
  run: (doc, { cloudIds }, ctx): CommandResult => {
    const unknown = (cloudIds ?? []).filter((id) => findCloud(doc, id) === undefined);
    if (unknown.length > 0)
      return refuseScan(doc, 'check_point_clouds', 'SCN_CLOUD_NOT_FOUND', `no attached cloud ${unknown.join(', ')}`, unknown, ['cloudIds']);
    const scan = scanOf(doc);
    const clouds = cloudsOf(doc).filter((c) => cloudIds === undefined || cloudIds.includes(c.id));
    const port = portOf(ctx);
    const items: Item[] = [];
    if (port === null && clouds.length > 0)
      items.push(item('info', 'SCN_ASSET_UNAVAILABLE', [], 'no point-cloud port in this host: the assets were not checked'));
    const fixedIds = new Set(Object.values(scan.registrations).map((r) => r.fixed));
    for (const cloud of clouds) {
      if (port !== null && port.manifest(cloud.assetKey) === null)
        items.push(
          item(
            'warn',
            'SCN_ASSET_MISSING',
            [cloud.id],
            `asset ${cloud.assetKey.slice(0, 12)}… of ${cloud.id} is not in this machine's store`,
          ),
        );
      const registration = cloud.registrationId !== null ? scan.registrations[cloud.registrationId] : undefined;
      if (registration === undefined) {
        if (cloudsOf(doc).length > 1 && !fixedIds.has(cloud.id))
          items.push(item('warn', 'SCN_CLOUD_UNREGISTERED', [cloud.id], `${cloud.id} is not registered to the other clouds`));
      } else if (registration.status !== 'accepted') {
        items.push(
          item(
            'warn',
            'SCN_REGISTRATION_UNVERIFIED',
            [cloud.id, registration.id, ...derivedOf(doc, cloud.id)],
            `registration ${registration.id} of ${cloud.id} is ${registration.status} (${registration.method}); everything derived from it is unverified`,
          ),
        );
      }
    }
    for (const extraction of Object.values(scan.extractions)) {
      const cloud = findCloud(doc, extraction.cloudId);
      if (cloudIds !== undefined && !cloudIds.includes(extraction.cloudId)) continue;
      const ids = [extraction.id, ...extraction.createdElementIds];
      if (cloud !== undefined && !sameTransform(cloud.transform, extraction.cloudTransform))
        items.push(item('warn', 'SCN_EXTRACTION_STALE', ids, `${extraction.id} was fitted before ${cloud.id} moved`));
      if (extraction.unverified)
        items.push(
          item('warn', 'SCN_EXTRACTION_UNVERIFIED', ids, `${extraction.id} is unverified: ${extraction.unverifiedReasons.join('; ')}`),
        );
      if (extraction.status !== 'accepted')
        items.push(item('info', 'SCN_REVIEW_REQUIRED', ids, `${extraction.id} awaits a reviewer before fabrication use`));
    }
    const status = items.some((i) => i.severity === 'fail') ? 'fail' : items.some((i) => i.severity === 'warn') ? 'warn' : 'pass';
    const warns = items.filter((i) => i.severity === 'warn').length;
    return report(doc, `check_point_clouds: ${status} (${clouds.length} cloud(s), ${warns} warning(s), ${items.length - warns} note(s)).`, {
      status,
      items,
    });
  },
});
