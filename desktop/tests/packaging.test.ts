/**
 * Installer packaging (08 ASC TR-ASC-01 / 02): no `file:` dependency pulls a repo folder into the staged server or the app, app.asar
 * carries no node_modules, and archives are extracted with the system `tar`, never the first one on `PATH`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemTar } from '../scripts/systemTar.mjs';

const repo = path.resolve(__dirname, '..', '..');
const read = (relative: string): string => readFileSync(path.join(repo, relative), 'utf8');

const dependencyRanges = (relative: string): string[] => {
  const manifest = JSON.parse(read(relative)) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  return [...Object.values(manifest.dependencies ?? {}), ...Object.values(manifest.optionalDependencies ?? {})];
};

describe('installer packaging', () => {
  it.each(['desktop/package.json', 'server/package.json'])('%s has no file: or link: runtime dependency', (manifest) => {
    expect(dependencyRanges(manifest).filter((range) => /^(file|link):/.test(range))).toEqual([]);
  });

  it.each(['desktop/package-lock.json', 'server/package-lock.json'])('%s resolves no package outside its folder', (lock) => {
    const packages = Object.keys((JSON.parse(read(lock)) as { packages: Record<string, unknown> }).packages);
    expect(packages.filter((key) => key === '..' || key.startsWith('../'))).toEqual([]);
  });

  it('keeps node_modules out of app.asar', () => {
    expect(read('desktop/electron-builder.yml')).toMatch(/^ {2}- '!node_modules\/\*\*'$/m);
  });

  it('extracts the Python archive with the system tar', () => {
    const script = read('desktop/scripts/prepare-python.mjs');
    expect(script).toContain('execFileSync(systemTar(),');
    expect(script).not.toMatch(/execFileSync\('tar'/);
  });
});

describe('systemTar', () => {
  it('uses System32 tar.exe on Windows, from SystemRoot', () => {
    const tar = systemTar('win32', { SystemRoot: 'D:\\Win' }, () => true);
    expect(tar).toBe('D:\\Win\\System32\\tar.exe');
  });

  it('falls back to C:\\Windows when SystemRoot and windir are unset', () => {
    expect(systemTar('win32', {}, () => true)).toBe('C:\\Windows\\System32\\tar.exe');
  });

  it('takes /usr/bin/tar, then /bin/tar, on other systems', () => {
    expect(systemTar('linux', {}, () => true)).toBe('/usr/bin/tar');
    expect(systemTar('darwin', {}, (candidate: string) => candidate === '/bin/tar')).toBe('/bin/tar');
  });

  it('refuses by name when no system tar exists', () => {
    expect(() => systemTar('linux', {}, () => false)).toThrow(/no system tar found/);
  });
});
