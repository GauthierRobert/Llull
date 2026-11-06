/**
 * The main-process bundle as built by `scripts/build-main.mjs` (the real build, into a temp folder): no native module in main.js (a `.node` addon, the SVG
 * rasterizer), a preload that requires only `electron` and exposes exactly `exportThreeMf` (no argument) and `restoreRecovery` (a slot id, never a path).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(__dirname, '..');
const out = mkdtempSync(path.join(tmpdir(), 'llull-main-bundle-'));

/** esbuild is a dev dependency of the desktop package: a checkout without `npm --prefix desktop install` cannot run the build (CI installs it). */
const hasEsbuild = ((): boolean => {
  try {
    createRequire(path.join(desktopRoot, 'package.json')).resolve('esbuild');
    return true;
  } catch {
    return false;
  }
})();

beforeAll(() => {
  if (!hasEsbuild) return;
  execFileSync(process.execPath, [path.join(desktopRoot, 'scripts', 'build-main.mjs')], {
    env: { ...process.env, LLULL_DESKTOP_OUT: out },
    stdio: 'pipe',
  });
}, 120_000);

describe.skipIf(!hasEsbuild)('desktop main bundle', () => {
  it('builds main.js and preload.js, and main.js requires no native module', () => {
    expect(existsSync(path.join(out, 'main.js'))).toBe(true);
    expect(existsSync(path.join(out, 'preload.js'))).toBe(true);
    const main = readFileSync(path.join(out, 'main.js'), 'utf8');
    expect(main).not.toMatch(/resvg/i);
    // a quoted path ending in .node (an addon), not a property access such as stage.node)
    expect(main).not.toMatch(/["'`][^"'`\n]*\.node["'`]/);
  });

  it('the preload requires only electron and exposes exactly exportThreeMf (no argument) and restoreRecovery (a slot id), each on its own channel', async () => {
    const source = readFileSync(path.join(out, 'preload.js'), 'utf8');
    const required = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
    expect(new Set(required)).toEqual(new Set(['electron']));
    const exposed: Array<{ name: string; api: Record<string, () => Promise<unknown>> }> = [];
    const calls: unknown[][] = [];
    const electron = {
      contextBridge: { exposeInMainWorld: (name: string, api: Record<string, () => Promise<unknown>>) => exposed.push({ name, api }) },
      ipcRenderer: {
        invoke: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve({ ok: true, message: 'done' });
        },
      },
    };
    vm.runInNewContext(source, {
      require: (name: string) => (name === 'electron' ? electron : undefined),
      module: { exports: {} },
      exports: {},
    });
    expect(exposed.map((entry) => entry.name)).toEqual(['llull']);
    expect(Object.keys(exposed[0]?.api ?? {})).toEqual(['exportThreeMf', 'restoreRecovery']);
    await exposed[0]?.api['exportThreeMf']?.();
    const restore = exposed[0]?.api['restoreRecovery'] as ((slotId: string) => Promise<unknown>) | undefined;
    await restore?.('doc-a');
    // restoreRecovery forwards a slot id only; the main process resolves the path itself.
    expect(calls).toEqual([['llull:export-3mf'], ['llull:restore-recovery', 'doc-a']]);
  });
});
