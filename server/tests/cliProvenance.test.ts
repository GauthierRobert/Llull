/** Through the `llull` CLI: a result the mesh kernel answered while the exact kernel was requested prints one stderr warning and carries `provenance` (FR-INT-07). */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(''),
    env: {},
    prepareKernel: () => Promise.resolve(),
  };
  return { io, out, err };
}

async function kernelWith(info: { active: 'manifold' | 'occt-native'; fallbackReason?: string }): Promise<GeometryKernel> {
  const kernel = await createManifoldKernel();
  return { ...kernel, info: () => ({ capabilities: [], exactRequested: true, ...info }) };
}

const docPath = (): string => path.join(mkdtempSync(path.join(tmpdir(), 'llull-cli-prov-')), 'part.llull.json');

beforeAll(() => setGeometryKernel(null));

describe('CLI result provenance', () => {
  it('prints one stderr warning per degraded result and puts provenance in --json', async () => {
    setGeometryKernel(await kernelWith({ active: 'manifold', fallbackReason: 'llull-kernel binary not found' }));
    const doc = docPath();
    await runCli(['exec', 'add_box', JSON.stringify({ size: [1, 1, 1] }), '--doc', doc], capture().io);
    const { io, out, err } = capture();
    expect(await runCli(['exec', 'mass_properties', JSON.stringify({ entityId: 'box-1.1' }), '--doc', doc, '--json'], io)).toBe(EXIT_OK);
    expect(err).toEqual(['warning: answered by the mesh kernel (llull-kernel binary not found); exact kernel unavailable']);
    expect(JSON.parse(out.join('')).provenance).toEqual({
      kernel: 'manifold',
      exactRequested: true,
      fallbackReason: 'llull-kernel binary not found',
    });
  });

  it('prints no warning for a command that does not use the kernel or when the exact kernel answered', async () => {
    setGeometryKernel(await kernelWith({ active: 'manifold', fallbackReason: 'binary not found' }));
    const plain = capture();
    await runCli(['exec', 'add_box', JSON.stringify({ size: [1, 1, 1] }), '--doc', docPath()], plain.io);
    expect(plain.err).toEqual([]);
    setGeometryKernel(await kernelWith({ active: 'occt-native' }));
    const doc = docPath();
    await runCli(['exec', 'add_box', JSON.stringify({ size: [1, 1, 1] }), '--doc', doc], capture().io);
    const exact = capture();
    await runCli(['exec', 'mass_properties', JSON.stringify({ entityId: 'box-1.1' }), '--doc', doc], exact.io);
    expect(exact.err).toEqual([]);
  });
});
