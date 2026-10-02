/**
 * @layer server/tests
 *
 * Hardening of the Python exchange: secret-free child environment, symlink-proof exchange
 * directory, and the structured exportStepFile used by both the MCP tool and GET /export/step.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { exportStepFile, type CadExchangePort } from '@mcp/index';
import {
  bridgeEnvironment,
  createPythonExchangePort,
  type PythonExchangeConfig,
} from '../src/pythonExchange';

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'llull-hardening-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('bridgeEnvironment', () => {
  it('passes interpreter essentials and drops server secrets', () => {
    const env = bridgeEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      PYTHONPATH: '/opt/py',
      VIRTUAL_ENV: '/venv',
      MCP_AUTH_TOKEN: 'secret',
      ANTHROPIC_API_KEY: 'sk-secret',
      AWS_SECRET_ACCESS_KEY: 'x',
    });
    expect(Object.keys(env).sort()).toEqual(
      ['HOME', 'LANG', 'LC_ALL', 'PATH', 'PYTHONPATH', 'VIRTUAL_ENV'].sort(),
    );
  });
});

describe('exchange directory symlink confinement', () => {
  let root: string;
  let outside: string;
  let port: CadExchangePort;

  beforeAll(async () => {
    root = path.join(scratch, 'exchange');
    outside = path.join(scratch, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'top secret');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.step'));
    await symlink(outside, path.join(root, 'linked-dir'));
    const config: PythonExchangeConfig = {
      python: 'python3',
      build123dPython: 'python3',
      timeoutMs: 1000,
      bridgeScript: '/nonexistent.py',
      exchangeDir: root,
    };
    port = createPythonExchangePort(config);
  });

  it('refuses to read through a symlink that points outside', async () => {
    await expect(port.readExchangeFile?.('leak.step', 'utf8')).rejects.toThrow(
      /outside the exchange/,
    );
  });

  it('refuses to write into a symlinked directory outside', async () => {
    await expect(port.writeExchangeFile?.('linked-dir/x.step', 'AAAA')).rejects.toThrow(
      /outside the exchange/,
    );
  });

  it('refuses to overwrite a symlink', async () => {
    await expect(port.writeExchangeFile?.('leak.step', 'AAAA')).rejects.toThrow(/symbolic link/);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('still reads and writes regular files inside', async () => {
    const written = await port.writeExchangeFile?.(
      'ok.step',
      Buffer.from('hello').toString('base64'),
    );
    expect(written).toBe(path.join(root, 'ok.step'));
    expect(await port.readExchangeFile?.('ok.step', 'utf8')).toBe('hello');
  });
});

describe('exportStepFile', () => {
  const fakePort: CadExchangePort = {
    runProgram: async () => ({ trace: null, traced: true, log: '', stepBase64: 'SVNP' }),
    importStep: async () => ({ bodies: [] }),
  };
  const withBox = execute(createEmptyDocument(), 'add_box', { size: [1, 2, 3] }).document;

  it('returns the STEP payload with the sanitised export_code base name', async () => {
    const file = await exportStepFile(() => withBox, fakePort, { name: '../part one' });
    expect('error' in file).toBe(false);
    if ('error' in file) return;
    expect(file.fileName).toBe('part_one.step');
    expect(file.stepBase64).toBe('SVNP');
    expect(file.summary).toMatch(/1 solid\(s\)/);
  });

  it('reports an unknown language and an empty model as errors', async () => {
    expect(await exportStepFile(() => withBox, fakePort, { language: 'openscad' })).toEqual({
      error: expect.stringMatching(/language must be/),
    });
    expect(await exportStepFile(() => createEmptyDocument(), fakePort, {})).toEqual({
      error: expect.stringMatching(/no 3D solids/),
    });
  });
});
