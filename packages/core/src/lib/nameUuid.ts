import { sha256Hex } from './sha256';

/**
 * Name-based UUID (RFC 9562 version 8: custom, here the first 128 bits of sha256(`name`)) in the 8-4-4-4-12 form. The same name always
 * gives the same UUID, so BCF GUIDs derived from document content are reproducible.
 */
export function nameUuid(name: string): string {
  const hex = sha256Hex(name).slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`;
}
