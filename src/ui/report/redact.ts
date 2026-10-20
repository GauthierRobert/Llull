/**
 * Redaction of anything the issue draft shows: the same rules as the backend's crash reports (`withoutConfirmations` for human
 * signatures in params; the home directory / user name in paths becomes `~`). Pure.
 */
import { withoutConfirmations } from '@lib/withoutConfirmations';

const HOME_PATTERNS: readonly RegExp[] = [
  /[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)+[^\\/\s"']+/g,
  /\/Users\/[^/\s"']+/g,
  /\/home\/[^/\s"']+/g,
];

export function redactHomePaths(text: string): string {
  return HOME_PATTERNS.reduce((current, pattern) => current.replace(pattern, '~'), text);
}

/** `value` as redacted JSON text (unserialisable values become a placeholder). */
export function redactedJson(value: unknown, space?: number): string {
  try {
    return redactHomePaths(JSON.stringify(withoutConfirmations(value), null, space) ?? 'null');
  } catch {
    return '"[unserialisable]"';
  }
}

/** `value` redacted and parsed back, ready to embed in a plan. */
export function redactedValue(value: unknown): unknown {
  return JSON.parse(redactedJson(value)) as unknown;
}
