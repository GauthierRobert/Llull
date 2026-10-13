/** Flat coordinates → 2D points: `xy(0, 0, 4, 0)` = `[[0, 0], [4, 0]]`. */
export const xy = (...c: number[]): Array<[number, number]> => c.flatMap((v, i) => (i % 2 ? [] : [[v, c[i + 1]!] as [number, number]]));

/** Flat coordinates → 3D points: `xyz(0, 0, 0, 1, 0, 0)` = `[[0, 0, 0], [1, 0, 0]]`. */
export const xyz = (...c: number[]): Array<[number, number, number]> =>
  c.flatMap((v, i) => (i % 3 ? [] : [[v, c[i + 1]!, c[i + 2]!] as [number, number, number]]));
