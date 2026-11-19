/**
 * Byte scanner of the two record kinds that make up almost all of an OBJ file: decimal numbers and face corner references. It only
 * accepts what it can read exactly as `Number` / `Number.parseInt` would; anything else is reported as "not read" and left to the caller.
 */

const POWERS_OF_TEN = [
  1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
];
/** Decimal digits a double holds exactly (10^15 < 2^53): with at most this many, one multiplication or division by an exact power of ten is correctly rounded. */
const EXACT_DIGITS = 15;
const MAX_REFERENCE_DIGITS = 9;
const MAX_EXPONENT_DIGITS = 4;

const isBlank = (code: number): boolean => code === 32 || (code >= 9 && code <= 13);
const isDigit = (code: number): boolean => code >= 48 && code <= 57;

export class ObjLineScanner {
  /** Byte after the token the last successful `number` call read. */
  cursor = 0;
  private text: string | null = null;

  constructor(private readonly bytes: Uint8Array) {}

  /** `Number` of the ASCII token `[from, to)`, for the tokens too long for the exact product. */
  private numberOfText(from: number, to: number): number {
    // One byte is one character in this decoding, so byte offsets index the string; the token itself is ASCII.
    this.text ??= new TextDecoder('latin1').decode(this.bytes);
    return Number(this.text.substring(from, to));
  }

  /**
   * The decimal number starting after the blanks at `from` (before `end`), ended by a blank or `end`: the value `Number` gives for that
   * token. NaN when there is no such plain token (`cursor` is then unchanged).
   */
  number(from: number, end: number): number {
    const bytes = this.bytes;
    let at = from;
    while (at < end && isBlank(bytes[at] as number)) at++;
    const tokenStart = at;
    let code = at < end ? (bytes[at] as number) : 0;
    const negative = code === 45;
    if (negative || code === 43) code = ++at < end ? (bytes[at] as number) : 0;
    let mantissa = 0;
    let significant = 0;
    let digits = 0;
    let scale = 0;
    while (isDigit(code)) {
      mantissa = mantissa * 10 + (code - 48);
      if (mantissa !== 0) significant++;
      digits++;
      code = ++at < end ? (bytes[at] as number) : 0;
    }
    if (code === 46) {
      code = ++at < end ? (bytes[at] as number) : 0;
      while (isDigit(code)) {
        mantissa = mantissa * 10 + (code - 48);
        if (mantissa !== 0) significant++;
        digits++;
        scale--;
        code = ++at < end ? (bytes[at] as number) : 0;
      }
    }
    if (digits === 0) return NaN;
    if (code === 101 || code === 69) {
      code = ++at < end ? (bytes[at] as number) : 0;
      const negativeExponent = code === 45;
      if (negativeExponent || code === 43) code = ++at < end ? (bytes[at] as number) : 0;
      let exponent = 0;
      let exponentDigits = 0;
      while (isDigit(code)) {
        exponent = exponent * 10 + (code - 48);
        exponentDigits++;
        code = ++at < end ? (bytes[at] as number) : 0;
      }
      if (exponentDigits === 0 || exponentDigits > MAX_EXPONENT_DIGITS) return NaN;
      scale += negativeExponent ? -exponent : exponent;
    }
    if (at < end && !isBlank(code)) return NaN;
    let value: number;
    if (significant > EXACT_DIGITS || scale > 22 || scale < -22) {
      value = this.numberOfText(tokenStart, at);
      if (!Number.isFinite(value)) return NaN;
    } else {
      const magnitude =
        scale === 0 ? mantissa : scale > 0 ? mantissa * (POWERS_OF_TEN[scale] as number) : mantissa / (POWERS_OF_TEN[-scale] as number);
      value = negative ? -magnitude : magnitude;
    }
    this.cursor = at;
    return value;
  }

  /**
   * The corners of a face record `[from, end)` as 0-based vertex indices in `corners` (1-based or negative references, `a/b/c` forms
   * read by their first part). False when a token is not a plain reference, a reference is outside the `vertexCount` vertices read so
   * far, or there are fewer than three corners.
   */
  corners(from: number, end: number, vertexCount: number, corners: number[]): boolean {
    const bytes = this.bytes;
    corners.length = 0;
    let at = from;
    for (;;) {
      while (at < end && isBlank(bytes[at] as number)) at++;
      if (at >= end) return corners.length >= 3;
      let code = bytes[at] as number;
      const negative = code === 45;
      if (negative || code === 43) code = ++at < end ? (bytes[at] as number) : 0;
      let reference = 0;
      let digits = 0;
      while (isDigit(code)) {
        reference = reference * 10 + (code - 48);
        digits++;
        code = ++at < end ? (bytes[at] as number) : 0;
      }
      if (digits === 0 || digits > MAX_REFERENCE_DIGITS) return false;
      if (code === 47) {
        // The texture / normal parts are not read; a byte outside ASCII could be a blank character of the general rules.
        while (at < end && !isBlank(code)) {
          if (code >= 128) return false;
          code = ++at < end ? (bytes[at] as number) : 0;
        }
      } else if (at < end && !isBlank(code)) return false;
      const resolved = negative ? vertexCount - reference : reference - 1;
      if (resolved < 0 || resolved >= vertexCount) return false;
      corners.push(resolved);
    }
  }
}
