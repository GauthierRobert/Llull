import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { nativeBinaryPath, nativeInstallHint } from '../src/native/nativeBinary';

describe('nativeBinaryPath', () => {
  it('prefers the per-binary override and refuses a missing one', () => {
    expect(nativeBinaryPath('llull-compute', { LLULL_COMPUTE: '/opt/x/llull-compute' }, () => true)).toBe(
      path.resolve('/opt/x/llull-compute'),
    );
    expect(nativeBinaryPath('llull-compute', { LLULL_COMPUTE: '/opt/x/llull-compute' }, () => false)).toBeNull();
  });

  it('uses the desktop bundle directory, with the .exe suffix on Windows', () => {
    const seen: string[] = [];
    const found = nativeBinaryPath(
      'llull-kernel',
      { LLULL_NATIVE_DIR: '/bundle' },
      (file) => (seen.push(file), file.startsWith('/bundle')),
      'win32',
    );
    expect(found).toBe(path.join('/bundle', 'llull-kernel.exe'));
    expect(seen).toHaveLength(1);
  });

  it('prefers the local compute-profile build of llull-compute', () => {
    const found = nativeBinaryPath('llull-compute', {}, (file) => file.includes(path.join('solver', 'target')), 'linux');
    expect(found).toMatch(/solver[\\/]target[\\/]compute[\\/]llull-compute$/);
    const kernel = nativeBinaryPath('llull-kernel', {}, (file) => file.includes(path.join('solver', 'target')), 'linux');
    expect(kernel).toMatch(/solver[\\/]target[\\/]release[\\/]llull-kernel$/);
  });

  it('falls back to a local release build, else null', () => {
    const local = nativeBinaryPath('llull-compute', {}, (file) => file.includes(path.join('solver', 'target', 'release')), 'linux');
    expect(local).toMatch(/solver[\\/]target[\\/]release[\\/]llull-compute$/);
    expect(nativeBinaryPath('llull-compute', {}, () => false)).toBeNull();
    expect(nativeInstallHint('llull-kernel')).toContain('LLULL_KERNEL_BIN');
  });
});
