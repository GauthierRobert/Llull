/** A value with its unit (08 unit grammar, parsed by `lib/quantity`). */
export interface Quantity {
  readonly value: number;
  readonly unit: string;
}
