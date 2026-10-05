/** @layer ui @pure Space-joined class names; `false` / `undefined` / empty parts are skipped. */
export function classNames(...parts: ReadonlyArray<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
