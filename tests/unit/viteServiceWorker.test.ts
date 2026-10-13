import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildServiceWorkerManifest, parseServiceWorkerPolicy, serviceWorkerScript } from '../../viteServiceWorker';

const policy = parseServiceWorkerPolicy(JSON.parse(readFileSync('serviceWorker/config.json', 'utf8')));

const files = [
  { fileName: 'assets/index-a1.js', bytes: 1000 },
  { fileName: 'assets/index-b2.css', bytes: 100 },
  { fileName: 'assets/occtKernelBrowser-c3.js', bytes: 1000 },
  { fileName: 'assets/opencascade.wasm-d4.js', bytes: 1000 },
  { fileName: 'assets/manifold-e5.wasm', bytes: 1000 },
  { fileName: 'assets/huge-f6.js', bytes: 5_000_000 },
  { fileName: 'samples/site.xml', bytes: 10 },
];

describe('service worker build', () => {
  it('the checked-in policy parses; a bad regex is rejected', () => {
    expect(policy.navigation.fallback).toBe('/index.html');
    expect(() => parseServiceWorkerPolicy({ ...policy, runtime: { cacheFirst: '(', exclude: 'x' } })).toThrow(/regular expression/);
  });
  it('precaches only the shell and small hashed js/css plus the manifold wasm (never occt), sorted', () => {
    const manifest = buildServiceWorkerManifest(files, policy, () => 'h', 'sw');
    expect(manifest.precache).toEqual([
      'assets/index-a1.js',
      'assets/index-b2.css',
      'assets/manifold-e5.wasm',
      'favicon.svg',
      'index.html',
    ]);
  });
  it('the version changes with file contents or worker source and is stable otherwise', () => {
    const v1 = buildServiceWorkerManifest(files, policy, () => 'h1', 'sw').version;
    expect(buildServiceWorkerManifest(files, policy, () => 'h1', 'sw').version).toBe(v1);
    expect(buildServiceWorkerManifest(files, policy, () => 'h2', 'sw').version).not.toBe(v1);
    expect(buildServiceWorkerManifest(files, policy, () => 'h1', 'sw2').version).not.toBe(v1);
  });
  it('prepends the manifest to the worker source', () => {
    const manifest = buildServiceWorkerManifest(files, policy, () => 'h', 'sw');
    const script = serviceWorkerScript(manifest, '/* worker */');
    expect(script.startsWith(`self.LLULL_SW = {"version":"${manifest.version}"`)).toBe(true);
    expect(script.endsWith('/* worker */')).toBe(true);
  });
});
