/** Stacking notation (06 CMP §5.1, after NASA RP-1351): `[0/+-45/90]s`, `[0_5/45]_2s`, `[(0/90)_2/45]s`, `[45/-45/0_2/90~]s`, `[0/90]T`. Bottom to top. */

export type NotationResult =
  | { readonly ok: true; readonly angles: readonly number[] }
  | { readonly ok: false; readonly message: string; readonly token: string; readonly index: number };

/** Angle in (-90, 90] (a ply at 90 degrees stays 90, -90 becomes 90); never -0. */
export function normalizeAngle(angle: number): number {
  const wrapped = ((((angle + 90) % 180) + 180) % 180) - 90;
  return (wrapped === -90 ? 90 : wrapped) + 0;
}

const fail = (message: string, token: string, index: number): NotationResult => ({ ok: false, message, token, index });

/** Splits `text` at the `/` characters outside parentheses. */
function splitTop(text: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth < 0) return null;
    if (character === '/' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += character;
  }
  if (depth !== 0) return null;
  parts.push(current);
  return parts;
}

const GROUP = /^\((.*)\)(?:_(\d+))?$/;
const PAIR = /^(?:\+-|±)(\d+(?:\.\d+)?)(?:_(\d+))?$/;
const SINGLE = /^([-+]?\d+(?:\.\d+)?)(?:_(\d+))?$/;
const MAX_PLIES = 2000;

/** `pattern` repeated `count` times, or null when the count is 0 or the result would exceed the ply limit. */
function repeated(unit: readonly number[], count: number): number[] | null {
  if (!Number.isSafeInteger(count) || count < 1 || count * unit.length > MAX_PLIES) return null;
  return Array.from({ length: count }, () => unit).flat();
}

/** Angles of one item (an angle, a pair or a group); null when it does not parse. */
function expandItem(item: string, depth: number): number[] | null {
  const group = GROUP.exec(item);
  if (group !== null) {
    const inner = parseItems(group[1] as string, depth + 1);
    return inner === null ? null : repeated(inner, Number(group[2] ?? 1));
  }
  const pair = PAIR.exec(item);
  if (pair !== null) return repeated([Number(pair[1]), -Number(pair[1])], Number(pair[2] ?? 1));
  const single = SINGLE.exec(item);
  return single === null ? null : repeated([Number(single[1])], Number(single[2] ?? 1));
}

function parseItems(text: string, depth: number): number[] | null {
  const items = splitTop(text);
  if (items === null || depth > 8) return null;
  const angles: number[] = [];
  for (const item of items) {
    const expanded = expandItem(item.trim(), depth);
    if (expanded === null) return null;
    angles.push(...expanded);
    if (angles.length > MAX_PLIES) return null;
  }
  return angles;
}

/**
 * Expands a stacking string into angles (bottom to top, normalised to (-90, 90]).
 * @failure a token that is not an angle, `+-angle`, `(group)_n`; a missing bracket; a stray suffix; more than 2000 plies -> { ok: false, token, index }
 */
export function parseNotation(notation: string): NotationResult {
  const text = notation.replace(/\s+/g, '');
  const outer = /^\[(.*)\]_?(\d*)(s\u0304?\.?|T)?$/.exec(text);
  if (outer === null) return fail('expected [angles]s, [angles]T or [angles] (angles separated by "/")', text, 0);
  let body = outer[1] as string;
  const repeat = outer[2] === '' ? 1 : Number(outer[2]);
  const overlined = outer[3]?.includes('\u0304') === true;
  const symmetric = outer[3]?.startsWith('s') === true;
  const middle = body.endsWith('~') || overlined;
  if (body.endsWith('~')) body = body.slice(0, -1);
  if (middle && !symmetric) return fail('~ (unduplicated middle ply) needs the symmetric suffix s', text, 0);
  const items = splitTop(body);
  if (items === null) return fail('unbalanced parentheses', body, 0);
  const angles: number[] = [];
  for (const [index, item] of items.entries()) {
    const expanded = expandItem(item.trim(), 0);
    if (expanded === null) return fail(`"${item}" is not an angle, +-angle or (group)_n`, item, index);
    angles.push(...expanded);
    if (angles.length > MAX_PLIES) return fail(`more than ${MAX_PLIES} plies`, text, 0);
  }
  if (angles.length === 0 || repeat === 0) return fail('the stack is empty', text, 0);
  const half = repeated(angles, repeat);
  if (half === null) return fail(`more than ${MAX_PLIES} plies`, text, 0);
  const stack = symmetric ? [...half, ...(middle ? half.slice(0, -1) : half).reverse()] : half;
  if (stack.length > MAX_PLIES) return fail(`more than ${MAX_PLIES} plies`, text, 0);
  return { ok: true, angles: stack.map(normalizeAngle) };
}

const runText = (angle: number, count: number): string => `${angle}${count > 1 ? `_${count}` : ''}`;

/** `/`-joined items of `angles` with runs as `a_n` and an adjacent +a, -a pair as `+-a`. */
function items(angles: readonly number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < angles.length; ) {
    const angle = angles[i] as number;
    const next = angles[i + 1];
    if (angle > 0 && angle < 90 && next === -angle) {
      let pairs = 1;
      while (angles[i + 2 * pairs] === angle && angles[i + 2 * pairs + 1] === -angle) pairs += 1;
      out.push(`+-${runText(angle, pairs)}`);
      i += 2 * pairs;
      continue;
    }
    let count = 1;
    while (angles[i + count] === angle) count += 1;
    out.push(runText(angle, count));
    i += count;
  }
  return out;
}

/** Shortest canonical notation of `angles`: `[half]s` for a symmetric stack (`~` marks an unduplicated middle ply), else `[all]T`. */
export function printNotation(angles: readonly number[]): string {
  const n = angles.length;
  const symmetric = angles.every((angle, i) => angle === angles[n - 1 - i]);
  if (!symmetric || n < 2) return `[${items(angles).join('/')}]T`;
  const odd = n % 2 === 1;
  const half = angles.slice(0, odd ? (n + 1) / 2 : n / 2);
  const text = items(half).join('/');
  return `[${text}${odd ? '~' : ''}]s`;
}
