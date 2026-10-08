/** True for characters XML 1.0 cannot represent at all (control codes except \t \n \r, U+FFFE/F, lone surrogates). */
function isIllegalXmlChar(code: number, next: number): boolean {
  if (code < 0x20) return code !== 0x09 && code !== 0x0a && code !== 0x0d;
  if (code === 0xfffe || code === 0xffff) return true;
  if (code >= 0xdc00 && code <= 0xdfff) return true; // low surrogate not consumed as part of a pair
  return code >= 0xd800 && code <= 0xdbff && !(next >= 0xdc00 && next <= 0xdfff);
}

/**
 * @pure escape `& < > "` for XML/SVG text and attribute values and drop characters XML 1.0
 * forbids (which would make the whole document unparseable); `\t \n \r` and astral characters stay.
 */
export function escapeXml(text: string): string {
  let kept = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && !isIllegalXmlChar(code, text.charCodeAt(i + 1))) {
      kept += text.slice(i, i + 2); // valid surrogate pair
      i++;
    } else if (!isIllegalXmlChar(code, 0)) {
      kept += text[i];
    }
  }
  return kept
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
