/**
 * Independent OpenEXR header reader for issued renders (OpenEXR file layout 2.0): magic number, version, then the attribute list
 * (name\0 type\0 size value) up to the empty name. Returns the data window size, the channel names and their pixel types; pixels are not
 * decoded (the header is what a compositing tool checks first).
 */

export interface ExrHeader {
  readonly width: number;
  readonly height: number;
  /** Channel name -> pixel type (0 uint, 1 half, 2 float). */
  readonly channels: Readonly<Record<string, number>>;
  readonly compression: number;
}

function cString(bytes: Buffer, offset: number): [string, number] {
  const end = bytes.indexOf(0, offset);
  if (end < 0) throw new Error('EXR: unterminated string');
  return [bytes.toString('latin1', offset, end), end + 1];
}

function channelList(value: Buffer): Record<string, number> {
  const channels: Record<string, number> = {};
  let offset = 0;
  while (offset < value.length && value[offset] !== 0) {
    const [name, next] = cString(value, offset);
    channels[name] = value.readInt32LE(next);
    offset = next + 16;
  }
  return channels;
}

export function readExrHeader(bytes: Uint8Array): ExrHeader {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 8 || buffer.readUInt32LE(0) !== 20000630) throw new Error('EXR: bad magic number');
  let offset = 8;
  let window: [number, number, number, number] | null = null;
  let channels: Record<string, number> = {};
  let compression = -1;
  for (;;) {
    const [name, afterName] = cString(buffer, offset);
    if (name === '') break;
    const [, afterType] = cString(buffer, afterName);
    const size = buffer.readInt32LE(afterType);
    const value = buffer.subarray(afterType + 4, afterType + 4 + size);
    if (name === 'dataWindow') window = [value.readInt32LE(0), value.readInt32LE(4), value.readInt32LE(8), value.readInt32LE(12)];
    else if (name === 'channels') channels = channelList(value);
    else if (name === 'compression') compression = value[0] ?? -1;
    offset = afterType + 4 + size;
  }
  if (window === null) throw new Error('EXR: no dataWindow');
  return { width: window[2] - window[0] + 1, height: window[3] - window[1] + 1, channels, compression };
}
