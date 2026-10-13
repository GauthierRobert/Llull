/** True for names that live on `Object.prototype` (`constructor`, `toString`, `__proto__`, ...): unsafe as keys of the document's plain-object records. */
export function isReservedKey(name: string): boolean {
  return name in Object.prototype;
}
