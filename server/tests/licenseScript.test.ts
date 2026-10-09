/**
 * @layer server/tests
 * The vendor script (`scripts/license.mjs`) and the server verifier agree on the license format.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { verifyLicense } from '../src/license';
import { tempDir } from './userTestSupport';

const script = path.resolve(__dirname, '..', 'scripts', 'license.mjs');
const run = (...args: string[]): string =>
  execFileSync(process.execPath, [script, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();

describe('scripts/license.mjs', () => {
  it('keygen + sign produce a license the server accepts', () => {
    const dir = tempDir();
    const key = path.join(dir, 'private.pem');
    const publicPem = run('keygen', '--out', key);
    const payload = path.join(dir, 'payload.json');
    fs.writeFileSync(
      payload,
      JSON.stringify({ customer: 'Script Co', seats: 7, expires: '2999-01-01' }),
    );
    const license = run('sign', payload, '--key', key).trim();
    expect(verifyLicense(license, publicPem)).toMatchObject({ mode: 'licensed', seats: 7 });
    expect(() => run('keygen', '--out', key)).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
