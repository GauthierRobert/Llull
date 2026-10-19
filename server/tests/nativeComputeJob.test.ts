/** llull-compute job runner: NDJSON parsing, timeouts, missing binary, protocol errors and output hash checks, with fake binaries. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createComputeRunner, f64Bytes, f64Values, readOutput, withJobFolder } from '../src/native/computeJob';

let dir = '';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** An executable shell script standing in for llull-compute. */
function fake(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-native-fake-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The fake tools are `#!/bin/sh` scripts made executable with chmod: Windows cannot spawn them (POSIX-only cases). */
const posixOnly = process.platform === 'win32';

describe('createComputeRunner', () => {
  it('reports NATIVE_TOOL_MISSING with the install hint when the binary is absent or cannot start', async () => {
    const absent = createComputeRunner({}, null);
    const run = await absent.run(['post', 'fatigue'], dir, 1000);
    expect(run).toMatchObject({ ok: false, code: 'NATIVE_TOOL_MISSING' });
    expect(run.message).toContain('cargo build --release');
    expect(await absent.version()).toBe('unknown');
    const broken = await createComputeRunner({}, path.join(dir, 'nope')).run([], dir, 1000);
    expect(broken).toMatchObject({ ok: false, code: 'NATIVE_TOOL_MISSING' });
  });

  it.skipIf(posixOnly)('parses progress, warning and done events and checks output hashes', async () => {
    const binary = fake(
      'ok',
      [
        'printf "abc" > out.bin',
        'echo \'{"type":"progress","step":1,"total":2,"message":"half"}\'',
        'echo \'{"type":"warning","code":"W1","message":"careful"}\'',
        `printf '{"type":"done","ok":true,"outputs":[{"path":"out.bin","sha256":"${sha('abc')}"}]}'`,
        'echo "llull-compute 9.9.9" >&2',
      ].join('\n'),
    );
    const runner = createComputeRunner({}, binary);
    await withJobFolder({ 'job.json': '{}' }, async (folder) => {
      const run = await runner.run(['post', 'fatigue'], folder, 5000);
      expect(run).toMatchObject({ ok: true, outputs: [{ path: 'out.bin' }], warnings: [{ code: 'W1', message: 'careful' }] });
      expect(run.log).toContain('9.9.9');
      expect((await readOutput(folder, run, 'out.bin')).toString()).toBe('abc');
      writeFileSync(path.join(folder, 'out.bin'), 'tampered');
      await expect(readOutput(folder, run, 'out.bin')).rejects.toThrow(/hashes to/);
      await expect(readOutput(folder, run, 'missing.bin')).rejects.toThrow(/did not report/);
    });
  });

  it.skipIf(posixOnly)('maps error events, missing final events, garbage and timeouts to codes', async () => {
    const error = createComputeRunner({}, fake('error', 'echo \'{"type":"error","code":"NATIVE_JOB_INPUT","message":"bad job"}\'; exit 2'));
    expect(await error.run([], dir, 5000)).toMatchObject({ ok: false, code: 'NATIVE_JOB_INPUT', message: 'bad job' });
    const silent = createComputeRunner({}, fake('silent', 'exit 3'));
    expect(await silent.run([], dir, 5000)).toMatchObject({
      ok: false,
      code: 'NATIVE_PROTOCOL',
      message: expect.stringContaining('code 3'),
    });
    const garbage = createComputeRunner({}, fake('garbage', 'echo "hello"; exit 0'));
    expect(await garbage.run([], dir, 5000)).toMatchObject({
      ok: false,
      code: 'NATIVE_PROTOCOL',
      message: expect.stringContaining('NDJSON'),
    });
    const badDone = createComputeRunner({}, fake('baddone', 'echo \'{"type":"done","ok":true,"outputs":[{"path":1}]}\''));
    expect(await badDone.run([], dir, 5000)).toMatchObject({ ok: false, code: 'NATIVE_PROTOCOL' });
    const slow = createComputeRunner({}, fake('slow', 'sleep 5'));
    expect(await slow.run([], dir, 200)).toMatchObject({ ok: false, code: 'NATIVE_TIMEOUT' });
  });

  it.skipIf(posixOnly)('reads the version once and converts f64 buffers', async () => {
    const runner = createComputeRunner({}, fake('version', 'echo "llull-compute 1.2.3"'));
    expect(await runner.version()).toBe('1.2.3');
    expect(await runner.version()).toBe('1.2.3');
    const values = Float64Array.from([1.5, -2, Number.MAX_VALUE]);
    expect(Array.from(f64Values(f64Bytes(values)))).toEqual([1.5, -2, Number.MAX_VALUE]);
    expect(() => f64Values(Buffer.alloc(3))).toThrow(/whole number/);
    let kept = '';
    await withJobFolder({ a: 'x' }, async (folder) => void (kept = folder), { LLULL_NATIVE_KEEP: '1' });
    expect(kept).not.toBe('');
    rmSync(kept, { recursive: true, force: true });
  });
});
