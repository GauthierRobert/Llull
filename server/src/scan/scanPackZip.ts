/**
 * Strict structural check of a pack archive before it is read (plant 10 §13.9): `llull pack` writes plain STORED, unique-named, non-symlink entries whose
 * local header agrees with the central directory, so anything else is a damaged or hostile archive, refused before a byte is inflated or installed.
 */

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** Central-directory external attributes: the high 16 bits are a unix mode on archives made by unix tools. */
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

/** The reason `bytes` is not a pack-shaped zip, or null. */
export function packZipProblem(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== END) end--;
  if (end < 0) return 'not a zip archive';
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL) return 'corrupt central directory';
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const attributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    if (method !== 0) return `entry ${name.slice(0, 80)} is not stored (method ${method})`;
    if (compressed !== size) return `entry ${name.slice(0, 80)} lies about its size`;
    if (((attributes >>> 16) & S_IFMT) === S_IFLNK) return `entry ${name.slice(0, 80)} is a symbolic link`;
    if (names.has(name)) return `duplicate entry ${name.slice(0, 80)}`;
    names.add(name);
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL)
      return `entry ${name.slice(0, 80)} has no local header`;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localName = new TextDecoder().decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== name) return `entry ${name.slice(0, 80)}: the local header names another file`;
    if (
      view.getUint16(localOffset + 8, true) !== 0 ||
      view.getUint32(localOffset + 18, true) !== compressed ||
      view.getUint32(localOffset + 22, true) !== size
    )
      return `entry ${name.slice(0, 80)}: the local header disagrees with the central directory`;
  }
  return null;
}
