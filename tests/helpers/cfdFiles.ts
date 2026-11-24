/** Binary result files of the flow query transports (`LLSL` slice, `LLST` streamlines), built the way `llull-flow-core` writes them. */

const u32 = (...values: number[]): number[] => values.flatMap((value) => [...new Uint8Array(new Uint32Array([value]).buffer)]);
const f32 = (...values: number[]): number[] => values.flatMap((value) => [...new Uint8Array(new Float32Array([value]).buffer)]);
const ascii = (text: string, width: number): number[] => Array.from({ length: width }, (_, k) => text.charCodeAt(k) || 0);

/** A `samples` x `samples` patch with corner at the origin, axes x / y and spacing 0.5 m. */
export function sliceBytes(samples: number, values: readonly number[], field: string): Uint8Array {
  return new Uint8Array([
    ...ascii('LLSL', 4),
    ...u32(1, samples, samples),
    ...f32(0, 0, 0, 1, 0, 0, 0, 1, 0, 0.5),
    ...ascii(field, 16),
    ...f32(...values),
  ]);
}

/** Two polylines of 3 and 2 points; speeds 1..5 m/s. */
export function streamlinesBytes(): Uint8Array {
  return new Uint8Array([
    ...ascii('LLST', 4),
    ...u32(1, 2, 5),
    ...u32(0, 3, 5),
    ...f32(0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0),
    ...f32(1, 2, 3, 4, 5),
  ]);
}
