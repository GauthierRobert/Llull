const GUID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** Deterministic 22-character IFC GlobalId derived from a seed (FNV-1a, 128 bits). */
export function ifcGuid(seed: string): string {
  const words = [0x811c9dc5, 0x01000193, 0x1b873593, 0xcc9e2d51];
  for (let index = 0; index < seed.length; index++) {
    const code = seed.charCodeAt(index);
    for (let word = 0; word < 4; word++) {
      words[word] = Math.imul((words[word] as number) ^ (code + word * 31), 0x01000193) >>> 0;
    }
  }
  let bits = '';
  for (const word of words) bits += word.toString(2).padStart(32, '0');
  let guid = GUID_ALPHABET[parseInt(bits.slice(0, 2), 2)] as string;
  for (let offset = 2; offset < 128; offset += 6) {
    guid += GUID_ALPHABET[parseInt(bits.slice(offset, offset + 6), 2)] as string;
  }
  return guid;
}
