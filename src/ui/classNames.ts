export function classNames(...parts: ReadonlyArray<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
