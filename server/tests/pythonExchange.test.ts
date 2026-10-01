/**
 * @layer server/tests
 *
 * Unit tests for pythonExchange.ts — config parsing, path confinement, bridge failure modes
 * (driven by a fake "python": node running a tiny script) and the exchange-directory I/O.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmod, mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  callBridge,
  codeExecutionAllowed,
  createPythonExchangePort,
  pythonExchangeConfigFromEnv,
  resolveInside,
  type PythonExchangeConfig,
} from '../src/pythonExchange';

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'llull-pyx-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function script(name: string, body: string): Promise<string> {
  const file = path.join(scratch, name);
  await writeFile(file, body, 'utf8');
  return file;
}

describe('pythonExchangeConfigFromEnv', () => {
  it('defaults to python3, 120 s, no exchange dir', () => {
    const config = pythonExchangeConfigFromEnv({});
    expect(config).not.toBeNull();
    expect(config?.python).toBe('python3');
    expect(config?.build123dPython).toBe('python3');
    expect(config?.timeoutMs).toBe(120_000);
    expect(config?.exchangeDir).toBeNull();
    expect(config?.bridgeScript.endsWith(path.join('python', 'llull_bridge.py'))).toBe(true);
  });

  it('returns null when LLULL_PYTHON=off', () => {
    expect(pythonExchangeConfigFromEnv({ LLULL_PYTHON: 'off' })).toBeNull();
  });

  it('build123d python falls back to LLULL_PYTHON, and can be overridden', () => {
    expect(pythonExchangeConfigFromEnv({ LLULL_PYTHON: '/opt/py' })?.build123dPython).toBe(
      '/opt/py',
    );
    const config = pythonExchangeConfigFromEnv({
      LLULL_PYTHON: '/opt/py',
      LLULL_PYTHON_BUILD123D: '/opt/b123/bin/python',
    });
    expect(config?.python).toBe('/opt/py');
    expect(config?.build123dPython).toBe('/opt/b123/bin/python');
  });

  it('parses LLULL_PYTHON_TIMEOUT_MS and ignores junk / non-positive values', () => {
    expect(pythonExchangeConfigFromEnv({ LLULL_PYTHON_TIMEOUT_MS: '2500' })?.timeoutMs).toBe(2500);
    for (const junk of ['abc', '0', '-5', '']) {
      expect(pythonExchangeConfigFromEnv({ LLULL_PYTHON_TIMEOUT_MS: junk })?.timeoutMs).toBe(
        120_000,
      );
    }
  });

  it('resolves LLULL_EXCHANGE_DIR to an absolute path; empty means none', () => {
    expect(pythonExchangeConfigFromEnv({ LLULL_EXCHANGE_DIR: 'rel/dir' })?.exchangeDir).toBe(
      path.resolve('rel/dir'),
    );
    expect(pythonExchangeConfigFromEnv({ LLULL_EXCHANGE_DIR: '' })?.exchangeDir).toBeNull();
  });
});

describe('codeExecutionAllowed', () => {
  it('is true only for exactly "1"', () => {
    expect(codeExecutionAllowed({ LLULL_ALLOW_CODE_EXECUTION: '1' })).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
      const env = value === undefined ? {} : { LLULL_ALLOW_CODE_EXECUTION: value };
      expect(codeExecutionAllowed(env)).toBe(false);
    }
  });
});

describe('resolveInside', () => {
  const root = path.resolve('/srv/exchange');

  it('resolves plain and nested relative paths inside the root', () => {
    expect(resolveInside(root, 'a.step')).toBe(path.join(root, 'a.step'));
    expect(resolveInside(root, 'sub/dir/a.step')).toBe(path.join(root, 'sub/dir/a.step'));
    expect(resolveInside(root, 'sub/../a.step')).toBe(path.join(root, 'a.step'));
  });

  it('rejects traversal out of the root', () => {
    expect(() => resolveInside(root, '../secret')).toThrow(/inside the exchange directory/);
    expect(() => resolveInside(root, 'sub/../../secret')).toThrow(/inside/);
    expect(() => resolveInside(root, '..')).toThrow(/inside/);
  });

  it('rejects absolute paths, even ones pointing into the root', () => {
    expect(() => resolveInside(root, '/etc/passwd')).toThrow(/inside/);
    expect(() => resolveInside(root, path.join(root, 'a.step'))).toThrow(/inside/);
  });

  it('does not treat a sibling directory sharing the root prefix as inside', () => {
    expect(() => resolveInside(root, '../exchange-evil/a.step')).toThrow(/inside/);
  });
});

describe('callBridge with a fake python', () => {
  it('returns the parsed JSON response and forwards the request on stdin', async () => {
    const echo = await script(
      'echo.js',
      `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({ok:true,echo:JSON.parse(s)}))});`,
    );
    const response = await callBridge(process.execPath, echo, { op: 'probe', n: 3 }, 10_000);
    expect(response).toEqual({ ok: true, echo: { op: 'probe', n: 3 } });
  });

  it('rejects when stdout is not JSON, including the stderr tail', async () => {
    const garbage = await script(
      'garbage.js',
      `console.error('boom detail');process.stdout.write('not json at all');`,
    );
    await expect(callBridge(process.execPath, garbage, { op: 'probe' }, 10_000)).rejects.toThrow(
      /exited with code 0 without a response\. boom detail/,
    );
  });

  it('rejects with the exit code when the process fails', async () => {
    const failing = await script('fail.js', `console.error('traceback here');process.exit(3);`);
    await expect(callBridge(process.execPath, failing, { op: 'probe' }, 10_000)).rejects.toThrow(
      /code 3 without a response\. traceback here/,
    );
  });

  it('kills the process and rejects past the timeout', async () => {
    const sleeper = await script('sleep.js', `process.stdin.resume();setTimeout(()=>{},60000);`);
    const started = Date.now();
    await expect(callBridge(process.execPath, sleeper, { op: 'probe' }, 300)).rejects.toThrow(
      /timed out after 300 ms/,
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects with a helpful message when the executable is missing', async () => {
    await expect(
      callBridge('/nonexistent/python-xyz', 'bridge.py', { op: 'probe' }, 5000),
    ).rejects.toThrow(/cannot start Python "\/nonexistent\/python-xyz".*LLULL_PYTHON/);
  });

  it('tolerates a process that exits without reading stdin', async () => {
    const early = await script('early.js', `process.stdout.write('{"ok":true}');process.exit(0);`);
    const big = { op: 'run', source: 'x'.repeat(5_000_000) };
    const response = await callBridge(process.execPath, early, big, 10_000);
    expect(response.ok).toBe(true);
  });
});

describe('createPythonExchangePort', () => {
  async function portWith(
    bridgeBody: string,
    exchangeDir: string | null,
  ): Promise<ReturnType<typeof createPythonExchangePort>> {
    const config: PythonExchangeConfig = {
      python: process.execPath,
      build123dPython: process.execPath,
      timeoutMs: 10_000,
      bridgeScript: await script('port-bridge.js', bridgeBody),
      exchangeDir,
    };
    return createPythonExchangePort(config);
  }

  const fakeBridge = `
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const r=JSON.parse(s);
  if(r.op==='run'&&r.source==='raise') return process.stdout.write(JSON.stringify({ok:false,error:"ModuleNotFoundError: No module named 'cadquery'"}));
  if(r.op==='run') return process.stdout.write(JSON.stringify({ok:true,trace:{lang:r.language},traced:true,log:'hi',stepBase64:r.step?'QUJD':undefined}));
  if(r.op==='import_step') return process.stdout.write(JSON.stringify(r.stepBase64==='bad'?{ok:true}:{ok:true,bodies:[{name:'b',positions:[]}]}));
});`;

  it('runProgram maps the bridge response (trace, traced, log, optional step)', async () => {
    const port = await portWith(fakeBridge, null);
    const withStep = await port.runProgram({ language: 'cadquery', source: 'x', step: true });
    expect(withStep).toEqual({
      trace: { lang: 'cadquery' },
      traced: true,
      log: 'hi',
      stepBase64: 'QUJD',
    });
    const without = await port.runProgram({ language: 'build123d', source: 'x', step: false });
    expect(without.stepBase64).toBeUndefined();
    expect(without.trace).toEqual({ lang: 'build123d' });
  });

  it('turns a bridge ok:false into an Error with an install hint for missing modules', async () => {
    const port = await portWith(fakeBridge, null);
    await expect(
      port.runProgram({ language: 'cadquery', source: 'raise', step: false }),
    ).rejects.toThrow(/No module named 'cadquery'.*pip install cadquery/);
  });

  it('importStep returns bodies and rejects a response without bodies', async () => {
    const port = await portWith(fakeBridge, null);
    expect((await port.importStep('QUJD')).bodies).toHaveLength(1);
    await expect(port.importStep('bad')).rejects.toThrow(/no bodies/);
  });

  it('routes build123d to the build123d python', async () => {
    const scriptA = await script(
      'which-a.js',
      `process.stdout.write('{"ok":true,"trace":"A","traced":true,"log":""}')`,
    );
    const scriptB = await script(
      'which-b.js',
      `process.stdout.write('{"ok":true,"trace":"B","traced":true,"log":""}')`,
    );
    const wrapper = await script(
      'wrapper.sh',
      `#!/bin/sh\nexec "${process.execPath}" "${scriptB}"\n`,
    );
    await chmod(wrapper, 0o755);
    const port = createPythonExchangePort({
      python: process.execPath,
      build123dPython: wrapper,
      timeoutMs: 10_000,
      bridgeScript: scriptA,
      exchangeDir: null,
    });
    expect((await port.runProgram({ language: 'cadquery', source: '', step: false })).trace).toBe(
      'A',
    );
    expect((await port.runProgram({ language: 'build123d', source: '', step: false })).trace).toBe(
      'B',
    );
  });

  it('has no exchange-file methods without an exchange dir', async () => {
    const port = await portWith(fakeBridge, null);
    expect(port.readExchangeFile).toBeUndefined();
    expect(port.writeExchangeFile).toBeUndefined();
  });

  it('writes and reads files inside the exchange dir, creating it, and confines paths', async () => {
    const dir = path.join(scratch, 'exchange', 'nested');
    const port = await portWith(fakeBridge, dir);
    const written = await port.writeExchangeFile!(
      'part.step',
      Buffer.from('HELLO').toString('base64'),
    );
    expect(written).toBe(path.join(dir, 'part.step'));
    expect((await stat(written)).isFile()).toBe(true);
    expect(await readFile(written, 'utf8')).toBe('HELLO');
    expect(await port.readExchangeFile!('part.step', 'base64')).toBe(
      Buffer.from('HELLO').toString('base64'),
    );
    expect(await port.readExchangeFile!('part.step', 'utf8')).toBe('HELLO');
    await expect(port.readExchangeFile!('../outside', 'utf8')).rejects.toThrow(/inside/);
    await expect(port.writeExchangeFile!('../outside.step', 'QUJD')).rejects.toThrow(/inside/);
    await expect(port.readExchangeFile!('missing.step', 'utf8')).rejects.toThrow(/ENOENT/);
  });
});
