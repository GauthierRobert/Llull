/** Tiny, dependency-free unique id generator for entities. */
let counter = 0;

export function nextId(prefix = 'e'): string {
  counter += 1;
  // Time component keeps ids sortable-ish; counter guarantees uniqueness in a tick.
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Reset — used by tests to get deterministic ids. */
export function __resetIdCounter(): void {
  counter = 0;
}
