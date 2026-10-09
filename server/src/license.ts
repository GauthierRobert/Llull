/**
 * @layer server
 * Offline license verification. A license is `<base64url payload>.<base64url Ed25519 signature>`
 * over the payload bytes `{ customer, seats, expires (ISO date), features[] }`, checked against the
 * public key in `LLULL_LICENSE_PUBLIC_KEY` (PEM, `\n` escapes allowed, or a path to a PEM file).
 * Anything missing, expired or tampered falls back to evaluation mode (3 named users).
 */

import crypto from 'crypto';
import fs from 'fs';
import { isRecord } from '@lib/isRecord';
import { errorMessage } from '@lib/errorMessage';

export const EVALUATION_SEATS = 3;

export interface LicenseStatus {
  readonly mode: 'licensed' | 'evaluation';
  readonly customer: string | null;
  readonly seats: number;
  readonly expires: string | null;
  readonly features: readonly string[];
  /** Short text for the UI status bar / banner. */
  readonly label: string;
  /** Why a configured license was not accepted (also logged once). */
  readonly warning?: string;
}

interface LicensePayload {
  readonly customer: string;
  readonly seats: number;
  readonly expires: string;
  readonly features: readonly string[];
}

function evaluation(warning?: string): LicenseStatus {
  return {
    mode: 'evaluation',
    customer: null,
    seats: EVALUATION_SEATS,
    expires: null,
    features: [],
    label: `Evaluation — ${EVALUATION_SEATS} users`,
    ...(warning !== undefined ? { warning } : {}),
  };
}

function publicKeyPem(): string | undefined {
  const raw = process.env['LLULL_LICENSE_PUBLIC_KEY']?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n');
  return fs.readFileSync(raw, 'utf8');
}

function parsePayload(bytes: Buffer): LicensePayload {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(value)) throw new Error('payload is not an object');
  const { customer, seats, expires, features } = value;
  if (typeof customer !== 'string' || customer === '') throw new Error('customer missing');
  if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < 1) {
    throw new Error('seats must be a positive integer');
  }
  if (typeof expires !== 'string' || Number.isNaN(Date.parse(expires))) {
    throw new Error('expires must be an ISO date');
  }
  if (!Array.isArray(features) || features.some((f) => typeof f !== 'string')) {
    throw new Error('features must be a string array');
  }
  return { customer, seats, expires, features: features as string[] };
}

/** Pure verification of a license string. @failure any problem -> evaluation status + warning */
export function verifyLicense(
  license: string,
  publicKeyPemText: string,
  now: Date = new Date(),
): LicenseStatus {
  try {
    const [payloadPart, signaturePart, ...extra] = license.trim().split('.');
    if (payloadPart === undefined || signaturePart === undefined || extra.length > 0) {
      throw new Error('malformed license (expected <payload>.<signature>)');
    }
    const payloadBytes = Buffer.from(payloadPart, 'base64url');
    const key = crypto.createPublicKey(publicKeyPemText);
    if (!crypto.verify(null, payloadBytes, key, Buffer.from(signaturePart, 'base64url'))) {
      throw new Error('signature does not match the public key');
    }
    const payload = parsePayload(payloadBytes);
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(payload.expires);
    const expiry = Date.parse(dateOnly ? `${payload.expires}T23:59:59.999Z` : payload.expires);
    if (expiry < now.getTime()) throw new Error(`license expired on ${payload.expires}`);
    return {
      mode: 'licensed',
      customer: payload.customer,
      seats: payload.seats,
      expires: payload.expires,
      features: payload.features,
      label: payload.customer,
    };
  } catch (err) {
    return evaluation(`Invalid license, running in evaluation mode: ${errorMessage(err)}`);
  }
}

let warned: string | undefined;
let cache: { stamp: string; text: string } | null = null;

function readLicenseText(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    const stamp = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (cache?.stamp !== stamp) cache = { stamp, text: fs.readFileSync(file, 'utf8') };
    return cache.text;
  } catch {
    return null;
  }
}

/** Current license status (file re-read when it changes; expiry evaluated at call time). */
export function getLicense(now: Date = new Date()): LicenseStatus {
  const file = process.env['LLULL_LICENSE_FILE']?.trim();
  if (file === undefined || file === '') return evaluation();
  let status: LicenseStatus;
  try {
    const pem = publicKeyPem();
    const text = readLicenseText(file);
    status =
      pem === undefined
        ? evaluation('LLULL_LICENSE_FILE is set but LLULL_LICENSE_PUBLIC_KEY is not.')
        : text === null
          ? evaluation(`License file ${file} cannot be read.`)
          : verifyLicense(text, pem, now);
  } catch (err) {
    status = evaluation(`License check failed: ${errorMessage(err)}`);
  }
  if (status.warning !== undefined && status.warning !== warned) {
    warned = status.warning;
    console.warn(`[llull-license] ${status.warning}`);
  }
  return status;
}

/** Body of the public `GET /license`. */
export function publicLicenseBody(status: LicenseStatus): Record<string, unknown> {
  return {
    mode: status.mode,
    customer: status.customer,
    seats: status.seats,
    expires: status.expires,
    label: status.label,
    evaluation: status.mode === 'evaluation',
    ...(status.warning !== undefined ? { warning: status.warning } : {}),
  };
}
