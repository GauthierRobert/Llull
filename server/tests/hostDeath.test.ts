/**
 * A native job does not outlive its host (TECHNICAL_SPEC 07 MSH 13.8): `llull-compute` runs detached on Windows (no shared console Ctrl-C), which also
 * takes it out of the host's kill-on-close job, so it watches the stdin pipe the host holds and exits when the host dies, however it dies.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAlive, jobPidOf, waitFor } from '../../tests/helpers/processList';
import { longMeshJobFolder } from '../../tests/helpers/longMeshJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('hostDeath: llull-compute not built (cargo build --release in solver/): skipped');
const native = BINARY === null ? it.skip : it;
const serverDir = path.resolve(__dirname, '..');

describe('the host dies', () => {
  native(
    'a hard kill of the host (no handler runs) ends its running llull-compute job within a moment',
    async () => {
      const host = spawn(
        process.execPath,
        ['--import', 'tsx', path.join(__dirname, 'fixtures', 'holdJob.ts'), BINARY as string, longMeshJobFolder(700)],
        { cwd: serverDir, stdio: 'ignore' },
      );
      // the job this host started, found by its parent: another lane's llull-compute is never taken
      const job = await waitFor(() => (host.pid === undefined ? undefined : jobPidOf('llull-compute', host.pid)), 60_000);
      expect(job).toBeDefined();
      try {
        host.kill('SIGKILL');
        const gone = await waitFor(() => (isAlive(job as number) ? undefined : true), 3_000);
        expect(gone).toBe(true);
      } finally {
        if (job !== undefined && isAlive(job)) process.kill(job);
      }
    },
    90_000,
  );
});
