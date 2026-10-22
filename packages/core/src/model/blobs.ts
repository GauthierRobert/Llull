/**
 * Document blobs (aerospace 01 KRN, TR-KRN-21): content-addressed payload texts referenced by `brep` recipe leaves.
 * @invariant a text blob is keyed by the sha256 of its decoded UTF-8 text, a binary blob (embedded fonts, 03 WRP D-WRP-1) by the sha256 of its raw
 *   bytes, so identical payloads share one entry and replay re-mints identical keys
 * @failure undecodable bytes -> blobText null; a key/hash/size/mediaType disagreement -> blobProblem names it
 */

import { base64ToText, base64ToUint8Array, textToBase64, uint8ArrayToBase64 } from '../lib/base64';
import { sha256Hex } from '../lib/sha256';
import type { CadDocument, DocumentBlob } from './types';

const BLOB_MEDIA_TYPES: ReadonlyArray<string> = ['model/x-occt-brep', 'model/step', 'model/iges', 'font/ttf', 'font/otf'];

/** Media types whose payload is raw bytes, not UTF-8 text. */
const BINARY_MEDIA_TYPES: ReadonlyArray<string> = ['font/ttf', 'font/otf'];

export function makeBlob(mediaType: DocumentBlob['mediaType'], text: string): DocumentBlob {
  return { sha256: sha256Hex(text), mediaType, bytes: textToBase64(text), size: new TextEncoder().encode(text).length };
}

/** A binary blob (embedded font): keyed by the sha256 of `bytes` as they are. */
export function makeBinaryBlob(mediaType: DocumentBlob['mediaType'], bytes: Uint8Array): DocumentBlob {
  return { sha256: sha256Hex(bytes), mediaType, bytes: uint8ArrayToBase64(bytes), size: bytes.length };
}

/** The raw bytes of a blob; null when its base64 is malformed. */
export function blobBytes(blob: DocumentBlob): Uint8Array | null {
  return base64ToUint8Array(blob.bytes);
}

export function blobText(blob: DocumentBlob): string | null {
  return base64ToText(blob.bytes);
}

/** `doc` with `blob` added (an existing entry with the same hash is kept). */
export function withBlob(doc: CadDocument, blob: DocumentBlob): CadDocument {
  if (doc.blobs?.[blob.sha256] !== undefined) return doc;
  return { ...doc, blobs: { ...doc.blobs, [blob.sha256]: blob } };
}

/** Why the blob stored under `key` is not trustworthy, or null when its mediaType, bytes, size and hash agree. */
export function blobProblem(key: string, blob: unknown): 'KRN_BLOB_HASH_MISMATCH' | 'malformed' | null {
  if (typeof blob !== 'object' || blob === null) return 'malformed';
  const { sha256, mediaType, bytes, size } = blob as Partial<Record<keyof DocumentBlob, unknown>>;
  if (typeof sha256 !== 'string' || typeof bytes !== 'string' || typeof size !== 'number') return 'malformed';
  if (typeof mediaType !== 'string' || !BLOB_MEDIA_TYPES.includes(mediaType)) return 'malformed';
  if (BINARY_MEDIA_TYPES.includes(mediaType)) {
    const raw = base64ToUint8Array(bytes);
    return raw !== null && sha256 === key && sha256Hex(raw) === key && raw.length === size ? null : 'KRN_BLOB_HASH_MISMATCH';
  }
  const text = base64ToText(bytes);
  if (text === null) return 'KRN_BLOB_HASH_MISMATCH';
  const decodedSize = new TextEncoder().encode(text).length;
  return sha256 === key && sha256Hex(text) === key && decodedSize === size ? null : 'KRN_BLOB_HASH_MISMATCH';
}
