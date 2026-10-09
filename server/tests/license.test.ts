/**
 * @layer server/tests
 * Offline Ed25519 license verification: valid, expired, tampered, wrong key, seat limit,
 * evaluation default, and the public GET /license.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { app } from '../src/index';
import { EVALUATION_SEATS, getLicense, verifyLicense } from '../src/license';
import { ADMIN, EDITOR, VIEWER, clearEnv, installUsersFile, tempDir } from './userTestSupport';

const keys = crypto.generateKeyPairSync('ed25519');
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const otherPublicPem = crypto
  .generateKeyPairSync('ed25519')
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();

function sign(payload: object, key = keys.privateKey): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  return `${bytes.toString('base64url')}.${crypto.sign(null, bytes, key).toString('base64url')}`;
}

const PAYLOAD = { customer: 'ACME Ingenieria', seats: 5, expires: '2999-12-31', features: ['dwg'] };
let dir: string;

beforeEach(() => {
  dir = tempDir();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  clearEnv();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('verifyLicense', () => {
  it('accepts a valid signature', () => {
    const status = verifyLicense(sign(PAYLOAD), publicPem);
    expect(status).toMatchObject({
      mode: 'licensed',
      customer: 'ACME Ingenieria',
      seats: 5,
      expires: '2999-12-31',
      features: ['dwg'],
      label: 'ACME Ingenieria',
    });
  });

  it('falls back to evaluation when expired (date-only expiry is inclusive)', () => {
    const license = sign({ ...PAYLOAD, expires: '2024-01-01' });
    const expired = verifyLicense(license, publicPem, new Date('2024-01-02T00:00:00Z'));
    expect(expired).toMatchObject({ mode: 'evaluation', seats: EVALUATION_SEATS });
    expect(expired.warning).toMatch(/expired/);
    expect(verifyLicense(license, publicPem, new Date('2024-01-01T12:00:00Z')).mode).toBe(
      'licensed',
    );
  });

  it('rejects a tampered payload and a wrong public key', () => {
    const [, signature] = sign(PAYLOAD).split('.');
    const forged = `${Buffer.from(JSON.stringify({ ...PAYLOAD, seats: 500 })).toString('base64url')}.${signature}`;
    expect(verifyLicense(forged, publicPem).warning).toMatch(/signature/);
    expect(verifyLicense(sign(PAYLOAD), otherPublicPem).mode).toBe('evaluation');
    expect(verifyLicense('garbage', publicPem).mode).toBe('evaluation');
  });

  it('rejects a signed but invalid payload', () => {
    expect(verifyLicense(sign({ ...PAYLOAD, seats: 0 }), publicPem).warning).toMatch(/seats/);
  });
});

describe('getLicense / GET /license', () => {
  function installLicense(license: string): void {
    const file = path.join(dir, 'license.key');
    fs.writeFileSync(file, license);
    process.env['LLULL_LICENSE_FILE'] = file;
    process.env['LLULL_LICENSE_PUBLIC_KEY'] = publicPem.replace(/\n/g, '\\n');
  }

  it('defaults to evaluation with 3 users and a banner flag', async () => {
    const res = await request(app).get('/license');
    expect(res.body).toMatchObject({
      mode: 'evaluation',
      seats: 3,
      customer: null,
      evaluation: true,
      label: 'Evaluation — 3 users',
    });
  });

  it('reports a valid license publicly (no features, no warning)', async () => {
    installLicense(sign(PAYLOAD));
    const res = await request(app).get('/license');
    expect(res.body).toMatchObject({ mode: 'licensed', customer: 'ACME Ingenieria', seats: 5 });
    expect(res.body.evaluation).toBe(false);
    expect(res.body.warning).toBeUndefined();
  });

  it('logs a warning and reports evaluation for a bad license', async () => {
    installLicense(sign(PAYLOAD, crypto.generateKeyPairSync('ed25519').privateKey));
    const res = await request(app).get('/license');
    expect(res.body.mode).toBe('evaluation');
    expect(res.body.warning).toMatch(/signature/);
    expect(console.warn).toHaveBeenCalled();
  });

  it('warns when the license file is set without a public key', () => {
    process.env['LLULL_LICENSE_FILE'] = path.join(dir, 'missing.key');
    expect(getLicense().warning).toMatch(/LLULL_LICENSE_PUBLIC_KEY/);
  });

  it('enforces seats: evaluation caps named users at 3, a license raises it', async () => {
    const fourth = { ...VIEWER, id: 'v2', token: 'tok-v2' };
    installUsersFile(dir, [ADMIN, EDITOR, VIEWER, fourth]);
    const asFourth = (): Promise<request.Response> =>
      request(app).get('/live/snapshot').set('Authorization', 'Bearer tok-v2');
    expect((await asFourth()).status).toBe(402);
    installLicense(sign(PAYLOAD));
    expect((await asFourth()).status).toBe(200);
  });
});
