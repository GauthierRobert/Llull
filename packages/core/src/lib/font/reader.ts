/**
 * Bounds-checked big-endian reads over an untrusted byte range (03 WRP, TrueType parser). Every access is validated against the range, so a hostile
 * offset, length or count can only raise `FontError`, never read outside the font or loop without bound.
 */

export type FontErrorCode =
  | 'WRP_FONT_PARSE'
  | 'WRP_FONT_FORMAT_UNSUPPORTED'
  | 'WRP_FONT_EMBEDDING_RESTRICTED'
  | 'WRP_FONT_TOO_LARGE'
  | 'WRP_FONT_VARIATION';

/** A refusal with one of the stable `WRP_FONT_*` codes. */
export class FontError extends Error {
  readonly code: FontErrorCode;

  constructor(code: FontErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const parseError = (message: string): FontError => new FontError('WRP_FONT_PARSE', message);

/** A window `[start, start + length)` of the font bytes; offsets are relative to `start`. */
export class ByteView {
  private readonly view: DataView;

  readonly length: number;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly start: number,
    length: number,
    private readonly label: string,
  ) {
    if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0 || start + length > bytes.length)
      throw parseError(`${label}: range ${start}+${length} lies outside the ${bytes.length}-byte font`);
    this.view = new DataView(bytes.buffer, bytes.byteOffset + start, length);
    this.length = length;
  }

  private check(offset: number, size: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > this.length)
      throw parseError(`${this.label}: read of ${size} byte(s) at ${offset} runs past the ${this.length}-byte range`);
  }

  u8(offset: number): number {
    this.check(offset, 1);
    return this.view.getUint8(offset);
  }

  i8(offset: number): number {
    this.check(offset, 1);
    return this.view.getInt8(offset);
  }

  u16(offset: number): number {
    this.check(offset, 2);
    return this.view.getUint16(offset);
  }

  i16(offset: number): number {
    this.check(offset, 2);
    return this.view.getInt16(offset);
  }

  u32(offset: number): number {
    this.check(offset, 4);
    return this.view.getUint32(offset);
  }

  /** `length` bytes at `offset` as a sub-view. */
  sub(offset: number, length: number, label: string): ByteView {
    this.check(offset, length);
    return new ByteView(this.bytes, this.start + offset, length, label);
  }

  /** ASCII text of `length` bytes at `offset` (non-ASCII bytes become `?`). */
  ascii(offset: number, length: number): string {
    this.check(offset, length);
    let text = '';
    for (let i = 0; i < length; i++) {
      const code = this.view.getUint8(offset + i);
      text += code >= 32 && code < 127 ? String.fromCharCode(code) : '?';
    }
    return text;
  }

  /** UTF-16BE text of `length` bytes at `offset`. */
  utf16(offset: number, length: number): string {
    this.check(offset, length);
    let text = '';
    for (let i = 0; i + 1 < length; i += 2) text += String.fromCharCode(this.view.getUint16(offset + i));
    return text;
  }
}
