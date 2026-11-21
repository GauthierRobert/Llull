/** The host version port (VAC-M3): the server / CLI context carries the server package version, and an export stamps it into its provenance (the command reads no file). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { serverContext } from '../src/fea/context';
import { hostVersion } from '../src/hostVersion';
import { boxKernel, exposedDocument } from '../../tests/unit/vibroacoustics/boxKernel';

const manifestVersion = (JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;

describe('host version', () => {
  it('is the server package version, read once, and is in every server / CLI context', () => {
    expect(manifestVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(hostVersion()).toBe(manifestVersion);
    expect(hostVersion()).toBe(hostVersion());
    expect(serverContext().hostVersion).toBe(manifestVersion);
  });

  it('export_acoustic_load run in the server context stamps it as provenance.llullVersion', () => {
    const { doc } = exposedDocument();
    const result = execute(doc, 'export_acoustic_load', { exposure: 'enclosure_skin' }, { ...serverContext(), kernel: boxKernel() });
    expect(result.rejected, result.summary).not.toBe(true);
    expect((result.data as { provenance: { llullVersion: string | null } }).provenance.llullVersion).toBe(manifestVersion);
  });
});
