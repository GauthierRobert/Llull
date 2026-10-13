/** Is `text` a plain identifier (letter or underscore, then letters, digits or underscores) — the name rule for parameters and loop variables? */
export function isIdentifier(text: string): boolean {
  return /^[A-Za-z_]\w*$/.test(text);
}
