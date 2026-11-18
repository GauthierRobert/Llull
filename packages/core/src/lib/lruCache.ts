/** Bounded least-recently-used map: `get` and `set` mark a key most recent; `set` beyond `capacity` evicts the least recent. @layer lib */
export class LruCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private capacity: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** Raises the capacity to `minimum` when it is lower (never shrinks, so nothing is evicted). */
  ensureCapacity(minimum: number): void {
    if (minimum > this.capacity) this.capacity = minimum;
  }

  get capacityNow(): number {
    return this.capacity;
  }

  get size(): number {
    return this.entries.size;
  }
}
