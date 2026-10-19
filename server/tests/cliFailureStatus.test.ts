/** Through the `llull` CLI: a command refusing with a plain no-op fails (exit 1); a successful mutation reports its ids. */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';

function capture(): { io: CliIo; out: string[] } {
  const out: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    readStdin: () => Promise.resolve(''),
    env: {},
    prepareKernel: () => Promise.resolve(),
  };
  return { io, out };
}

let docPath = '';

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});

beforeEach(() => {
  docPath = path.join(mkdtempSync(path.join(tmpdir(), 'llull-cli-status-')), 'part.llull.json');
});

describe('CLI failure status', () => {
  it.each([
    ['pipe_hydraulics', { pipeId: 'nope' }],
    ['mass_properties', { entityId: 'nope' }],
    ['add_box', { size: [0, 1, 1] }],
    ['add_rigid_body', { entityIds: ['nope'] }],
    ['add_body_joint', { child: 'nope' }],
    ['move_entities', { ids: ['nope'] }],
  ])('%s refusing exits with the command-error status', async (name, args) => {
    const { io, out } = capture();
    expect(await runCli(['exec', name, JSON.stringify(args), '--doc', docPath, '--json'], io)).toBe(EXIT_COMMAND_ERROR);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: false });
  });

  it('a successful mutation exits 0 and returns its ids', async () => {
    const { io, out } = capture();
    expect(await runCli(['exec', 'add_box', '{"size":[1,1,1]}', '--doc', docPath, '--json'], io)).toBe(EXIT_OK);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, affected: [expect.stringMatching(/^box-/)] });
  });
});
